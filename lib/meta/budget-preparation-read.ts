/**
 * PRE-DEPLOY AUDIT — the server read behind the admin preparation form.
 *
 * The shape, the field list and the prerequisite rule live in
 * `budget-preparation-contract.ts`, which imports nothing, so the mounted form
 * can share them. This module is only the read.
 *
 * A failed read yields every field at `unknown` and `rowRead: false`. It never
 * throws into the page: the section renders "could not read", which is a state
 * an operator can act on, where a crashed surface is not. `unknown` is never
 * collapsed into `unset` — "there is no row" and "we could not tell" lead to
 * different actions, and only one of them is safe to overwrite without looking.
 */
import { getDb } from "@/lib/db";
import {
  BUDGET_PREPARATION_READ_CONTRACT,
  everyFieldAt,
  projectStoredGuardrails,
  type BudgetPreparationView,
} from "@/lib/meta/budget-preparation-contract";

export * from "@/lib/meta/budget-preparation-contract";

export async function readBudgetPreparation(input: {
  businessId: string;
}): Promise<BudgetPreparationView> {
  const unreadable: BudgetPreparationView = {
    contract: BUDGET_PREPARATION_READ_CONTRACT,
    rowRead: false,
    rowExists: false,
    ...everyFieldAt("unknown"),
  };
  if (!input.businessId) return unreadable;

  const rows = (await getDb()
    .query(
      `SELECT guardrails_json
         FROM meta_automation_business_controls
        WHERE business_id = $1::uuid`,
      [input.businessId],
    )
    .catch(() => null)) as Array<{ guardrails_json: unknown }> | null;

  if (rows === null) return unreadable;
  if (rows.length === 0) {
    // The row genuinely does not exist. Every key is UNSET, which is a
    // different statement from `unknown` and licenses a first save.
    return {
      contract: BUDGET_PREPARATION_READ_CONTRACT,
      rowRead: true,
      rowExists: false,
      ...everyFieldAt("unset"),
    };
  }
  return {
    contract: BUDGET_PREPARATION_READ_CONTRACT,
    rowRead: true,
    rowExists: true,
    ...projectStoredGuardrails(rows[0]!.guardrails_json),
  };
}
