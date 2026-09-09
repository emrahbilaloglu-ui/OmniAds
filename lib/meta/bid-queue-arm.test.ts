/**
 * Finding 4, the bid family: reproduced, then built.
 *
 * `bid` has been an allowed `proposed_action` since the table was created. No
 * producer ever raised one and no executor could have run one — the sweep's
 * status runtime withholds anything that is not a pause or a resume — so
 * unattended bid execution was "excluded" in the sense that it did not exist.
 * The root cause was not caution: a queue row carried a verb and a target id,
 * and nothing in it said how far to move a cost cap.
 *
 * These cases drive the forward-compatible producer and runtime against a
 * synthetic semantic B1 ad-set row. The production snapshot seam separately
 * proves that no current emitter creates that row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/ads-action-log", () => ({
  createMetaAdsActionLog: vi.fn(async () => ({ id: "log-bid-1" })),
  completeMetaAdsActionLog: vi.fn(async () => ({ id: "log-bid-1" })),
}));
vi.mock("@/lib/meta/ads-write", () => ({
  readMetaAdsetBidState: vi.fn(),
  updateAdsetBidAmount: vi.fn(),
}));
vi.mock("@/lib/meta/automation-write-guard", () => ({
  readMetaWritePosture: vi.fn(async () => ({ blocked: false, rehearsal: false })),
}));

import * as log from "@/lib/meta/ads-action-log";
import * as adsWrite from "@/lib/meta/ads-write";
import * as writeGuard from "@/lib/meta/automation-write-guard";
import { AUTOMATABLE_PROPOSAL_ACTIONS } from "@/lib/meta/automation-proposals";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import {
  bidEnvelopeForProposalRow,
  buildBidProposalEnvelope,
  parseBidProposalEnvelope,
} from "@/lib/meta/bid-proposal-envelope";
import {
  TYPED_BID_CANDIDATE_SQL,
  insertBidProposalRow,
  projectMetaBidProposals,
  type TypedBidCandidate,
} from "@/lib/meta/bid-proposal-producer";
import { createScheduledBidRuntime } from "@/lib/meta/scheduled-bid-runtime";
import type { ScheduledAuthorityGates } from "@/lib/meta/scheduled-action-execution";
import { runClaimedProposalExecution, type ClaimedExecutionDeps } from "@/lib/meta/budget-execution-lifecycle";
import type { BudgetProposalExecutionResult } from "@/lib/meta/budget-proposal-runtime";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_9";
const ADSET = "set_77";

/** A2.5's worked case: a $12.00 cost cap raised one rung to $13.20. */
function candidate(overrides: Partial<TypedBidCandidate> = {}): TypedBidCandidate {
  return {
    businessId: BUSINESS,
    scopeId: ADSET,
    parentCampaignId: "cmp_1",
    providerAccountId: ACCOUNT,
    recId: "rec-1",
    recType: "scenario_b1_capped_winner_bid_raise",
    snapshotDate: "2026-09-04",
    engineVersion: "v1",
    decisionLabel: "tune",
    decisionAt: "2026-09-04T03:00:00.000Z",
    bidStrategyType: "cost_cap",
    direction: "increase",
    percent: 10,
    currentMinorUnits: 1200,
    proposedMinorUnits: 1320,
    currency: "USD",
    currencyExponent: 2,
    intentKey: "meta.bid-intent.v1:abc",
    reasoning: "CPA is 16% under the benchmark and delivery is constrained.",
    entityLabel: "Prospecting — broad",
    evidence: { cpa28d: 8.4 },
    ...overrides,
  };
}

function envelopeFor(overrides: Partial<TypedBidCandidate> = {}) {
  const source = candidate(overrides);
  return buildBidProposalEnvelope({
    proposalId: PROPOSAL_ID,
    businessId: source.businessId,
    providerAccountId: source.providerAccountId,
    entityId: source.scopeId,
    parentCampaignId: source.parentCampaignId,
    bidStrategyType: source.bidStrategyType,
    direction: source.direction,
    percent: source.percent,
    currentMinorUnits: source.currentMinorUnits,
    proposedMinorUnits: source.proposedMinorUnits,
    currency: source.currency,
    currencyExponent: source.currencyExponent,
    intentKey: source.intentKey,
    recId: source.recId,
    recType: source.recType,
    snapshotDate: source.snapshotDate,
    engineVersion: source.engineVersion,
    decisionAt: source.decisionAt,
  });
}

function proposal(overrides: Partial<MetaAutomationProposal> = {}): MetaAutomationProposal {
  return {
    id: PROPOSAL_ID,
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    scopeType: "adset",
    scopeId: ADSET,
    proposedAction: "bid",
    recId: "rec-1",
    recType: "scenario_b1_capped_winner_bid_raise",
    snapshotDate: "2026-09-04",
    engineVersion: "v1",
    bidEnvelope: envelopeFor(),
    ...overrides,
  } as unknown as MetaAutomationProposal;
}

function gates(overrides: Partial<ScheduledAuthorityGates> = {}): ScheduledAuthorityGates {
  return {
    releaseGateOpen: true,
    autoExecutionEnabled: true,
    enabledProviderAccountId: ACCOUNT,
    enablingActorUserId: ACTOR,
    activationControlVersion: "v-7",
    dryRunOnly: false,
    ...overrides,
  };
}

const SCHEDULED = {
  kind: "scheduled",
  expectedEnablingActorUserId: ACTOR,
  expectedActivationControlVersion: "v-7",
} as const;

function runtime() {
  return createScheduledBidRuntime({
    ctx: {} as never,
    readGates: async () => gates(),
    readMode: async () => "auto",
    now: () => new Date("2026-09-05T10:00:00.000Z"),
  });
}

/** The provider double: it answers a GET, and records what was written. */
function providerHas(state: {
  bidAmountMinor: number | null;
  bidStrategy: string | null;
}) {
  vi.mocked(adsWrite.readMetaAdsetBidState).mockResolvedValue({
    ok: true,
    adsetId: ADSET,
    providerAccountId: ACCOUNT,
    bidAmountMinor: state.bidAmountMinor,
    bidStrategy: state.bidStrategy,
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    observedAt: "2026-09-05T09:59:00.000Z",
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(log.createMetaAdsActionLog).mockResolvedValue({ id: "log-bid-1" } as never);
  vi.mocked(log.completeMetaAdsActionLog).mockResolvedValue({ id: "log-bid-1" } as never);
  vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
    { blocked: false, rehearsal: false } as never,
  );
  providerHas({ bidAmountMinor: 1200, bidStrategy: "COST_CAP" });
  vi.mocked(adsWrite.updateAdsetBidAmount).mockResolvedValue({
    ok: true,
    verifiedBidAmount: 1320,
    responsePayload: { success: true },
    verificationPayload: { id: ADSET, bid_amount: 1320, bid_strategy: "COST_CAP" },
  } as never);
});

describe("the future bid queue requires an explicit amount contract", () => {
  it("admits persisted typed bid intents only from act decisions", () => {
    expect(TYPED_BID_CANDIDATE_SQL).toMatch(
      /AND\s+d\.decision_state\s*=\s*'act'/,
    );
    expect(TYPED_BID_CANDIDATE_SQL).toMatch(
      /provider_account_id\s*=\s*ANY\(\$\d::text\[\]\)/,
    );
    expect(TYPED_BID_CANDIDATE_SQL).toContain(
      "held.proposed_action = 'bid'",
    );
    expect(TYPED_BID_CANDIDATE_SQL).toContain(
      "held.status IN ('pending', 'claimed', 'reconcile')",
    );
    expect(TYPED_BID_CANDIDATE_SQL).toMatch(
      /held\.status\s*=\s*'pending'[\s\S]*held\.origin\s*=\s*'engine_decision'[\s\S]*held\.rec_type\s*=\s*d\.rec_type[\s\S]*held\.snapshot_date\s*=\s*d\.snapshot_date/,
    );
  });

  it("cannot project a stale candidate from an account this run did not finish", async () => {
    const inserted: TypedBidCandidate[] = [];
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
      providerAccountIds: [ACCOUNT],
      readBidMode: async () => "auto",
      listCandidates: async () => [
        candidate(),
        candidate({ providerAccountId: "act_failed_this_run", scopeId: "set_stale" }),
      ],
      insertProposal: async (input) => {
        inserted.push(input.candidate);
        return PROPOSAL_ID;
      },
    });

    expect(result.candidates).toBe(1);
    expect(result.projected).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.providerAccountId).toBe(ACCOUNT);
  });

  it("refuses injected candidates from another business or snapshot day", async () => {
    const inserted: TypedBidCandidate[] = [];
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
      providerAccountIds: [ACCOUNT],
      readBidMode: async () => "auto",
      listCandidates: async () => [
        candidate(),
        candidate({ businessId: "other-business" }),
        candidate({ snapshotDate: "2026-09-03" }),
      ],
      insertProposal: async (input) => {
        inserted.push(input.candidate);
        return PROPOSAL_ID;
      },
    });

    expect(result.candidates).toBe(1);
    expect(result.projected).toBe(1);
    expect(result.refusals).toEqual({ candidate_scope_mismatch: 2 });
    expect(inserted).toEqual([candidate()]);
  });

  it("does not read candidates when no account finished this run", async () => {
    const listCandidates = vi.fn(async () => []);
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
      providerAccountIds: [],
      readBidMode: async () => "auto",
      listCandidates,
      insertProposal: async () => PROPOSAL_ID,
    });

    expect(result.candidates).toBe(0);
    expect(result.refusals).toEqual({ account_generation_not_fulfilled: 1 });
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it("raises one row per authorised typed intent, with the envelope on it", async () => {
    const inserted: Array<{ proposalId: string; envelopeJson: string; actionLabel: string }> = [];
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
      providerAccountIds: [ACCOUNT],
      readBidMode: async () => "auto",
      listCandidates: async () => [candidate()],
      newProposalId: () => PROPOSAL_ID,
      insertProposal: async (input) => {
        inserted.push({
          proposalId: input.proposalId,
          envelopeJson: input.envelopeJson,
          actionLabel: input.actionLabel,
        });
        return input.proposalId;
      },
    });

    expect(result.projected).toBe(1);
    expect(inserted[0]!.actionLabel).toBe("Apply bid");
    const stored = parseBidProposalEnvelope(JSON.parse(inserted[0]!.envelopeJson));
    // The exact amount, not a direction and a hope.
    expect(stored).toMatchObject({
      entityId: ADSET,
      currentMinorUnits: 1200,
      proposedMinorUnits: 1320,
      percent: 10,
      bidStrategyType: "cost_cap",
    });
    // And it names the row it was written for, before the row existed.
    expect(stored!.proposalId).toBe(PROPOSAL_ID);
  });

  it("keeps projecting the family when another writer wins an open slot", async () => {
    const openSlotConflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "uq_meta_automation_proposals_open_slot",
    });
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
      providerAccountIds: [ACCOUNT],
      readBidMode: async () => "auto",
      listCandidates: async () => [candidate()],
      insertProposal: async () => { throw openSlotConflict; },
    });

    expect(result.candidates).toBe(1);
    expect(result.projected).toBe(0);
    expect(result.refusals).toEqual({ insert_conflicted: 1 });
  });

  it("refuses a tampered or row-mismatched bid envelope before database access", async () => {
    const valid = envelopeFor();
    const tampered = { ...valid, proposedMinorUnits: valid.proposedMinorUnits + 1 };

    await expect(insertBidProposalRow({
      businessId: BUSINESS,
      proposalId: PROPOSAL_ID,
      candidate: candidate(),
      envelopeJson: JSON.stringify(tampered),
      actionLabel: "Apply bid",
    })).resolves.toBeNull();
    await expect(insertBidProposalRow({
      businessId: BUSINESS,
      proposalId: PROPOSAL_ID,
      candidate: candidate({ scopeId: "set_other" }),
      envelopeJson: JSON.stringify(valid),
      actionLabel: "Apply bid",
    })).resolves.toBeNull();
  });

  it("refuses a candidate whose own arithmetic disagrees", async () => {
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
      providerAccountIds: [ACCOUNT],
      readBidMode: async () => "auto",
      // 10% of 1200 is 1320, not 1500. Three numbers that are not one
      // instruction describe a change of ambiguous size.
      listCandidates: async () => [candidate({ proposedMinorUnits: 1500 })],
      insertProposal: async () => PROPOSAL_ID,
    });
    expect(result.projected).toBe(0);
    expect(result.refusals).toEqual({ percent_math_inconsistent: 1 });
  });

  it("refuses an injected candidate that borrows a non-bid recommendation", async () => {
    const insert = vi.fn(async () => PROPOSAL_ID);
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
      providerAccountIds: [ACCOUNT],
      readBidMode: async () => "auto",
      listCandidates: async () => [candidate({ recType: "adset_cut_spend" })],
      insertProposal: insert,
    });

    expect(result.candidates).toBe(0);
    expect(result.refusals).toEqual({ bid_action_semantic_missing: 1 });
    expect(insert).not.toHaveBeenCalled();
  });

  it("raises nothing while the bid mode is manual", async () => {
    const insert = vi.fn(async () => PROPOSAL_ID);
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
      providerAccountIds: [ACCOUNT],
      readBidMode: async () => "manual",
      listCandidates: async () => [candidate()],
      insertProposal: insert,
    });
    expect(result.refusals).toEqual({ bid_mode_manual: 1 });
    expect(insert).not.toHaveBeenCalled();
  });

  it("counts against the same daily cap every other money-moving family does", () => {
    expect([...AUTOMATABLE_PROPOSAL_ACTIONS]).toContain("bid");
  });
});

describe("an envelope belongs to exactly one row", () => {
  it("refuses one copied onto another proposal", () => {
    const envelope = envelopeFor();
    expect(bidEnvelopeForProposalRow(envelope, {
      id: "44444444-4444-4444-8444-444444444444",
      businessId: BUSINESS, providerAccountId: ACCOUNT,
      scopeType: "adset", scopeId: ADSET,
      recId: "rec-1", recType: "scenario_b1_capped_winner_bid_raise",
      snapshotDate: "2026-09-04", engineVersion: "v1",
    })).toBeNull();
  });

  it("refuses one whose amount was edited in the database", () => {
    const tampered = { ...envelopeFor(), proposedMinorUnits: 5000 };
    expect(parseBidProposalEnvelope(tampered)).toBeNull();
  });

  it("refuses one pointing at another ad set", () => {
    const envelope = envelopeFor();
    expect(bidEnvelopeForProposalRow(envelope, {
      id: PROPOSAL_ID, businessId: BUSINESS, providerAccountId: ACCOUNT,
      scopeType: "adset", scopeId: "set_other",
      recId: "rec-1", recType: "scenario_b1_capped_winner_bid_raise",
      snapshotDate: "2026-09-04", engineVersion: "v1",
    })).toBeNull();
  });
});

describe("the unattended executor", () => {
  it("writes the envelope's amount and journals a verified success", async () => {
    const result = await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.ok).toBe(true);
    const write = vi.mocked(adsWrite.updateAdsetBidAmount).mock.calls[0]![1];
    expect(write.bidAmountMinor).toBe(1320);
    // The provider's OWN spelling of the strategy, read a moment earlier. The
    // read-back must still show it: the same number under another strategy is
    // a different instruction to the auction.
    expect(write.expectedBidStrategy).toBe("COST_CAP");

    const claim = vi.mocked(log.createMetaAdsActionLog).mock.calls[0]![0];
    expect(claim.action).toBe("bid");
    // Never the manual origin: nobody confirmed this one.
    expect(claim.source).toBe("scheduled_automation_v1");
    expect(claim.requestedBy).toBeNull();
    // Written before the POST, so a compensating action knows what to restore.
    expect(claim.payloadRequest).toMatchObject({
      prior_state: { bid_amount: 1200, bid_strategy: "COST_CAP" },
      rollback: { operation: "set", field: "bid_amount", bid_amount: 1200 },
    });
    expect(vi.mocked(log.completeMetaAdsActionLog).mock.calls[0]![0].status)
      .toBe("success");
  });

  it("sends nothing when the strategy no longer owns a writable amount", async () => {
    // The operator moved the ad set to lowest cost after the decision. There
    // is no cap to raise, and writing one would be a different change.
    providerHas({ bidAmountMinor: 1200, bidStrategy: "LOWEST_COST_WITHOUT_CAP" });

    const result = await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.receipt.withheld).toBe("bid_strategy_not_writable");
    expect(vi.mocked(adsWrite.updateAdsetBidAmount)).not.toHaveBeenCalled();
    expect(vi.mocked(log.createMetaAdsActionLog)).not.toHaveBeenCalled();
  });

  it("accepts the provider's own spelling of a bid cap", async () => {
    /*
      The warehouse says `bid_cap`; Meta says `LOWEST_COST_WITH_BID_CAP`. They
      are one strategy, and comparing the two spellings by string equality
      would refuse every real bid cap in the account while reporting it as
      "the strategy changed".
    */
    providerHas({ bidAmountMinor: 1200, bidStrategy: "LOWEST_COST_WITH_BID_CAP" });
    const result = await runtime()({
      proposal: proposal({ bidEnvelope: envelopeFor({ bidStrategyType: "bid_cap" }) }),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses when somebody already moved the cap", async () => {
    // 1320 is 10% above 1200. It is not 10% above 1500, so applying it now
    // would be a change of the wrong size — and recomputing here would be this
    // runtime sizing a bid, which is the producer's job.
    providerHas({ bidAmountMinor: 1500, bidStrategy: "COST_CAP" });

    const result = await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.receipt.withheld).toBe("bid_baseline_changed");
    expect(vi.mocked(adsWrite.updateAdsetBidAmount)).not.toHaveBeenCalled();
  });

  it("refuses when the current value cannot be read at all", async () => {
    vi.mocked(adsWrite.readMetaAdsetBidState).mockResolvedValue({
      ok: false, adsetId: ADSET,
      error: { code: "current_entity_state_unverified", message: "x" },
      httpStatus: 500,
    } as never);

    const result = await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    // "We could not check" and "it is fine" are different answers.
    expect(result.receipt.withheld).toBe("bid_baseline_unreadable");
    expect(vi.mocked(adsWrite.updateAdsetBidAmount)).not.toHaveBeenCalled();
  });

  it("refuses a row with no envelope rather than inventing an amount", async () => {
    const result = await runtime()({
      proposal: proposal({ bidEnvelope: null }),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("bid_envelope_absent");
    expect(vi.mocked(adsWrite.readMetaAdsetBidState)).not.toHaveBeenCalled();
  });

  it("revokes a legacy row whose recommendation never authorised a bid", async () => {
    const result = await runtime()({
      proposal: proposal({ recType: "adset_cut_spend" }),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.receipt.withheld).toBe("bid_semantic_authority_absent");
    expect(vi.mocked(adsWrite.readMetaAdsetBidState)).not.toHaveBeenCalled();
    expect(vi.mocked(adsWrite.updateAdsetBidAmount)).not.toHaveBeenCalled();
    expect(vi.mocked(log.createMetaAdsActionLog)).not.toHaveBeenCalled();
  });

  it("never speaks for an operator", async () => {
    const result = await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: {
        kind: "manual", explicitConfirmation: true, operatorUserId: ACTOR,
      },
    });
    expect(result.receipt.withheld).toBe("manual_confirmation_absent");
  });

  it("answers to the shared server posture like every other write", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
      { blocked: true, reason: "release_capability_closed", rehearsal: true } as never,
    );
    const result = await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("release_gate_closed");
    expect(vi.mocked(adsWrite.updateAdsetBidAmount)).not.toHaveBeenCalled();
  });

  it("parks an ambiguous outcome instead of settling it", async () => {
    vi.mocked(adsWrite.updateAdsetBidAmount).mockResolvedValue({
      ok: false,
      httpStatus: 504,
      error: { code: "provider_outcome_ambiguous", message: "timeout" },
      providerOutcome: "outcome_ambiguous",
      mutationAttempt: { attempted: true },
    } as never);

    const result = await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.ok).toBe(false);
    expect(result.reconcile).toBe(true);
    expect(vi.mocked(log.completeMetaAdsActionLog).mock.calls[0]![0].status)
      .toBe("silent_failure");
  });
});


describe("terminal persistence is required for an ordinary settlement", () => {
  const targets = [{ scopeType: "adset", action: "bid", write: "updateAdsetBidAmount" }] as const;
  const outcomes = [
    { name: "verified live success", ok: true, attempted: true, dryRun: false, ambiguous: false },
    { name: "known live failure", ok: false, attempted: true, dryRun: false, ambiguous: false },
    { name: "ambiguous live failure", ok: false, attempted: true, dryRun: false, ambiguous: true },
    { name: "pre-provider refusal", ok: false, attempted: false, dryRun: false, ambiguous: false },
    { name: "verified rehearsal", ok: true, attempted: false, dryRun: true, ambiguous: false },
    { name: "failed rehearsal", ok: false, attempted: false, dryRun: true, ambiguous: false },
  ] as const;
  for (const target of targets) {
    it.each(outcomes)(`${target.scopeType} ${target.action}: $name retains journal failure without retry`, async (outcome) => {
      vi.mocked(log.completeMetaAdsActionLog).mockRejectedValueOnce(new Error("statement timeout"));
      const providerResponse = { evidence: outcome.name };
      let providerPosts = 0;
      vi.mocked(adsWrite[target.write]).mockImplementation((async (...args: unknown[]) => {
        const options = args[1] as { beforeMutationAttempt?: () => Promise<void> };
        if (outcome.attempted) {
          await options.beforeMutationAttempt?.();
          providerPosts += 1;
        }
        return {
          ok: outcome.ok, dryRun: outcome.dryRun, responsePayload: providerResponse,
          verificationPayload: outcome.ok ? { verified: true } : null,
          httpStatus: outcome.ambiguous ? 504 : 422,
          error: outcome.ok ? undefined : {
            code: outcome.ambiguous ? "provider_outcome_ambiguous" : "provider_refused",
            message: "Provider fixture refusal",
          },
          providerOutcome: outcome.ambiguous ? "outcome_ambiguous" : undefined,
          mutationAttempt: outcome.attempted ? { attemptCount: 1 } : null,
        };
      }) as never);
      const row = proposal();
      const results: BudgetProposalExecutionResult[] = [];
      const settle = vi.fn<ClaimedExecutionDeps["settle"]>(async () => row);
      const recordLedger = vi.fn<ClaimedExecutionDeps["recordLedger"]>(async () => true);
      const markDispatchStarted = vi.fn(async () => true);
      const settled = await runClaimedProposalExecution({
        businessId: row.businessId, providerAccountId: row.providerAccountId,
        proposal: row, claimToken: "claim-1", actorUserId: ACTOR, executionKind: "scheduled",
        markDispatchStarted, settle, recordLedger,
        forceReconcile: async () => true, recordReconciliation: async () => true,
        execute: async (beforeProviderPost) => {
          const result = await runtime()({
            proposal: row, claimToken: "claim-1", authorization: SCHEDULED,
            dryRunOnly: outcome.dryRun, beforeProviderPost,
          });
          results.push(result);
          return result;
        },
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        ok: false, reconcile: true, journalId: "log-bid-1", rollbackRequested: false,
        receipt: { httpStatus: 503, response: providerResponse, dryRun: outcome.dryRun,
          providerMutationAttempted: outcome.attempted, receiptKey: "claim-1", withheld: null },
      });
      expect(adsWrite[target.write]).toHaveBeenCalledTimes(1);
      expect(providerPosts).toBe(outcome.attempted ? 1 : 0);
      expect(markDispatchStarted).toHaveBeenCalledTimes(outcome.attempted ? 1 : 0);
      expect(log.completeMetaAdsActionLog).toHaveBeenCalledTimes(1);
      expect(log.completeMetaAdsActionLog).toHaveBeenCalledWith(expect.objectContaining({
        id: "log-bid-1", status: outcome.ok ? "success" : outcome.ambiguous ? "silent_failure" : "failure",
        payloadResponse: providerResponse,
      }));
      expect(settled.ok).toBe(false);
      expect(settled.providerDispatchStarted).toBe(outcome.attempted);
      expect(settled.settledStatus).toBe(outcome.attempted ? "reconcile" : "failed");
      expect(settle).toHaveBeenCalledWith(expect.objectContaining({
        status: outcome.attempted ? "reconcile" : "failed",
      }));
      expect(recordLedger).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        activityType: outcome.attempted ? "automation_proposal_reconcile" : "automation_proposal_failed",
        severity: "danger",
      }));
    });
  }
});
