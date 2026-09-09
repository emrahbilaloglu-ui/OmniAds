/**
 * The strategy a bid amount was proved under reaches the provider write.
 *
 * WHAT WAS WRONG. The approval path re-proves an approved bid against the live
 * ad set — `automation-proposal-execution.ts` reads the current cap and
 * strategy and refuses a mismatch — and then forwarded a body carrying only
 * `bidAmountMinor`. Everything after that check is the handler's own work:
 * access, account context, the action log and a live provider preflight, each
 * an await. An ad set moved from cost cap to bid cap inside that window still
 * took the approved amount, and `updateAdsetBidAmount` — called with no
 * `expectedBidStrategy` — verified the NUMBER, found it, and reported success.
 * The operator was told the raise they approved had been applied, under a
 * bidding strategy nobody approved it for.
 *
 * Moving the check earlier is not the fix on its own; the result has to travel
 * with the request. These cases drive the handler directly for the contract,
 * and then the real executor through the real handler for the thread itself.
 *
 * The operator's own apply-bid entry sends no such field and must be untouched
 * by this, which is asserted rather than assumed.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/integrations", () => ({ getIntegration: vi.fn() }));

vi.mock("@/lib/meta/automation-write-guard", () => ({
  // Unblocked and NOT rehearsing: these cases are about what a real provider
  // write is handed, and a rehearsing posture would make every one a dry run.
  readMetaWritePosture: vi.fn(async () => ({
    blocked: false, rehearsal: false, reason: null, message: null,
  })),
  metaWriteBlockedResponse: vi.fn(() =>
    NextResponse.json({ ok: false, error: { code: "kill_switch_engaged" } }, { status: 503 })),
  metaWriteIsRehearsal: (input: {
    posture: { rehearsal: boolean };
    requestedDryRun: boolean;
  }) => input.posture.rehearsal || input.requestedDryRun === true,
}));

vi.mock("@/lib/meta/account-context", () => ({
  getMetaAccountContext: vi.fn(async () => ({
    accountProfiles: { act_1: { currency: "USD", timezone: null, name: "Account" } },
  })),
  normalizeMetaCurrencyCode: (value: unknown) =>
    typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null,
  resolveMetaAccountAuthority: vi.fn(async () => ({
    state: "authorized" as const, errorMessage: null,
  })),
}));

vi.mock("@/lib/meta/ads-action-log", () => ({
  createMetaAdsActionLog: vi.fn(async () => ({ id: "log_1" })),
  completeMetaAdsActionLog: vi.fn(async () => ({ id: "log_1" })),
  hasRecentPendingMetaAdsAction: vi.fn(async () => false),
}));

vi.mock("@/lib/meta/ads-write", () => ({
  hasSuccessfulMetaProviderMutationAttempt: vi.fn(() => false),
  pauseCampaign: vi.fn(),
  resumeCampaign: vi.fn(),
  pauseAdset: vi.fn(),
  resumeAdset: vi.fn(),
  readMetaEntityExecutionState: vi.fn(async (_ctx, scopeType, entityId) => ({
    ok: true,
    scopeType,
    entityId,
    providerAccountId: "act_1",
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    campaignId: "cmp_1",
    campaignProviderAccountId: "act_1",
    campaignConfiguredStatus: "ACTIVE",
    campaignEffectiveStatus: "ACTIVE",
    observedAt: "2026-09-04T14:00:00.000Z",
  })),
  updateAdsetBidAmount: vi.fn(async () => ({
    ok: true,
    verifiedBidAmount: 1320,
    responsePayload: { success: true },
    verificationPayload: { bid_amount: 1320, bid_strategy: "COST_CAP" },
  })),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const integrations = await import("@/lib/integrations");
const writes = await import("@/lib/meta/ads-write");
const actionLog = await import("@/lib/meta/ads-action-log");
const { handleMetaAdsetBidAction } = await import(
  "@/lib/meta/entity-action-routes"
);
const { executeMetaAutomationProposal } = await import(
  "@/lib/meta/automation-proposal-execution"
);
const { buildBidProposalEnvelope } = await import(
  "@/lib/meta/bid-proposal-envelope"
);
type MetaAutomationProposal =
  import("@/lib/meta/automation-proposals").MetaAutomationProposal;

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";
const ADSET = "adset_1";
const providerHasCurrentCap = async () => ({ bidAmountMinor: 1200, bidStrategy: "COST_CAP" });

/** The operator's own apply-bid body: an amount, and nothing proved about it. */
function bidRequest(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/meta/adsets/${ADSET}/apply-bid`, {
    method: "POST",
    body: JSON.stringify({
      actionOrigin: "manual_operator_v1",
      manualConfirmation: "explicit_operator_confirmation",
      businessId: "biz_1",
      providerAccountId: "act_1",
      ...body,
    }),
  });
}

function callHandler(body: Record<string, unknown>) {
  return handleMetaAdsetBidAction(bidRequest(body), {
    params: Promise.resolve({ adsetId: ADSET }),
  });
}

/** The second argument `updateAdsetBidAmount` was actually handed. */
function bidWriteInput() {
  const call = vi.mocked(writes.updateAdsetBidAmount).mock.calls[0];
  return call?.[1] as Record<string, unknown> | undefined;
}

/** A $12.00 cost cap approved one rung up to $13.20 — the queue arm's case. */
function bidProposal(
  overrides: { bidStrategyType?: string } = {},
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
    recType: "scenario_b1_capped_winner_bid_raise",
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
    bidEnvelope: buildBidProposalEnvelope({
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
      recType: "scenario_b1_capped_winner_bid_raise",
      snapshotDate: "2026-09-04",
      engineVersion: "meta-v3",
      decisionAt: "2026-09-04T03:00:00.000Z",
    }),
    budgetEnvelope: null,
    launchIntentId: null,
    claimToken: null,
    claimedBy: null,
    claimedAt: null,
    dispatchStartedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(actionLog.completeMetaAdsActionLog).mockResolvedValue({ id: "log_1" } as never);
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_1" } },
    membership: { businessId: "biz_1" },
  } as never);
  vi.mocked(db.getDb).mockReturnValue(
    vi.fn(async () => [{ provider_account_id: "act_1", label: "Prospecting" }]) as never,
  );
  vi.mocked(integrations.getIntegration).mockResolvedValue({
    status: "connected",
    provider_account_id: "act_1",
    access_token: "token",
  } as never);
});

describe("the apply-bid handler binds a strategy only when one was proved", () => {
  it("hands the proved strategy to the write, which must read it back", async () => {
    const response = await callHandler({
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
    });

    expect(response.status).toBe(200);
    expect(bidWriteInput()).toMatchObject({
      adsetId: ADSET,
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
    });
  });

  it("leaves the operator's own apply-bid exactly as it was", async () => {
    // The route a person uses from a decision card sends no such field. It has
    // proved nothing about the strategy, so nothing is asserted on its behalf
    // and the write is handed the input shape it has always had.
    const response = await callHandler({ bidAmountMinor: 1320, recId: "rec_bid" });

    expect(response.status).toBe(200);
    expect(bidWriteInput()).not.toHaveProperty("expectedBidStrategy");
    expect(bidWriteInput()).toMatchObject({ adsetId: ADSET, bidAmountMinor: 1320 });
  });

  it("refuses a strategy field it cannot use instead of dropping the check", async () => {
    // Ignoring a malformed value would silently disable the guard the caller
    // asked for — which is the defect this field exists to prevent.
    for (const value of [42, "", "   ", null]) {
      vi.clearAllMocks();
      const response = await callHandler({
        bidAmountMinor: 1320,
        expectedBidStrategy: value,
      });
      const payload = (await response.json()) as { error?: { code?: string } };

      expect(response.status).toBe(400);
      expect(payload.error?.code).toBe("invalid_bid_strategy");
      expect(writes.updateAdsetBidAmount).not.toHaveBeenCalled();
    }
  });
});

describe("an approved queue row carries its check through to the write", () => {
  it.each(["verified", "failed"])("preserves the dispatch when a %s write cannot terminalize its log", async (outcome) => {
    vi.mocked(writes.updateAdsetBidAmount).mockImplementationOnce(async (_ctx, input) => {
      await input.beforeMutationAttempt?.();
      return (outcome === "verified"
        ? { ok: true, verifiedBidAmount: 1320, responsePayload: { success: true }, verificationPayload: { bid_amount: 1320 } }
        : { ok: false, error: { code: "provider_error", message: "Provider refused" }, httpStatus: 400 }) as never;
    });
    vi.mocked(actionLog.completeMetaAdsActionLog).mockRejectedValue(new Error("terminal log unavailable"));
    const markDispatchStarted = vi.fn(async () => true);
    const result = await executeMetaAutomationProposal({
      request: new NextRequest(`http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}`, { method: "POST" }),
      businessId: "biz_1", proposal: bidProposal(), dryRunOnly: false,
      readBidBaseline: providerHasCurrentCap,
      markDispatchStarted,
    });
    expect(markDispatchStarted).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(result.receipt).toMatchObject({ providerMutationAttempted: true, ambiguous: true, dryRun: false });
    expect(result.receipt.response).toMatchObject({ providerOutcome: "outcome_ambiguous", retryAllowed: false });
  });

  it("does not invent a provider attempt when the durable dispatch marker is refused", async () => {
    let posts = 0;
    vi.mocked(writes.updateAdsetBidAmount).mockImplementationOnce(async (_ctx, input) => {
      await input.beforeMutationAttempt?.();
      posts++;
      return { ok: true, verifiedBidAmount: 1320 } as never;
    });
    const result = await executeMetaAutomationProposal({
      request: new NextRequest(`http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}`, { method: "POST" }),
      businessId: "biz_1", proposal: bidProposal(), dryRunOnly: false,
      readBidBaseline: providerHasCurrentCap, markDispatchStarted: async () => false,
    });
    expect(posts).toBe(0);
    expect(result.receipt.providerMutationAttempted).toBe(false);
    expect(result.receipt.ambiguous).not.toBe(true);
  });

  it("binds the strategy the executor proved, in the provider's own spelling", async () => {
    /*
      The finding's own case, driven end to end: the real executor, the real
      handler, and only the provider write mocked. Before the fix the executor
      compared the live strategy and then forwarded an amount alone, so this
      arrived with no `expectedBidStrategy` and a flip after the check would
      have verified and reported success.
    */
    const result = await executeMetaAutomationProposal({
      request: new NextRequest(
        `http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}`,
        { method: "POST", headers: { cookie: "adsecute_session=token-abc" } },
      ),
      businessId: "biz_1",
      proposal: bidProposal(),
      dryRunOnly: false,
      // What Meta says the ad set runs at this moment, which is what the
      // executor compares the envelope against before dispatching.
      readBidBaseline: vi.fn(async () => ({
        bidAmountMinor: 1200,
        bidStrategy: "COST_CAP",
      })),
    });

    expect(result.ok).toBe(true);
    expect(bidWriteInput()).toMatchObject({
      adsetId: ADSET,
      bidAmountMinor: 1320,
      // The LIVE read's spelling, not the envelope's `cost_cap`: the read-back
      // this is compared against is Meta's.
      expectedBidStrategy: "COST_CAP",
    });
  });

  it("carries Meta's spelling of a bid cap, not the warehouse's", async () => {
    // The envelope says `bid_cap`; Meta says `LOWEST_COST_WITH_BID_CAP`. They
    // are one strategy — the family check admits the row — but only Meta's
    // spelling can survive the write's own read-back comparison.
    const result = await executeMetaAutomationProposal({
      request: new NextRequest(
        `http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}`,
        { method: "POST", headers: { cookie: "adsecute_session=token-abc" } },
      ),
      businessId: "biz_1",
      proposal: bidProposal({ bidStrategyType: "bid_cap" }),
      dryRunOnly: false,
      readBidBaseline: vi.fn(async () => ({
        bidAmountMinor: 1200,
        bidStrategy: "LOWEST_COST_WITH_BID_CAP",
      })),
    });

    expect(result.ok).toBe(true);
    expect(bidWriteInput()).toMatchObject({
      expectedBidStrategy: "LOWEST_COST_WITH_BID_CAP",
    });
  });
});
