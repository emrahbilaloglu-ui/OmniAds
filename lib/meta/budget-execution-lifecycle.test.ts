/**
 * D088 C2 — one execution lifecycle for both paths, and no fabricated facts.
 *
 * Written before the implementation. Each case names a way C1 was still
 * scaffolding: a lifecycle only the manual route had, authority values invented
 * from a non-null id, an envelope bound to a placeholder, and a scheduler that
 * assumed the gates it never read.
 */
import { describe, expect, it } from "vitest";

import {
  runClaimedProposalExecution,
  type ClaimedExecutionDeps,
} from "@/lib/meta/budget-execution-lifecycle";
import {
  buildBudgetProposalEnvelope,
  envelopeForProposalRow,
  parseBudgetProposalEnvelope,
} from "@/lib/meta/budget-proposal-runtime";

const BIZ = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_770001";
const PROPOSAL = "11111111-1111-4111-8111-111111111111";
const CLAIM = "77777777-7777-4777-8777-777777777777";

const proposal = (over: Record<string, unknown> = {}) => ({
  id: PROPOSAL, businessId: BIZ, providerAccountId: ACCOUNT,
  scopeType: "campaign", scopeId: "c_100", proposedAction: "budget",
  actionLabel: "Change campaign budget", entityLabel: "Prospecting",
  recId: "rec_1", decisionKey: "campaign:c_100",
  ...over,
} as never);

const deps = (over: Partial<ClaimedExecutionDeps> = {}): ClaimedExecutionDeps => ({
  businessId: BIZ,
  providerAccountId: ACCOUNT,
  proposal: proposal(),
  claimToken: CLAIM,
  actorUserId: "22222222-2222-4222-8222-222222222222",
  executionKind: "manual",
  markDispatchStarted: async () => true,
  settle: async () => proposal(),
  forceReconcile: async () => true,
  recordReconciliation: async () => true,
  recordLedger: async () => true,
  execute: async (beforeProviderPost) => {
    // The executor is what reaches the provider, so it is what fires the
    // marker — synchronously, immediately before the POST.
    await beforeProviderPost();
    return {
    ok: true,
    receipt: {
      httpStatus: 200, response: null, dryRun: false,
      dispatchedAt: "2026-08-31T12:00:00.000Z",
      endpoint: "campaign:c_100", withheld: null, receiptKey: CLAIM,
    },
    reconcile: false, rollbackRequested: false as const, journalId: "journal-1",
    };
  },
  ...over,
});

describe("D088 C2 — one lifecycle, shared by both entry points", () => {
  it("marks dispatch, settles APPROVED and writes ONE ledger row on success", async () => {
    const marks: string[] = [];
    const settles: string[] = [];
    const ledger: string[] = [];
    const result = await runClaimedProposalExecution(deps({
      markDispatchStarted: async () => { marks.push("mark"); return true; },
      settle: async (input) => { settles.push(input.status); return proposal(); },
      recordLedger: async (input) => { ledger.push(input.activityType); return true; },
    }));
    expect(result.ok).toBe(true);
    expect(marks).toEqual(["mark"]);
    expect(settles).toEqual(["approved"]);
    expect(ledger).toEqual(["automation_proposal_approved"]);
  });

  it("a WITHHELD pre-provider result never marks dispatch started", async () => {
    const marks: string[] = [];
    const settles: string[] = [];
    const result = await runClaimedProposalExecution(deps({
      markDispatchStarted: async () => { marks.push("mark"); return true; },
      settle: async (input) => { settles.push(input.status); return proposal(); },
      execute: async () => ({
        ok: false,
        receipt: {
          httpStatus: 422, response: null, dryRun: true,
          dispatchedAt: "2026-08-31T12:00:00.000Z", endpoint: null,
          withheld: "release_gate_closed" as const, receiptKey: CLAIM,
        },
        reconcile: false, rollbackRequested: false as const, journalId: null,
      }),
    }));
    expect(result.ok).toBe(false);
    // Nothing was dispatched, so nothing may say it was.
    expect(marks).toEqual([]);
    expect(result.providerDispatchStarted).toBe(false);
    expect(result.providerOutcomeKnown).toBe(true);
    // ...and the row does not stay claimed.
    expect(settles).toEqual(["failed"]);
  });

  it("records a successful rehearsal without calling it applied", async () => {
    const ledger: Array<{
      resultStatus: string;
      severity: string;
      providerWriteVerified: unknown;
    }> = [];
    const result = await runClaimedProposalExecution(deps({
      execute: async () => ({
        ok: true,
        receipt: {
          httpStatus: 200,
          response: { rehearsed: true },
          dryRun: true,
          dispatchedAt: "2026-08-31T12:00:00.000Z",
          endpoint: null,
          withheld: null,
          receiptKey: CLAIM,
          providerMutationAttempted: false,
        },
        reconcile: false,
        rollbackRequested: false as const,
        journalId: null,
      }),
      recordLedger: async (entry) => {
        ledger.push({
          resultStatus: entry.resultStatus,
          severity: entry.severity,
          providerWriteVerified: entry.payload.providerWriteVerified,
        });
        return true;
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.settledStatus).toBe("approved");
    expect(result.providerDispatchStarted).toBe(false);
    expect(result.providerOutcomeKnown).toBe(true);
    expect(ledger).toEqual([{
      resultStatus: "recorded",
      severity: "info",
      providerWriteVerified: false,
    }]);
  });

  it("an UNKNOWN outcome reconciles ONCE and never retries", async () => {
    let executions = 0;
    const settles: string[] = [];
    const ledger: string[] = [];
    const result = await runClaimedProposalExecution(deps({
      settle: async (input) => { settles.push(input.status); return proposal(); },
      recordLedger: async (input) => { ledger.push(input.activityType); return true; },
      execute: async (beforeProviderPost) => {
        executions += 1;
        await beforeProviderPost();
        return {
          ok: false,
          receipt: {
            httpStatus: 502, response: null, dryRun: false,
            dispatchedAt: "2026-08-31T12:00:00.000Z", endpoint: "campaign:c_100",
            withheld: null, receiptKey: CLAIM,
          },
          reconcile: true, rollbackRequested: false as const, journalId: "journal-1",
        };
      },
    }));
    expect(executions).toBe(1);
    expect(settles).toEqual(["reconcile"]);
    expect(ledger).toEqual(["automation_proposal_reconcile"]);
    expect(result.rollbackRequested).toBe(false);
  });

  it("settles an unmarked executor exception as failed, not reconcile", async () => {
    const settles: string[] = [];
    const result = await runClaimedProposalExecution(deps({
      settle: async (input) => { settles.push(input.status); return proposal(); },
      execute: async () => { throw new Error("socket hang up"); },
    }));
    expect(result.ok).toBe(false);
    expect(settles).toEqual(["failed"]);
    expect(result.providerDispatchStarted).toBe(false);
    expect(result.reconcile).toBe(false);
    expect(result.providerOutcomeKnown).toBe(true);
  });

  it("settles a marked executor exception as reconcile", async () => {
    const settles: string[] = [];
    const result = await runClaimedProposalExecution(deps({
      settle: async (input) => { settles.push(input.status); return proposal(); },
      execute: async (beforeProviderPost) => {
        await beforeProviderPost();
        throw new Error("socket hang up after POST boundary");
      },
    }));
    expect(result.ok).toBe(false);
    expect(settles).toEqual(["reconcile"]);
    expect(result.providerDispatchStarted).toBe(true);
    expect(result.reconcile).toBe(true);
    expect(result.providerOutcomeKnown).toBe(false);
  });

  it("separates a durable intent marker from a proven provider non-attempt", async () => {
    const settles: string[] = [];
    const ledger: Record<string, unknown>[] = [];
    const result = await runClaimedProposalExecution(deps({
      settle: async (input) => { settles.push(input.status); return proposal(); },
      recordLedger: async (input) => { ledger.push(input.payload); return true; },
      execute: async (beforeProviderPost) => {
        await beforeProviderPost();
        // The final provider-side CAS rejected after the write-ahead marker.
        return {
          ok: false,
          receipt: {
            httpStatus: 502, response: null, dryRun: false,
            dispatchedAt: "2026-08-31T12:00:00.000Z",
            endpoint: "campaign:c_100", withheld: null, receiptKey: CLAIM,
            providerMutationAttempted: false,
          },
          reconcile: false, rollbackRequested: false as const, journalId: "journal-1",
        };
      },
    }));

    expect(settles).toEqual(["failed"]);
    expect(result.providerDispatchIntentMarked).toBe(true);
    expect(result.providerDispatchStarted).toBe(false);
    expect(result.providerOutcomeKnown).toBe(true);
    expect(result.reconcile).toBe(false);
    expect(ledger[0]).toMatchObject({
      providerDispatchIntentMarked: true,
      providerDispatchStarted: false,
      providerWriteVerified: false,
    });
  });

  it("still records the ledger when the settle loses the row", async () => {
    const ledger: string[] = [];
    const result = await runClaimedProposalExecution(deps({
      settle: async () => null,
      recordLedger: async (input) => { ledger.push(input.activityType); return true; },
    }));
    expect(ledger).toHaveLength(1);
    expect(result.lostTheRow).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.settledStatus).toBe("reconcile");
  });

  it.each(["false", "throw"] as const)(
    "keeps a verified provider result but exposes a %s ledger failure",
    async (failure) => {
      const result = await runClaimedProposalExecution(deps({
        recordLedger: async () => {
          if (failure === "throw") throw new Error("ledger unavailable");
          return false;
        },
      }));

      expect(result.ok).toBe(true);
      expect(result.settledStatus).toBe("approved");
      expect(result.ledgerCompleteness).toBe("unavailable");
      expect(result.ledgerErrorCode).toBe("activity_ledger_write_failed");
    },
  );

  it("overrides a verified provider success when terminal settlement throws", async () => {
    const forced: string[] = [];
    const reconciled: string[] = [];
    const ledger: string[] = [];
    const result = await runClaimedProposalExecution(deps({
      settle: async () => { throw new Error("database unavailable"); },
      forceReconcile: async ({ claimToken }) => {
        forced.push(claimToken);
        return true;
      },
      recordReconciliation: async ({ claimToken }) => {
        reconciled.push(claimToken);
        return true;
      },
      recordLedger: async (entry) => { ledger.push(entry.activityType); return true; },
    }));

    expect(forced).toEqual([CLAIM]);
    expect(reconciled).toEqual([CLAIM]);
    expect(result.ok).toBe(false);
    expect(result.reconcile).toBe(true);
    expect(result.settledStatus).toBe("reconcile");
    expect(result.providerOutcomeKnown).toBe(false);
    expect(result.settlementFailed).toBe(true);
    expect(result.reconciliationHeld).toBe(true);
    expect(result.reconciliationRecorded).toBe(true);
    expect(ledger).toEqual(["automation_proposal_reconcile"]);
  });
});

describe("D088 C2 — the envelope is bound to its own row", () => {
  const envelopeFor = (id: string) => buildBudgetProposalEnvelope({
    proposalId: id, businessId: BIZ, providerAccountId: ACCOUNT,
    ownerGrain: "campaign", entityId: "c_100", parentCampaignId: null,
    budgetField: "daily_budget", ownerMode: "campaign_budget_optimization",
    currentAmountMinor: 250000, intendedAmountMinor: 300000,
    currency: "TRY", currencyExponent: 2,
    currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
    intentVerb: "increase_budget",

    recId: "rec_1", recType: "scenario_c1_controlled_scale", snapshotDate: "2026-08-30",
    engineVersion: "v3", decisionHash: "e".repeat(64),
    decisionAt: "2026-08-30T00:00:00.000Z",
  });

  const row = (over: Record<string, unknown> = {}) => ({
    id: PROPOSAL, businessId: BIZ, providerAccountId: ACCOUNT,
    scopeType: "campaign", scopeId: "c_100", proposedAction: "budget",
    ...over,
  });

  it("accepts an envelope whose identity matches its row", () => {
    expect(envelopeForProposalRow(envelopeFor(PROPOSAL), row() as never)).not.toBeNull();
  });

  it.each([
    ["another proposal id", () => envelopeFor("99999999-9999-4999-8999-999999999999"), {}],
    ["another business", () => envelopeFor(PROPOSAL), { businessId: "other" }],
    ["another account", () => envelopeFor(PROPOSAL), { providerAccountId: "act_999" }],
    ["another grain", () => envelopeFor(PROPOSAL), { scopeType: "adset" }],
    ["another entity", () => envelopeFor(PROPOSAL), { scopeId: "c_999" }],
    ["a non-budget action", () => envelopeFor(PROPOSAL), { proposedAction: "pause" }],
  ])("REFUSES an envelope bound to %s", (_label, make, over) => {
    expect(envelopeForProposalRow(make(), row(over) as never)).toBeNull();
  });

  it("REFUSES a placeholder proposal id outright", () => {
    const placeholder = envelopeFor("00000000-0000-4000-8000-000000000000");
    expect(envelopeForProposalRow(placeholder, row() as never)).toBeNull();
  });

  it.each([
    ["campaign-only type at ad-set grain", {
      ownerGrain: "adset",
      entityId: "as_100",
      parentCampaignId: "c_100",
      ownerMode: "adset_budget",
    }],
    ["campaign scale with a decrease direction", {
      intentVerb: "decrease_budget",
    }],
  ])("REFUSES a validly fingerprinted envelope with %s", (_label, crossed) => {
    const crossedEnvelope = buildBudgetProposalEnvelope({
      ...envelopeFor(PROPOSAL),
      ...crossed,
    } as never);
    expect(parseBudgetProposalEnvelope(crossedEnvelope)).toBeNull();
    expect(envelopeForProposalRow(crossedEnvelope, row({
      scopeType: crossedEnvelope.ownerGrain,
      scopeId: crossedEnvelope.entityId,
    }) as never)).toBeNull();
  });
});

describe("D088 C3 — the marker is written BEFORE the POST, or nothing is sent", () => {
  it("VETOES the provider call when the marker cannot be written", async () => {
    let posted = 0;
    const settles: string[] = [];
    const result = await runClaimedProposalExecution(deps({
      markDispatchStarted: async () => false,
      settle: async (input) => { settles.push(input.status); return proposal(); },
      execute: async (beforeProviderPost) => {
        const marked = await beforeProviderPost();
        if (!marked) {
          return {
            ok: false,
            receipt: {
              httpStatus: 422, response: null, dryRun: false,
              dispatchedAt: "2026-08-31T12:00:00.000Z", endpoint: null,
              withheld: "dispatch_marker_unavailable" as const, receiptKey: CLAIM,
            },
            reconcile: false, rollbackRequested: false as const, journalId: null,
          };
        }
        posted += 1;
        throw new Error("must not post");
      },
    }));
    expect(posted).toBe(0);
    expect(result.markerFailed).toBe(true);
    expect(result.providerDispatchStarted).toBe(false);
    // A vetoed write is a definite non-attempt, never an unknown one.
    expect(result.providerOutcomeKnown).toBe(true);
    expect(result.reconcile).toBe(false);
    expect(settles).toEqual(["failed"]);
  });

  it("fires the marker EXACTLY once even if the executor asks twice", async () => {
    const marks: string[] = [];
    await runClaimedProposalExecution(deps({
      markDispatchStarted: async () => { marks.push("mark"); return true; },
      execute: async (beforeProviderPost) => {
        await beforeProviderPost();
        await beforeProviderPost();
        return {
          ok: true,
          receipt: {
            httpStatus: 200, response: null, dryRun: false,
            dispatchedAt: "2026-08-31T12:00:00.000Z", endpoint: "campaign:c_100",
            withheld: null, receiptKey: CLAIM,
          },
          reconcile: false, rollbackRequested: false as const, journalId: "j",
        };
      },
    }));
    expect(marks).toEqual(["mark"]);
  });
});
