/**
 * PRE-DEPLOY AUDIT — preparing the system without enabling it.
 *
 * Two things have to be true at once and they pull in opposite directions: an
 * operator must be able to write the guardrails activation readiness demands,
 * and no path through that write may leave automation on or clear a safety
 * state. These cases hold both ends.
 */
import { BUDGET_SIZING_POLICY_VERSION } from "@/lib/meta/budget-sizing-policy";
import { BID_SIZING_POLICY_VERSION } from "@/lib/meta/bid-sizing-policy";
import { describe, expect, it, vi } from "vitest";

const statements: Array<{ sql: string; params: unknown[] }> = [];
const query = vi.fn(async (sql: string, params: unknown[] = []) => {
  statements.push({ sql: String(sql), params });
  return [{ guardrails_json: { dryRunOnly: false, kept: "value" } }];
});

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: (sql: string, params?: unknown[]) => query(sql, params) }),
}));

const {
  parseBudgetAutomationConfig,
  saveBudgetAutomationConfiguration,
} = await import("@/lib/meta/budget-automation-configuration");

const VALID = {
  dryRunOnly: false,
  budgetMinHoursBetweenChanges: 12,
  budgetMaxChangesPer7d: 3,
  budgetMaxAccountConcentrationPct: 40,
  maxBudgetIncreasePct: 25,
  perActionSpendCeilingMinor: 500000,
  perActionSpendCeilingCurrency: "TRY",
};

describe("budget automation configuration — every value is explicit", () => {
  it("accepts a complete, valid configuration", () => {
    const parsed = parseBudgetAutomationConfig(VALID);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config).toEqual(VALID);
  });

  it.each([
    ["dryRunOnly missing", { ...VALID, dryRunOnly: undefined }, "dry_run_only_not_boolean"],
    ["dryRunOnly as a string", { ...VALID, dryRunOnly: "false" }, "dry_run_only_not_boolean"],
    ["zero cooldown", { ...VALID, budgetMinHoursBetweenChanges: 0 }, "min_hours_between_changes_invalid"],
    ["negative cooldown", { ...VALID, budgetMinHoursBetweenChanges: -1 }, "min_hours_between_changes_invalid"],
    ["a string cooldown", { ...VALID, budgetMinHoursBetweenChanges: "12" }, "min_hours_between_changes_invalid"],
    ["fractional change cap", { ...VALID, budgetMaxChangesPer7d: 2.5 }, "max_changes_per_7d_invalid"],
    ["zero change cap", { ...VALID, budgetMaxChangesPer7d: 0 }, "max_changes_per_7d_invalid"],
    ["concentration over 100", { ...VALID, budgetMaxAccountConcentrationPct: 101 }, "max_account_concentration_pct_invalid"],
    ["zero concentration", { ...VALID, budgetMaxAccountConcentrationPct: 0 }, "max_account_concentration_pct_invalid"],
    ["zero increase ceiling", { ...VALID, maxBudgetIncreasePct: 0 }, "max_budget_increase_pct_invalid"],
    ["fractional spend ceiling", { ...VALID, perActionSpendCeilingMinor: 1.5 }, "per_action_spend_ceiling_invalid"],
    ["a ceiling with no currency", { ...VALID, perActionSpendCeilingCurrency: null }, "per_action_spend_ceiling_currency_invalid"],
    ["a malformed currency", { ...VALID, perActionSpendCeilingCurrency: "try" }, "per_action_spend_ceiling_currency_invalid"],
  ])("refuses %s by name", (_label, body, rejection) => {
    const parsed = parseBudgetAutomationConfig(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.rejection).toBe(rejection);
  });

  it("permits clearing the spend ceiling, currency and all", () => {
    const parsed = parseBudgetAutomationConfig({
      ...VALID, perActionSpendCeilingMinor: null, perActionSpendCeilingCurrency: null,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.perActionSpendCeilingMinor).toBeNull();
      expect(parsed.config.perActionSpendCeilingCurrency).toBeNull();
    }
  });

  it("refuses a non-object body without throwing", () => {
    for (const body of [null, undefined, 7, "config", []]) {
      expect(parseBudgetAutomationConfig(body).ok, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("budget automation configuration — the write can never enable", () => {
  it("pins auto_execution_enabled FALSE and clears the account on BOTH paths", async () => {
    statements.length = 0;
    await saveBudgetAutomationConfiguration({
      businessId: "b1", actorUserId: "u1", config: VALID,
    });
    const sql = statements[0]!.sql;

    // The INSERT branch.
    expect(sql).toContain("INSERT INTO meta_automation_business_controls");
    expect(sql).toMatch(/VALUES\s*\(\s*\$1::uuid,\s*FALSE,\s*NULL,/);
    // The UPDATE branch.
    expect(sql).toContain("auto_execution_enabled = FALSE");
    expect(sql).toContain("auto_execution_provider_account_id = NULL");
    expect(sql).toContain("auto_execution_enabled_by = NULL");
    // Neither branch may take the value from the caller.
    expect(sql).not.toContain("EXCLUDED.auto_execution_enabled");
    expect(sql).not.toContain("EXCLUDED.auto_execution_provider_account_id");
  });

  it("clears NO safety state: the STOP and the tier are never named", async () => {
    statements.length = 0;
    await saveBudgetAutomationConfiguration({
      businessId: "b1", actorUserId: "u1", config: VALID,
    });
    const sql = statements[0]!.sql;
    expect(sql).not.toContain("kill_switch_engaged");
    expect(sql).not.toContain("kill_switch_reason");
    expect(sql).not.toContain("readiness_tier");
  });

  it("MERGES into the stored guardrails rather than replacing them", async () => {
    statements.length = 0;
    await saveBudgetAutomationConfiguration({
      businessId: "b1", actorUserId: "u1", config: VALID,
    });
    const sql = statements[0]!.sql;
    // `||` is jsonb concatenation: keys this contract does not own survive.
    expect(sql).toContain("|| $2::jsonb");
    expect(sql).toContain("COALESCE(meta_automation_business_controls.guardrails_json, '{}'::jsonb)");

    const patch = JSON.parse(String(statements[0]!.params[1])) as Record<string, unknown>;
    expect(patch).toEqual({
      dryRunOnly: false,
      budgetMinHoursBetweenChanges: 12,
      budgetMaxChangesPer7d: 3,
      budgetMaxAccountConcentrationPct: 40,
      maxBudgetIncreasePct: 25,
      perActionSpendCeilingMinor: 500000,
      perActionSpendCeilingCurrency: "TRY",
      /*
        Which sizing policies this saved configuration is bound to.

        The bands and the ladder are an operating policy, so a build that
        changes them must not start proposing different amounts against a
        configuration nobody re-approved. Saving this form is what binds the
        current versions; the producers refuse against any other.
      */
      budgetSizingPolicyVersion: BUDGET_SIZING_POLICY_VERSION,
      bidSizingPolicyVersion: BID_SIZING_POLICY_VERSION,
    });
    // The patch itself must never carry the enablement.
    expect(Object.keys(patch)).not.toContain("autoExecutionEnabled");
  });

  it("creates the row for a business that has none", async () => {
    statements.length = 0;
    await saveBudgetAutomationConfiguration({
      businessId: "never-configured", actorUserId: "u1", config: VALID,
    });
    // One statement, an upsert — no read-modify-write race.
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain("ON CONFLICT (business_id) DO UPDATE");
    expect(statements[0]!.params[0]).toBe("never-configured");
  });
});
