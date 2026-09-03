/**
 * D087 — execution, idempotency, journal and rollback.
 *
 * The orchestrator is written against injected dependencies so every case here
 * runs without a network, a database or a real clock. That is not a convenience:
 * a race, a duplicate and an intervening provider change are exactly the states
 * a live test cannot reproduce on demand, and they are the ones that matter.
 */
import { describe, expect, it } from "vitest";

import { D087_BUDGET_TRANSPORT_CAPABILITY } from "@/lib/meta/budget-write-capability";
import { BUDGET_WRITE_REQUEST_CONTRACT } from "@/lib/meta/budget-write-request";
import {
  BUDGET_WRITE_RESULT_CLASSES,
  executeBudgetWrite,
  rollbackBudgetWrite,
  sanitizeBudgetWriteRequestForJournal,
  type BudgetWriteJournalRow,
} from "@/lib/meta/budget-write-execution";

const PROPOSAL = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const BIZ = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-08-30T10:00:00.000Z");

const rawRequest = (over: Record<string, unknown> = {}) => ({
  contractVersion: BUDGET_WRITE_REQUEST_CONTRACT,
  proposalId: PROPOSAL,
  idempotencyKey: "d087:proposal-1:daily:300000",
  actor: { userId: ACTOR },
  scope: {
    businessId: BIZ,
    providerAccountId: "act_770001",
    ownerGrain: "campaign",
    entityId: "c_100",
    parentCampaignId: null,
  },
  ownerMode: "campaign_budget_optimization",
  budgetField: "daily_budget",
  intendedAmountMinor: 300000,
  currency: "TRY",
  currencyExponent: 2,
  currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
  baseline: {
    amountMinor: 250000,
    budgetField: "daily_budget",
    capturedAt: "2026-08-30T09:06:00.000Z",
    sourceRunId: "44444444-4444-4444-8444-444444444444",
    sourceSnapshotId: "55555555-5555-4555-8555-555555555555",
    providerApiVersion: "v23.0",
  },
  evidenceAsOf: "2026-08-30T09:06:00.000Z",
  ...over,
});

/** A journal that behaves like the real unique constraint, in memory. */
const makeJournal = () => {
  const rows: BudgetWriteJournalRow[] = [];
  return {
    rows,
    findByIdempotency: async (key: string, businessId: string, accountId: string) =>
      rows.find((r) => r.idempotencyKey === key && r.businessId === businessId
        && r.providerAccountId === accountId) ?? null,
    findById: async (id: string) => rows.find((r) => r.id === id) ?? null,
    open: async (row: BudgetWriteJournalRow) => {
      if (rows.some((r) => r.idempotencyKey === row.idempotencyKey
        && r.businessId === row.businessId
        && r.providerAccountId === row.providerAccountId)) {
        throw new Error("duplicate key value violates unique constraint");
      }
      rows.push({ ...row });
      return { ...row };
    },
    complete: async (id: string, patch: Partial<BudgetWriteJournalRow>) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("no such journal row");
      Object.assign(row, patch);
      return { ...row };
    },
  };
};

const deps = (over: Record<string, unknown> = {}) => ({
  journal: makeJournal(),
  nowMs: () => NOW,
  newId: (() => { let n = 0; return () => `journal-${++n}`; })(),
  actor: {
    userId: ACTOR,
    businessId: BIZ,
    authenticated: true,
    writeScopeBound: true,
    selectedProviderAccountId: "act_770001",
  },
  governance: {
    verified: true, writeBlocked: false, killSwitchEngaged: false, blockReason: null,
  },
  automationEnabled: true,
  capability: D087_BUDGET_TRANSPORT_CAPABILITY,
  policy: {
    maxChangePercent: 25, minHoursBetweenChanges: 12, maxChangesPer7d: 3,
    maxAccountConcentrationPercent: 40, maxBaselineAgeMinutes: 60,
  },
  history: { lastChangeAtMs: null, changesInLast7d: 0, accountConcentrationPercent: 10 },
  readProviderBaseline: async () => ({
    entityId: "c_100", providerAccountId: "act_770001",
    budgetField: "daily_budget" as const, amountMinor: 250000, currency: "TRY",
    readAtMs: NOW - 60_000,
  }),
  writeBudget: async () => ({
    ok: true as const,
    scope: "campaign" as const,
    entityId: "c_100",
    budgetField: "daily_budget" as const,
    verifiedAmountMinor: 300000,
    verifiedCurrency: "TRY",
    previousAmountMinor: 250000,
    responsePayload: { success: true },
    verificationPayload: { id: "c_100", daily_budget: "300000" },
  }),
  ...over,
});

describe("D087 execution — nothing is written until every gate agrees", () => {
  it("refuses a malformed request WITHOUT touching the provider", async () => {
    let called = 0;
    const d = deps({ writeBudget: async () => { called += 1; throw new Error("must not run"); } });
    const result = await executeBudgetWrite(d as never, rawRequest({ intendedAmountMinor: 0 }));
    expect(result.ok).toBe(false);
    expect(result.resultClass).toBe("refused_request");
    expect(called).toBe(0);
    expect(d.journal.rows).toHaveLength(0);
  });

  it("refuses on preflight WITHOUT touching the provider, and journals the refusal", async () => {
    let called = 0;
    const d = deps({
      automationEnabled: false,
      writeBudget: async () => { called += 1; throw new Error("must not run"); },
    });
    const result = await executeBudgetWrite(d as never, rawRequest());
    expect(result.ok).toBe(false);
    expect(result.resultClass).toBe("refused_preflight");
    expect(result.blockers).toContain("automation_disabled");
    expect(called).toBe(0);
    // The refusal is evidence too: it is journalled, with no provider attempt.
    expect(d.journal.rows).toHaveLength(1);
    expect(d.journal.rows[0]!.providerAttempted).toBe(false);
  });

  it("writes, verifies and journals the exact before/intended/read-back facts", async () => {
    const d = deps();
    const result = await executeBudgetWrite(d as never, rawRequest());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.resultClass).toBe("verified");
    const row = d.journal.rows[0]!;
    expect(row.beforeAmountMinor).toBe(250000);
    expect(row.intendedAmountMinor).toBe(300000);
    expect(row.readbackAmountMinor).toBe(300000);
    expect(row.providerAttempted).toBe(true);
    expect(row.rollbackEligible).toBe(true);
    expect(row.actorUserId).toBe(ACTOR);
    expect(row.proposalId).toBe(PROPOSAL);
  });

  it("every result class it can report is declared", async () => {
    const d = deps();
    const result = await executeBudgetWrite(d as never, rawRequest());
    expect(BUDGET_WRITE_RESULT_CLASSES).toContain(result.resultClass);
  });
});

describe("D087 idempotency and races", () => {
  it("an identical repeat does NOT mutate twice", async () => {
    let calls = 0;
    const d = deps({
      writeBudget: async () => {
        calls += 1;
        return {
          ok: true as const, scope: "campaign" as const, entityId: "c_100",
          budgetField: "daily_budget" as const, verifiedAmountMinor: 300000,
          verifiedCurrency: "TRY", previousAmountMinor: 250000,
          responsePayload: null, verificationPayload: null,
        };
      },
    });
    const first = await executeBudgetWrite(d as never, rawRequest());
    const second = await executeBudgetWrite(d as never, rawRequest());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.resultClass).toBe("already_applied");
    expect(calls).toBe(1);
    expect(d.journal.rows).toHaveLength(1);
  });

  it("the same key with a DIFFERENT payload refuses", async () => {
    const d = deps();
    await executeBudgetWrite(d as never, rawRequest());
    const collided = await executeBudgetWrite(
      d as never, rawRequest({ intendedAmountMinor: 280000 }),
    );
    expect(collided.ok).toBe(false);
    expect(collided.resultClass).toBe("refused_idempotency_collision");
    expect(d.journal.rows).toHaveLength(1);
  });

  it("a concurrent insert that loses the unique race refuses without writing", async () => {
    let calls = 0;
    const d = deps({
      writeBudget: async () => { calls += 1; throw new Error("must not run"); },
    });
    // Simulate the other transaction having committed between the lookup and
    // the insert: the journal already holds the row the open() will collide on.
    d.journal.rows.push({
      id: "journal-existing", contract: BUDGET_WRITE_REQUEST_CONTRACT,
      proposalId: PROPOSAL, idempotencyKey: "d087:proposal-1:daily:300000",
      requestFingerprint: "different-fingerprint",
      businessId: BIZ, providerAccountId: "act_770001", ownerGrain: "campaign",
      entityId: "c_100", parentCampaignId: null, budgetField: "daily_budget",
      currency: "TRY", currencyExponent: 2, actorUserId: ACTOR,
      beforeAmountMinor: 250000, intendedAmountMinor: 300000, readbackAmountMinor: null,
      providerAttempted: false, providerHttpStatus: null, resultClass: "in_flight",
      blockers: [], rollbackEligible: false, rolledBackAt: null,
      requestedAtMs: NOW, completedAtMs: null,
    });
    const result = await executeBudgetWrite(d as never, rawRequest());
    expect(result.ok).toBe(false);
    expect(result.resultClass).toBe("refused_idempotency_collision");
    expect(calls).toBe(0);
  });

  it("a compare-and-set race refuses without writing", async () => {
    let calls = 0;
    const d = deps({
      readProviderBaseline: async () => ({
        entityId: "c_100", providerAccountId: "act_770001",
        budgetField: "daily_budget" as const,
        // Somebody moved it after the proposal was built.
        amountMinor: 275000, currency: "TRY", readAtMs: NOW - 60_000,
      }),
      writeBudget: async () => { calls += 1; throw new Error("must not run"); },
    });
    const result = await executeBudgetWrite(d as never, rawRequest());
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("compare_and_set_mismatch");
    expect(calls).toBe(0);
  });
});

describe("D087 provider outcomes — 2xx is not success", () => {
  it.each([
    ["a provider error", {
      ok: false as const, httpStatus: 400,
      error: { code: "meta_budget_write_failed", message: "rejected" },
      responsePayload: null, verificationPayload: null,
    }, "failed"],
    ["a timeout", {
      ok: false as const, httpStatus: 504, providerOutcome: "outcome_ambiguous" as const,
      error: { code: "provider_timeout", message: "timed out" },
      responsePayload: null, verificationPayload: null,
    }, "unknown"],
    ["an ambiguous outcome", {
      ok: false as const, httpStatus: 502, providerOutcome: "outcome_ambiguous" as const,
      error: { code: "transport_error", message: "connection reset" },
      responsePayload: null, verificationPayload: null,
    }, "unknown"],
    ["a read-back on the wrong entity", {
      ok: false as const, httpStatus: 502, providerOutcome: "definite_failure" as const,
      error: { code: "readback_entity_mismatch", message: "verified c_999" },
      responsePayload: null, verificationPayload: null,
    }, "failed"],
    ["a read-back with the wrong value", {
      ok: false as const, httpStatus: 502, providerOutcome: "definite_failure" as const,
      error: { code: "silent_failure", message: "verified as 250000" },
      responsePayload: null, verificationPayload: null,
    }, "failed"],
  ])("classifies %s and never claims success", async (_label, adapterResult, expected) => {
    const d = deps({ writeBudget: async () => adapterResult });
    const result = await executeBudgetWrite(d as never, rawRequest());
    expect(result.ok).toBe(false);
    expect(result.resultClass).toBe(expected);
    const row = d.journal.rows[0]!;
    expect(row.readbackAmountMinor).toBeNull();
    // An unknown outcome must never be rolled back automatically.
    expect(row.rollbackEligible).toBe(false);
  });

  it("an adapter that throws is UNKNOWN, never failed", async () => {
    const d = deps({ writeBudget: async () => { throw new Error("socket hang up"); } });
    const result = await executeBudgetWrite(d as never, rawRequest());
    expect(result.resultClass).toBe("unknown");
    expect(d.journal.rows[0]!.rollbackEligible).toBe(false);
  });
});

describe("D087 journal — redacted, and lineage that cannot be rewritten", () => {
  it("stores no token, header or raw credential", () => {
    const sanitized = sanitizeBudgetWriteRequestForJournal({
      ...rawRequest(),
      // Hostile extras a caller might attach; none may survive.
      accessToken: "EAAG-secret", authorization: "Bearer x", headers: { cookie: "s" },
    } as never);
    const serialized = JSON.stringify(sanitized);
    for (const forbidden of ["EAAG", "Bearer", "cookie", "accessToken", "authorization"]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    expect(sanitized.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the fingerprint changes when the intended amount changes", () => {
    const a = sanitizeBudgetWriteRequestForJournal(rawRequest() as never);
    const b = sanitizeBudgetWriteRequestForJournal(
      rawRequest({ intendedAmountMinor: 280000 }) as never);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("the same request always fingerprints the same way", () => {
    expect(sanitizeBudgetWriteRequestForJournal(rawRequest() as never).fingerprint)
      .toBe(sanitizeBudgetWriteRequestForJournal(rawRequest() as never).fingerprint);
  });
});

describe("D087 rollback — guarded, exact, and refused on any intervening change", () => {
  const succeeded = async () => {
    const d = deps();
    await executeBudgetWrite(d as never, rawRequest());
    return d;
  };

  it("restores the exact prior value when the provider still holds what we wrote", async () => {
    const d = await succeeded();
    const written: Array<{ amountMinor: number }> = [];
    const result = await rollbackBudgetWrite({
      ...d,
      readProviderBaseline: async () => ({
        entityId: "c_100", providerAccountId: "act_770001",
        budgetField: "daily_budget" as const, amountMinor: 300000, currency: "TRY",
        readAtMs: NOW - 30_000,
      }),
      writeBudget: async (input: { amountMinor: number }) => {
        written.push({ amountMinor: input.amountMinor });
        return {
          ok: true as const, scope: "campaign" as const, entityId: "c_100",
          budgetField: "daily_budget" as const, verifiedAmountMinor: input.amountMinor,
          verifiedCurrency: "TRY", previousAmountMinor: 300000,
          responsePayload: null, verificationPayload: null,
        };
      },
    } as never, { journalId: "journal-1", actorUserId: ACTOR });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(written).toEqual([{ amountMinor: 250000 }]);
    expect(d.journal.rows[0]!.rolledBackAt).toBe(NOW);
  });

  it("REFUSES when the provider no longer holds the value this execution wrote", async () => {
    const d = await succeeded();
    let calls = 0;
    const result = await rollbackBudgetWrite({
      ...d,
      readProviderBaseline: async () => ({
        entityId: "c_100", providerAccountId: "act_770001",
        budgetField: "daily_budget" as const,
        // An operator moved it again after our write.
        amountMinor: 320000, currency: "TRY", readAtMs: NOW - 30_000,
      }),
      writeBudget: async () => { calls += 1; throw new Error("must not run"); },
    } as never, { journalId: "journal-1", actorUserId: ACTOR });
    expect(result.ok).toBe(false);
    expect(result.resultClass).toBe("refused_intervening_change");
    expect(calls).toBe(0);
    expect(d.journal.rows[0]!.rolledBackAt).toBeNull();
  });

  it("REFUSES to roll back an execution that was never verified", async () => {
    const d = deps({
      writeBudget: async () => ({
        ok: false as const, httpStatus: 502, providerOutcome: "outcome_ambiguous" as const,
        error: { code: "transport_error", message: "reset" },
        responsePayload: null, verificationPayload: null,
      }),
    });
    await executeBudgetWrite(d as never, rawRequest());
    const result = await rollbackBudgetWrite(d as never,
      { journalId: "journal-1", actorUserId: ACTOR });
    expect(result.ok).toBe(false);
    expect(result.resultClass).toBe("refused_not_eligible");
  });

  it("REFUSES a second rollback of the same execution", async () => {
    const d = await succeeded();
    const rollbackDeps = {
      ...d,
      readProviderBaseline: async () => ({
        entityId: "c_100", providerAccountId: "act_770001",
        budgetField: "daily_budget" as const, amountMinor: 300000, currency: "TRY",
        readAtMs: NOW - 30_000,
      }),
      writeBudget: async (input: { amountMinor: number }) => ({
        ok: true as const, scope: "campaign" as const, entityId: "c_100",
        budgetField: "daily_budget" as const, verifiedAmountMinor: input.amountMinor,
        verifiedCurrency: "TRY", previousAmountMinor: 300000,
        responsePayload: null, verificationPayload: null,
      }),
    };
    const first = await rollbackBudgetWrite(rollbackDeps as never,
      { journalId: "journal-1", actorUserId: ACTOR });
    expect(first.ok).toBe(true);
    const second = await rollbackBudgetWrite(rollbackDeps as never,
      { journalId: "journal-1", actorUserId: ACTOR });
    expect(second.ok).toBe(false);
    expect(second.resultClass).toBe("refused_not_eligible");
  });

  it("C1: hands the adapter the value THIS execution wrote as the expected current", async () => {
    /*
      The rollback guard read and the rollback POST are separated by the same
      gap the forward write had. The adapter's own pre-POST check closes it —
      but only if it is told what to expect, which is the value we wrote.
    */
    const d = await succeeded();
    const seen: Array<Record<string, unknown>> = [];
    await rollbackBudgetWrite({
      ...d,
      readProviderBaseline: async () => ({
        entityId: "c_100", providerAccountId: "act_770001",
        budgetField: "daily_budget" as const, amountMinor: 300000, currency: "TRY",
        readAtMs: NOW - 30_000,
      }),
      writeBudget: async (input: Record<string, unknown>) => {
        seen.push(input);
        return {
          ok: true as const, scope: "campaign" as const, entityId: "c_100",
          budgetField: "daily_budget" as const,
          verifiedAmountMinor: input.amountMinor as number,
          verifiedCurrency: "TRY", previousAmountMinor: 300000,
          responsePayload: null, verificationPayload: null,
        };
      },
    } as never, { journalId: "journal-1", actorUserId: ACTOR });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.amountMinor).toBe(250000);
    expect(seen[0]!.expectedPreviousAmountMinor).toBe(300000);
  });

  it("C1: the forward write hands the adapter the ACCEPTED baseline", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const d = deps({
      writeBudget: async (input: Record<string, unknown>) => {
        seen.push(input);
        return {
          ok: true as const, scope: "campaign" as const, entityId: "c_100",
          budgetField: "daily_budget" as const, verifiedAmountMinor: 300000,
          verifiedCurrency: "TRY", previousAmountMinor: 250000,
          responsePayload: null, verificationPayload: null,
        };
      },
    });
    await executeBudgetWrite(d as never, rawRequest());
    expect(seen[0]!.expectedPreviousAmountMinor).toBe(250000);
  });

  it.each([
    ["a different authenticated actor",
      { actor: { userId: "99999999-9999-4999-8999-999999999999" } }, "refused_scope"],
    ["a lost write scope", { actor: { writeScopeBound: false } }, "refused_scope"],
    ["an unauthenticated actor", { actor: { authenticated: false } }, "refused_scope"],
    ["an engaged kill switch",
      { governance: { verified: true, writeBlocked: false, killSwitchEngaged: true, blockReason: "business_kill_switch" } },
      "refused_governance"],
    ["a blocked write",
      { governance: { verified: true, writeBlocked: true, killSwitchEngaged: false, blockReason: "guard" } },
      "refused_governance"],
    ["unverified governance",
      { governance: { verified: false, writeBlocked: false, killSwitchEngaged: false, blockReason: null } },
      "refused_governance"],
  ])("C1: REFUSES a rollback with %s, before any provider read", async (_l, over, expected) => {
    const d = await succeeded();
    let reads = 0;
    let writes = 0;
    const patch = over as { actor?: Record<string, unknown>; governance?: unknown };
    const result = await rollbackBudgetWrite({
      ...d,
      actor: { ...d.actor, ...(patch.actor ?? {}) },
      governance: patch.governance ?? d.governance,
      readProviderBaseline: async () => { reads += 1; throw new Error("must not run"); },
      writeBudget: async () => { writes += 1; throw new Error("must not run"); },
    } as never, { journalId: "journal-1", actorUserId: ACTOR });
    expect(result.ok).toBe(false);
    expect(result.resultClass).toBe(expected);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  it("REFUSES a rollback from another business's actor", async () => {
    const d = await succeeded();
    const result = await rollbackBudgetWrite({
      ...d,
      actor: { ...d.actor, businessId: "other-business" },
    } as never, { journalId: "journal-1", actorUserId: ACTOR });
    expect(result.ok).toBe(false);
    expect(result.resultClass).toBe("refused_scope");
  });
});
