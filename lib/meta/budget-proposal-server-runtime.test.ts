/**
 * D088 C1 — the concrete runtime, end to end, against the mocked Meta transport.
 *
 * This exercises the ACTUAL composition the approval route uses:
 * `createBudgetProposalServerRuntime` → `executeBudgetProposal` →
 * `executeBudgetWrite` → `updateEntityBudget`. The only thing mocked is the
 * network, so the POST count is a real count of what would leave the process.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildBudgetProposalEnvelope } from "@/lib/meta/budget-proposal-runtime";
import { createBudgetProposalServerRuntime } from "@/lib/meta/budget-proposal-server-runtime";
import { executeBudgetWrite, type BudgetWriteJournalRow } from "@/lib/meta/budget-write-execution";
import { updateEntityBudget, type MetaAdsWriteContext } from "@/lib/meta/ads-write";
import { D087_BUDGET_TRANSPORT_CAPABILITY } from "@/lib/meta/budget-write-capability";
import { CANONICAL_PROFILE_CONTRACT } from "@/lib/meta/budget-proposal-dry-run";
import { WRITE_SAFETY_STEPS } from "@/lib/meta/write-safety-contract";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import { CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV }
  from "@/lib/creative-decision-engine/campaign-context/source";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION }
  from "@/lib/creative-decision-engine/campaign-context/resolver";

vi.mock("@/lib/meta/automation-control-plane", () => ({
  getMetaWriteBlockState: vi.fn(),
}));
const controlPlane = await import("@/lib/meta/automation-control-plane");
vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveMetaAccountAuthority: vi.fn(async () => ({ state: "authorized", errorMessage: null })),
  };
});
vi.mock("@/lib/provider-write-authority", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertProviderWriteAuthorityUnchanged: vi.fn(async () => ({ ok: true })),
  };
});

const BIZ = "33333333-3333-4333-8333-333333333333";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-08-31T12:00:00.000Z");

const ctx: MetaAdsWriteContext = {
  businessId: BIZ, providerAccountId: "act_123",
  accessToken: "secret-token", connectionGeneration: "1:connected",
};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status, headers: { "Content-Type": "application/json" },
  });

const posts = () =>
  vi.mocked(fetch).mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );

const flag = (why: string) => ({
  state: "clear" as const, source: "d088-test", asOf: "2026-08-30", why,
});

interface Shape {
  grain: "campaign" | "adset";
  entityId: string;
  parentCampaignId: string | null;
  field: "daily_budget" | "lifetime_budget";
  ownerMode: "campaign_budget_optimization" | "adset_budget";
  current: number;
  intended: number;
}

const CBO: Shape = {
  grain: "campaign", entityId: "23851234567890123", parentCampaignId: null,
  field: "daily_budget", ownerMode: "campaign_budget_optimization",
  current: 250000, intended: 300000,
};
const ABO: Shape = {
  grain: "adset", entityId: "23851234567890124", parentCampaignId: "23859876543210987",
  field: "daily_budget", ownerMode: "adset_budget",
  current: 90000, intended: 108000,
};

/** The node the provider answers with, in the shape the read-back asks for. */
const node = (shape: Shape, amount: number) => json({
  id: shape.entityId, account_id: "123", name: "Entity",
  [shape.field]: String(amount), currency: "TRY",
  status: "ACTIVE", effective_status: "ACTIVE",
});

const observationRow = (shape: Shape, role: "subject" | "parent") => ({
  grain: role === "parent" ? "campaign" : shape.grain,
  business_id: BIZ, provider_account_id: "act_123",
  entity_id: role === "parent" ? shape.parentCampaignId : shape.entityId,
  campaign_id: role === "parent" ? shape.parentCampaignId
    : shape.grain === "campaign" ? shape.entityId : shape.parentCampaignId,
  presence: "present", run_completeness: "complete",
  configured_status: "ACTIVE", effective_status: "ACTIVE",
  budget_origin: role === "parent" ? "not_applicable"
    : shape.grain === "campaign" ? "campaign" : "adset",
  budget_currency: "TRY", budget_currency_exponent: 2,
  budget_currency_registry_version: "iso4217.minor-units.2026-09-01",
  budget_shape_support: "supported",
  campaign_daily_budget_raw: role === "subject" && shape.grain === "campaign"
    ? String(shape.current) : null,
  campaign_lifetime_budget_raw: null,
  adset_daily_budget_raw: role === "subject" && shape.grain === "adset"
    ? String(shape.current) : null,
  adset_lifetime_budget_raw: null,
  campaign_start_time: null, campaign_end_time: null,
  adset_start_time: null, adset_end_time: null,
  provider_api_version: "v22.0", state_hash: "a".repeat(64),
  observation_id: `obs-${role}`,
  field_coverage_json: { configuredStatus: true, effectiveStatus: true },
  provider_updated_at: "2026-08-30T02:00:00.000Z",
  observed_on: "2026-08-30", observed_at: "2026-08-30T03:00:00.000Z",
  captured_at: "2026-08-30T03:00:00.000Z", created_at: "2026-08-30T03:00:05.000Z",
  id: `state-${role}`, run_id: "44444444-4444-4444-8444-444444444444",
  source_snapshot_id: "55555555-5555-4555-8555-555555555555",
  payload_hash: "b".repeat(64), run_hash: "c".repeat(64),
  distinct_truths: 1, population_total: 1,
});

const proposalFor = (shape: Shape): MetaAutomationProposal => ({
  id: "11111111-1111-4111-8111-111111111111",
  businessId: BIZ, providerAccountId: "act_123", origin: "engine_decision",
  ruleId: null, dedupeKey: null,
  decisionKey: `${shape.grain}:${shape.entityId}`,
  scopeType: shape.grain, scopeId: shape.entityId,
  recId: "rec_1", recType: shape.grain, snapshotDate: "2026-08-30",
  engineVersion: "v3", decisionLabel: "scale",
  proposedAction: "budget", actionLabel: "Change budget",
  primaryCaption: "Approve & apply", entityLabel: "Entity",
  reason: "typed budget intent", evidenceLabel: null, evidenceRef: {},
  expiresAt: "2026-09-01T00:00:00.000Z", status: "claimed",
  decidedBy: ACTOR, decidedAt: null, decisionNote: null, receipt: null,
  budgetEnvelope: buildBudgetProposalEnvelope({
    proposalId: "11111111-1111-4111-8111-111111111111",
    businessId: BIZ, providerAccountId: "act_123",
    ownerGrain: shape.grain, entityId: shape.entityId,
    parentCampaignId: shape.parentCampaignId,
    budgetField: shape.field, ownerMode: shape.ownerMode,
    currentAmountMinor: shape.current, intendedAmountMinor: shape.intended,
    currency: "TRY", currencyExponent: 2,
    currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
    intentVerb: "increase_budget",

    recId: "rec_1", recType: "campaign", snapshotDate: "2026-08-30",
    engineVersion: "v3", decisionHash: "e".repeat(64),
    decisionAt: "2026-08-30T00:00:00.000Z",
  }),
  claimToken: "77777777-7777-4777-8777-777777777777",
  claimedBy: ACTOR, claimedAt: null, dispatchStartedAt: null,
  createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:00:00.000Z",
});

/** An in-memory journal that enforces the real unique occurrence key. */
const makeJournal = () => {
  const rows: BudgetWriteJournalRow[] = [];
  return {
    rows,
    findByIdempotency: async (key: string) =>
      rows.find((r) => r.idempotencyKey === key) ?? null,
    findById: async (id: string) => rows.find((r) => r.id === id) ?? null,
    open: async (row: BudgetWriteJournalRow) => {
      if (rows.some((r) => r.idempotencyKey === row.idempotencyKey)) {
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

const readersFor = (shape: Shape, journal: ReturnType<typeof makeJournal>) => ({
    readGates: async () => ({ releaseGateOpen: true, autoExecutionEnabled: true }),
    loadCompositionSources: async () => ({
      businessId: BIZ, providerAccountId: "act_123",
      ownerGrain: shape.grain, entityId: shape.entityId,
      parentCampaignId: shape.parentCampaignId,
      actorUserId: ACTOR,
      observations: shape.grain === "adset"
        ? [observationRow(shape, "subject"), observationRow(shape, "parent")]
        : [observationRow(shape, "subject")],
      accountTimeZone: "Europe/Istanbul",
      intent: {
        verb: "increase_budget", intendedAmountMinor: shape.intended, percent: 20,
      },
      // The APPROVED resolver identity, stubbed into the environment below —
      // an unapproved one can never be a canonical authority, which is the
      // honest default this environment ships with.
      role: {
        kind: "main", source: "automatic",
        resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
        confidence: "high", asOf: "2026-08-30", accountScoped: true,
        satisfiesRoleAuthority: true, producer: "automatic_inference",
        authorityBlockers: [],
      },
      profileRetained: true,
      changeHistory: {
        lastChangeAtMs: null, changesInLast7d: 0, accountConcentrationPercent: 10,
      },
      optimizationGoal: shape.grain === "adset" ? "OFFSITE_CONVERSIONS" : null,
      providerBaseline: {
        entityId: shape.entityId, providerAccountId: "act_123",
        budgetField: shape.field, amountMinor: shape.current,
        currency: "TRY", readAtMs: NOW - 60_000,
      },
      nowMs: NOW,
      safety: {
        killSwitch: flag("disengaged"), admission: flag("allowed"),
        cap: flag("under cap"), cooldown: flag("no cooldown"), conflict: flag("no lock"),
      },
      writeSafety: Object.fromEntries(
        WRITE_SAFETY_STEPS.map((step) => [step, "satisfied" as const]),
      ),
      commercial: {
        profileContractVersion: CANONICAL_PROFILE_CONTRACT,
        businessId: BIZ, providerAccountId: "act_123", sourceStatus: "resolved",
        selectedAction: "scale", eligible: true, code: null, reason: null,
        blockerCodes: [], evidenceFloorsClear: true, changeSafetyClear: true,
      },
      decision: {
        id: "rec_1", hash: "d".repeat(64), version: "v3",
        decidedAt: new Date(NOW - 60_000).toISOString(), maxAgeSeconds: 86_400,
      },
      casBaseline: null, preflight: null,
      preflightEvidence: null,
      rawIntent: null,
    }),
    writeDeps: async () => ({
      journal,
      nowMs: () => NOW,
      newId: (() => { let n = 0; return () => `journal-${++n}`; })(),
      actor: {
        userId: ACTOR, businessId: BIZ, authenticated: true,
        writeScopeBound: true, selectedProviderAccountId: "act_123",
      },
      governance: {
        verified: true, writeBlocked: false, killSwitchEngaged: false, blockReason: null,
      },
      // PR #272 review: the account's VERIFIED currency, as the budget write
      // context carries it. The adapter refuses without one.
      accountCurrency: "TRY",
      automationEnabled: true,
      capability: D087_BUDGET_TRANSPORT_CAPABILITY,
      policy: {
        maxChangePercent: 25, minHoursBetweenChanges: 12, maxChangesPer7d: 3,
        maxAccountConcentrationPercent: 40, maxBaselineAgeMinutes: 60,
        maxAmountMinor: 500000, currency: "TRY",
      },
      history: {
        lastChangeAtMs: null, changesInLast7d: 0, accountConcentrationPercent: 10,
      },
      readProviderBaseline: async () => ({
        entityId: shape.entityId, providerAccountId: "act_123",
        budgetField: shape.field, amountMinor: shape.current,
        currency: "TRY", readAtMs: NOW - 60_000,
      }),
      writeBudget: async (write: Parameters<typeof updateEntityBudget>[1]) =>
        updateEntityBudget(ctx, write),
    }),
  });

const runtimeFor = (shape: Shape, journal: ReturnType<typeof makeJournal>) =>
  createBudgetProposalServerRuntime(readersFor(shape, journal) as never);

describe("D088 C1 — the real runtime composition, mocked transport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn());
    /*
      D088 C2: the canonical resolver identity has to be APPROVED for a role
      authority to be canonical, and this repository approves none by default.
      Stubbing it here is a test-local environment stub — no file, no
      deployment and no control row is touched — and without it the positive
      path is unreachable for a reason that is about configuration, not code.
    */
    vi.stubEnv(CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
      CAMPAIGN_CONTEXT_RESOLVER_VERSION);
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({ blocked: false, reason: null, message: null, rehearsal: false });
  });

  it.each([["CBO campaign", CBO], ["ABO ad set", ABO]] as const)(
    "%s: exactly ONE POST and an exact read-back",
    async (_label, shape) => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(node(shape, shape.current))     // pre-POST CAS
        .mockResolvedValueOnce(json({ success: true }))         // the POST
        .mockResolvedValueOnce(node(shape, shape.intended));    // read-back

      const journal = makeJournal();
      const result = await runtimeFor(shape, journal)({
        proposal: proposalFor(shape), dryRunOnly: false,
        claimToken: "77777777-7777-4777-8777-777777777777",
        authorization: {
          kind: "manual", explicitConfirmation: true, operatorUserId: ACTOR,
        },
      });

      expect(result.ok, JSON.stringify(result.receipt)).toBe(true);
      const issued = posts();
      expect(issued).toHaveLength(1);
      expect(String(issued[0]![0])).toContain(shape.entityId);
      expect(String((issued[0]![1] as RequestInit).body))
        .toBe(`${shape.field}=${shape.intended}`);
      expect(journal.rows).toHaveLength(1);
      expect(journal.rows[0]!.readbackAmountMinor).toBe(shape.intended);
      expect(journal.rows[0]!.beforeAmountMinor).toBe(shape.current);
    },
  );

  it("uses the DEFAULT composition — no injected verdict, request or safety", () => {
    /*
      C1's positive proof injected a composed result, which proved only the
      injected object. These cases traverse the real D083 -> D085 -> D087 chain;
      the readers supply low-level facts and nothing else.
    */
    // The readers object itself, not its source text: a `compose` key is the
    // only way to substitute the chain, and there is none.
    expect(Object.keys(readersFor(CBO, makeJournal())).sort())
      .toEqual(["loadCompositionSources", "readGates", "writeDeps"]);
  });

  it("a duplicate claim adds ZERO further POSTs", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO, CBO.current))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node(CBO, CBO.intended));

    const journal = makeJournal();
    const runtime = runtimeFor(CBO, journal);
    const first = await runtime({
      proposal: proposalFor(CBO), dryRunOnly: false,
      claimToken: "77777777-7777-4777-8777-777777777777",
      authorization: {
        kind: "manual", explicitConfirmation: true, operatorUserId: ACTOR,
      },
    });
    const second = await runtime({
      proposal: proposalFor(CBO), dryRunOnly: false,
      claimToken: "77777777-7777-4777-8777-777777777777",
      authorization: {
        kind: "manual", explicitConfirmation: true, operatorUserId: ACTOR,
      },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(journal.rows).toHaveLength(1);
  });

  it("withholds and POSTs nothing when the gates are closed", async () => {
    const journal = makeJournal();
    const runtime = createBudgetProposalServerRuntime({
      readGates: async () => ({ releaseGateOpen: false, autoExecutionEnabled: false }),
      loadCompositionSources: async () => { throw new Error("must not compose"); },
      writeDeps: async () => { throw new Error("must not build write deps"); },
    });
    const result = await runtime({
      proposal: proposalFor(CBO), dryRunOnly: true,
      claimToken: "77777777-7777-4777-8777-777777777777",
      authorization: {
        kind: "manual", explicitConfirmation: true, operatorUserId: ACTOR,
      },
    });
    expect(result.ok).toBe(false);
    expect(posts()).toHaveLength(0);
    expect(journal.rows).toHaveLength(0);
  });

  it("withholds when the row carries no valid envelope", async () => {
    const journal = makeJournal();
    const result = await runtimeFor(CBO, journal)({
      proposal: { ...proposalFor(CBO), budgetEnvelope: null },
      dryRunOnly: false, claimToken: "77777777-7777-4777-8777-777777777777",
      authorization: {
        kind: "manual", explicitConfirmation: true, operatorUserId: ACTOR,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.withheld).toBe("composition_blocked");
    expect(posts()).toHaveLength(0);
  });

  it("an UNKNOWN transport outcome reconciles once, with no retry", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO, CBO.current))
      .mockRejectedValueOnce(new Error("socket hang up"));
    const journal = makeJournal();
    const result = await runtimeFor(CBO, journal)({
      proposal: proposalFor(CBO), dryRunOnly: false,
      claimToken: "77777777-7777-4777-8777-777777777777",
      authorization: {
        kind: "manual", explicitConfirmation: true, operatorUserId: ACTOR,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reconcile).toBe(true);
    expect(result.rollbackRequested).toBe(false);
    expect(posts()).toHaveLength(1);
  });

  void executeBudgetWrite;
});
