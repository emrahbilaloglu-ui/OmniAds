import { describe, expect, it } from "vitest";

import {
  BUDGET_SIZING_POLICY_VERSION,
  shareAfterIncrease,
  sizeBudgetChange,
  type BudgetSizingInput,
} from "@/lib/meta/budget-sizing-policy";

/** An eligible ad set: every gate passes so a case can move exactly one input. */
function eligible(overrides: Partial<BudgetSizingInput> = {}): BudgetSizingInput {
  return {
    decisionLabel: "scale",
    roleAuthoritySatisfied: true,
    budgetUniverse: "applicable",
    isBudgetMixed: false,
    funnelCohort: "purchase",
    currentMinorUnits: 5000,
    maturityOk: true,
    roas28d: 2.85,
    spend28d: 4200,
    purchases28d: 41,
    targetRoas: 2.0,
    breakEvenRoas: 1.6,
    calibrationSampleSize: 64,
    pauseProduced: false,
    pauseWithheld: false,
    policy: {
      maxBudgetIncreasePct: 15,
      perActionSpendCeilingMinor: 8000,
      perActionSpendCeilingCurrency: "USD",
      budgetMinHoursBetweenChanges: 24,
      budgetMaxChangesPer7d: 2,
      budgetMaxAccountConcentrationPct: 40,
      budgetSizingPolicyVersion: BUDGET_SIZING_POLICY_VERSION,
    },
    accountCurrency: "USD",
    hoursSinceLastChange: 96,
    changesLast7d: 0,
    accountShareBefore: 0.12,
    providerBaselineKnown: true,
    ...overrides,
  };
}

describe("budget sizing — the worked cases", () => {
  it("case 1: sizes an increase from the band and clears every clamp", () => {
    const outcome = sizeBudgetChange(eligible());
    expect(outcome).toMatchObject({
      status: "sized",
      direction: "increase",
      percent: 15,
      proposedMinorUnits: 5750,
    });
    // 2.85 / 2.00 = 1.425, which is the ≥1.35 band.
    expect(outcome.status === "sized" && outcome.rationale[0]).toContain("1.43x");
  });

  it("case 1b: refuses when no rung leaves the total under the ceiling", () => {
    // 5250, 5500 and 5750 all exceed 5200, so nothing on the ladder fits and a
    // budget already near its ceiling simply cannot grow.
    const outcome = sizeBudgetChange(
      eligible({ policy: { ...eligible().policy, perActionSpendCeilingMinor: 5200 } }),
    );
    expect(outcome).toMatchObject({
      status: "withheld",
      code: "policy_spend_ceiling_exceeded",
    });
  });

  it("case 2: sizes a protect-band reduction from distance to break-even", () => {
    const outcome = sizeBudgetChange(
      eligible({
        decisionLabel: "tune",
        currentMinorUnits: 120_000,
        roas28d: 1.95,
        targetRoas: 2.2,
        breakEvenRoas: 1.8,
        policy: {
          ...eligible().policy,
          perActionSpendCeilingMinor: 200_000,
          perActionSpendCeilingCurrency: "TRY",
        },
        accountCurrency: "TRY",
      }),
    );
    // (2.20 − 1.95) / (2.20 − 1.80) = 0.625 → the 0.5..0.8 band.
    expect(outcome).toMatchObject({
      status: "sized",
      direction: "decrease",
      percent: 10,
      proposedMinorUnits: 108_000,
    });
  });

  it("case 2b: measures a reduction against the ceiling too", () => {
    const outcome = sizeBudgetChange(
      eligible({
        decisionLabel: "tune",
        currentMinorUnits: 120_000,
        roas28d: 1.95,
        targetRoas: 2.2,
        breakEvenRoas: 1.8,
        policy: {
          ...eligible().policy,
          perActionSpendCeilingMinor: 20_000,
          perActionSpendCeilingCurrency: "TRY",
        },
        accountCurrency: "TRY",
      }),
    );
    expect(outcome).toMatchObject({
      status: "withheld",
      code: "policy_spend_ceiling_exceeded",
    });
  });

  it("case 2c: allows a reduction that brings the total under the ceiling", () => {
    // A budget above the ceiling is not frozen: the rule is about the proposed
    // total, so a change that crosses back under it is exactly what should pass.
    const outcome = sizeBudgetChange(
      eligible({
        decisionLabel: "tune",
        currentMinorUnits: 21_000,
        roas28d: 1.95,
        targetRoas: 2.2,
        breakEvenRoas: 1.8,
        policy: {
          ...eligible().policy,
          perActionSpendCeilingMinor: 20_000,
          perActionSpendCeilingCurrency: "TRY",
        },
        accountCurrency: "TRY",
      }),
    );
    expect(outcome).toMatchObject({
      status: "sized",
      direction: "decrease",
      percent: 10,
      proposedMinorUnits: 18_900,
    });
  });

  it("case 3: proposes nothing inside the dead band", () => {
    const outcome = sizeBudgetChange(
      eligible({ roas28d: 3.05, targetRoas: 3.0, breakEvenRoas: 2.0 }),
    );
    expect(outcome).toMatchObject({
      status: "withheld",
      code: "within_target_dead_band",
    });
  });

  it("case 4: asks only for a Target ROAS when none is configured", () => {
    const outcome = sizeBudgetChange(eligible({ targetRoas: null }));
    expect(outcome).toMatchObject({ status: "withheld", code: "target_roas_missing" });
    expect(outcome.status === "withheld" && outcome.detail).toContain("Target ROAS");
    // Never a CPA or an AOV: those are optional inputs this product reads.
    expect(outcome.status === "withheld" && outcome.detail).not.toMatch(/CPA|AOV/);
  });

  it("case 5: names the cooldown and when it lifts", () => {
    const outcome = sizeBudgetChange(eligible({ hoursSinceLastChange: 9 }));
    expect(outcome).toMatchObject({ status: "withheld", code: "policy_cooldown_active" });
    expect(outcome.status === "withheld" && outcome.detail).toContain("15 hours");
  });

  it("case 6: reads zero purchases as thin evidence, not as broken arithmetic", () => {
    // revenue 0 over positive spend is a ROAS of 0 — a valid observation. The
    // reason a budget does not move is evidence, not division.
    const outcome = sizeBudgetChange(
      eligible({ roas28d: 0, purchases28d: 0, spend28d: 4200, decisionLabel: "cut" }),
    );
    expect(outcome).toMatchObject({
      status: "withheld",
      code: "zero_purchase_evidence",
    });
  });

  it("case 7: an inconsistent pair closes only the branch that uses it", () => {
    const belowTarget = sizeBudgetChange(
      eligible({ decisionLabel: "tune", roas28d: 1.7, targetRoas: 1.8, breakEvenRoas: 2.0 }),
    );
    expect(belowTarget).toMatchObject({
      status: "withheld",
      code: "commercial_targets_inconsistent",
    });

    // The increase branch never consults break-even, so it is unaffected.
    const above = sizeBudgetChange(
      eligible({ roas28d: 2.6, targetRoas: 1.8, breakEvenRoas: 2.0 }),
    );
    expect(above.status).toBe("sized");
  });

  it("case 8: sizes an increase with no break-even configured at all", () => {
    const outcome = sizeBudgetChange(
      eligible({
        roas28d: 3.4,
        targetRoas: 2.5,
        breakEvenRoas: null,
        policy: { ...eligible().policy, maxBudgetIncreasePct: 20 },
      }),
    );
    // 3.4 / 2.5 = 1.36 → the ≥1.35 band. ROAS is the only required target.
    expect(outcome).toMatchObject({ status: "sized", direction: "increase", percent: 15 });
  });
});

describe("budget sizing — damping and concentration", () => {
  it("caps the rung when the evidence is thin", () => {
    const outcome = sizeBudgetChange(eligible({ purchases28d: 11, roas28d: 3.9 }));
    expect(outcome).toMatchObject({ status: "sized", percent: 10 });
    expect(outcome.status === "sized" && outcome.rationale.join(" ")).toContain(
      "thin",
    );
  });

  it("computes concentration against the denominator it will actually have", () => {
    // 0.12 × 1.15 / (1 + 0.12 × 0.15) = 0.1356, not 0.138. Using the old
    // denominator overstates the result and rejects changes that are in policy.
    expect(shareAfterIncrease(0.12, 15)).toBeCloseTo(0.1356, 4);
  });

  it("steps down until the concentration limit is met", () => {
    const outcome = sizeBudgetChange(
      eligible({ accountShareBefore: 0.5, policy: { ...eligible().policy, budgetMaxAccountConcentrationPct: 52 } }),
    );
    expect(outcome.status).toBe("sized");
    expect(outcome.status === "sized" && outcome.rationale.join(" ")).toContain(
      "concentration",
    );
  });

  it("refuses when no rung fits the concentration limit", () => {
    const outcome = sizeBudgetChange(
      eligible({ accountShareBefore: 0.9, policy: { ...eligible().policy, budgetMaxAccountConcentrationPct: 5 } }),
    );
    expect(outcome).toMatchObject({
      status: "withheld",
      code: "policy_account_concentration_exceeded",
    });
  });
});

describe("budget sizing — the gates that come first", () => {
  it("refuses without a policy version bound to this business", () => {
    const outcome = sizeBudgetChange(
      eligible({ policy: { ...eligible().policy, budgetSizingPolicyVersion: null } }),
    );
    expect(outcome).toMatchObject({
      status: "withheld",
      code: "sizing_policy_version_unbound",
    });
  });

  it("refuses an unproven budget owner rather than guessing from a value", () => {
    for (const budgetUniverse of ["owner_unknown", "proven_non_applicable"] as const) {
      expect(sizeBudgetChange(eligible({ budgetUniverse }))).toMatchObject({
        status: "withheld",
        code: "budget_owner_unresolved",
      });
    }
    expect(sizeBudgetChange(eligible({ isBudgetMixed: true }))).toMatchObject({
      status: "withheld",
      code: "budget_owner_unresolved",
    });
  });

  it("judges only purchase-cohort entities on purchase ROAS", () => {
    for (const funnelCohort of ["traffic", "lead", "upper_funnel", "engagement"]) {
      expect(sizeBudgetChange(eligible({ funnelCohort }))).toMatchObject({
        status: "withheld",
        code: "non_sales_eligible",
      });
    }
  });

  it("refuses without a resolved campaign role", () => {
    expect(
      sizeBudgetChange(eligible({ roleAuthoritySatisfied: false })),
    ).toMatchObject({ status: "withheld", code: "role_authority_absent" });
  });

  it("refuses an unset or mismatched spend ceiling instead of writing in another currency", () => {
    expect(
      sizeBudgetChange(
        eligible({ policy: { ...eligible().policy, perActionSpendCeilingMinor: null } }),
      ),
    ).toMatchObject({ status: "withheld", code: "policy_spend_ceiling_unset" });

    // The packaged default is EUR and none of these accounts is; a silent
    // mismatch is exactly what the named refusal replaces.
    expect(
      sizeBudgetChange(
        eligible({
          policy: { ...eligible().policy, perActionSpendCeilingCurrency: "EUR" },
        }),
      ),
    ).toMatchObject({
      status: "withheld",
      code: "policy_spend_ceiling_currency_mismatch",
    });
  });

  it("lets the pause path own an entity below break-even", () => {
    const withPause = sizeBudgetChange(
      eligible({
        decisionLabel: "cut",
        roas28d: 1.2,
        targetRoas: 2.0,
        breakEvenRoas: 1.6,
        pauseProduced: true,
      }),
    );
    expect(withPause).toMatchObject({
      status: "withheld",
      code: "pause_takes_precedence",
    });
  });

  it("does not let a withheld pause become an automatic reduction on its own", () => {
    // The reduction is produced only when every gate passed independently; a
    // pause that was withheld is not itself an authorization.
    const ineligible = sizeBudgetChange(
      eligible({
        decisionLabel: "cut",
        roas28d: 1.2,
        targetRoas: 2.0,
        breakEvenRoas: 1.6,
        pauseWithheld: true,
        maturityOk: false,
      }),
    );
    expect(ineligible).toMatchObject({
      status: "withheld",
      code: "maturity_insufficient",
    });

    const eligibleReduction = sizeBudgetChange(
      eligible({
        decisionLabel: "cut",
        roas28d: 1.2,
        targetRoas: 2.0,
        breakEvenRoas: 1.6,
        pauseWithheld: true,
      }),
    );
    expect(eligibleReduction).toMatchObject({
      status: "sized",
      direction: "decrease",
      percent: 25,
    });
  });

  it("refuses when the provider's current budget could not be read", () => {
    expect(
      sizeBudgetChange(eligible({ providerBaselineKnown: false })),
    ).toMatchObject({ status: "withheld", code: "provider_baseline_unknown" });
  });
});
