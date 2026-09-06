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
 * These cases drive the real producer and the real runtime against a provider
 * double, and assert on the amount, the strategy and the durable row.
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
  projectMetaBidProposals,
  type TypedBidCandidate,
} from "@/lib/meta/bid-proposal-producer";
import { createScheduledBidRuntime } from "@/lib/meta/scheduled-bid-runtime";
import type { ScheduledAuthorityGates } from "@/lib/meta/scheduled-action-execution";

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
    recType: "bid_amount",
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

describe("the queue can finally carry an amount", () => {
  it("raises one row per authorised typed intent, with the envelope on it", async () => {
    const inserted: Array<{ proposalId: string; envelopeJson: string; actionLabel: string }> = [];
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
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

  it("refuses a candidate whose own arithmetic disagrees", async () => {
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
      readBidMode: async () => "auto",
      // 10% of 1200 is 1320, not 1500. Three numbers that are not one
      // instruction describe a change of ambiguous size.
      listCandidates: async () => [candidate({ proposedMinorUnits: 1500 })],
      insertProposal: async () => PROPOSAL_ID,
    });
    expect(result.projected).toBe(0);
    expect(result.refusals).toEqual({ percent_math_inconsistent: 1 });
  });

  it("raises nothing while the bid mode is manual", async () => {
    const insert = vi.fn(async () => PROPOSAL_ID);
    const result = await projectMetaBidProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-04",
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
