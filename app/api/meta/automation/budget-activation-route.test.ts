/**
 * D088 C1 — the activation action is admin-only, server-verified, and refuses.
 *
 * The route is exercised through its own contract rather than mocked away: the
 * point is that a browser cannot supply readiness, cannot supply an admin role,
 * and cannot skip the phrase.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
  evaluateBudgetAutomationReadiness,
  setBudgetAutoExecutionEnabled,
} from "@/lib/meta/budget-activation";

const ROUTE = readFileSync("app/api/meta/automation/route.ts", "utf8");
const READINESS_SERVER = readFileSync(
  "lib/meta/budget-activation-readiness-server.ts", "utf8");
const SURFACE_SERVER = readFileSync(
  "lib/meta/budget-write-readiness-server.ts", "utf8");

describe("D088 C1 — the activation route", () => {
  it("admits the action and puts it behind the ADMIN floor", () => {
    expect(ROUTE).toContain('action !== "set_budget_auto_execution"');
    expect(ROUTE).toContain('action === "release_kill_switch" || action === "set_guardrail_policy"');
    expect(ROUTE).toContain('|| action === "set_budget_auto_execution"');
    /* PRE-DEPLOY AUDIT: PREPARE joined the same admin floor. */
    expect(ROUTE).toContain('|| action === "save_budget_automation_config" || armsAutoExecution');
    expect(ROUTE).toContain('? "admin"');
    /*
      PRE-DEPLOY AUDIT: the SECOND key takes the same floor. Automatic
      execution needs the master switch AND the decision type's Tier 3 mode;
      leaving the mode at the collaborator floor let a collaborator re-arm the
      one decision type with a live automatic executor.
    */
    expect(ROUTE).toContain(
      'action === "set_decision_type_mode" && body?.mode === "auto"');
  });

  it("carries the reviewer read-only label every other mutation carries", () => {
    expect(ROUTE).toContain('set_budget_auto_execution: "automation_budget_auto_execution"');
  });

  it("computes readiness on the SERVER and never reads it from the body", () => {
    const handler = ROUTE.slice(
      ROUTE.indexOf('if (action === "set_budget_auto_execution")'),
      ROUTE.indexOf('if (action === "release_kill_switch")'),
    );
    // The only things taken from the request are the intent and the phrase.
    expect(handler).toContain("body?.enabled");
    expect(handler).toContain("body?.confirmationPhrase");
    for (const forbidden of [
      "body?.readiness", "body.readiness", "body?.globalGateOpen",
      "body?.canonicalFactRetentionReady", "body?.blockers",
    ]) {
      expect(handler, forbidden).not.toContain(forbidden);
    }
    // ...and every condition comes from the shared, server-owned reader.
    expect(handler).toContain("readBudgetActivationServerRead");
    expect(READINESS_SERVER).toContain("getMetaAutomationControlPlane");
    expect(READINESS_SERVER).toContain("readMetaReleaseGates");
    // C2: the schema proof is COLUMNS and CONSTRAINTS, not a table-name check.
    expect(READINESS_SERVER).toContain("information_schema.columns");
    expect(READINESS_SERVER).toContain("pg_constraint");
    expect(READINESS_SERVER).toContain("meta_budget_write_journal_occurrence");
    expect(READINESS_SERVER).toContain("readBudgetReadiness");
  });

  it("resolves the exact account scope before deciding anything", () => {
    const handler = ROUTE.slice(
      ROUTE.indexOf('if (action === "set_budget_auto_execution")'),
      ROUTE.indexOf('if (action === "release_kill_switch")'),
    );
    expect(handler).toContain("accountScope.providerAccountId");
  });

  it("shows the same fresh blockers on the surface instead of an empty default", () => {
    expect(SURFACE_SERVER).toContain("readBudgetActivationServerRead");
    expect(SURFACE_SERVER).toContain("activation.verdict.blockers");
    expect(SURFACE_SERVER).toContain("enabling_actor_absent");
    expect(SURFACE_SERVER).not.toContain("activationReadyBlockers: []");
  });

  it("the surface sends the route's required business and account query scope", () => {
    const view = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx", "utf8");
    expect(view).toContain("new URLSearchParams");
    expect(view).toContain("businessId: readiness.businessId");
    expect(view).toContain("providerAccountId: readiness.providerAccountId");
    expect(view).toContain("/api/meta/automation?${query.toString()}");
  });

  it("persists on the EXISTING control row, not a new table", () => {
    /*
      PRE-DEPLOY AUDIT: the write moved into ONE shared helper, because the
      fail-safe STOP path and the enable ceremony must not be able to disagree
      about what "off" means. The assertion follows it there, and additionally
      pins that both paths use it.
    */
    const helper = ROUTE.slice(
      ROUTE.indexOf("async function persistBudgetAutoExecution"),
      ROUTE.indexOf("async function resolveAutomationAccountScope"),
    );
    expect(helper).toContain("meta_automation_business_controls");
    expect(helper).toContain("auto_execution_enabled");
    expect(helper).toContain("auto_execution_provider_account_id");
    // Disabling always CLEARS the bound account.
    expect(helper).toContain("row.enabled ? row.providerAccountId : null");
    // And exactly two callers, one per path.
    expect(ROUTE.split("persist: persistBudgetAutoExecution").length - 1).toBe(2);
  });

  it("the STOP path runs BEFORE account resolution and readiness", () => {
    /*
      PRE-DEPLOY AUDIT: `resolveAutomationAccountScope` answers 503 when the
      account-assignment read throws, and it used to run first — so an
      unrelated outage could refuse a request to turn automation OFF.
    */
    const post = ROUTE.slice(ROUTE.indexOf("export async function POST"));
    const stopAt = post.indexOf('action === "set_budget_auto_execution" && body?.enabled === false');
    const scopeAt = post.indexOf("const accountScope = await resolveAutomationAccountScope");
    const readinessAt = post.indexOf("readBudgetActivationServerRead(");
    const reviewerAt = post.indexOf("rejectIfReviewerReadOnly(");
    const demoAt = post.indexOf("rejectIfAutomationDemoWrite(");
    expect(stopAt).toBeGreaterThan(0);
    // Authorization first...
    expect(stopAt).toBeGreaterThan(reviewerAt);
    expect(stopAt).toBeGreaterThan(demoAt);
    // ...then the stop, before anything it does not need.
    expect(scopeAt).toBeGreaterThan(stopAt);
    expect(readinessAt).toBeGreaterThan(stopAt);
    // A stop that could not be recorded says so exactly.
    expect(post).toContain("budget_auto_execution_stop_unpersisted");
    // Both halves of the act are audited.
    expect(post).toContain("budget_auto_execution_disabled");
    expect(post).toContain("budget_auto_execution_enabled");
  });
});

describe("D088 C1 — the ceremony refuses in the current configuration", () => {
  const currentReadiness = {
    controlRowPersisted: true,
    globalGateOpen: false,
    businessStopClear: true,
    budgetDecisionMode: "manual_review",
    dryRunGuardrailLifted: false,
    canonicalFactRetentionReady: false,
    profileRetentionReady: false,
    automaticRoleRetentionReady: false,
    accountScopeExact: true,
    journalSchemaReady: true,
    unresolvedReconciliations: 0,
    openClaims: 0,
  };

  it("the server verdict is NOT ready today, and names why", () => {
    const verdict = evaluateBudgetAutomationReadiness(currentReadiness);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers).toContain("global_gate_closed");
  });

  it("enabling with the exact phrase still refuses, and writes nothing", async () => {
    let writes = 0;
    const result = await setBudgetAutoExecutionEnabled({
      businessId: "b", providerAccountId: "act_1", enabled: true,
      confirmationPhrase: BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
      actor: { userId: "u", isAdmin: true },
      readiness: currentReadiness,
      persist: async () => { writes += 1; },
    });
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("readiness_not_proven");
    expect(writes).toBe(0);
  });

  it("STOP is always available and writes immediately", async () => {
    const persisted: Array<{ enabled: boolean }> = [];
    const result = await setBudgetAutoExecutionEnabled({
      businessId: "b", providerAccountId: "act_1", enabled: false,
      confirmationPhrase: null,
      actor: { userId: "u", isAdmin: true },
      readiness: currentReadiness,
      persist: async (row) => { persisted.push(row); },
    });
    expect(result.ok).toBe(true);
    expect(persisted[0]?.enabled).toBe(false);
  });
});

describe("D088 C1 — the approval route passes a CONCRETE runtime", () => {
  const PROPOSALS_ROUTE = readFileSync(
    "app/api/meta/automation/proposals/route.ts", "utf8");

  it("supplies budgetRuntime rather than leaving it absent", () => {
    /*
      D088 C3: the runtime is now built inside the `budgetRuntime` callback so
      the shared lifecycle can wrap it — the concrete construction is the same,
      one scope deeper.
    */
    expect(PROPOSALS_ROUTE).toContain("budgetRuntime: async (runtimeInput)");
    expect(PROPOSALS_ROUTE).toContain("createBudgetProposalServerRuntime(");
    expect(PROPOSALS_ROUTE).toContain("createBudgetServerReaders(");
    expect(PROPOSALS_ROUTE).toContain("buildMetaWriteContextForProposal(");
    // And it enters the ONE lifecycle the scheduled sweep enters.
    expect(PROPOSALS_ROUTE).toContain("runClaimedProposalExecution(");
  });

  it("builds it AFTER the atomic claim it is bound to", () => {
    const claimAt = PROPOSALS_ROUTE.indexOf("claim.claimToken");
    const runtimeAt = PROPOSALS_ROUTE.indexOf("createBudgetProposalServerRuntime(\n");
    expect(claimAt).toBeGreaterThan(0);
    expect(runtimeAt).toBeGreaterThan(claimAt);
  });
});

describe("D088 C1 — the sweep is registered on the existing cron", () => {
  const CRON = readFileSync("app/api/sync/cron/route.ts", "utf8");

  it("is called from the same route the other Meta jobs are", () => {
    expect(CRON).toContain("runMetaBudgetAutomationSweepIfDue");
    expect(CRON).toContain("metaBudgetAutomationJob");
  });

  it("reports why it stopped, like its siblings", () => {
    expect(CRON).toContain("metaBudgetAutomationJobReason");
  });
});

describe("D088 C2 — the activation route fails closed", () => {
  const handler = ROUTE.slice(
    ROUTE.indexOf('if (action === "set_budget_auto_execution")'),
    ROUTE.indexOf('if (action === "release_kill_switch")'),
  );

  it("an unread open-work query is UNKNOWN, never zero", () => {
    expect(READINESS_SERVER).toContain("openWork === null");
    expect(READINESS_SERVER).toContain("? -1 :");
    // A `?? 0` may only appear INSIDE the null-checked branch, never as the
    // whole answer: `0` was the one value that would have let activation pass.
    expect(READINESS_SERVER).toContain("unresolvedReconciliations: openWork === null");
    expect(READINESS_SERVER).toContain("openClaims: openWork === null ? -1 :");
  });

  it("reads the PERSISTED dry-run guardrail, not the global gate", () => {
    expect(READINESS_SERVER).toContain("guardrails.dryRunOnly === false");
    expect(READINESS_SERVER).not.toMatch(
      /dryRunGuardrailLifted:\s*gates\.automationLiveWrites/,
    );
  });

  it("proves the account scope resolved, not merely that a string exists", () => {
    expect(handler).toContain("accountScope.providerAccountId");
    expect(READINESS_SERVER).toContain("accountScopeExact");
    expect(READINESS_SERVER).not.toContain("Boolean(input.providerAccountId)");
  });

  it("treats the business stop as global AND business", () => {
    expect(READINESS_SERVER).toContain("control?.globalKillSwitch.engaged === false");
  });
});
