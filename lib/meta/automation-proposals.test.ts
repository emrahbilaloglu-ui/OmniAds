import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn(async (run: () => Promise<unknown>) => run()),
}));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));
vi.mock("@/lib/meta/automation-guardrail-policy", () => ({
  readMetaAutomationProposalRoasFloor: vi.fn(),
}));

const dbModule = await import("@/lib/db");
const guardrailPolicy = await import("@/lib/meta/automation-guardrail-policy");

import {
  META_AUTOMATION_PROPOSAL_OPEN_STATUSES,
  META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
  META_AUTOMATION_PROPOSAL_TTL_HOURS,
  META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES,
  NO_PROVIDER_DISPATCH,
  claimScheduledMetaAutomationProposal,
  evaluateProposalTransition,
  providerDispatchFacts,
  isProposalExpired,
  proposalActionForDecision,
  proposalActionLabel,
  proposalDecisionKey,
  proposalExpiryFor,
  projectMetaAutomationProposals,
  raiseRuleAutomationProposal,
  type MetaAutomationProposalStatus,
} from "@/lib/meta/automation-proposals";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const RULE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVATION_VERSION = "2026-08-17T11:55:00.000Z";

/**
 * A db double that RECORDS the statement it was handed.
 *
 * Shared by the projection and the rule-intake suites, because both now assert
 * on the SQL that was actually issued rather than on source text: the status
 * predicates are interpolated from the exported constants, so a source scan
 * would be checking a template literal instead of a statement.
 */
function recordingDb(rows: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tagged = () => Promise.resolve([]);
  (tagged as unknown as { query: unknown }) .query = (
    text: string,
    values: unknown[],
  ) => {
    calls.push({ text, values });
    return Promise.resolve(rows.shift() ?? []);
  };
  return { tagged, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduled proposal claims reserve the daily cap atomically", () => {
  it("locks, counts in-flight/reconcile reservations, and refuses a claim at cap", async () => {
    const { tagged, calls } = recordingDb([
      [], [{ business_id: BUSINESS_ID }], [], [{ used: 1 }],
    ]);
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);

    const result = await claimScheduledMetaAutomationProposal({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      proposalId: RULE_ID,
      claimedBy: ACTOR_ID,
      expectedEnablingActorUserId: ACTOR_ID,
      expectedActivationControlVersion: ACTIVATION_VERSION,
      dailyAutoActionCap: 1,
      now: NOW,
    });

    expect(result).toEqual({ status: "cap_reached" });
    expect(calls).toHaveLength(4);
    expect(calls[0]!.text).toContain("pg_advisory_xact_lock");
    expect(calls[1]!.text).toContain("FOR SHARE OF controls, m");
    expect(calls[1]!.values).toEqual([
      BUSINESS_ID, "act_123", ACTOR_ID, ACTIVATION_VERSION,
    ]);
    expect(calls[2]!.text).toContain("claimed_at <= $3::timestamptz");
    expect(calls[3]!.text).toContain("status = 'claimed'");
    expect(calls[3]!.text).toContain("status = 'reconcile'");
    expect(calls[3]!.text).toContain("receipt_json->>'executionKind' = 'scheduled'");
    expect(calls.some(({ text }) => text.includes("SET status = 'claimed'")))
      .toBe(false);
  });

  it("fails closed before the cap count when stale leases cannot be classified", async () => {
    const calls: string[] = [];
    const tagged = Object.assign(
      () => Promise.resolve([]),
      {
        query: async (text: string) => {
          calls.push(text);
          if (text.includes("FOR SHARE OF controls, m")) {
            return [{ business_id: BUSINESS_ID }];
          }
          if (text.includes("claimed_at <= $3::timestamptz")) {
            throw Object.assign(new Error("missing claim column"), { code: "42703" });
          }
          return [];
        },
      },
    );
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);

    const result = await claimScheduledMetaAutomationProposal({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      proposalId: RULE_ID,
      claimedBy: ACTOR_ID,
      expectedEnablingActorUserId: ACTOR_ID,
      expectedActivationControlVersion: ACTIVATION_VERSION,
      dailyAutoActionCap: 1,
      now: NOW,
    });

    expect(result).toEqual({ status: "cap_unavailable" });
    expect(calls[0]).toContain("pg_advisory_xact_lock");
    expect(calls[1]).toContain("FOR SHARE OF controls, m");
    expect(calls[2]).toContain("claimed_at <= $3::timestamptz");
    expect(calls.some((text) => text.includes("receipt_json->>'executionKind'")))
      .toBe(false);
  });

  it("refuses before lease sweep and cap count when activation changed", async () => {
    const { tagged, calls } = recordingDb([[], []]);
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);

    const result = await claimScheduledMetaAutomationProposal({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      proposalId: RULE_ID,
      claimedBy: ACTOR_ID,
      expectedEnablingActorUserId: ACTOR_ID,
      expectedActivationControlVersion: ACTIVATION_VERSION,
      dailyAutoActionCap: 1,
      now: NOW,
    });

    expect(result).toEqual({ status: "activation_changed" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.text).toContain("FOR SHARE OF controls, m");
    expect(calls.some(({ text }) => text.includes("claimed_at <= $3::timestamptz")))
      .toBe(false);
    expect(calls.some(({ text }) => text.includes("receipt_json->>'executionKind'")))
      .toBe(false);
  });
});

describe("which engine decisions may become a proposal", () => {
  it("projects a cut decision at campaign and ad-set grain as a pause", () => {
    expect(
      proposalActionForDecision({ decisionLabel: "cut", scopeType: "campaign" }),
    ).toEqual({ action: "pause", scopeType: "campaign" });
    expect(
      proposalActionForDecision({ decisionLabel: "cut", scopeType: "adset" }),
    ).toEqual({ action: "pause", scopeType: "adset" });
  });

  it("refuses every label that has no guarded endpoint to execute", () => {
    // `scale` is the design's own first prototype row. There is no guarded
    // budget-write endpoint in this repo, so projecting it would put a primary
    // button on screen whose only possible outcome is a failure.
    for (const decisionLabel of [
      "scale",
      "tune",
      "keep",
      "rebuild",
      "switch",
      "test_more",
      "diagnose",
      null,
    ]) {
      expect(
        proposalActionForDecision({ decisionLabel, scopeType: "adset" }),
      ).toBeNull();
    }
  });

  it("refuses ad grain, whose write path is the decision-origin contract", () => {
    expect(
      proposalActionForDecision({ decisionLabel: "cut", scopeType: "ad" }),
    ).toBeNull();
    expect(
      proposalActionForDecision({ decisionLabel: "cut", scopeType: "account" }),
    ).toBeNull();
  });

  it("labels the row with the design's own wording and caption", () => {
    expect(proposalActionLabel("pause", "adset")).toBe("Pause ad set");
    expect(proposalActionLabel("pause", "campaign")).toBe("Pause campaign");
    expect(META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION).toBe("Approve & apply");
  });

  it("keys a proposal by the same decision key the write ceremony parses", () => {
    expect(proposalDecisionKey("adset", "23848")).toBe("adset:23848");
  });
});

describe("expiry is one snapshot cadence", () => {
  it("derives the expiry from the decision row's own creation time", () => {
    expect(proposalExpiryFor("2026-08-17T09:00:00.000Z")).toBe(
      "2026-08-18T09:00:00.000Z",
    );
    expect(META_AUTOMATION_PROPOSAL_TTL_HOURS).toBe(24);
  });

  it("treats the exact expiry instant as expired, not as the last usable moment", () => {
    expect(
      isProposalExpired({ expiresAt: NOW.toISOString(), now: NOW }),
    ).toBe(true);
    expect(
      isProposalExpired({ expiresAt: "2026-08-17T12:00:00.001Z", now: NOW }),
    ).toBe(false);
  });

  it("treats an unparseable expiry as expired", () => {
    // Fail-closed: the alternative makes a corrupt timestamp the one way to
    // reach a provider write past the evidence that justified it.
    expect(isProposalExpired({ expiresAt: "not-a-date", now: NOW })).toBe(true);
  });
});

describe("the proposal state machine", () => {
  const pendingUntil = "2026-08-17T18:00:00.000Z";

  it("moves a live pending proposal to the state its control names", () => {
    expect(
      evaluateProposalTransition({
        status: "pending",
        expiresAt: pendingUntil,
        action: "approve",
        now: NOW,
      }),
    ).toEqual({ ok: true, next: "approved" });
    expect(
      evaluateProposalTransition({
        status: "pending",
        expiresAt: pendingUntil,
        action: "modify",
        now: NOW,
      }),
    ).toEqual({ ok: true, next: "modified" });
    expect(
      evaluateProposalTransition({
        status: "pending",
        expiresAt: pendingUntil,
        action: "dismiss",
        now: NOW,
      }),
    ).toEqual({ ok: true, next: "dismissed" });
  });

  it("refuses every already-decided state, including the server-written ones", () => {
    const decided: MetaAutomationProposalStatus[] = [
      "approved",
      "failed",
      "modified",
      "dismissed",
      "expired",
    ];
    for (const status of decided) {
      const result = evaluateProposalTransition({
        status,
        expiresAt: pendingUntil,
        action: "approve",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.refusal).toBe("proposal_not_pending");
    }
  });

  it("refuses an expired proposal for every control, including dismiss", () => {
    for (const action of ["approve", "modify", "dismiss"] as const) {
      const result = evaluateProposalTransition({
        status: "pending",
        expiresAt: "2026-08-17T11:59:59.000Z",
        action,
        now: NOW,
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.refusal).toBe("proposal_expired");
    }
  });

  it("says the expired proposal will be re-evaluated rather than lost", () => {
    const result = evaluateProposalTransition({
      status: "pending",
      expiresAt: "2026-08-16T00:00:00.000Z",
      action: "approve",
      now: NOW,
    });
    expect(result.ok === false && result.message).toContain(
      "next snapshot re-evaluates it",
    );
  });
});

describe("one queue, two origins", () => {
  // Rewritten from a source scan to an EXECUTION.
  //
  // The scan asserted on literals in the file, and the file no longer holds
  // them: the status lists are interpolated from the exported constants
  // precisely so the SQL and the code-side twin cannot drift. A scan for
  // "'pending', 'claimed'" would now pass or fail on the shape of a template
  // literal rather than on the statement PostgreSQL is asked to run. So the
  // real function runs against a recording db and the assertions read the
  // statement that was actually issued.
  it("never lets a rule and the projection queue the same pause twice", async () => {
    const { tagged, calls } = recordingDb([
      // expireStaleMetaAutomationProposals, sweepStaleMetaAutomationProposalClaims
      [],
      [],
      // the projection insert
      [],
    ]);
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);
    vi.mocked(
      guardrailPolicy.readMetaAutomationProposalRoasFloor,
    ).mockResolvedValue({ status: "read", floor: null } as never);

    await projectMetaAutomationProposals({
      businessId: BUSINESS_ID,
      snapshotDate: "2026-08-17",
      now: NOW,
    });

    const projection = calls.at(-1)!.text;

    // Widened when the execution claim landed, and the law it states is WIDER
    // than the one it replaced, never narrower.
    //
    // The original assertion pinned `held.status = 'pending'`. That was the
    // whole slot at the time, because a row was either pending or decided. It
    // is not any more: an approval moves the row to `claimed` for the duration
    // of its provider dispatch, and a slot check that only saw `pending` would
    // let the projection raise a SECOND pause for an entity whose first pause
    // was in flight.
    //
    // Widened AGAIN, and again only outwards. `reconcile` joined the open list
    // because leaving it out reopened the same hole one layer down: the
    // stale-claim sweep moves a dead claim whose dispatch had started into
    // `reconcile`, and a pending+claimed slot check then treated that as a FREE
    // slot. So the next snapshot could project a fresh pause for an entity
    // whose previous pause may already be live at Meta — a second dispatch path
    // for work whose provider outcome nobody has established.
    //
    // The law: an entity's action slot is held by an OPEN row — pending,
    // claimed or reconcile — whatever raised it, and the clause exempts only
    // the exact PENDING row it upserts onto, so refresh-in-place still works.
    // The exemption is pending-only because the upsert's own DO UPDATE is
    // guarded on `status = 'pending'`: exempting a held row would attempt an
    // insert the open-slot unique index then rejects inside the pipeline.
    expect(projection).toContain(
      "held.status IN ('pending', 'claimed', 'reconcile')",
    );
    expect(projection).toContain("held.status = 'pending'");
    // A reconcile row is BOTH decided (for its own snapshot day) and open (its
    // slot is still held). The decided clause must therefore stay narrower than
    // the open one; collapsing them either way is a bug in one direction or the
    // other.
    expect(projection).toContain(
      "decided.status NOT IN ('pending', 'claimed')",
    );
    expect(projection).toContain("held.proposed_action = 'pause'");
    expect(projection).toContain("held.origin = 'engine_decision'");
    // And it stamps its own origin rather than letting the default decide.
    expect(projection).toContain("'engine_decision',");
  });

  it("reads the queue as one collection, not one per origin", () => {
    const source = readFileSync("lib/meta/automation-proposals.ts", "utf8");
    const read = source.slice(
      source.indexOf("export async function readMetaAutomationProposalQueue"),
      source.indexOf("/** One proposal, scoped to the authorized business"),
    );

    // One read of one table, no origin filter: the operator sees a single
    // list. The FROM itself now lives in the shared `selectProposalRows`
    // helper (which exists so the claim columns can degrade on an unmigrated
    // database), so the law is checked in both halves rather than dropped.
    expect(read.match(/selectProposalRows\(/g)).toHaveLength(1);
    expect(read).not.toContain("origin =");
    const selector = source.slice(
      source.indexOf("async function selectProposalRows"),
      source.indexOf("async function proposalsReady"),
    );
    expect(selector.match(/FROM meta_automation_proposals/g)).toHaveLength(2);
    expect(selector).not.toContain("origin =");
  });

  it("has no second proposal table anywhere in the subsystem", () => {
    for (const file of [
      "lib/meta/automation-proposals.ts",
      "lib/meta/automation-proposal-intake.ts",
      "lib/meta/automation-rules-store.ts",
      "lib/migrations.ts",
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toContain(
        "meta_automation_rule_proposals",
      );
    }
  });
});

describe("raising a rule firing into the queue", () => {
  it("inserts one pending row and reports its id", async () => {
    const { tagged, calls } = recordingDb([[{ id: "proposal_1" }]]);
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);

    const result = await raiseRuleAutomationProposal({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      ruleId: RULE_ID,
      dedupeKey: `${RULE_ID}:adset_1:2026-08-16`,
      scopeType: "adset",
      scopeId: "adset_1",
      proposedAction: "pause",
      entityLabel: "Retargeting 7d — DPA",
      reason: "ROAS below breakeven.",
      evidenceLabel: "breakeven 2.50 · 3d",
      evidenceRef: {},
      evaluatedForDate: "2026-08-16",
      now: NOW,
    });

    expect(result).toEqual({ status: "inserted", proposalId: "proposal_1" });
    expect(calls).toHaveLength(1);
    const statement = calls[0]!.text.replace(/\s+/g, " ");
    // Untargeted on purpose: two different unique indexes can refuse this row,
    // and naming one would turn the other into a thrown error mid-evaluation.
    expect(statement).toContain("ON CONFLICT DO NOTHING");
    expect(statement).not.toMatch(/ON CONFLICT \(/);
    expect(calls[0]!.values).toContain("adset:adset_1");
    expect(calls[0]!.values).toContain("Pause ad set");
    expect(calls[0]!.values).toContain(
      META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
    );
  });

  it("joins the row that already holds the slot instead of queueing a second", async () => {
    const { tagged, calls } = recordingDb([
      [],
      [{ id: "proposal_held", status: "pending" }],
    ]);
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);

    const result = await raiseRuleAutomationProposal({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      ruleId: RULE_ID,
      dedupeKey: `${RULE_ID}:adset_1:2026-08-16`,
      scopeType: "adset",
      scopeId: "adset_1",
      proposedAction: "pause",
      entityLabel: null,
      reason: "ROAS below breakeven.",
      evidenceLabel: null,
      evidenceRef: {},
      evaluatedForDate: "2026-08-16",
      now: NOW,
    });

    expect(result).toEqual({
      status: "already_queued",
      proposalId: "proposal_held",
    });
    // Rewritten with the claim, same reason as the projection's slot clause
    // above: the row that holds this entity's slot may be pending, claimed OR
    // reconcile, and a firing that arrives while the entity's pause is being
    // dispatched — or while its outcome is unknown — must join THAT row rather
    // than report a queue row that does not exist.
    expect(calls[1]!.text.replace(/\s+/g, " ")).toContain(
      "status IN ('pending', 'claimed', 'reconcile')",
    );
  });

  // `already_queued` and "the previous attempt's outcome is unknown" are not
  // the same fact, and reporting the second as the first tells an operator a
  // confirmation is waiting for them when what is waiting is a reconciliation.
  // There is no approvable row behind a reconcile hold and there will not be
  // one until a human resolves it against a fresh provider read.
  it("reports a reconcile hold as its own status, never as queued", async () => {
    const { tagged } = recordingDb([
      [],
      [{ id: "proposal_reconcile", status: "reconcile" }],
    ]);
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);

    const result = await raiseRuleAutomationProposal({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      ruleId: RULE_ID,
      dedupeKey: `${RULE_ID}:adset_1:2026-08-17`,
      scopeType: "adset",
      scopeId: "adset_1",
      proposedAction: "pause",
      entityLabel: null,
      reason: "ROAS below breakeven.",
      evidenceLabel: null,
      evidenceRef: {},
      evaluatedForDate: "2026-08-17",
      now: NOW,
    });

    expect(result).toEqual({
      status: "held_for_reconciliation",
      proposalId: "proposal_reconcile",
    });
  });
});

/**
 * The three facts an attempt can establish about the provider.
 *
 * A single `providerWrite: boolean` cannot carry this path's real outcomes, and
 * the failure was not theoretical: a ledger row whose own message read "was
 * dispatched and no result came back" was written as `providerWrite: false`,
 * which every reader, filter and aggregate treats as "nothing was sent".
 */
describe("providerDispatchFacts", () => {
  it("reports an unanswered dispatch as UNKNOWN, never as no-write", () => {
    const facts = providerDispatchFacts({
      dispatchStarted: true,
      outcomeKnown: false,
      ok: false,
      dryRun: false,
    });
    expect(facts).toEqual({
      providerDispatchStarted: true,
      providerOutcomeKnown: false,
      providerWriteVerified: false,
    });
    // The pair is the contract: `providerWriteVerified: false` alone would be
    // indistinguishable from a dispatch that provably wrote nothing.
    expect(facts.providerDispatchStarted && !facts.providerOutcomeKnown).toBe(
      true,
    );
  });

  it("never verifies a write that never left the building", () => {
    expect(
      providerDispatchFacts({
        dispatchStarted: true,
        outcomeKnown: true,
        ok: true,
        dryRun: true,
      }).providerWriteVerified,
    ).toBe(false);
  });

  it("verifies only a known, successful, real dispatch", () => {
    expect(
      providerDispatchFacts({
        dispatchStarted: true,
        outcomeKnown: true,
        ok: true,
        dryRun: false,
      }),
    ).toEqual({
      providerDispatchStarted: true,
      providerOutcomeKnown: true,
      providerWriteVerified: true,
    });
  });

  it("states an absent dispatch as absence, which is the one provable negative", () => {
    expect(NO_PROVIDER_DISPATCH).toEqual({
      providerDispatchStarted: false,
      providerOutcomeKnown: true,
      providerWriteVerified: false,
    });
  });
});

/**
 * The slot list and the decided list are DIFFERENT lists, and the difference is
 * load-bearing. `reconcile` is decided (that attempt is over) and open (its
 * slot is still held). Collapsing them in either direction is a bug: one way
 * re-raises a proposal for an unresolved dispatch, the other way freezes a
 * snapshot day's projection forever.
 */
describe("the open-slot and undecided status lists", () => {
  it("holds the slot for reconcile and does not call it undecided", () => {
    expect([...META_AUTOMATION_PROPOSAL_OPEN_STATUSES]).toEqual([
      "pending",
      "claimed",
      "reconcile",
    ]);
    expect([...META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES]).toEqual([
      "pending",
      "claimed",
    ]);
  });
});
