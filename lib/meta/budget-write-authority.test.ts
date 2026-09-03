/**
 * D087 — one authority chain, and no label system.
 *
 * These are the guards that keep the new capability inside the accepted chain:
 * it may not resurrect the manual Test/Main/Mixed label authority, may not read
 * a campaign name, and may not introduce a second decision or dispatch core.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const D087_SOURCES = [
  "lib/meta/budget-write-capability.ts",
  "lib/meta/budget-write-request.ts",
  "lib/meta/budget-write-preflight.ts",
  "lib/meta/budget-write-execution.ts",
  "lib/meta/budget-write-readiness.ts",
  "scripts/audits/d087-budget-write-simulation.ts",
  // D088 sources join the same guard: one authority chain, no label system.
  "lib/meta/budget-execution-composition.ts",
  "lib/meta/budget-proposal-runtime.ts",
  "lib/meta/budget-activation.ts",
  "lib/meta/budget-automation-worker.ts",
  "scripts/audits/d088-budget-counterfactual-replay.ts",
  "lib/meta/budget-proposal-server-runtime.ts",
  "lib/meta/budget-proposal-server-readers.ts",
  "lib/meta/budget-proposal-source-loader.ts",
  "lib/meta/budget-execution-lifecycle.ts",
] as const;

/** Prose is not linkage: a comment naming a thing is not a use of it. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

describe("D087 — no manual label authority anywhere in the new capability", () => {
  it.each(D087_SOURCES)("%s uses no label vocabulary", (file) => {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const forbidden of [
      "campaignLabelStatus", "campaign_label_status", "labelStatus",
      "manualLabel", "campaignName", "campaign_name", "brief_variation",
    ]) {
      expect(code, `${file}:${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the owner comes from the retained mode, never from a name or a role guess", () => {
    const code = stripComments(readFileSync("lib/meta/budget-write-request.ts", "utf8"));
    // The only admitted owner modes are the two PROVEN ones.
    expect(code).toContain("campaign_budget_optimization");
    expect(code).toContain("adset_budget");
    // ...and the unproven ones are absent from the admitted set by construction.
    expect(code).not.toMatch(/PROVEN_OWNER_MODES[^;]*"mixed"/);
    expect(code).not.toMatch(/PROVEN_OWNER_MODES[^;]*"unknown"/);
  });
});

describe("D087 — one decision core, one dispatch architecture", () => {
  it("declares no second decision core and no renamed route", () => {
    for (const file of D087_SOURCES) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code, file).not.toMatch(/creative-decision-os-v3|decision-core-v2/);
      expect(code, file).not.toMatch(/app\/api\/meta\/budget/);
    }
  });

  it("reuses the existing write adapter rather than adding a transport", () => {
    const code = readFileSync("lib/meta/budget-write-execution.ts", "utf8");
    expect(code).toContain('from "@/lib/meta/ads-write"');
    // The orchestrator itself never speaks HTTP.
    expect(stripComments(code)).not.toContain("fetch(");
  });

  it("the capability lives beside the dispatch contract it extends", () => {
    const code = readFileSync("lib/meta/budget-write-capability.ts", "utf8");
    expect(code).toContain("budget-intent-contract");
    expect(code).toContain("budget-proposal-dry-run");
  });
});

describe("D087 — nothing in this slice can enable a write", () => {
  it("D088: the sweep and the ceremony cannot enable themselves", async () => {
    const { runBudgetAutomationSweep } = await import("@/lib/meta/budget-automation-worker");
    const { evaluateBudgetAutomationReadiness } = await import("@/lib/meta/budget-activation");
    // Default-shaped inputs: nothing runs, nothing is ready.
    const sweep = await runBudgetAutomationSweep({
      businessId: "b", providerAccountId: "a",
      releaseGateOpen: false, autoExecutionEnabled: false, dryRunOnly: true,
      listEligibleProposals: async () => { throw new Error("must not list"); },
      claim: async () => { throw new Error("must not claim"); },
      executeProposal: async () => { throw new Error("must not execute"); },
    });
    expect(sweep.ran).toBe(false);
    expect(evaluateBudgetAutomationReadiness({
      controlRowPersisted: false, globalGateOpen: false, businessStopClear: true,
      budgetDecisionMode: "manual_review", dryRunGuardrailLifted: false,
      canonicalFactRetentionReady: false, profileRetentionReady: false,
      automaticRoleRetentionReady: false, accountScopeExact: true,
      journalSchemaReady: false, unresolvedReconciliations: 0, openClaims: 0,
    }).ready).toBe(false);
  });

  it("no D087 source sets an environment value, a flag or an enablement", () => {
    for (const file of D087_SOURCES) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code, file).not.toMatch(/process\.env\.[A-Z_]+\s*=/);
      expect(code, file).not.toContain("META_AUTOMATION_ENABLED");
      expect(code, file).not.toMatch(/automationEnabled\s*=\s*true/);
    }
  });

  it("the activation answer is a function that cannot be narrowed to true", async () => {
    const { budgetWriteIsActivated } = await import("@/lib/meta/budget-write-capability");
    const answer: false = budgetWriteIsActivated();
    expect(answer).toBe(false);
  });

  it("C2: the STATIC default drives no runtime decision", () => {
    /*
      A constant `false` that gated execution would contradict a deliberate
      activation the moment one existed. Runtime authority is the fresh release
      gate, the persisted control row and the server readiness verdict — so no
      runtime module may consult the static answer.
    */
    for (const file of [
      "lib/meta/budget-proposal-server-runtime.ts",
      "lib/meta/budget-proposal-server-readers.ts",
      "lib/meta/budget-proposal-runtime.ts",
      "lib/meta/budget-automation-scheduled.ts",
      "lib/meta/budget-automation-worker.ts",
      "lib/meta/budget-execution-lifecycle.ts",
      "app/api/meta/automation/route.ts",
      "app/api/meta/automation/proposals/route.ts",
    ]) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code, file).not.toContain("budgetWriteIsActivated");
      expect(code, file).not.toContain("budgetDecisionIsExecutable");
    }
  });
});
