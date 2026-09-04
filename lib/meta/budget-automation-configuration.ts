/**
 * PRE-DEPLOY AUDIT — the SAFE preparation path.
 *
 * Activation readiness demands a persisted control row whose `dryRunOnly` is
 * false and whose three budget policy keys carry real numbers. Nothing in the
 * product could write any of them: `setMetaAutomationGuardrailPolicy` writes
 * the ROAS floor and quiet-hours COLUMNS and deliberately leaves
 * `guardrails_json` alone, and five of the six target businesses have no
 * control row at all. So the system could not be PREPARED without a hand-run
 * SQL statement — and a hand-run statement is exactly what an activation
 * ceremony exists to replace.
 *
 * Two properties make this safe to add while automation stays off:
 *
 *  1. **It can never enable.** Every write pins `auto_execution_enabled` to
 *     FALSE and clears `auto_execution_provider_account_id`. Preparing and
 *     enabling are different actions with different verbs, and only the second
 *     takes a typed phrase and a fresh readiness verdict.
 *  2. **It clears no safety state.** `kill_switch_engaged`, its reason and the
 *     readiness tier are never named by the statement, so an engaged STOP
 *     survives a save. Guardrail keys the caller did not send are merged
 *     forward from the stored document rather than replaced by defaults.
 *
 * Every value is explicit. There is no "sensible default" here: a number
 * nobody chose is the thing D088 C3 spent a correction removing.
 */
import { getDb } from "@/lib/db";
/*
  PRE-DEPLOY AUDIT: the contract and its parser moved to a db-free module so
  the mounted preparation form can share them. Re-exported here so every
  existing importer of this path keeps working unchanged.
*/
export {
  BUDGET_AUTOMATION_CONFIG_CONTRACT,
  parseBudgetAutomationConfig,
  type BudgetAutomationConfigInput,
  type BudgetAutomationConfigRejection,
  type BudgetAutomationConfigParse,
} from "@/lib/meta/budget-automation-config-contract";
import type { BudgetAutomationConfigInput }
  from "@/lib/meta/budget-automation-config-contract";

/**
 * Persist the configuration, with automation pinned OFF.
 *
 * The statement:
 *  - creates the row when it does not exist (five of six target businesses);
 *  - MERGES the budget keys into the stored guardrail document, so keys this
 *    contract does not own survive;
 *  - writes `auto_execution_enabled = FALSE` and
 *    `auto_execution_provider_account_id = NULL` on EVERY path, insert and
 *    update alike;
 *  - names neither `kill_switch_engaged` nor `readiness_tier`, so an engaged
 *    STOP and a chosen tier survive untouched.
 */
export async function saveBudgetAutomationConfiguration(input: {
  businessId: string;
  actorUserId: string;
  config: BudgetAutomationConfigInput;
}): Promise<{ ok: true; storedGuardrails: Record<string, unknown> }> {
  const patch = {
    dryRunOnly: input.config.dryRunOnly,
    budgetMinHoursBetweenChanges: input.config.budgetMinHoursBetweenChanges,
    budgetMaxChangesPer7d: input.config.budgetMaxChangesPer7d,
    budgetMaxAccountConcentrationPct: input.config.budgetMaxAccountConcentrationPct,
    maxBudgetIncreasePct: input.config.maxBudgetIncreasePct,
    perActionSpendCeilingMinor: input.config.perActionSpendCeilingMinor,
    perActionSpendCeilingCurrency: input.config.perActionSpendCeilingCurrency,
  };

  const rows = (await getDb().query(
    `INSERT INTO meta_automation_business_controls
       (business_id, auto_execution_enabled,
        auto_execution_provider_account_id, auto_execution_enabled_by,
        guardrails_json,
        updated_at, updated_by)
     VALUES (
       $1::uuid,
       FALSE,
       NULL,
       NULL,
       COALESCE(
         (SELECT guardrails_json FROM meta_automation_business_controls
           WHERE business_id = $1::uuid),
         '{}'::jsonb
       ) || $2::jsonb,
       now(), $3::uuid
     )
     ON CONFLICT (business_id) DO UPDATE SET
       auto_execution_enabled = FALSE,
       auto_execution_provider_account_id = NULL,
       auto_execution_enabled_by = NULL,
       guardrails_json =
         COALESCE(meta_automation_business_controls.guardrails_json, '{}'::jsonb)
         || $2::jsonb,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by
     RETURNING guardrails_json`,
    [input.businessId, JSON.stringify(patch), input.actorUserId],
  )) as Array<{ guardrails_json: Record<string, unknown> }>;

  return { ok: true, storedGuardrails: rows[0]?.guardrails_json ?? patch };
}
