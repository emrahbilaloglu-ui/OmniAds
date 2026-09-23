import { resolveMetaCurrencyOffset } from "@/lib/currency/meta-currency-offsets";

/**
 * PRE-DEPLOY AUDIT — the budget automation configuration CONTRACT, with no
 * database in it.
 *
 * Split out of `budget-automation-configuration.ts` so the mounted admin
 * preparation form can validate with the SAME parser the route validates with.
 * That module imports `@/lib/db`; a client component importing it would drag a
 * database handle into the browser bundle, and the alternative — a second,
 * hand-written validator in the UI — is how a form comes to accept a value the
 * server then rejects, or worse, to reject one the server would have accepted.
 *
 * One parser, both sides. This file imports nothing.
 */

export const BUDGET_AUTOMATION_CONFIG_CONTRACT =
  "meta.budget-automation-configuration.v1" as const;

export interface BudgetAutomationConfigInput {
  /** Every write stays inside the building until this is explicitly false. */
  dryRunOnly: boolean;
  /** Hours between two budget changes on one entity. Positive. */
  budgetMinHoursBetweenChanges: number;
  /** Budget changes allowed on one entity in 7 days. Positive integer. */
  budgetMaxChangesPer7d: number;
  /** Share of the account's retained budget one entity may hold, in percent. */
  budgetMaxAccountConcentrationPct: number;
  /** The percentage ceiling a single increase may not exceed. Positive. */
  maxBudgetIncreasePct: number;
  /** Minor-unit ceiling for one action. Positive integer, or null to clear. */
  perActionSpendCeilingMinor: number | null;
  /** ISO-4217 for the ceiling above. Required whenever the ceiling is set. */
  perActionSpendCeilingCurrency: string | null;
}

export type BudgetAutomationConfigRejection =
  | "dry_run_only_not_boolean"
  | "min_hours_between_changes_invalid"
  | "max_changes_per_7d_invalid"
  | "max_account_concentration_pct_invalid"
  | "max_budget_increase_pct_invalid"
  | "per_action_spend_ceiling_invalid"
  | "per_action_spend_ceiling_currency_invalid"
  /**
   * Well-formed ISO code, but Meta publishes no minor-unit offset for it — so
   * this product cannot say what scale the stored integer is in.
   */
  | "per_action_spend_ceiling_currency_unsupported_by_provider";

export type BudgetAutomationConfigParse =
  | { ok: true; config: BudgetAutomationConfigInput }
  | { ok: false; rejection: BudgetAutomationConfigRejection; message: string };

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const positiveInteger = (value: unknown): value is number =>
  positive(value) && Number.isSafeInteger(value);

/**
 * Parse a caller's proposed configuration. Nothing is defaulted and nothing is
 * coerced: a string `"12"`, a zero, a negative, a NaN or an absent field is a
 * named rejection, because a guardrail the operator did not actually choose is
 * not a guardrail.
 */
export function parseBudgetAutomationConfig(
  raw: unknown,
): BudgetAutomationConfigParse {
  const body = (raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw : {}) as Record<string, unknown>;

  if (typeof body.dryRunOnly !== "boolean") {
    return {
      ok: false, rejection: "dry_run_only_not_boolean",
      message: "dryRunOnly must be a JSON boolean.",
    };
  }
  if (!positive(body.budgetMinHoursBetweenChanges)) {
    return {
      ok: false, rejection: "min_hours_between_changes_invalid",
      message: "budgetMinHoursBetweenChanges must be a positive number of hours.",
    };
  }
  if (!positiveInteger(body.budgetMaxChangesPer7d)) {
    return {
      ok: false, rejection: "max_changes_per_7d_invalid",
      message: "budgetMaxChangesPer7d must be a positive whole number.",
    };
  }
  if (!positive(body.budgetMaxAccountConcentrationPct)
    || (body.budgetMaxAccountConcentrationPct as number) > 100) {
    return {
      ok: false, rejection: "max_account_concentration_pct_invalid",
      message:
        "budgetMaxAccountConcentrationPct must be a positive percentage no greater than 100.",
    };
  }
  if (!positive(body.maxBudgetIncreasePct)) {
    return {
      ok: false, rejection: "max_budget_increase_pct_invalid",
      message: "maxBudgetIncreasePct must be a positive percentage.",
    };
  }

  const ceiling = body.perActionSpendCeilingMinor;
  const currency = body.perActionSpendCeilingCurrency;
  const ceilingCleared = ceiling === null;
  if (!ceilingCleared && !positiveInteger(ceiling)) {
    return {
      ok: false, rejection: "per_action_spend_ceiling_invalid",
      message:
        "perActionSpendCeilingMinor must be a positive whole number of minor units, or null to clear it.",
    };
  }
  if (!ceilingCleared
    && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency.trim()))) {
    return {
      ok: false, rejection: "per_action_spend_ceiling_currency_invalid",
      message:
        "perActionSpendCeilingCurrency must be a three-letter ISO-4217 code whenever a ceiling is set.",
    };
  }
  /*
    ── THE SCALE HAS TO BE NAMEABLE, NOT ONLY THE CODE ───────────────────────

    `perActionSpendCeilingMinor` is compared UNSCALED against the provider
    minor-unit amount an automated budget write would send, so a ceiling is
    only meaningful if this product knows how many subdivision digits the
    provider uses for that currency. Meta publishes an offset table; a code it
    does not list has no such scale here.

    A well-formed code is therefore not enough, and this check has to live on
    the SERVER: the editor already refuses to mint an unscaleable ceiling, but
    a raw POST bypasses the editor entirely and this is the only thing between
    it and a persisted guardrail nobody can interpret. The read path fails
    closed too (`automation-control-plane.ts` marks the pair invalid, which
    withholds the budget change rather than allowing an unlimited one), so this
    is the third of three independent gates — stated because a safety ceiling
    that fails OPEN is worse than no ceiling at all.

    Costs the live currencies nothing: Meta lists USD, TRY, GBP and EUR.
  */
  if (!ceilingCleared) {
    const code = (currency as string).trim().toUpperCase();
    if (resolveMetaCurrencyOffset(code).status !== "resolved") {
      return {
        ok: false,
        rejection: "per_action_spend_ceiling_currency_unsupported_by_provider",
        message:
          `The provider publishes no minor-unit offset for ${code}, so a spend `
          + "ceiling in it cannot be compared against a budget amount.",
      };
    }
  }

  return {
    ok: true,
    config: {
      dryRunOnly: body.dryRunOnly,
      budgetMinHoursBetweenChanges: body.budgetMinHoursBetweenChanges as number,
      budgetMaxChangesPer7d: body.budgetMaxChangesPer7d as number,
      budgetMaxAccountConcentrationPct: body.budgetMaxAccountConcentrationPct as number,
      maxBudgetIncreasePct: body.maxBudgetIncreasePct as number,
      perActionSpendCeilingMinor: ceilingCleared ? null : (ceiling as number),
      perActionSpendCeilingCurrency: ceilingCleared
        ? null : (currency as string).trim(),
    },
  };
}
