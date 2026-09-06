/**
 * How large a budget change should be, and when there should be none.
 *
 * This is the piece the budget feature was missing. Every other part existed —
 * the typed intent contract, the validator, the approval runtime, the write
 * journal, the read-back — but nothing chose a direction and a magnitude, so
 * the producer's candidate query could never match and the whole path was inert.
 *
 * ## What this is, and is not
 *
 * It is an operating policy, stated as data so it can be read and argued with.
 * It is NOT a derived optimum: nothing here demonstrates a marginal-return
 * curve, and a ROAS above target is not evidence that fifteen percent more
 * budget earns the same return. The ladder it selects from is the existing
 * `APPROVED_MAGNITUDE_PERCENTS`, whose own provenance record says plainly that
 * D080B found the rungs indistinguishable on retained history.
 *
 * It selects; it does not compute money. Minor units, rounding, currency and
 * every rejection stay with `validateBudgetIntent`.
 *
 * ## The shape of the rules
 *
 * Eligibility runs in order and stops at the first failure, so the reason an
 * operator sees is the first thing that was actually wrong rather than the last
 * one checked. Every gate returns a code the surface already knows.
 */
import { APPROVED_MAGNITUDE_PERCENTS } from "@/lib/meta/budget-intent-contract";

export const BUDGET_SIZING_POLICY_VERSION = "meta.budget-sizing.v1" as const;

/**
 * The rungs, and the bands that pick one.
 *
 * Config-as-data because `INVARIANTS.md` requires it: thresholds must be
 * readable in one place rather than scattered through resolver branches. No
 * environment variable and no per-business override in v1 — a business-specific
 * ladder is a different claim and would need its own evidence.
 */
export const BUDGET_SIZING_POLICY_V1 = {
  version: BUDGET_SIZING_POLICY_VERSION,
  ladder: APPROVED_MAGNITUDE_PERCENTS,
  /**
   * Within five percent of target, the difference is not distinguishable from
   * noise at this grain, and a change would be motion rather than management.
   */
  increaseDeadBandRatio: 1.05,
  /** `r = roas28d / targetRoas`; the first band whose floor `r` clears wins. */
  increaseBands: [
    { minRatio: 1.75, percent: 20 },
    { minRatio: 1.35, percent: 15 },
    { minRatio: 1.15, percent: 10 },
    { minRatio: 1.05, percent: 5 },
  ],
  /**
   * `d` is how far the entity has fallen from target towards break-even:
   * 0 at target, 1 at break-even. Deeper means a larger reduction.
   */
  protectBands: [
    { minDistance: 0.8, percent: 15 },
    { minDistance: 0.5, percent: 10 },
    { minDistance: 0, percent: 5 },
  ],
  /** Below break-even, when a pause is withheld and a reduction is eligible. */
  belowBreakEvenPercent: 25,
  /**
   * Purchases in the 28-day window below which the ladder is damped.
   *
   * A named policy number. It is NOT the winner-pool purchase floor
   * (`AccountCalibration.winnerPurchaseP50`): that lives at ad grain and this
   * producer works at campaign and ad-set grain, so borrowing it would be
   * reading a number about a different population.
   */
  minPurchases28dForFullRung: 25,
  /** Calibration sample below which the ladder is damped. */
  minCalibrationSampleSize: 30,
  /** The rung a damped increase may not exceed. */
  dampedMaxPercent: 10,
} as const;

export type BudgetSizingDirection = "increase" | "decrease";

export type BudgetSizingWithheldCode =
  | "role_authority_absent"
  | "budget_owner_unresolved"
  | "non_sales_eligible"
  | "maturity_insufficient"
  | "target_roas_missing"
  | "break_even_roas_missing"
  | "commercial_targets_inconsistent"
  | "no_spend_signal"
  | "zero_purchase_evidence"
  | "within_target_dead_band"
  | "pause_takes_precedence"
  | "policy_cooldown_active"
  | "policy_change_frequency_exceeded"
  | "policy_spend_ceiling_currency_mismatch"
  | "policy_spend_ceiling_unset"
  | "policy_spend_ceiling_exceeded"
  | "policy_account_concentration_exceeded"
  | "sizing_policy_version_unbound"
  | "provider_baseline_unknown";

export interface BudgetSizingInput {
  /** The engine's own label for this entity today. */
  decisionLabel: string | null;
  /** `resolveCampaignRoleAuthority().satisfiesRoleAuthority`. */
  roleAuthoritySatisfied: boolean;
  /**
   * `classifyBudgetUniverse({entityGrain, budgetOwnerMode})`. Only `applicable`
   * proceeds: a non-null `daily_budget` on both the campaign and the ad set
   * proves nothing about which one owns it.
   */
  budgetUniverse: "applicable" | "proven_non_applicable" | "owner_unknown";
  isBudgetMixed: boolean;
  /** `resolveMetaFunnelCohort(...)`; only `purchase` is evaluated here. */
  funnelCohort: string;
  currentMinorUnits: number | null;
  maturityOk: boolean;
  roas28d: number | null;
  spend28d: number | null;
  purchases28d: number | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  calibrationSampleSize: number | null;
  /** True when a pause for this entity was produced and will be offered. */
  pauseProduced: boolean;
  /** True when the entity is below break-even and a pause was NOT produced. */
  pauseWithheld: boolean;
  policy: {
    maxBudgetIncreasePct: number | null;
    /** Compared against the PROPOSED TOTAL, never against the delta. */
    perActionSpendCeilingMinor: number | null;
    perActionSpendCeilingCurrency: string | null;
    budgetMinHoursBetweenChanges: number | null;
    budgetMaxChangesPer7d: number | null;
    budgetMaxAccountConcentrationPct: number | null;
    /** Stamped when the operator configured automation. */
    budgetSizingPolicyVersion: string | null;
  };
  accountCurrency: string | null;
  hoursSinceLastChange: number | null;
  changesLast7d: number | null;
  /** This owner's share of the account's total daily budget, 0..1. */
  accountShareBefore: number | null;
  providerBaselineKnown: boolean;
}

export type BudgetSizingOutcome =
  | {
      status: "sized";
      direction: BudgetSizingDirection;
      percent: number;
      proposedMinorUnits: number;
      /** Band, ratio and every clamp that moved the rung, in order. */
      rationale: string[];
      policyVersion: typeof BUDGET_SIZING_POLICY_VERSION;
    }
  | { status: "withheld"; code: BudgetSizingWithheldCode; detail: string };

function withheld(
  code: BudgetSizingWithheldCode,
  detail: string,
): BudgetSizingOutcome {
  return { status: "withheld", code, detail };
}

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The largest ladder rung at or below `cap`, or null when none fits. */
function rungAtOrBelow(cap: number): number | null {
  const fitting = BUDGET_SIZING_POLICY_V1.ladder.filter((rung) => rung <= cap);
  return fitting.length > 0 ? Math.max(...fitting) : null;
}

/** The next rung strictly below `percent`, or null at the bottom. */
function rungBelow(percent: number): number | null {
  const lower = BUDGET_SIZING_POLICY_V1.ladder.filter((rung) => rung < percent);
  return lower.length > 0 ? Math.max(...lower) : null;
}

/**
 * The proposed total, in the same minor units, at half-up-away-from-zero.
 *
 * The contract validator re-derives this and would reject a disagreement; the
 * duplication is deliberate, because the clamps below have to compare a real
 * proposed total against the ceiling before choosing a rung.
 */
export function proposedMinorUnitsFor(
  currentMinorUnits: number,
  direction: BudgetSizingDirection,
  percent: number,
): number {
  const factor = direction === "increase" ? 1 + percent / 100 : 1 - percent / 100;
  return Math.round(currentMinorUnits * factor);
}

/**
 * The owner's share of account daily budget after an increase.
 *
 * The denominator grows with the numerator: this owner's own increase is part
 * of the account total afterwards. Using the old denominator overstates the
 * resulting concentration and would reject changes that are in fact inside the
 * policy.
 */
export function shareAfterIncrease(shareBefore: number, percent: number): number {
  const p = percent / 100;
  return (shareBefore * (1 + p)) / (1 + shareBefore * p);
}

export function sizeBudgetChange(input: BudgetSizingInput): BudgetSizingOutcome {
  const policy = input.policy;

  // The policy in force is the one the operator's configuration was stamped
  // with. An unstamped or mismatched version means nobody agreed to these
  // bands, and inventing agreement is exactly what a sizing policy must not do.
  if (policy.budgetSizingPolicyVersion !== BUDGET_SIZING_POLICY_VERSION) {
    return withheld(
      "sizing_policy_version_unbound",
      "No budget sizing policy version is bound to this business's automation configuration.",
    );
  }

  // ── Eligibility, in order ────────────────────────────────────────────────
  if (
    input.decisionLabel !== "scale" &&
    input.decisionLabel !== "cut" &&
    input.decisionLabel !== "tune"
  ) {
    return withheld(
      "role_authority_absent",
      `A budget intent is produced only for scale, cut or tune; this row is ${input.decisionLabel ?? "unlabelled"}.`,
    );
  }
  if (!input.roleAuthoritySatisfied) {
    return withheld(
      "role_authority_absent",
      "The campaign's automatic Main/Test/Mixed role is not resolved with authority.",
    );
  }
  if (input.budgetUniverse !== "applicable" || input.isBudgetMixed) {
    return withheld(
      "budget_owner_unresolved",
      "The budget owner is not proven, so a change could be written to the wrong entity.",
    );
  }
  if (input.funnelCohort !== "purchase") {
    return withheld(
      "non_sales_eligible",
      `This entity optimises for ${input.funnelCohort}, so purchase ROAS does not judge it.`,
    );
  }
  if (!input.maturityOk) {
    return withheld(
      "maturity_insufficient",
      "The entity has not spent enough for its result to carry a budget change.",
    );
  }
  if (!positive(input.currentMinorUnits)) {
    return withheld(
      "budget_owner_unresolved",
      "No current budget amount was observed for the owning entity.",
    );
  }
  if (!positive(input.spend28d)) {
    return withheld(
      "no_spend_signal",
      "Nothing was spent in the evidence window, so no return can be computed.",
    );
  }
  if (input.roas28d === null || !Number.isFinite(input.roas28d)) {
    return withheld(
      "no_spend_signal",
      "The 28-day return could not be computed for this entity.",
    );
  }
  if (!positive(input.targetRoas)) {
    // ROAS is the one commercial target this product requires.
    return withheld(
      "target_roas_missing",
      "Set a Target ROAS in Commercial Truth before budget changes can be sized.",
    );
  }
  // Zero purchases is a valid observation — revenue 0 over positive spend is a
  // ROAS of 0 — but it is not evidence a budget should move. The pause and
  // anomaly paths own that row.
  if (!positive(input.purchases28d)) {
    return withheld(
      "zero_purchase_evidence",
      "No purchases were recorded in the evidence window, so a budget change has nothing to act on.",
    );
  }
  if (!positive(policy.perActionSpendCeilingMinor)) {
    return withheld(
      "policy_spend_ceiling_unset",
      "No per-action spend ceiling is configured for this business, in its own currency.",
    );
  }
  if (
    !policy.perActionSpendCeilingCurrency ||
    !input.accountCurrency ||
    policy.perActionSpendCeilingCurrency !== input.accountCurrency
  ) {
    return withheld(
      "policy_spend_ceiling_currency_mismatch",
      `The spend ceiling is set in ${policy.perActionSpendCeilingCurrency ?? "no currency"} and this account is in ${input.accountCurrency ?? "an unknown currency"}.`,
    );
  }
  if (!input.providerBaselineKnown) {
    return withheld(
      "provider_baseline_unknown",
      "The provider's current budget for this entity could not be read.",
    );
  }
  if (
    positive(policy.budgetMinHoursBetweenChanges) &&
    input.hoursSinceLastChange !== null &&
    input.hoursSinceLastChange < policy.budgetMinHoursBetweenChanges
  ) {
    const wait = Math.ceil(
      policy.budgetMinHoursBetweenChanges - input.hoursSinceLastChange,
    );
    return withheld(
      "policy_cooldown_active",
      `This budget changed too recently; it can be reconsidered in ${wait} hours.`,
    );
  }
  if (
    positive(policy.budgetMaxChangesPer7d) &&
    input.changesLast7d !== null &&
    input.changesLast7d >= policy.budgetMaxChangesPer7d
  ) {
    return withheld(
      "policy_change_frequency_exceeded",
      "This budget has already changed as often as the policy allows in seven days.",
    );
  }

  // ── Band selection ───────────────────────────────────────────────────────
  const rationale: string[] = [];
  let direction: BudgetSizingDirection;
  let percent: number;
  const roas = input.roas28d;
  const targetRoas = input.targetRoas;

  if (roas >= targetRoas * BUDGET_SIZING_POLICY_V1.increaseDeadBandRatio) {
    if (input.decisionLabel !== "scale") {
      return withheld(
        "within_target_dead_band",
        "The entity is above target but the engine did not label it for scale.",
      );
    }
    const ratio = roas / targetRoas;
    const band = BUDGET_SIZING_POLICY_V1.increaseBands.find(
      (candidate) => ratio >= candidate.minRatio,
    );
    if (!band) {
      return withheld(
        "within_target_dead_band",
        "The return is inside the band where no change is proposed.",
      );
    }
    direction = "increase";
    percent = band.percent;
    rationale.push(
      `return ${roas.toFixed(2)} is ${ratio.toFixed(2)}x the ${targetRoas.toFixed(2)} target, band ≥${band.minRatio} → ${percent}%`,
    );
  } else if (roas < targetRoas) {
    // Below target. Which reduction applies depends on break-even, and the
    // break-even branches are the only ones that need it — an increase never
    // consults it, because ROAS is the one required target.
    if (!positive(input.breakEvenRoas)) {
      return withheld(
        "break_even_roas_missing",
        "A reduction is judged against break-even ROAS, which is not configured.",
      );
    }
    const breakEven = input.breakEvenRoas;
    if (targetRoas <= breakEven) {
      return withheld(
        "commercial_targets_inconsistent",
        "The Target ROAS is not above the break-even ROAS, so the protect band cannot be measured.",
      );
    }
    if (roas >= breakEven) {
      const distance = (targetRoas - roas) / (targetRoas - breakEven);
      const band = BUDGET_SIZING_POLICY_V1.protectBands.find(
        (candidate) => distance >= candidate.minDistance,
      )!;
      direction = "decrease";
      percent = band.percent;
      rationale.push(
        `return ${roas.toFixed(2)} sits ${(distance * 100).toFixed(0)}% of the way from the ${targetRoas.toFixed(2)} target to the ${breakEven.toFixed(2)} break-even → ${percent}%`,
      );
    } else {
      // Below break-even the pause path owns the row. A reduction is produced
      // only when no pause was, and it never inherits the pause's authority:
      // every gate above had to pass on its own.
      if (input.pauseProduced) {
        return withheld(
          "pause_takes_precedence",
          "A pause is already offered for this entity, so no budget change is proposed beside it.",
        );
      }
      if (!input.pauseWithheld) {
        return withheld(
          "pause_takes_precedence",
          "Below break-even this entity is handled by the pause path.",
        );
      }
      direction = "decrease";
      percent = BUDGET_SIZING_POLICY_V1.belowBreakEvenPercent;
      rationale.push(
        `return ${roas.toFixed(2)} is below the ${breakEven.toFixed(2)} break-even and a pause is withheld → ${percent}%`,
      );
    }
  } else {
    return withheld(
      "within_target_dead_band",
      `Return ${roas.toFixed(2)} is at the ${targetRoas.toFixed(2)} target; no change is proposed.`,
    );
  }

  // ── Damping and clamping, in order ───────────────────────────────────────
  if (direction === "increase") {
    const thinSample =
      (input.calibrationSampleSize ?? 0) <
      BUDGET_SIZING_POLICY_V1.minCalibrationSampleSize;
    const thinPurchases =
      (input.purchases28d ?? 0) <
      BUDGET_SIZING_POLICY_V1.minPurchases28dForFullRung;
    if ((thinSample || thinPurchases) && percent > BUDGET_SIZING_POLICY_V1.dampedMaxPercent) {
      percent = BUDGET_SIZING_POLICY_V1.dampedMaxPercent;
      rationale.push(
        `evidence is thin (${input.purchases28d} purchases, calibration sample ${input.calibrationSampleSize ?? 0}) → capped at ${percent}%`,
      );
    }
    if (positive(policy.maxBudgetIncreasePct) && percent > policy.maxBudgetIncreasePct) {
      const capped = rungAtOrBelow(policy.maxBudgetIncreasePct);
      if (capped === null) {
        return withheld(
          "policy_spend_ceiling_exceeded",
          `No approved increase is at or below this business's ${policy.maxBudgetIncreasePct}% ceiling.`,
        );
      }
      percent = capped;
      rationale.push(`business ceiling ${policy.maxBudgetIncreasePct}% → ${percent}%`);
    }
  }

  const ceiling = policy.perActionSpendCeilingMinor;
  let proposed = proposedMinorUnitsFor(input.currentMinorUnits, direction, percent);
  // The ceiling is compared against the PROPOSED TOTAL, exactly as the write
  // preflight compares it. It is not a limit on the size of the change, and it
  // applies in both directions: a reduction that does not bring the total under
  // the ceiling is refused, and one that does is allowed even from above it.
  while (proposed > ceiling) {
    const next = rungBelow(percent);
    if (next === null) {
      return withheld(
        "policy_spend_ceiling_exceeded",
        `Every approved change leaves this budget above the ${ceiling} ceiling.`,
      );
    }
    percent = next;
    proposed = proposedMinorUnitsFor(input.currentMinorUnits, direction, percent);
    rationale.push(`spend ceiling ${ceiling} → ${percent}%`);
  }

  if (
    direction === "increase" &&
    positive(policy.budgetMaxAccountConcentrationPct) &&
    input.accountShareBefore !== null
  ) {
    const limit = policy.budgetMaxAccountConcentrationPct / 100;
    while (shareAfterIncrease(input.accountShareBefore, percent) > limit) {
      const next = rungBelow(percent);
      if (next === null) {
        return withheld(
          "policy_account_concentration_exceeded",
          "Any approved increase would put too much of the account's budget on this one owner.",
        );
      }
      percent = next;
      proposed = proposedMinorUnitsFor(input.currentMinorUnits, direction, percent);
      rationale.push(`account concentration ${policy.budgetMaxAccountConcentrationPct}% → ${percent}%`);
    }
  }

  if (proposed === input.currentMinorUnits) {
    return withheld(
      "within_target_dead_band",
      "Every approved change rounds back to the current amount.",
    );
  }

  return {
    status: "sized",
    direction,
    percent,
    proposedMinorUnits: proposed,
    rationale,
    policyVersion: BUDGET_SIZING_POLICY_VERSION,
  };
}
