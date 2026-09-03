/**
 * D088 — the one proposal/execution path, the activation ceremony, and the
 * scheduled entry point that stays inert.
 *
 * The claim these cases defend is narrow and total: after this slice a future
 * activation is a configuration change, and until that change nothing here can
 * reach a provider. Every path — manual approval, scheduled sweep — goes through
 * the same executor, the same claim, the same journal.
 */
import { describe, expect, it } from "vitest";

import { MUTATION_ENDPOINTS, type MutationAction } from "@/lib/zero-base/meta/dispatch-contract";
import {
  BUDGET_PROPOSAL_ACTION,
  buildBudgetProposalEnvelope,
  executeBudgetProposal,
  type BudgetProposalEnvelope,
} from "@/lib/meta/budget-proposal-runtime";
import {
  BUDGET_ACTIVATION_CONDITIONS,
  BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
  evaluateBudgetAutomationReadiness,
  setBudgetAutoExecutionEnabled,
} from "@/lib/meta/budget-activation";
import { runBudgetAutomationSweep } from "@/lib/meta/budget-automation-worker";

const BIZ = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_770001";
const PROPOSAL = "11111111-1111-4111-8111-111111111111";
const CLAIM = "77777777-7777-4777-8777-777777777777";

describe("D088 — one action vocabulary, no second dispatcher", () => {
  it("declares budget as a canonical proposal action", () => {
    const action: MutationAction = BUDGET_PROPOSAL_ACTION;
    expect(action).toBe("budget");
  });

  it("keeps the OPERATOR CEREMONY table free of a budget action", () => {
    /*
      The ceremony map is what the browser posts. A budget change is never an
      operator ceremony in this product — the UI chooses no entity, field or
      magnitude — so the descriptor builder must still refuse to name a path.
    */
    for (const grain of Object.keys(MUTATION_ENDPOINTS)) {
      const actions = Object.keys(
        MUTATION_ENDPOINTS[grain as keyof typeof MUTATION_ENDPOINTS] ?? {},
      );
      expect(actions, grain).not.toContain("budget");
    }
  });

  it("builds the envelope on the SERVER and accepts nothing from a caller", () => {
    const envelope = buildBudgetProposalEnvelope({
      proposalId: PROPOSAL,
      businessId: BIZ,
      providerAccountId: ACCOUNT,
      ownerGrain: "campaign",
      entityId: "c_100",
      parentCampaignId: null,
      budgetField: "daily_budget",
      ownerMode: "campaign_budget_optimization",
      currentAmountMinor: 250000,
      intendedAmountMinor: 300000,
      currency: "TRY",
      currencyExponent: 2,
      currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
      intentVerb: "increase_budget",
      // Hostile extras a browser might attach.
      entityId_client: "c_999", amountOverride: 999_999,

      recId: "rec_1", recType: "campaign", snapshotDate: "2026-08-30",
      engineVersion: "v3", decisionHash: "e".repeat(64),
      decisionAt: "2026-08-30T00:00:00.000Z",
    } as never);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("c_999");
    expect(serialized).not.toContain("amountOverride");
    expect(envelope.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.entityId).toBe("c_100");
  });

  it("the envelope fingerprint changes with the amount and is stable otherwise", () => {
    const base = {
      proposalId: PROPOSAL, businessId: BIZ, providerAccountId: ACCOUNT,
      ownerGrain: "campaign" as const, entityId: "c_100", parentCampaignId: null,
      budgetField: "daily_budget" as const,
      ownerMode: "campaign_budget_optimization" as const,
      currentAmountMinor: 250000, intendedAmountMinor: 300000, currency: "TRY",
      currencyExponent: 2, currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
      intentVerb: "increase_budget" as const,
      recId: "rec_1", recType: "campaign", snapshotDate: "2026-08-30",
      engineVersion: "v3", decisionHash: "e".repeat(64),
      decisionAt: "2026-08-30T00:00:00.000Z",
    };
    expect(buildBudgetProposalEnvelope(base).fingerprint)
      .toBe(buildBudgetProposalEnvelope(base).fingerprint);
    expect(buildBudgetProposalEnvelope({ ...base, intendedAmountMinor: 280000 }).fingerprint)
      .not.toBe(buildBudgetProposalEnvelope(base).fingerprint);
  });
});

const envelope = (): BudgetProposalEnvelope => buildBudgetProposalEnvelope({
  proposalId: PROPOSAL, businessId: BIZ, providerAccountId: ACCOUNT,
  ownerGrain: "campaign", entityId: "c_100", parentCampaignId: null,
  budgetField: "daily_budget", ownerMode: "campaign_budget_optimization",
  currentAmountMinor: 250000, intendedAmountMinor: 300000, currency: "TRY",
  currencyExponent: 2, currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
  intentVerb: "increase_budget",

  recId: "rec_1", recType: "campaign", snapshotDate: "2026-08-30",
  engineVersion: "v3", decisionHash: "e".repeat(64),
  decisionAt: "2026-08-30T00:00:00.000Z",
});

const execDeps = (over: Record<string, unknown> = {}) => ({
  envelope: envelope(),
  claimToken: CLAIM,
  actorUserId: "22222222-2222-4222-8222-222222222222",
  dryRunOnly: true,
  releaseGateOpen: false,
  autoExecutionEnabled: false,
  composition: {
    blockers: [] as string[],
    request: {
      contractVersion: "meta.budget-write.v1",
      proposalId: PROPOSAL,
      idempotencyKey: `d088:${PROPOSAL}:${CLAIM}:abc`,
      actor: { userId: "22222222-2222-4222-8222-222222222222" },
      scope: {
        businessId: BIZ, providerAccountId: ACCOUNT, ownerGrain: "campaign",
        entityId: "c_100", parentCampaignId: null,
      },
      ownerMode: "campaign_budget_optimization",
      budgetField: "daily_budget",
      intendedAmountMinor: 300000,
      currency: "TRY", currencyExponent: 2,
      currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
      baseline: {
        amountMinor: 250000, budgetField: "daily_budget",
        capturedAt: "2026-08-30T09:06:00.000Z",
        sourceRunId: "44444444-4444-4444-8444-444444444444",
        sourceSnapshotId: "55555555-5555-4555-8555-555555555555",
      },
      evidenceAsOf: "2026-08-30T09:06:00.000Z",
      evidenceAsOfMs: Date.parse("2026-08-30T09:06:00.000Z"),
    },
    dryRunStatus: "would_write_available" as string,
    requestFingerprint: "f".repeat(64),
  },
  execute: async () => ({
    ok: true, resultClass: "verified" as const, blockers: [] as string[],
    journalId: "journal-1", readbackAmountMinor: 300000, message: null,
  }),
  ...over,
});

describe("D088 — the execution path is dry-run and gate-closed by default", () => {
  it("records a validated preview and makes ZERO provider calls under current defaults", async () => {
    let executed = 0;
    const result = await executeBudgetProposal(execDeps({
      execute: async () => { executed += 1; throw new Error("must not run"); },
    }) as never);
    expect(result.ok).toBe(false);
    expect(result.receipt.withheld).toBe("release_gate_closed");
    expect(result.receipt.dryRun).toBe(true);
    expect(executed).toBe(0);
  });

  it.each([
    ["auto execution off", { releaseGateOpen: true, autoExecutionEnabled: false },
      "auto_execution_disabled"],
    ["the dry-run guardrail on", { releaseGateOpen: true, autoExecutionEnabled: true, dryRunOnly: true },
      "dry_run_guardrail"],
    ["a composition blocker",
      { releaseGateOpen: true, autoExecutionEnabled: true, dryRunOnly: false,
        composition: { ...execDeps().composition, blockers: ["profile_not_retained"] } },
      "composition_blocked"],
    ["no durable request",
      { releaseGateOpen: true, autoExecutionEnabled: true, dryRunOnly: false,
        composition: { ...execDeps().composition, request: null } },
      "composition_blocked"],
    ["a D085 verdict short of would-write",
      { releaseGateOpen: true, autoExecutionEnabled: true, dryRunOnly: false,
        composition: { ...execDeps().composition, dryRunStatus: "blocked" } },
      "dry_run_not_would_write_available"],
    ["an envelope that disagrees with the request",
      { releaseGateOpen: true, autoExecutionEnabled: true, dryRunOnly: false,
        envelope: { ...envelope(), intendedAmountMinor: 999999 } },
      "envelope_request_mismatch"],
  ])("withholds on %s with ZERO provider calls", async (_l, over, withheld) => {
    let executed = 0;
    const result = await executeBudgetProposal(execDeps({
      ...over,
      execute: async () => { executed += 1; throw new Error("must not run"); },
    }) as never);
    expect(result.ok).toBe(false);
    expect(result.receipt.withheld).toBe(withheld);
    expect(executed).toBe(0);
  });

  it("a fully enabled path executes EXACTLY once through the D087 executor", async () => {
    let executed = 0;
    const result = await executeBudgetProposal(execDeps({
      releaseGateOpen: true, autoExecutionEnabled: true, dryRunOnly: false,
      execute: async () => {
        executed += 1;
        return {
          ok: true, resultClass: "verified" as const, blockers: [],
          journalId: "journal-1", readbackAmountMinor: 300000, message: null,
        };
      },
    }) as never);
    expect(result.ok).toBe(true);
    expect(executed).toBe(1);
    expect(result.receipt.withheld).toBeNull();
  });

  it("an UNKNOWN outcome reconciles once and never retries or auto-rolls-back", async () => {
    let executed = 0;
    const result = await executeBudgetProposal(execDeps({
      releaseGateOpen: true, autoExecutionEnabled: true, dryRunOnly: false,
      execute: async () => {
        executed += 1;
        return {
          ok: false, resultClass: "unknown" as const,
          blockers: ["provider_outcome_unknown"],
          journalId: "journal-1", readbackAmountMinor: null, message: null,
        };
      },
    }) as never);
    expect(result.ok).toBe(false);
    expect(result.reconcile).toBe(true);
    expect(result.rollbackRequested).toBe(false);
    expect(executed).toBe(1);
  });
});

describe("D088 — activation is a real ceremony, and it refuses today", () => {
  const readiness = (over: Record<string, unknown> = {}) => ({
    controlRowPersisted: true,
    globalGateOpen: false,
    businessStopClear: true,
    budgetDecisionMode: "manual_review" as string,
    dryRunGuardrailLifted: false,
    canonicalFactRetentionReady: false,
    profileRetentionReady: false,
    automaticRoleRetentionReady: false,
    accountScopeExact: true,
    journalSchemaReady: true,
    unresolvedReconciliations: 0,
    openClaims: 0,
    ...over,
  });

  it("every named condition is declared", () => {
    const verdict = evaluateBudgetAutomationReadiness(readiness());
    for (const blocker of verdict.blockers) {
      expect(BUDGET_ACTIVATION_CONDITIONS).toContain(blocker);
    }
  });

  it("is NOT ready in the current configuration, and names what is missing", () => {
    const verdict = evaluateBudgetAutomationReadiness(readiness());
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers).toContain("global_gate_closed");
    expect(verdict.blockers).toContain("budget_mode_not_auto");
    expect(verdict.blockers).toContain("dry_run_guardrail_engaged");
    expect(verdict.blockers).toContain("canonical_fact_retention_not_ready");
  });

  it.each([
    ["no control row", { controlRowPersisted: false }, "control_row_absent"],
    ["a business stop", { businessStopClear: false }, "business_stop_engaged"],
    ["a foreign account scope", { accountScopeExact: false }, "account_scope_not_exact"],
    ["no journal schema", { journalSchemaReady: false }, "journal_schema_not_ready"],
    ["an unresolved reconciliation", { unresolvedReconciliations: 1 }, "unresolved_reconciliation"],
    ["an open claim", { openClaims: 1 }, "open_claim"],
    ["missing role retention", { automaticRoleRetentionReady: false },
      "automatic_role_retention_not_ready"],
  ])("refuses with %s", (_l, over, blocker) => {
    const verdict = evaluateBudgetAutomationReadiness(readiness(over));
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers).toContain(blocker);
  });

  it("ENABLING refuses without the exact confirmation phrase, and writes nothing", async () => {
    let writes = 0;
    const result = await setBudgetAutoExecutionEnabled({
      businessId: BIZ, providerAccountId: ACCOUNT, enabled: true,
      confirmationPhrase: "yes please",
      actor: { userId: "u1", isAdmin: true },
      readiness: readiness({
        globalGateOpen: true, budgetDecisionMode: "auto", dryRunGuardrailLifted: true,
        canonicalFactRetentionReady: true, profileRetentionReady: true,
        automaticRoleRetentionReady: true,
      }),
      persist: async () => { writes += 1; },
    } as never);
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("confirmation_phrase_mismatch");
    expect(writes).toBe(0);
  });

  it("ENABLING refuses for a non-admin, and writes nothing", async () => {
    let writes = 0;
    const result = await setBudgetAutoExecutionEnabled({
      businessId: BIZ, providerAccountId: ACCOUNT, enabled: true,
      confirmationPhrase: BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
      actor: { userId: "u1", isAdmin: false },
      readiness: readiness({
        globalGateOpen: true, budgetDecisionMode: "auto", dryRunGuardrailLifted: true,
        canonicalFactRetentionReady: true, profileRetentionReady: true,
        automaticRoleRetentionReady: true,
      }),
      persist: async () => { writes += 1; },
    } as never);
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("actor_not_admin");
    expect(writes).toBe(0);
  });

  it("ENABLING refuses while ANY readiness condition is unproven, and writes nothing", async () => {
    let writes = 0;
    const result = await setBudgetAutoExecutionEnabled({
      businessId: BIZ, providerAccountId: ACCOUNT, enabled: true,
      confirmationPhrase: BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
      actor: { userId: "u1", isAdmin: true },
      readiness: readiness(),
      persist: async () => { writes += 1; },
    } as never);
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("readiness_not_proven");
    expect(writes).toBe(0);
  });

  it("DISABLING always works, with no confirmation phrase and no readiness", async () => {
    const persisted: Array<{ enabled: boolean }> = [];
    const result = await setBudgetAutoExecutionEnabled({
      businessId: BIZ, providerAccountId: ACCOUNT, enabled: false,
      confirmationPhrase: null,
      actor: { userId: "u1", isAdmin: true },
      readiness: readiness(),
      persist: async (row: { enabled: boolean }) => { persisted.push(row); },
    } as never);
    expect(result.ok).toBe(true);
    expect(persisted).toEqual([expect.objectContaining({ enabled: false })]);
  });
});

describe("D088 — the scheduled sweep is inert and shares the manual path", () => {
  const sweepDeps = (over: Record<string, unknown> = {}) => ({
    businessId: BIZ,
    providerAccountId: ACCOUNT,
    releaseGateOpen: false,
    autoExecutionEnabled: false,
    dryRunOnly: true,
    listEligibleProposals: async () => [{ id: PROPOSAL }],
    claim: async () => CLAIM,
    executeProposal: async () => ({ ok: true, receipt: { withheld: null } }),
    ...over,
  });

  it("claims and executes NOTHING under current defaults", async () => {
    let claims = 0;
    let executions = 0;
    const report = await runBudgetAutomationSweep(sweepDeps({
      claim: async () => { claims += 1; return CLAIM; },
      executeProposal: async () => { executions += 1; return { ok: true, receipt: {} }; },
    }) as never);
    expect(report.ran).toBe(false);
    expect(report.blockers).toContain("auto_execution_disabled");
    expect(claims).toBe(0);
    expect(executions).toBe(0);
  });

  it("uses the SAME executor as manual review when every gate is open", async () => {
    const calls: string[] = [];
    const report = await runBudgetAutomationSweep(sweepDeps({
      releaseGateOpen: true, autoExecutionEnabled: true, dryRunOnly: false,
      claim: async () => { calls.push("claim"); return CLAIM; },
      executeProposal: async () => {
        calls.push("execute");
        return { ok: true, receipt: { withheld: null } };
      },
    }) as never);
    expect(report.ran).toBe(true);
    expect(calls).toEqual(["claim", "execute"]);
    expect(report.executed).toBe(1);
  });

  it("skips a proposal it cannot claim, and never executes it unclaimed", async () => {
    let executions = 0;
    const report = await runBudgetAutomationSweep(sweepDeps({
      releaseGateOpen: true, autoExecutionEnabled: true, dryRunOnly: false,
      claim: async () => null,
      executeProposal: async () => { executions += 1; return { ok: true, receipt: {} }; },
    }) as never);
    expect(report.executed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(executions).toBe(0);
  });
});

describe("D088 — manual review and the sweep enter through the SAME executor", () => {
  it("the queue executor routes a budget proposal to the budget runtime", async () => {
    const { executeMetaAutomationProposal } = await import(
      "@/lib/meta/automation-proposal-execution");
    const seen: string[] = [];
    const result = await executeMetaAutomationProposal({
      request: { nextUrl: new URL("http://local/api"), headers: new Headers() } as never,
      businessId: BIZ,
      proposal: { proposedAction: "budget", scopeType: "campaign", scopeId: "c_100" } as never,
      dryRunOnly: true,
      receiptKey: CLAIM,
      budgetRuntime: async () => {
        seen.push("budget-runtime");
        return {
          ok: false,
          receipt: {
            httpStatus: 422, response: null, dryRun: true,
            dispatchedAt: "2026-08-31T12:00:00.000Z", endpoint: null,
            withheld: "release_gate_closed" as const, receiptKey: CLAIM,
          },
          reconcile: false, rollbackRequested: false as const, journalId: null,
        };
      },
    });
    expect(seen).toEqual(["budget-runtime"]);
    expect(result.receipt.withheld).toBe("release_gate_closed");
    expect(result.receipt.receiptKey).toBe(CLAIM);
  });

  it("WITHHOLDS a budget proposal when no runtime is injected — every caller today", async () => {
    const { executeMetaAutomationProposal } = await import(
      "@/lib/meta/automation-proposal-execution");
    const result = await executeMetaAutomationProposal({
      request: { nextUrl: new URL("http://local/api"), headers: new Headers() } as never,
      businessId: BIZ,
      proposal: { proposedAction: "budget", scopeType: "campaign", scopeId: "c_100" } as never,
      dryRunOnly: true,
      receiptKey: CLAIM,
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.withheld).toBe("budget_runtime_unavailable");
  });

  it("leaves pause and resume behaviour untouched", async () => {
    const { executeMetaAutomationProposal } = await import(
      "@/lib/meta/automation-proposal-execution");
    const result = await executeMetaAutomationProposal({
      request: { nextUrl: new URL("http://local/api"), headers: new Headers() } as never,
      businessId: BIZ,
      proposal: { proposedAction: "duplicate", scopeType: "campaign", scopeId: "c_100" } as never,
      dryRunOnly: true,
      receiptKey: CLAIM,
    });
    // `duplicate` was never executable from the queue, and still is not.
    expect(result.receipt.withheld).toBe("unsupported_action");
  });
});
