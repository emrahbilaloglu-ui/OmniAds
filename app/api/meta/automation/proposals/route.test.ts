import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));

vi.mock("@/lib/meta/automation-control-plane", () => ({
  getMetaAutomationControlPlane: vi.fn(),
  writeActivityLedgerRow: vi.fn(async () => undefined),
}));

vi.mock("@/lib/meta/automation-write-guard", () => ({
  rejectIfMetaWritesBlocked: vi.fn(),
  // The shared posture every write family now reads. Unblocked and NOT
  // rehearsing: these suites assert on real provider calls, and a rehearsing
  // posture would turn every one of them into a dry run.
  readMetaWritePosture: vi.fn(async () => ({
    blocked: false, rehearsal: false, reason: null, message: null,
  })),
  metaWriteBlockedResponse: vi.fn((posture: { reason: string | null; message: string | null }) =>
    // The real refusal envelope, so a caller reading `error.code` sees what the
    // shipped helper actually answers with.
    new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: "kill_switch_engaged",
          message: posture?.message ?? "Meta writes are disabled by kill switch.",
          reason: posture?.reason ?? null,
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    )),
  metaWriteIsRehearsal: (input: { posture: { rehearsal: boolean }; requestedDryRun: boolean }) =>
    input.posture.rehearsal || input.requestedDryRun === true,
}));

vi.mock("@/lib/meta/reviewer-write-guard", () => ({
  rejectIfReviewerReadOnly: vi.fn(),
}));

// The demo/unverified-business write gate, mocked open by default exactly like
// the reviewer and kill-switch guards above. It is a REAL gate in the route and
// keeps its own coverage; leaving it unmocked here would make every approve
// case in this file fail on `demo_status_unverified` — which proves nothing
// about the boundary behaviour these cases are about.
vi.mock("../demo-write-authority", () => ({
  rejectIfAutomationDemoWrite: vi.fn(async () => null),
}));

vi.mock("@/lib/meta/automation-proposal-execution", () => ({
  executeMetaAutomationProposal: vi.fn(),
}));

vi.mock("@/lib/meta/automation-proposals", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/meta/automation-proposals")
  >("@/lib/meta/automation-proposals");
  return {
    ...actual,
    claimMetaAutomationProposal: vi.fn(),
    countMetaAutomationProposalHolds: vi.fn(),
    markMetaAutomationProposalDispatchStarted: vi.fn(),
    readMetaAutomationProposal: vi.fn(),
    readMetaAutomationProposalQueue: vi.fn(),
    settleMetaAutomationProposal: vi.fn(),
    forceMetaAutomationProposalReconcile: vi.fn(),
  };
});

// The durable reconciliation outbox. Mocked here rather than exercised, because
// this file's subject is the BOUNDARY's behaviour; the outbox itself is proven
// against a real PostgreSQL in
// `lib/meta/automation-proposal-reconcile-slot.db.test.ts`.
vi.mock("@/lib/meta/automation-reconciliation", () => ({
  appendMetaAutomationReconciliationReceipt: vi.fn(async () => ({
    status: "recorded" as const,
    id: "reconciliation_1",
  })),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    const sql = (..._args: unknown[]) => Promise.resolve([]);
    return sql;
  },
}));

const access = await import("@/lib/access");
const accountAssignments = await import("@/lib/meta/creatives-fetchers");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const writeGuard = await import("@/lib/meta/automation-write-guard");
const reviewerGuard = await import("@/lib/meta/reviewer-write-guard");
const execution = await import("@/lib/meta/automation-proposal-execution");
const store = await import("@/lib/meta/automation-proposals");
const reconciliation = await import("@/lib/meta/automation-reconciliation");
const demoAuthority = await import("../demo-write-authority");
const { GET, POST } = await import("./route");

type MetaAutomationProposal =
  import("@/lib/meta/automation-proposals").MetaAutomationProposal;

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_TOKEN = "22222222-2222-4222-8222-222222222222";
const URL_BASE = `http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}&providerAccountId=act_1`;

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
    decisionKey: "adset:23848",
    scopeType: "adset",
    scopeId: "23848",
    recId: "rec_1",
    recType: "scenario_m3_mid_funnel_inefficient_cut",
    snapshotDate: "2026-08-17",
    engineVersion: "meta-v3",
    decisionLabel: "cut",
    proposedAction: "pause",
    actionLabel: "Pause ad set",
    primaryCaption: "Approve & apply",
    entityLabel: "Retargeting 7d — DPA",
    reason: "ROAS 1.94 below breakeven 2.50 for 6 consecutive days.",
    evidenceLabel: "frees $680/d",
    evidenceRef: {},
    // Far enough ahead that only a test that sets it explicitly is testing
    // expiry.
    expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    receipt: null,
    bidEnvelope: null,
    budgetEnvelope: null,
    // Claim fields are part of the row now. A fixture that omitted them would
    // let a test assert on a proposal shape the database can no longer produce.
    claimToken: null,
    claimedBy: null,
    claimedAt: null,
    dispatchStartedAt: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

function controlPlanePayload(
  overrides: Partial<{
    source: "persisted" | "default";
    readinessTier: string;
    dryRunOnly: boolean;
  }> = {},
) {
  return {
    contractVersion: "meta-automation-control-plane.v1",
    businessId: BUSINESS_ID,
    providerAccountId: "act_1",
    globalKillSwitch: { engaged: false, reason: null },
    businessControl: {
      businessId: BUSINESS_ID,
      killSwitchEngaged: false,
      killSwitchReason: null,
      autoExecutionEnabled: false,
      readinessTier: overrides.readinessTier ?? "manual_review",
      guardrails: {
        dailyAutoActionCap: 3,
        perActionSpendCeilingMinor: 5000,
        perActionSpendCeilingCurrency: "EUR",
        notificationPolicy: "every_auto_action",
        maxBudgetIncreasePct: 15,
        maxDailyBudgetChangeMinor: null,
        requireCampaignLabel: true,
        requireCommercialAnchor: true,
        requireLivePreflight: true,
        requireRollbackPlan: true,
        dryRunOnly: overrides.dryRunOnly ?? false,
      },
      updatedAt: null,
      updatedBy: null,
      source: overrides.source ?? "persisted",
    },
    execution: {
      autoExecutionAllowed: false,
      writeEndpointsBlocked: false,
      blockedReasons: [],
    },
    promotionRecords: [],
    readCompleteness: { promotionRecords: "complete" },
    activityLedger: [],
    decisionTypeModes: [],
  } as never;
}

function post(body: unknown, url = URL_BASE) {
  return new NextRequest(url, { method: "POST", body: JSON.stringify(body) });
}

const APPROVE = {
  proposalId: PROPOSAL_ID,
  action: "approve",
  manualConfirmation: "explicit_operator_confirmation",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue([
    "act_1",
  ]);
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_1", email: "operator@example.com" } },
    membership: { businessId: BUSINESS_ID, role: "collaborator" },
  } as never);
  vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(null);
  vi.mocked(demoAuthority.rejectIfAutomationDemoWrite).mockResolvedValue(null);
  vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValue(null);
  vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
    controlPlanePayload(),
  );
  vi.mocked(store.readMetaAutomationProposal).mockResolvedValue(proposal());
  vi.mocked(store.claimMetaAutomationProposal).mockResolvedValue({
    status: "claimed",
    proposal: proposal({ status: "claimed", claimToken: CLAIM_TOKEN }),
    claimToken: CLAIM_TOKEN,
  });
  vi.mocked(store.markMetaAutomationProposalDispatchStarted).mockResolvedValue(
    true,
  );
  vi.mocked(store.countMetaAutomationProposalHolds).mockResolvedValue({
    claimed: 0,
    reconcile: 0,
  });
  vi.mocked(store.readMetaAutomationProposalQueue).mockResolvedValue({
    readCompleteness: "complete",
    proposals: [proposal()],
  });
  vi.mocked(store.settleMetaAutomationProposal).mockImplementation(
    async (input) => proposal({ status: input.status }),
  );
  // Re-established every test: `vi.clearAllMocks()` clears calls, not
  // implementations, so a mockResolvedValue from one case would otherwise leak
  // into the next and turn a durable write into a silent failure.
  vi.mocked(store.forceMetaAutomationProposalReconcile).mockResolvedValue(true);
  vi.mocked(
    reconciliation.appendMetaAutomationReconciliationReceipt,
  ).mockResolvedValue({ status: "recorded", id: "reconciliation_1" });
  vi.mocked(controlPlane.writeActivityLedgerRow).mockResolvedValue(undefined);
  vi.mocked(execution.executeMetaAutomationProposal).mockResolvedValue({
    ok: true,
    receipt: {
      httpStatus: 200,
      response: { ok: true },
      dryRun: false,
      dispatchedAt: new Date().toISOString(),
      endpoint: "/api/meta/adsets/23848/pause",
      withheld: null,
    },
  });
});

describe("GET /api/meta/automation/proposals — the read boundary", () => {
  it("requires a business and reads it at the sibling route's guest level", async () => {
    const response = await GET(new NextRequest(URL_BASE));

    expect(response.status).toBe(200);
    expect(vi.mocked(access.requireBusinessAccess).mock.calls[0][0]).toMatchObject(
      { businessId: BUSINESS_ID, minRole: "guest" },
    );
  });

  it("refuses a Meta account that is not assigned to this business", async () => {
    vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue([
      "act_other",
    ]);

    const response = await GET(new NextRequest(URL_BASE));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("account_not_assigned");
    expect(store.readMetaAutomationProposalQueue).not.toHaveBeenCalled();
  });

  it("fails closed when account assignments cannot be read", async () => {
    vi.mocked(accountAssignments.fetchAssignedAccountIds).mockRejectedValue(
      new Error("db down"),
    );

    const response = await GET(new NextRequest(URL_BASE));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe(
      "provider_account_scope_unavailable",
    );
  });

  it("returns an unproven read as unavailable rather than as an empty queue", async () => {
    vi.mocked(store.readMetaAutomationProposalQueue).mockResolvedValue({
      readCompleteness: "unavailable",
      proposals: [],
    });

    const body = await (await GET(new NextRequest(URL_BASE))).json();

    expect(body.readCompleteness.proposals).toBe("unavailable");
    expect(body.proposals).toEqual([]);
  });

  it("propagates the caller's own authorization denial untouched", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    expect((await GET(new NextRequest(URL_BASE))).status).toBe(403);
  });
});

describe("POST /api/meta/automation/proposals — the write boundary", () => {
  it("requires collaborator, the level the guarded entity write itself requires", async () => {
    await POST(post(APPROVE));

    expect(vi.mocked(access.requireBusinessAccess).mock.calls[0][0]).toMatchObject(
      { businessId: BUSINESS_ID, minRole: "collaborator" },
    );
  });

  it("stops a reviewer before any proposal is even looked up", async () => {
    vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(
      NextResponse.json({ ok: false }, { status: 403 }) as never,
    );

    const response = await POST(post(APPROVE));

    expect(response.status).toBe(403);
    expect(store.readMetaAutomationProposal).not.toHaveBeenCalled();
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });

  it("refuses an action that is not one of the design's three controls", async () => {
    const response = await POST(
      post({ proposalId: PROPOSAL_ID, action: "execute" }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(
      "unsupported_proposal_action",
    );
  });

  it("cannot reach a proposal outside the resolved account scope", async () => {
    vi.mocked(store.readMetaAutomationProposal).mockResolvedValue(null);

    const response = await POST(post(APPROVE));

    expect(response.status).toBe(404);
    expect(
      vi.mocked(store.readMetaAutomationProposal).mock.calls[0][0],
    ).toMatchObject({ businessId: BUSINESS_ID, providerAccountId: "act_1" });
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });
});

describe("the guards an approval must clear", () => {
  it("does not execute an expired proposal, and says it will be re-evaluated", async () => {
    vi.mocked(store.readMetaAutomationProposal).mockResolvedValue(
      proposal({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );

    const response = await POST(post(APPROVE));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("proposal_expired");
    expect(body.error.message).toContain("next snapshot re-evaluates it");
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
    expect(store.settleMetaAutomationProposal).not.toHaveBeenCalled();
  });

  it("does not execute a proposal that was already decided", async () => {
    vi.mocked(store.readMetaAutomationProposal).mockResolvedValue(
      proposal({ status: "dismissed" }),
    );

    const response = await POST(post(APPROVE));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("proposal_not_pending");
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });

  it("honours the kill switch through the shared guard, before any dispatch", async () => {
    vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValue(
      NextResponse.json(
        { ok: false, error: { code: "kill_switch_engaged" } },
        { status: 503 },
      ) as never,
    );

    const response = await POST(post(APPROVE));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("kill_switch_engaged");
    expect(writeGuard.rejectIfMetaWritesBlocked).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
    });
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });

  it("refuses to execute unless the supervised posture is actually persisted", async () => {
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
      controlPlanePayload({ source: "default" }),
    );

    const response = await POST(post(APPROVE));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe(
      "supervision_state_unavailable",
    );
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });

  it("refuses an approval when the business is set to read-only", async () => {
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
      controlPlanePayload({ readinessTier: "read_only" }),
    );

    const response = await POST(post(APPROVE));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("supervision_tier_read_only");
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });

  it("refuses an approval that does not carry the explicit operator confirmation", async () => {
    const response = await POST(
      post({ proposalId: PROPOSAL_ID, action: "approve" }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(
      "manual_confirmation_required",
    );
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });

  it("forces the reused handler's dry-run mode when the guardrail says dry-run only", async () => {
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
      controlPlanePayload({ dryRunOnly: true }),
    );

    await POST(post(APPROVE));

    expect(
      vi.mocked(execution.executeMetaAutomationProposal).mock.calls[0][0],
    ).toMatchObject({ dryRunOnly: true, businessId: BUSINESS_ID });
  });
});

describe("what an approval records", () => {
  it("settles the proposal as approved with the executor's own receipt", async () => {
    const response = await POST(post(APPROVE));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      vi.mocked(store.settleMetaAutomationProposal).mock.calls[0][0],
    ).toMatchObject({
      businessId: BUSINESS_ID,
      proposalId: PROPOSAL_ID,
      status: "approved",
      decidedBy: "user_1",
    });
    expect(body.receipt.endpoint).toBe("/api/meta/adsets/23848/pause");
  });

  it("records a refused provider write as failed rather than as approved", async () => {
    vi.mocked(execution.executeMetaAutomationProposal).mockResolvedValue({
      ok: false,
      receipt: {
        httpStatus: 502,
        response: { ok: false, error: { code: "provider_refused" } },
        dryRun: false,
        dispatchedAt: new Date().toISOString(),
        endpoint: "/api/meta/adsets/23848/pause",
        withheld: null,
      },
    });

    await POST(post(APPROVE));

    expect(
      vi.mocked(store.settleMetaAutomationProposal).mock.calls[0][0],
    ).toMatchObject({ status: "failed" });
  });

  // The Activity ledger draws Actor, Entity and Result. This boundary knows all
  // three at every exit, and used to write none of them: its own INSERT named
  // only the six pre-tuple columns, so the row it produced rendered three em
  // dashes on a screen that had the facts in hand.
  it("writes the ledger tuple the Activity table renders, not just a sentence", async () => {
    await POST(post(APPROVE));

    expect(
      vi.mocked(controlPlane.writeActivityLedgerRow).mock.calls[0][0],
    ).toMatchObject({
      businessId: BUSINESS_ID,
      activityType: "automation_proposal_approved",
      userId: "user_1",
      actorKind: "operator",
      entityType: "adset",
      entityId: "23848",
      resultStatus: "applied",
      resultReceiptId: null,
    });
  });

  // `dryRunOnly` defaults to true in the code default AND the column default,
  // and nothing in the tree ever writes guardrails_json — so this is not an edge
  // case, it is the only configuration production can reach.
  it("does not call a dry run applied", async () => {
    vi.mocked(execution.executeMetaAutomationProposal).mockResolvedValue({
      ok: true,
      receipt: {
        httpStatus: 200,
        response: { ok: true },
        dryRun: true,
        dispatchedAt: new Date().toISOString(),
        endpoint: "/api/meta/adsets/23848/pause",
        withheld: null,
      },
    });

    await POST(post(APPROVE));

    const row = vi.mocked(controlPlane.writeActivityLedgerRow).mock.calls[0][0];
    // Nothing reached Meta, so the ledger must say what did happen — the
    // decision was recorded — rather than draw the green "Applied" chip under a
    // footnote that promises a receipt.
    expect(row).toMatchObject({ resultStatus: "recorded" });
    // Restated with the three-fact shape. `providerWrite: false` said the right
    // thing here and the wrong thing one case over — on an UNANSWERED dispatch,
    // where the same `false` read as "nothing was sent". A dry run is the
    // opposite situation and needs its own words: the handler WAS entered, its
    // answer IS known, and no write left the building.
    expect(row.payload).toMatchObject({
      providerDispatchStarted: true,
      providerOutcomeKnown: true,
      providerWriteVerified: false,
    });
  });

  it("records a provider refusal as a failed result, not an applied one", async () => {
    vi.mocked(execution.executeMetaAutomationProposal).mockResolvedValue({
      ok: false,
      receipt: {
        httpStatus: 502,
        response: { ok: false },
        dryRun: false,
        dispatchedAt: new Date().toISOString(),
        endpoint: "/api/meta/adsets/23848/pause",
        withheld: null,
      },
    });

    await POST(post(APPROVE));

    expect(
      vi.mocked(controlPlane.writeActivityLedgerRow).mock.calls[0][0],
    ).toMatchObject({ resultStatus: "failed" });
  });

  /**
   * Rewritten twice, never deleted, and this is the version the code finally
   * earns.
   *
   * v1 pinned `proposal_not_pending` with "decided by another action before
   * this one landed" — false, because the compare-and-set ran AFTER the
   * provider call, so the loser HAD dispatched. v2 kept the dispatch and told
   * the truth about it, which was harm reduction rather than a fix.
   *
   * The law now: a losing approval never reaches a provider at all, because
   * the row is claimed BEFORE the dispatch. So there is nothing to confess —
   * the loser is refused deterministically, with the row's real state, and the
   * executor is never called. That is the property the ephemeral-Postgres
   * concurrency seam proves against real parallel sessions
   * (scripts/ephemeral-postgres-automation-claim-race-seam.ts); this test pins
   * the boundary's own contract.
   */
  it("refuses a losing approval without dispatching anything", async () => {
    vi.mocked(store.claimMetaAutomationProposal).mockResolvedValue({
      status: "conflict",
      current: proposal({ status: "claimed", claimToken: CLAIM_TOKEN }),
    });

    const response = await POST(post(APPROVE));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("proposal_claim_conflict");
    expect(body.proposalStatus).toBe("claimed");
    // The one thing this answer must never do is imply a write left the
    // building, because none did.
    expect(body.error.message).toContain("Nothing was sent from this request");
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
    expect(controlPlane.writeActivityLedgerRow).not.toHaveBeenCalled();
  });

  it("gives the loser the winner's existing status and receipt", async () => {
    const winnerReceipt = {
      httpStatus: 200,
      response: { ok: true },
      dryRun: false,
      dispatchedAt: new Date().toISOString(),
      endpoint: "/api/meta/adsets/23848/pause",
      withheld: null,
      receiptKey: CLAIM_TOKEN,
    };
    vi.mocked(store.claimMetaAutomationProposal).mockResolvedValue({
      status: "conflict",
      current: proposal({
        status: "approved",
        claimToken: CLAIM_TOKEN,
        receipt: winnerReceipt,
      }),
    });

    const response = await POST(post(APPROVE));
    const body = await response.json();

    // Deterministic code whatever the winner is doing; the difference travels
    // as data beside it, not as a different refusal.
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("proposal_claim_conflict");
    expect(body.proposalStatus).toBe("approved");
    expect(body.receipt).toMatchObject({ endpoint: "/api/meta/adsets/23848/pause" });
    expect(body.receiptKey).toBe(CLAIM_TOKEN);
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });

  // The claim IS the exclusivity. A deployment whose database cannot express
  // one cannot approve at all: dispatching unclaimed would restore the exact
  // both-requests-write race the claim exists to close.
  it("refuses to dispatch at all when the claim columns are not migrated", async () => {
    vi.mocked(store.claimMetaAutomationProposal).mockResolvedValue({
      status: "migration_required",
    });

    const response = await POST(post(APPROVE));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("proposal_claim_unavailable");
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });

  // Every cheap refusal above the claim is a READ. A claim taken before them
  // would strand the row under a request that was never going to dispatch.
  it("claims nothing when a cheap gate refuses first", async () => {
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
      controlPlanePayload({ readinessTier: "read_only" }),
    );

    await POST(post(APPROVE));

    expect(store.claimMetaAutomationProposal).not.toHaveBeenCalled();
  });

  it("claims the row before the executor is ever called", async () => {
    const order: string[] = [];
    vi.mocked(store.claimMetaAutomationProposal).mockImplementation(async () => {
      order.push("claim");
      return {
        status: "claimed",
        proposal: proposal({ status: "claimed", claimToken: CLAIM_TOKEN }),
        claimToken: CLAIM_TOKEN,
      };
    });
    vi.mocked(
      store.markMetaAutomationProposalDispatchStarted,
    ).mockImplementation(async () => {
      order.push("dispatch-marked");
      return true;
    });
    vi.mocked(execution.executeMetaAutomationProposal).mockImplementation(
      async () => {
        order.push("execute");
        return {
          ok: true,
          receipt: {
            httpStatus: 200,
            response: { ok: true },
            dryRun: false,
            dispatchedAt: new Date().toISOString(),
            endpoint: "/api/meta/adsets/23848/pause",
            withheld: null,
            receiptKey: CLAIM_TOKEN,
          },
        };
      },
    );

    await POST(post(APPROVE));

    expect(order).toEqual(["claim", "dispatch-marked", "execute"]);
    expect(
      vi.mocked(store.settleMetaAutomationProposal).mock.calls[0][0],
    ).toMatchObject({ status: "approved", claimToken: CLAIM_TOKEN });
  });

  // `dispatch_started_at` is the only durable evidence that a write MIGHT
  // exist. If it cannot be stamped, the claim is not ours and dispatching
  // anyway would be the unclaimed provider write this path forbids.
  it("does not dispatch when the dispatch marker cannot be stamped", async () => {
    vi.mocked(
      store.markMetaAutomationProposalDispatchStarted,
    ).mockResolvedValue(false);

    const response = await POST(post(APPROVE));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("proposal_claim_conflict");
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });

  // A dispatch that produced no answer is not a failure and not a success. It
  // must never render as PAUSED, and it must not be requeued for a second try
  // by anything automatic.
  it("holds an unanswered dispatch for reconciliation instead of calling it applied", async () => {
    vi.mocked(execution.executeMetaAutomationProposal).mockRejectedValue(
      new Error("socket hang up"),
    );

    const response = await POST(post(APPROVE));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("proposal_outcome_unknown");
    expect(body.receipt.ambiguous).toBe(true);
    expect(
      vi.mocked(store.settleMetaAutomationProposal).mock.calls[0][0],
    ).toMatchObject({ status: "reconcile", claimToken: CLAIM_TOKEN });
    const row = vi.mocked(controlPlane.writeActivityLedgerRow).mock.calls[0][0];
    expect(row.resultStatus).toBe("failed");
    expect(row.resultStatus).not.toBe("applied");
    // ITEM 3. The old assertion here required `providerWrite: false` on a row
    // whose own message says the pause may have happened at Meta. That is the
    // defect, not the contract: `false` is what "nothing was sent" looks like
    // to every reader, filter and aggregate, and this attempt cannot claim it.
    // The tri-state replaces it, and the flat boolean must be GONE from this
    // payload rather than merely accompanied.
    expect(row.payload).toMatchObject({
      providerDispatchStarted: true,
      providerOutcomeKnown: false,
      providerWriteVerified: false,
    });
    expect(row.payload).not.toHaveProperty("providerWrite");
  });

  // ITEM 4. The provider answered; the write that had to record its answer
  // threw. This used to fall through to the generic 500 (`proposal_action_
  // failed`) with the ledger never attempted and the receipt alive only in the
  // dead request's memory.
  it("holds a post-dispatch settle failure for reconciliation instead of 500ing", async () => {
    vi.mocked(store.settleMetaAutomationProposal).mockRejectedValue(
      new Error("could not serialize access due to concurrent update"),
    );

    const response = await POST(post(APPROVE));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("proposal_reconciliation_required");
    expect(body.error.code).not.toBe("proposal_action_failed");
    // The provider is reached ONCE. No path from the failure re-enters it.
    expect(execution.executeMetaAutomationProposal).toHaveBeenCalledTimes(1);
    // The claim is moved by a statement that shares nothing with the settle
    // that just failed.
    expect(store.forceMetaAutomationProposalReconcile).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      proposalId: PROPOSAL_ID,
      claimToken: CLAIM_TOKEN,
    });
    // The receipt and the claim token are durable somewhere other than the row
    // that could not be written.
    expect(
      vi.mocked(reconciliation.appendMetaAutomationReconciliationReceipt).mock
        .calls[0][0],
    ).toMatchObject({
      claimToken: CLAIM_TOKEN,
      reason: "settle_failed_after_dispatch",
      facts: {
        providerDispatchStarted: true,
        providerOutcomeKnown: false,
        providerWriteVerified: false,
      },
    });
    expect(body.receiptKey).toBe(CLAIM_TOKEN);
    expect(body.receipt).not.toBeNull();
    expect(body.proposalStatus).toBe("reconcile");
    expect(body.providerOutcomeKnown).toBe(false);
  });

  // The whole database is gone: the row cannot be moved, the outbox refuses,
  // the ledger refuses. The one thing this must never be is quiet.
  it("says recording_failed out loud when nothing durable can be written", async () => {
    vi.mocked(store.settleMetaAutomationProposal).mockRejectedValue(
      new Error("connection terminated"),
    );
    vi.mocked(store.forceMetaAutomationProposalReconcile).mockResolvedValue(
      false,
    );
    vi.mocked(
      reconciliation.appendMetaAutomationReconciliationReceipt,
    ).mockResolvedValue({ status: "unavailable" });
    vi.mocked(controlPlane.writeActivityLedgerRow).mockRejectedValue(
      new Error("ledger insert failed"),
    );

    const response = await POST(post(APPROVE));
    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("reconciliation_recording_failed");
    // The response body becomes the only copy, so it may not withhold either.
    expect(body.receiptKey).toBe(CLAIM_TOKEN);
    expect(body.receipt).not.toBeNull();
    expect(body.reconciliation).toMatchObject({
      required: true,
      recorded: false,
    });
    // Still exactly one provider call.
    expect(execution.executeMetaAutomationProposal).toHaveBeenCalledTimes(1);
  });

  // An unanswered dispatch is durable in two places, not one: the queue row
  // says `reconcile`, and the append-only outbox carries the attempt's receipt
  // keyed by its claim token.
  it("appends an unanswered dispatch to the reconciliation outbox", async () => {
    vi.mocked(execution.executeMetaAutomationProposal).mockRejectedValue(
      new Error("socket hang up"),
    );

    const body = await (await POST(post(APPROVE))).json();

    expect(
      vi.mocked(reconciliation.appendMetaAutomationReconciliationReceipt).mock
        .calls[0][0],
    ).toMatchObject({
      claimToken: CLAIM_TOKEN,
      reason: "dispatch_no_answer",
    });
    expect(body.reconciliation).toMatchObject({ required: true, recorded: true });
  });

  // ITEM 9. The ledger promise on this screen is "every outcome lands in the
  // ledger with a receipt". A swallowed INSERT failure made that promise a
  // decoration, so the failure is now reported and the surface can stop making
  // the claim. There is deliberately NO retry: this runs after the provider
  // result exists, so a retry could only duplicate bookkeeping.
  it("reports a failed ledger write instead of swallowing it", async () => {
    vi.mocked(controlPlane.writeActivityLedgerRow).mockRejectedValue(
      new Error("ledger insert failed"),
    );

    const response = await POST(post(APPROVE));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ledgerCompleteness).toBe("unavailable");
    expect(body.ledgerErrorCode).toBe("activity_ledger_write_failed");
    // One attempt. Never a loop around a provider result that already exists.
    expect(controlPlane.writeActivityLedgerRow).toHaveBeenCalledTimes(1);
    // The outcome is still durable: the proposal row itself carries it.
    expect(
      vi.mocked(store.settleMetaAutomationProposal).mock.calls[0][0],
    ).toMatchObject({ status: "approved" });
  });

  it("says the ledger is complete when the row actually landed", async () => {
    const body = await (await POST(post(APPROVE))).json();

    expect(body.ledgerCompleteness).toBe("complete");
    expect(body.ledgerErrorCode).toBeNull();
  });

  // The auditable link: one key on the queue row, on the ledger row and in the
  // receipt envelope. `result_receipt_id` stays null because that column drives
  // a rendered `Receipt <id>` caption that promises a PROVIDER entity id.
  it("links the ledger row to the receipt by the attempt's claim token", async () => {
    const body = await (await POST(post(APPROVE))).json();

    expect(body.receiptKey).toBe(CLAIM_TOKEN);
    const row = vi.mocked(controlPlane.writeActivityLedgerRow).mock.calls[0][0];
    expect(row.payload).toMatchObject({
      proposalId: PROPOSAL_ID,
      receiptKey: CLAIM_TOKEN,
    });
    expect(row.resultReceiptId).toBeNull();
  });

  /**
   * Kept from the previous shape, rewritten for the claim.
   *
   * The row can still be taken away between the dispatch and the settle — only
   * by the claim sweep, never by another approval — and when it is, the
   * dispatch still happened. The response must say so and must carry the
   * receipt, because a provider write nobody can see is worse than the
   * bookkeeping that lost it.
   */
  it("still surfaces the receipt when the claim is released before the settle", async () => {
    vi.mocked(store.settleMetaAutomationProposal).mockResolvedValue(null);

    const response = await POST(post(APPROVE));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("proposal_claim_lost");
    expect(body.error.message).toContain("already been dispatched to Meta");
    expect(body.receipt).toMatchObject({
      httpStatus: 200,
      endpoint: "/api/meta/adsets/23848/pause",
    });
    expect(controlPlane.writeActivityLedgerRow).toHaveBeenCalledTimes(1);
  });

  it("does not claim a Meta dispatch when the guardrail held it inside the building", async () => {
    vi.mocked(store.settleMetaAutomationProposal).mockResolvedValue(null);
    vi.mocked(execution.executeMetaAutomationProposal).mockResolvedValue({
      ok: true,
      receipt: {
        httpStatus: 200,
        response: { ok: true },
        dryRun: true,
        dispatchedAt: new Date().toISOString(),
        endpoint: null,
        withheld: null,
        receiptKey: CLAIM_TOKEN,
      },
    });

    const body = await (await POST(post(APPROVE))).json();

    expect(body.error.code).toBe("proposal_claim_lost");
    expect(body.error.message).toContain("Nothing reached Meta");
    expect(body.error.message).not.toContain("dispatched to Meta");
  });
});

describe("modify and dismiss never reach a provider", () => {
  it("dismisses without executing anything", async () => {
    const response = await POST(
      post({ proposalId: PROPOSAL_ID, action: "dismiss" }),
    );

    expect(response.status).toBe(200);
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
    expect(writeGuard.rejectIfMetaWritesBlocked).not.toHaveBeenCalled();
    expect(
      vi.mocked(store.settleMetaAutomationProposal).mock.calls[0][0],
    ).toMatchObject({ status: "dismissed" });
  });

  it("requires the change an operator wants instead before recording a modification", async () => {
    const response = await POST(
      post({ proposalId: PROPOSAL_ID, action: "modify" }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(
      "modification_note_required",
    );
    expect(store.settleMetaAutomationProposal).not.toHaveBeenCalled();
  });

  it("records the modification note it was given", async () => {
    await POST(
      post({
        proposalId: PROPOSAL_ID,
        action: "modify",
        note: "Cut 30% instead of pausing outright.",
      }),
    );

    expect(
      vi.mocked(store.settleMetaAutomationProposal).mock.calls[0][0],
    ).toMatchObject({
      status: "modified",
      decisionNote: "Cut 30% instead of pausing outright.",
    });
    expect(execution.executeMetaAutomationProposal).not.toHaveBeenCalled();
  });

  // ITEM 8. The `pending -> claimed` transition must survive modify and
  // dismiss. Both settle WITHOUT a claim token, so their UPDATE is guarded on
  // `status = 'pending'` and a claimed row is untouchable — otherwise a
  // dismissal could overwrite a row whose pause is in flight, and the ledger
  // would carry "dismissed" for something Meta was pausing at that moment.
  it("cannot dismiss a proposal an approval has already claimed", async () => {
    vi.mocked(store.settleMetaAutomationProposal).mockResolvedValue(null);
    vi.mocked(store.readMetaAutomationProposal)
      .mockResolvedValueOnce(proposal())
      .mockResolvedValueOnce(
        proposal({ status: "claimed", claimToken: CLAIM_TOKEN }),
      );

    const response = await POST(
      post({ proposalId: PROPOSAL_ID, action: "dismiss" }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("proposal_claim_conflict");
    expect(body.proposalStatus).toBe("claimed");
    expect(body.error.message).toContain("already holds this proposal");
    // The settle it attempted carried no claim token, which is what made the
    // pending-only guard refuse it.
    expect(
      vi.mocked(store.settleMetaAutomationProposal).mock.calls[0][0]
        .claimToken,
    ).toBeUndefined();
  });

  it("still reports a plain lost decision as not pending", async () => {
    vi.mocked(store.settleMetaAutomationProposal).mockResolvedValue(null);
    vi.mocked(store.readMetaAutomationProposal)
      .mockResolvedValueOnce(proposal())
      .mockResolvedValueOnce(proposal({ status: "dismissed" }));

    const body = await (
      await POST(post({ proposalId: PROPOSAL_ID, action: "dismiss" }))
    ).json();

    expect(body.error.code).toBe("proposal_not_pending");
  });

  // `recorded` is the honest result for a decision that reached no provider:
  // neither `applied` nor `failed` is true of it.
  it("ledgers a dismissal as recorded against the proposal's own scope", async () => {
    await POST(post({ proposalId: PROPOSAL_ID, action: "dismiss" }));

    expect(
      vi.mocked(controlPlane.writeActivityLedgerRow).mock.calls[0][0],
    ).toMatchObject({
      activityType: "automation_proposal_dismiss",
      actorKind: "operator",
      entityType: "adset",
      entityId: "23848",
      resultStatus: "recorded",
    });
  });

  it("still refuses an expired proposal, so dismissal cannot judge dead evidence", async () => {
    vi.mocked(store.readMetaAutomationProposal).mockResolvedValue(
      proposal({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );

    const response = await POST(
      post({ proposalId: PROPOSAL_ID, action: "dismiss" }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("proposal_expired");
  });
});
