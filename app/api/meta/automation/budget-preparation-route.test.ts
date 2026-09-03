/**
 * PRE-DEPLOY AUDIT — the preparation ACTION, now that a surface calls it.
 *
 * `save_budget_automation_config` was unreachable from the product, so the
 * only thing that had ever exercised it was a unit test on its SQL. With the
 * admin form mounted, a browser can reach it — which makes the questions below
 * live ones rather than theoretical:
 *
 *   - can a non-admin call it? (no: the admin floor)
 *   - can a caller enable automation through it? (no: FALSE is pinned in the
 *     statement, and the response restates it)
 *   - can it clear an engaged STOP, a kill-switch reason, or a readiness tier?
 *     (no: the statement never names them)
 *   - can a value the FORM accepted be rejected by the route, or the reverse?
 *     (no: both run the same parser, from a module with no database in it)
 *
 * Driven through the route's own contract rather than a mocked handler,
 * because the properties above are properties of the shipped source.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseBudgetAutomationConfig }
  from "@/lib/meta/budget-automation-config-contract";

/**
 * Prose is not code. Several assertions below are "this identifier does not
 * appear", and every one of these files DISCUSSES the identifiers it must not
 * use — the configuration writer's own header explains that it never names the
 * kill switch. Matching the raw text would have made those comments fail their
 * own guarantee, so comments are stripped before any absence is asserted.
 */
const codeOf = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const ROUTE = readFileSync("app/api/meta/automation/route.ts", "utf8");
const VIEW = readFileSync(
  "app/(dashboard)/platforms/meta/automation/automation-view.tsx", "utf8");

const VALID = {
  dryRunOnly: false,
  budgetMinHoursBetweenChanges: 12,
  budgetMaxChangesPer7d: 3,
  budgetMaxAccountConcentrationPct: 40,
  maxBudgetIncreasePct: 25,
  perActionSpendCeilingMinor: 500000,
  perActionSpendCeilingCurrency: "TRY",
};

describe("preparation route — authorization", () => {
  it("sits behind the ADMIN floor, beside the actions that arm execution", () => {
    expect(ROUTE).toContain('|| action === "save_budget_automation_config" || armsAutoExecution');
    expect(ROUTE).toContain('? "admin"');
  });

  it("is in the route's action allowlist, so it is not reachable by accident", () => {
    expect(ROUTE).toContain('action !== "save_budget_automation_config" &&');
    expect(ROUTE).toContain("save_budget_automation_config, set_guardrail_policy");
  });

  it("records an activity-ledger row naming an operator actor", () => {
    const handler = ROUTE.slice(ROUTE.indexOf('if (action === "save_budget_automation_config")'));
    expect(handler).toContain('activityType: "budget_automation_configuration_saved"');
    expect(handler).toContain('actorKind: "operator"');
    expect(handler).toContain("userId: access.session.user.id");
  });
});

describe("preparation route — it cannot enable, and cannot clear a safety state", () => {
  /*
    Sliced FORWARD from the handler. `const accountScope` also appears in the
    GET handler earlier in the file, so a bare `indexOf` for the end anchor
    returns a position BEFORE the start and yields an empty string — which
    silently satisfies every `not.toContain` and fails every `toContain`.
  */
  const handlerStart = ROUTE.indexOf('if (action === "save_budget_automation_config")');
  const handler = ROUTE.slice(
    handlerStart,
    ROUTE.indexOf("const accountScope = await resolveAutomationAccountScope", handlerStart),
  );

  it("slices a real handler, so the assertions below are not vacuous", () => {
    expect(handlerStart).toBeGreaterThan(0);
    expect(handler.length).toBeGreaterThan(400);
  });

  it("restates OFF in the response, so a success cannot be read as an enable", () => {
    expect(handler).toContain("autoExecutionEnabled: false");
    expect(handler).toContain("activatedProviderAccountCleared: true");
  });

  it("takes the business from the SESSION, never from the request body", () => {
    // A body-supplied businessId would let an admin of one business prepare
    // another. The membership decides.
    expect(handler).toContain("businessId: access.membership.businessId");
    expect(handler).not.toMatch(/businessId:\s*body\./);
  });

  it("never names the kill switch, its reason, or the readiness tier", () => {
    const writer = codeOf(readFileSync("lib/meta/budget-automation-configuration.ts", "utf8"));
    for (const forbidden of ["kill_switch_engaged", "kill_switch_reason", "readiness_tier"]) {
      expect(writer, forbidden).not.toContain(forbidden);
    }
  });

  it("pins the master switch FALSE and clears the account on BOTH upsert paths", () => {
    const writer = readFileSync("lib/meta/budget-automation-configuration.ts", "utf8");
    expect(writer).toMatch(/VALUES\s*\(\s*\$1::uuid,\s*FALSE,\s*NULL,/);
    expect(writer).toContain("auto_execution_enabled = FALSE");
    expect(writer).toContain("auto_execution_provider_account_id = NULL");
    // Never from the caller.
    expect(writer).not.toContain("EXCLUDED.auto_execution_enabled");
    expect(writer).not.toContain("EXCLUDED.auto_execution_provider_account_id");
  });
});

describe("preparation route — one parser, both sides", () => {
  it("the route and the form import the SAME parser", () => {
    expect(ROUTE).toContain("parseBudgetAutomationConfig");
    expect(VIEW).toContain("parseBudgetAutomationConfig(candidate)");
    expect(VIEW).toContain('from "@/lib/meta/budget-automation-config-contract"');
  });

  it("the form's module has no database in it, so the bundle stays clean", () => {
    const contract = codeOf(
      readFileSync("lib/meta/budget-automation-config-contract.ts", "utf8"));
    expect(contract).not.toContain("@/lib/db");
    expect(contract).not.toMatch(/^import /m);
    const view = codeOf(readFileSync("lib/meta/budget-preparation-contract.ts", "utf8"));
    expect(view).not.toContain("@/lib/db");
    // It may import a TYPE from the config contract, which carries no runtime.
    expect(view).toMatch(/^import type /m);
  });

  it("rejects by NAME, and the form shows the same code", () => {
    /*
      The agreement that matters: whatever the form refuses, the route refuses
      with the same rejection string. Asserted on the parser both call.
    */
    for (const [body, rejection] of [
      [{ ...VALID, dryRunOnly: undefined }, "dry_run_only_not_boolean"],
      [{ ...VALID, budgetMinHoursBetweenChanges: null }, "min_hours_between_changes_invalid"],
      [{ ...VALID, budgetMaxChangesPer7d: 2.5 }, "max_changes_per_7d_invalid"],
      [{ ...VALID, budgetMaxAccountConcentrationPct: 101 }, "max_account_concentration_pct_invalid"],
      [{ ...VALID, maxBudgetIncreasePct: 0 }, "max_budget_increase_pct_invalid"],
      [{ ...VALID, perActionSpendCeilingMinor: 1.5 }, "per_action_spend_ceiling_invalid"],
      [{ ...VALID, perActionSpendCeilingCurrency: "try" }, "per_action_spend_ceiling_currency_invalid"],
    ] as const) {
      const parsed = parseBudgetAutomationConfig(body);
      expect(parsed.ok, JSON.stringify(body)).toBe(false);
      if (!parsed.ok) expect(parsed.rejection).toBe(rejection);
    }
    expect(VIEW).toContain('data-rejection={parsed.rejection}');
  });

  it("accepts a complete configuration, and a deliberately cleared ceiling", () => {
    expect(parseBudgetAutomationConfig(VALID).ok).toBe(true);
    expect(parseBudgetAutomationConfig({
      ...VALID, perActionSpendCeilingMinor: null, perActionSpendCeilingCurrency: null,
    }).ok).toBe(true);
  });

  it("returns 400 with the parser's own rejection rather than a generic error", () => {
    const handler = ROUTE.slice(ROUTE.indexOf('if (action === "save_budget_automation_config")'));
    expect(handler).toContain("return jsonError(400, parsed.rejection, parsed.message)");
  });
});

describe("preparation form — it refetches readiness after a save", () => {
  it("calls back into the page rather than assuming the new state", () => {
    const form = VIEW.slice(VIEW.indexOf("function BudgetPreparationForm"));
    expect(form).toContain("onSaved?.()");
    // And the section wires that callback to the page's re-read.
    expect(VIEW).toContain("onSaved={onActivationChanged}");
  });

  it("sends no confirmation phrase — preparing is not the enable ceremony", () => {
    const form = VIEW.slice(VIEW.indexOf("function BudgetPreparationForm"));
    expect(form).not.toContain("confirmationPhrase");
    expect(form).toContain('action: "save_budget_automation_config"');
    expect(form).not.toContain('action: "set_budget_auto_execution"');
  });

  it("still requires the phrase on the enable path beside it", () => {
    const ceremony = VIEW.slice(VIEW.indexOf("const submitActivation"));
    expect(ceremony).toContain("confirmationPhrase: enabled ? activationPhrase : null");
  });
});
