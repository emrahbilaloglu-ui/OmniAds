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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/integrations", () => ({ getIntegration: vi.fn() }));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  getMetaWriteBlockState: vi.fn(async () => ({ blocked: false })),
}));
vi.mock("@/lib/provider-write-authority", () => ({
  assertProviderWriteAuthorityUnchanged: vi.fn(async () => ({ ok: true })),
}));

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

vi.mock("@/lib/meta/ads-write", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/meta/ads-write")>(),
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
      input.onProviderMutationAttempt?.();
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

describe("the real bid provider boundary survives the handler and proposal receipt", () => {
  const actualWrites = vi.importActual<typeof import("@/lib/meta/ads-write")>("@/lib/meta/ads-write");
  let observedAttempts = vi.fn();
  let order: string[] = [];

  function providerState(amount: number, strategy = "COST_CAP") {
    return new Response(JSON.stringify({
      id: ADSET, account_id: "1", bid_amount: amount,
      bid_strategy: strategy, status: "ACTIVE", effective_status: "ACTIVE",
    }), { status: 200 });
  }

  function providerError(status = 400) {
    return new Response(JSON.stringify({ error: { code: 100, message: "Provider refused" } }), { status });
  }

  function accepted() {
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  function methods() {
    return vi.mocked(fetch).mock.calls.map(([, request]) => request?.method);
  }

  function execute(input: { dryRun?: boolean; markAllowed?: boolean } = {}) {
    const markDispatchStarted = vi.fn(async () => {
      order.push("durable intent");
      return input.markAllowed !== false;
    });
    return {
      markDispatchStarted,
      result: executeMetaAutomationProposal({
        request: new NextRequest(`http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}`, { method: "POST" }),
        businessId: "biz_1", proposal: bidProposal(), dryRunOnly: input.dryRun === true,
        readBidBaseline: providerHasCurrentCap, markDispatchStarted,
      }),
    };
  }

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("META_ADS_WRITE_KILL_SWITCH", "false");
    observedAttempts = vi.fn();
    order = [];
    const actual = await actualWrites;
    // Only the external boundaries remain mocked. This wrapper records the
    // callback from the real adapter and forwards it to the real route.
    vi.mocked(writes.updateAdsetBidAmount).mockImplementation((ctx, input) =>
      actual.updateAdsetBidAmount(ctx, {
        ...input,
        onProviderMutationAttempt: () => {
          observedAttempts();
          order.push("actual attempt");
          input.onProviderMutationAttempt?.();
        },
      }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(["cap drift", "strategy drift", "GET rejection", "GET transport"])(
    "does not turn durable intent into a POST when the final read has %s",
    async (failure) => {
      if (failure === "GET transport") vi.mocked(fetch).mockRejectedValueOnce(new Error("connection reset"));
      else vi.mocked(fetch).mockResolvedValueOnce(failure === "cap drift"
        ? providerState(1500)
        : failure === "strategy drift" ? providerState(1200, "LOWEST_COST_WITH_BID_CAP")
          : providerError(500));
      const attempt = execute();
      const result = await attempt.result;
      expect(attempt.markDispatchStarted).toHaveBeenCalledOnce();
      expect(methods()).toEqual(["GET"]);
      expect(observedAttempts).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.receipt.providerMutationAttempted).toBe(false);
      expect(result.receipt.ambiguous).not.toBe(true);
      expect(result.receipt.response).toMatchObject({
        metaHttpStatus: 409, providerMutationAttempted: false,
        providerOutcome: "definite_failure", mutationAttempt: null,
      });
    },
  );

  it("preserves a known no-POST refusal when terminal failure logging also fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(providerState(1500));
    vi.mocked(actionLog.completeMetaAdsActionLog).mockRejectedValue(new Error("terminal log unavailable"));
    const result = await execute().result;
    expect(methods()).toEqual(["GET"]);
    expect(observedAttempts).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({ httpStatus: 500, providerMutationAttempted: false });
    expect(result.receipt.ambiguous).not.toBe(true);
    expect(result.receipt.response).toMatchObject({ providerMutationAttempted: false, providerWriteAttempted: false });
    expect(vi.mocked(actionLog.completeMetaAdsActionLog).mock.calls.every(([input]) => input.status === "failure")).toBe(true);
  });

  it("does not reach the final GET or POST after a refused durable claim", async () => {
    const attempt = execute({ markAllowed: false });
    const result = await attempt.result;
    expect(attempt.markDispatchStarted).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(observedAttempts).not.toHaveBeenCalled();
    expect(result.receipt.providerMutationAttempted).toBe(false);
    expect(result.receipt.ambiguous).not.toBe(true);
  });

  it("records an actual rejected POST separately from a pre-POST refusal", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(providerState(1200)).mockResolvedValueOnce(providerError());
    const result = await execute().result;
    expect(methods()).toEqual(["GET", "POST"]);
    expect(observedAttempts).toHaveBeenCalledOnce();
    expect(result.receipt.providerMutationAttempted).toBe(true);
    expect(result.receipt.ambiguous).not.toBe(true);
    expect(result.receipt.response).toMatchObject({
      providerMutationAttempted: true, providerOutcome: "definite_failure",
      mutationAttempt: { attemptCount: 1, providerResponseSuccessful: false, automaticRetryAttempted: false },
    });
  });

  it("keeps an unacknowledged POST ambiguous and forbids a retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(providerState(1200)).mockRejectedValueOnce(new Error("POST connection reset"));
    const result = await execute().result;
    expect(methods()).toEqual(["GET", "POST"]);
    expect(observedAttempts).toHaveBeenCalledOnce();
    expect(result.receipt).toMatchObject({ providerMutationAttempted: true, ambiguous: true });
    expect(result.receipt.response).toMatchObject({
      providerOutcome: "outcome_ambiguous", retryAllowed: false,
      mutationAttempt: { attemptCount: 1, automaticRetryAttempted: false },
    });
  });

  it.each(["readback failure", "readback mismatch"])("keeps accepted POST evidence after %s and forbids a retry", async (failure) => {
    vi.mocked(fetch).mockResolvedValueOnce(providerState(1200)).mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(failure === "readback failure" ? providerError(500) : providerState(1500));
    const result = await execute().result;
    expect(methods()).toEqual(["GET", "POST", "GET"]);
    expect(observedAttempts).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(result.receipt.providerMutationAttempted).toBe(true);
    expect(result.receipt.response).toMatchObject({
      providerMutationAttempted: true, retryAllowed: false,
      mutationAttempt: { attemptCount: 1, providerResponseSuccessful: true, automaticRetryAttempted: false },
    });
  });

  it.each(["accepted", "rejected"])("retains no-retry ambiguity after an %s POST loses terminal logging", async (outcome) => {
    vi.mocked(fetch).mockResolvedValueOnce(providerState(1200))
      .mockResolvedValueOnce(outcome === "accepted" ? accepted() : providerError());
    if (outcome === "accepted") vi.mocked(fetch).mockResolvedValueOnce(providerState(1320));
    vi.mocked(actionLog.completeMetaAdsActionLog).mockRejectedValue(new Error("terminal log unavailable"));
    const result = await execute().result;
    expect(methods()).toEqual(outcome === "accepted" ? ["GET", "POST", "GET"] : ["GET", "POST"]);
    expect(observedAttempts).toHaveBeenCalledOnce();
    expect(result.receipt).toMatchObject({ providerMutationAttempted: true, ambiguous: true });
    expect(result.receipt.response).toMatchObject({ providerOutcome: "outcome_ambiguous", retryAllowed: false });
  });

  it("keeps the durable claim before the final GET and observes only the single real POST", async () => {
    let gets = 0;
    vi.mocked(fetch).mockImplementation(async (_url, request) => {
      const method = request?.method ?? "GET";
      order.push(method);
      return method === "POST" ? accepted() : providerState(++gets === 1 ? 1200 : 1320);
    });
    const result = await execute().result;
    expect(result.ok).toBe(true);
    expect(result.receipt.providerMutationAttempted).toBe(true);
    expect(observedAttempts).toHaveBeenCalledOnce();
    expect(order).toEqual(["durable intent", "GET", "actual attempt", "POST", "GET"]);
  });

  it("rehearses without a durable dispatch claim or actual POST observation", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(providerState(1200));
    const attempt = execute({ dryRun: true });
    const result = await attempt.result;
    expect(result.ok).toBe(true);
    expect(attempt.markDispatchStarted).not.toHaveBeenCalled();
    expect(methods()).toEqual(["GET"]);
    expect(observedAttempts).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({ providerMutationAttempted: false, dryRun: true });
  });
});
