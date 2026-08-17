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
}));

vi.mock("@/lib/meta/automation-write-guard", () => ({
  rejectIfMetaWritesBlocked: vi.fn(),
}));

vi.mock("@/lib/meta/reviewer-write-guard", () => ({
  rejectIfReviewerReadOnly: vi.fn(),
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
    readMetaAutomationProposal: vi.fn(),
    readMetaAutomationProposalQueue: vi.fn(),
    settleMetaAutomationProposal: vi.fn(),
  };
});

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
const { GET, POST } = await import("./route");

type MetaAutomationProposal =
  import("@/lib/meta/automation-proposals").MetaAutomationProposal;

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
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
  vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValue(null);
  vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
    controlPlanePayload(),
  );
  vi.mocked(store.readMetaAutomationProposal).mockResolvedValue(proposal());
  vi.mocked(store.readMetaAutomationProposalQueue).mockResolvedValue({
    readCompleteness: "complete",
    proposals: [proposal()],
  });
  vi.mocked(store.settleMetaAutomationProposal).mockImplementation(
    async (input) => proposal({ status: input.status }),
  );
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

  it("executes only under the Tier 1 supervised readiness tier", async () => {
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
      controlPlanePayload({ readinessTier: "read_only" }),
    );

    const response = await POST(post(APPROVE));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("supervision_tier_mismatch");
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

  it("loses the race rather than settling a proposal twice", async () => {
    vi.mocked(store.settleMetaAutomationProposal).mockResolvedValue(null);

    const response = await POST(post(APPROVE));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("proposal_not_pending");
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
