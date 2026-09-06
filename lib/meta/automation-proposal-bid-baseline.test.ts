/**
 * An approved bid row is re-proved against the live cap before it is sent.
 *
 * The queue's amount is a percentage of a number that was current when the
 * decision was made. Between the decision and an operator clicking Approve,
 * that number can move in Ads Manager — and `handleMetaAdsetBidAction` writes
 * whatever `bidAmountMinor` it is handed, so nothing downstream of this module
 * can notice. A queued "+10%, 1200 → 1320" dispatched against a live cap of
 * 1500 is a 12% CUT carrying the operator's own confirmation.
 *
 * `scheduled-bid-runtime.ts` has always settled this with a fresh read and
 * three refusals. These cases assert the manual approval path now answers in
 * the same terms, in the same order, and that the check belongs to the bid
 * family alone.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/entity-action-routes", () => ({
  handleMetaEntityPauseAction: vi.fn(),
  handleMetaEntityResumeAction: vi.fn(),
  handleMetaAdsetBidAction: vi.fn(),
}));

const entityRoutes = await import("@/lib/meta/entity-action-routes");
const { executeMetaAutomationProposal } = await import(
  "@/lib/meta/automation-proposal-execution"
);
const { buildBidProposalEnvelope } = await import(
  "@/lib/meta/bid-proposal-envelope"
);
type MetaAutomationProposal =
  import("@/lib/meta/automation-proposals").MetaAutomationProposal;

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const ADSET = "23848";

/** A $12.00 cost cap raised one rung to $13.20 — the queue arm's own case. */
function envelope(overrides: { bidStrategyType?: string } = {}) {
  return buildBidProposalEnvelope({
    proposalId: PROPOSAL_ID,
    businessId: BUSINESS_ID,
    providerAccountId: "act_1",
    entityId: ADSET,
    parentCampaignId: "cmp_1",
    bidStrategyType: overrides.bidStrategyType ?? "cost_cap",
    direction: "increase",
    percent: 10,
    currentMinorUnits: 1200,
    proposedMinorUnits: 1320,
    currency: "USD",
    currencyExponent: 2,
    intentKey: "meta.bid-intent.v1:abc",
    recId: "rec_1",
    recType: "bid_amount",
    snapshotDate: "2026-09-04",
    engineVersion: "meta-v3",
    decisionAt: "2026-09-04T03:00:00.000Z",
  });
}

function proposal(
  overrides: Partial<MetaAutomationProposal> = {},
): MetaAutomationProposal {
  return {
    id: PROPOSAL_ID,
    businessId: BUSINESS_ID,
    providerAccountId: "act_1",
    origin: "engine_decision",
    ruleId: null,
    dedupeKey: null,
    decisionKey: `adset:${ADSET}`,
    scopeType: "adset",
    scopeId: ADSET,
    recId: "rec_1",
    recType: "bid_amount",
    snapshotDate: "2026-09-04",
    engineVersion: "meta-v3",
    decisionLabel: "tune",
    proposedAction: "bid",
    actionLabel: "Raise cost cap",
    primaryCaption: "Approve & apply",
    entityLabel: "Prospecting — broad",
    reason: "CPA is 16% under the benchmark and delivery is constrained.",
    evidenceLabel: null,
    evidenceRef: {},
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    receipt: null,
    bidEnvelope: envelope(),
    budgetEnvelope: null,
    launchIntentId: null,
    claimToken: null,
    claimedBy: null,
    claimedAt: null,
    dispatchStartedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function operatorRequest() {
  return new NextRequest(
    "http://localhost/api/meta/automation/proposals?businessId=" + BUSINESS_ID,
    { method: "POST", headers: { cookie: "adsecute_session=token-abc" } },
  );
}

/** What the provider says the ad set's cap is RIGHT NOW. */
function providerHas(state: {
  bidAmountMinor: number | null;
  bidStrategy: string | null;
}) {
  return vi.fn(async () => state);
}

async function dispatchedBidBody() {
  const [request] = vi.mocked(entityRoutes.handleMetaAdsetBidAction).mock.calls[0]!;
  return (await request.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(entityRoutes.handleMetaAdsetBidAction).mockResolvedValue(
    NextResponse.json(
      { ok: true, action: "apply_bid", adsetId: ADSET, bidAmountMinor: 1320 },
      { status: 200 },
    ) as never,
  );
  vi.mocked(entityRoutes.handleMetaEntityPauseAction).mockResolvedValue(
    NextResponse.json({ ok: true, action: "pause" }, { status: 200 }) as never,
  );
});

describe("an approved bid is re-proved against the live cap", () => {
  it("dispatches the envelope's amount when the baseline still holds", async () => {
    const readBidBaseline = providerHas({
      bidAmountMinor: 1200,
      bidStrategy: "COST_CAP",
    });

    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
      readBidBaseline,
    });

    expect(result.ok).toBe(true);
    expect(readBidBaseline).toHaveBeenCalledWith({
      providerAccountId: "act_1",
      adsetId: ADSET,
    });
    expect(await dispatchedBidBody()).toMatchObject({ bidAmountMinor: 1320 });
  });

  it("sends nothing when somebody moved the cap after the decision", async () => {
    /*
      The finding's own case. 1320 is 10% above 1200; against a live cap of
      1500 it is a reduction, and the operator approved a raise. Refused rather
      than recomputed — sizing a bid is the producer's job.
    */
    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
      readBidBaseline: providerHas({
        bidAmountMinor: 1500,
        bidStrategy: "COST_CAP",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.receipt.withheld).toBe("bid_baseline_changed");
    expect(result.receipt.endpoint).toBeNull();
    expect(entityRoutes.handleMetaAdsetBidAction).not.toHaveBeenCalled();
  });

  it("sends nothing when the strategy no longer owns a writable amount", async () => {
    // The ad set was moved to lowest cost after the decision. There is no cap
    // to raise, and writing one would be a different change entirely.
    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
      readBidBaseline: providerHas({
        bidAmountMinor: 1200,
        bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      }),
    });

    expect(result.receipt.withheld).toBe("bid_strategy_not_writable");
    expect(entityRoutes.handleMetaAdsetBidAction).not.toHaveBeenCalled();
  });

  it("accepts the provider's own spelling of a bid cap", async () => {
    // The warehouse says `bid_cap`, Meta says `LOWEST_COST_WITH_BID_CAP`. A
    // string compare would refuse every real bid cap in the account while
    // reporting it as "the strategy changed".
    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal({ bidEnvelope: envelope({ bidStrategyType: "bid_cap" }) }),
      dryRunOnly: false,
      readBidBaseline: providerHas({
        bidAmountMinor: 1200,
        bidStrategy: "LOWEST_COST_WITH_BID_CAP",
      }),
    });

    expect(result.ok).toBe(true);
    expect(entityRoutes.handleMetaAdsetBidAction).toHaveBeenCalledTimes(1);
  });

  it("refuses when the live cap cannot be read at all", async () => {
    // "We could not check" and "it is fine" are different answers.
    for (const reader of [
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error("meta_unreachable");
      }),
      vi.fn(async () => ({ bidAmountMinor: null, bidStrategy: "COST_CAP" })),
    ]) {
      vi.clearAllMocks();
      const result = await executeMetaAutomationProposal({
        request: operatorRequest(),
        businessId: BUSINESS_ID,
        proposal: proposal(),
        dryRunOnly: false,
        readBidBaseline: reader as never,
      });

      expect(result.receipt.withheld).toBe("bid_baseline_unreadable");
      expect(entityRoutes.handleMetaAdsetBidAction).not.toHaveBeenCalled();
    }
  });

  it("refuses rather than dispatching an amount no caller can prove", async () => {
    // A caller that wired no baseline reader has not proved anything about the
    // live cap, and that is exactly the state this check exists to refuse.
    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
    });

    expect(result.receipt.withheld).toBe("bid_baseline_reader_unavailable");
    expect(entityRoutes.handleMetaAdsetBidAction).not.toHaveBeenCalled();
  });

  it("rehearses against the same baseline it would write against", async () => {
    // The guardrail's whole value is telling the operator what WOULD happen. A
    // rehearsal of a stale amount would report a raise that is really a cut.
    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: true,
      readBidBaseline: providerHas({
        bidAmountMinor: 1500,
        bidStrategy: "COST_CAP",
      }),
    });

    expect(result.receipt.withheld).toBe("bid_baseline_changed");
    expect(result.receipt.dryRun).toBe(true);
    expect(entityRoutes.handleMetaAdsetBidAction).not.toHaveBeenCalled();
  });

  it("still refuses a row with no envelope before reading anything", async () => {
    const readBidBaseline = providerHas({
      bidAmountMinor: 1200,
      bidStrategy: "COST_CAP",
    });

    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal({ bidEnvelope: null }),
      dryRunOnly: false,
      readBidBaseline,
    });

    expect(result.receipt.withheld).toBe("bid_envelope_absent");
    expect(readBidBaseline).not.toHaveBeenCalled();
  });
});

describe("the baseline check belongs to the bid family alone", () => {
  it("never reads a cap for a pause row", async () => {
    const readBidBaseline = providerHas({
      bidAmountMinor: 1200,
      bidStrategy: "COST_CAP",
    });

    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal({ proposedAction: "pause", bidEnvelope: null }),
      dryRunOnly: false,
      readBidBaseline,
    });

    expect(result.ok).toBe(true);
    expect(entityRoutes.handleMetaEntityPauseAction).toHaveBeenCalledTimes(1);
    expect(readBidBaseline).not.toHaveBeenCalled();
  });
});
