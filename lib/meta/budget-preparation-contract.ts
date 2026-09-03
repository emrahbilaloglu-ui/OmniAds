/**
 * PRE-DEPLOY AUDIT — the preparation VIEW contract, with no database in it.
 *
 * Split from `budget-preparation-read.ts` for the same reason the config
 * parser was: the mounted admin form needs the field list, the field-state
 * shape and the prerequisite rule, and that module imports `@/lib/db`. A
 * client component importing it would pull a database handle into the browser
 * bundle. This file imports only a type.
 */
import type { BudgetAutomationConfigInput }
  from "@/lib/meta/budget-automation-config-contract";

export const BUDGET_PREPARATION_READ_CONTRACT =
  "meta.budget-preparation-read.v1" as const;

export type PreparationFieldState = "persisted" | "unset" | "unknown";

export interface PreparationField<T> {
  readonly state: PreparationFieldState;
  /** Only ever non-null when `state` is `persisted`. */
  readonly value: T | null;
}

export type BudgetPreparationView = {
  readonly contract: typeof BUDGET_PREPARATION_READ_CONTRACT;
  /** False when the control row itself could not be read. */
  readonly rowRead: boolean;
  /** True when a control row exists for this business. */
  readonly rowExists: boolean;
} & {
  readonly [K in keyof BudgetAutomationConfigInput]:
  PreparationField<NonNullable<BudgetAutomationConfigInput[K]>>;
};

/** The seven keys the preparation contract owns, in form order. */
export const BUDGET_PREPARATION_FIELDS = [
  "dryRunOnly",
  "budgetMinHoursBetweenChanges",
  "budgetMaxChangesPer7d",
  "budgetMaxAccountConcentrationPct",
  "maxBudgetIncreasePct",
  "perActionSpendCeilingMinor",
  "perActionSpendCeilingCurrency",
] as const;

export function everyFieldAt(state: PreparationFieldState) {
  return Object.fromEntries(
    BUDGET_PREPARATION_FIELDS.map((key) => [key, { state, value: null }]),
  ) as Omit<BudgetPreparationView, "contract" | "rowRead" | "rowExists">;
}

/**
 * Project one stored guardrail document into the field states above.
 *
 * Pure, and exported so the projection can be tested without a database. A
 * value of the WRONG TYPE is reported as `unset` rather than shown: a stored
 * `"12"` is not a number the runtime would honour, and rendering it as
 * persisted would tell an admin their cooldown is configured when the
 * validator will reject it.
 */
export function projectStoredGuardrails(
  stored: unknown,
): Omit<BudgetPreparationView, "contract" | "rowRead" | "rowExists"> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return everyFieldAt("unset");
  }
  const document = stored as Record<string, unknown>;
  const numeric = (key: string) => {
    const value = document[key];
    return typeof value === "number" && Number.isFinite(value)
      ? ({ state: "persisted", value } as const)
      : ({ state: "unset", value: null } as const);
  };
  return {
    dryRunOnly:
      typeof document.dryRunOnly === "boolean"
        ? { state: "persisted", value: document.dryRunOnly }
        : { state: "unset", value: null },
    budgetMinHoursBetweenChanges: numeric("budgetMinHoursBetweenChanges"),
    budgetMaxChangesPer7d: numeric("budgetMaxChangesPer7d"),
    budgetMaxAccountConcentrationPct: numeric("budgetMaxAccountConcentrationPct"),
    maxBudgetIncreasePct: numeric("maxBudgetIncreasePct"),
    perActionSpendCeilingMinor: numeric("perActionSpendCeilingMinor"),
    perActionSpendCeilingCurrency:
      typeof document.perActionSpendCeilingCurrency === "string"
        && /^[A-Z]{3}$/.test(document.perActionSpendCeilingCurrency)
        ? { state: "persisted", value: document.perActionSpendCeilingCurrency }
        : { state: "unset", value: null },
  };
}

/** Every field that is not persisted, for the form's prerequisite check. */
export function unpreparedFields(view: BudgetPreparationView): string[] {
  return BUDGET_PREPARATION_FIELDS.filter((key) => {
    const field = view[key] as PreparationField<unknown>;
    /*
      The spend ceiling is legitimately clearable — `perActionSpendCeilingMinor:
      null` with a null currency is a valid saved configuration — so an unset
      ceiling is not a missing prerequisite. Every other key must carry a value
      before activation readiness can be satisfied.
    */
    if (key === "perActionSpendCeilingMinor" || key === "perActionSpendCeilingCurrency") {
      return false;
    }
    return field.state !== "persisted";
  });
}
