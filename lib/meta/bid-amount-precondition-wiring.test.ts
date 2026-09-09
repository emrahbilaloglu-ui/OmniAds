/**
 * Both callers that re-read a cap carry it all the way to the write boundary.
 *
 * The pre-POST comparison in `updateAdsetBidAmount` only exists for a caller
 * that hands it an expected current amount — see
 * `bid-amount-precondition.test.ts` for the adapter's own behaviour. That makes
 * the wiring load-bearing: a caller that proves a baseline and then forwards
 * only the new amount reopens exactly the window the comparison closes, and it
 * does so silently, because the write's read-back verifies the number it sent
 * and reports success.
 *
 * There are two such callers and they are covered here: the manual approval
 * path (`automation-proposal-execution.ts` → `handleMetaAdsetBidAction` →
 * `updateAdsetBidAmount`) and the unattended sweep
 * (`scheduled-bid-runtime.ts`). The operator's own apply-bid entry proves no
 * baseline and must stay untouched, which is asserted rather than assumed.
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
  // The unattended path's own baseline read, which it then has to carry.
  readMetaAdsetBidState: vi.fn(async () => ({
    ok: true,
    adsetId: "adset_1",
    providerAccountId: "act_1",
    bidAmountMinor: 1200,
    bidStrategy: "COST_CAP",
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
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
const actionLog = await import("@/lib/meta/ads-action-log");
const writes = await import("@/lib/meta/ads-write");
const writeGuard = await import("@/lib/meta/automation-write-guard");
const { handleMetaAdsetBidAction } = await import(
  "@/lib/meta/entity-action-routes"
);
const { executeMetaAutomationProposal } = await import(
  "@/lib/meta/automation-proposal-execution"
);
const { createScheduledBidRuntime } = await import(
  "@/lib/meta/scheduled-bid-runtime"
);
const { buildBidProposalEnvelope } = await import(
  "@/lib/meta/bid-proposal-envelope"
);
type MetaAutomationProposal =
  import("@/lib/meta/automation-proposals").MetaAutomationProposal;

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const PROPOSAL_ID = "55555555-5555-4555-8555-555555555555";
const ENABLING_ACTOR = "9f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071";
const ADSET = "adset_1";

/** The second argument `updateAdsetBidAmount` was actually handed. */
function bidWriteInput() {
  const call = vi.mocked(writes.updateAdsetBidAmount).mock.calls[0];
  return call?.[1] as Record<string, unknown> | undefined;
}

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

/** A $12.00 cost cap approved one rung up to $13.20 — the queue arm's case. */
function bidProposal(): MetaAutomationProposal {
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
      bidStrategyType: "cost_cap",
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

describe("the apply-bid handler binds a current cap only when one was proved", () => {
  it("hands the proved cap to the write, which must still see it pre-POST", async () => {
    const response = await callHandler({
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
      expectedCurrentBidAmountMinor: 1200,
    });

    expect(response.status).toBe(200);
    expect(bidWriteInput()).toMatchObject({
      adsetId: ADSET,
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
      expectedCurrentBidAmountMinor: 1200,
    });
  });

  it("leaves the operator's own apply-bid exactly as it was", async () => {
    // A person typing a cap on a decision card has proved nothing about the
    // current one, so nothing is asserted on their behalf — and the write makes
    // no extra provider request on their behalf either.
    const response = await callHandler({ bidAmountMinor: 1320, recId: "rec_bid" });

    expect(response.status).toBe(200);
    expect(bidWriteInput()).not.toHaveProperty("expectedCurrentBidAmountMinor");
    expect(bidWriteInput()).toMatchObject({ adsetId: ADSET, bidAmountMinor: 1320 });
  });

  it("refuses a cap field it cannot use instead of dropping the check", async () => {
    // Ignoring a malformed value would silently disable the guard the caller
    // asked for — which is the defect the field exists to prevent.
    for (const value of ["1200", 0, -1200, 12.5, null]) {
      vi.clearAllMocks();
      const response = await callHandler({
        bidAmountMinor: 1320,
        expectedCurrentBidAmountMinor: value,
      });
      const payload = (await response.json()) as { error?: { code?: string } };

      expect(response.status).toBe(400);
      expect(payload.error?.code).toBe("invalid_expected_bid_amount");
      expect(writes.updateAdsetBidAmount).not.toHaveBeenCalled();
    }
  });
});

describe("an approved queue row carries its cap through to the write", () => {
  it("binds the live cap the executor proved, not the envelope's copy of it", async () => {
    /*
      The finding's own case, driven end to end: the real executor, the real
      handler, and only the provider write mocked. Before the fix the executor
      compared the live cap and then forwarded the new amount alone, so an
      operator moving the cap during the handler's own awaits was overwritten
      and the read-back reported success.
    */
    const result = await executeMetaAutomationProposal({
      request: new NextRequest(
        `http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}`,
        { method: "POST", headers: { cookie: "adsecute_session=token-abc" } },
      ),
      businessId: "biz_1",
      proposal: bidProposal(),
      dryRunOnly: false,
      readBidBaseline: vi.fn(async () => ({
        bidAmountMinor: 1200,
        bidStrategy: "COST_CAP",
      })),
    });

    expect(result.ok).toBe(true);
    expect(bidWriteInput()).toMatchObject({
      adsetId: ADSET,
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
      expectedCurrentBidAmountMinor: 1200,
    });
  });

  it("stamps durable intent before observing the provider POST", async () => {
    const order: string[] = [];
    vi.mocked(writes.updateAdsetBidAmount).mockImplementationOnce(
      async (_ctx, writeInput) => {
        order.push("write-entered");
        await writeInput.beforeMutationAttempt?.();
        // Intent alone does not prove a POST. Model the adapter's separate
        // synchronous observation at the simulated request boundary; the real
        // final-GET ordering is covered by bid-amount-precondition.test.ts.
        expect(writeInput.onProviderMutationAttempt).toEqual(expect.any(Function));
        writeInput.onProviderMutationAttempt?.();
        order.push("provider-attempt-observed");
        order.push("provider-post");
        return {
          ok: true,
          verifiedBidAmount: 1320,
          responsePayload: { success: true },
          verificationPayload: { bid_amount: 1320, bid_strategy: "COST_CAP" },
        } as never;
      },
    );

    const result = await executeMetaAutomationProposal({
      request: new NextRequest(
        `http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}`,
        { method: "POST", headers: { cookie: "adsecute_session=token-abc" } },
      ),
      businessId: "biz_1",
      proposal: bidProposal(),
      dryRunOnly: false,
      readBidBaseline: vi.fn(async () => ({
        bidAmountMinor: 1200,
        bidStrategy: "COST_CAP",
      })),
      markDispatchStarted: vi.fn(async () => {
        order.push("claim-marked");
        return true;
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.receipt.providerMutationAttempted).toBe(true);
    expect(order).toEqual([
      "write-entered", "claim-marked", "provider-attempt-observed", "provider-post",
    ]);
  });

  it("reports a posture-forced rehearsal as a non-attempt and never stamps dispatch", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValueOnce({
      blocked: false,
      rehearsal: true,
      reason: "provider_mutation_rehearsal",
      message: "Provider writes are rehearsed.",
    } as never);
    vi.mocked(writes.updateAdsetBidAmount).mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      wouldHaveWritten: { bid_amount: 1320 },
      verifiedBidAmount: 1200,
      responsePayload: { dryRun: true },
      verificationPayload: { bid_amount: 1200, bid_strategy: "COST_CAP" },
    } as never);
    const markDispatchStarted = vi.fn(async () => true);

    const result = await executeMetaAutomationProposal({
      request: new NextRequest(
        `http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}`,
        { method: "POST", headers: { cookie: "adsecute_session=token-abc" } },
      ),
      businessId: "biz_1",
      proposal: bidProposal(),
      dryRunOnly: false,
      readBidBaseline: vi.fn(async () => ({
        bidAmountMinor: 1200,
        bidStrategy: "COST_CAP",
      })),
      markDispatchStarted,
    });

    expect(result.ok).toBe(true);
    expect(result.receipt.dryRun).toBe(true);
    expect(result.receipt.providerMutationAttempted).toBe(false);
    expect(markDispatchStarted).not.toHaveBeenCalled();
  });
});

/**
 * The exact shape `updateAdsetBidAmount` returns when its pre-POST comparison
 * refuses: no mutation attempt, no provider request, definitely failed.
 */
function preconditionRefusal() {
  return {
    ok: false as const,
    httpStatus: 409,
    providerMutationAttempted: false,
    providerOutcome: "definite_failure" as const,
    error: {
      code: "bid_baseline_changed",
      message: "The ad set holds 1500 rather than the 1200 this change was approved against.",
    },
    responsePayload: null,
    verificationPayload: null,
  };
}

describe("a pre-POST refusal is read downstream as definitely failed", () => {
  it("settles the handler's journal and answer as failed, not as unresolved", async () => {
    /*
      The shape matters as much as the refusal. An answer of
      `provider_outcome_ambiguous` would park the attempt for human
      reconciliation and forbid a retry — for a write that was never sent. The
      mocked `hasSuccessfulMetaProviderMutationAttempt` answers false, which is
      what the real one answers for a result carrying no mutation attempt.
    */
    vi.mocked(writes.updateAdsetBidAmount).mockResolvedValueOnce(
      preconditionRefusal() as never,
    );

    const response = await callHandler({
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
      expectedCurrentBidAmountMinor: 1200,
    });
    const payload = (await response.json()) as {
      error?: { code?: string };
      outcome?: string;
      retryAllowed?: boolean | null;
    };

    expect(payload.error?.code).toBe("bid_baseline_changed");
    expect(payload.outcome).toBe("failed");
    // Neither ambiguous nor a successful attempt, so nothing forbids a retry
    // once the operator has looked at the cap.
    expect(payload.retryAllowed).toBeNull();
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failure" }),
    );
  });

  it("keeps the unattended row out of reconcile", async () => {
    vi.mocked(writes.updateAdsetBidAmount).mockResolvedValueOnce(
      preconditionRefusal() as never,
    );
    const runtime = createScheduledBidRuntime({
      ctx: {
        businessId: BUSINESS_ID,
        providerAccountId: "act_1",
        accessToken: "token",
        connectionGeneration: "1:connected",
      },
      readGates: async () => ({
        releaseGateOpen: true,
        autoExecutionEnabled: true,
        enabledProviderAccountId: "act_1",
        enablingActorUserId: ENABLING_ACTOR,
        activationControlVersion: "v7",
        dryRunOnly: false,
      }),
      readMode: async () => "auto",
    });

    const result = await runtime({
      proposal: bidProposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: {
        kind: "scheduled",
        expectedEnablingActorUserId: ENABLING_ACTOR,
        expectedActivationControlVersion: "v7",
      },
    });

    expect(result.ok).toBe(false);
    // Nothing was sent, so there is no provider state for a person to
    // establish: the row terminalises instead of waiting.
    expect(result.reconcile).toBe(false);
    expect(result.receipt.providerMutationAttempted).toBe(false);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failure",
        errorCode: "bid_baseline_changed",
      }),
    );
  });
});

describe("the unattended sweep carries its cap through to the write", () => {
  const gates = {
    releaseGateOpen: true,
    autoExecutionEnabled: true,
    enabledProviderAccountId: "act_1",
    enablingActorUserId: ENABLING_ACTOR,
    activationControlVersion: "v7",
    dryRunOnly: false,
  };

  it("binds the baseline it read, so nobody is watching an unproved write", async () => {
    const runtime = createScheduledBidRuntime({
      ctx: {
        businessId: BUSINESS_ID,
        providerAccountId: "act_1",
        accessToken: "token",
        connectionGeneration: "1:connected",
      },
      readGates: async () => gates,
      readMode: async () => "auto",
    });

    const result = await runtime({
      proposal: bidProposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: {
        kind: "scheduled",
        expectedEnablingActorUserId: ENABLING_ACTOR,
        expectedActivationControlVersion: "v7",
      },
    });

    expect(result.ok).toBe(true);
    expect(bidWriteInput()).toMatchObject({
      adsetId: ADSET,
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
      // Its own baseline read, re-proved at the boundary. The action-log
      // insert, the three control re-reads and the dispatch marker all await
      // between that read and the POST.
      expectedCurrentBidAmountMinor: 1200,
    });
  });
});
