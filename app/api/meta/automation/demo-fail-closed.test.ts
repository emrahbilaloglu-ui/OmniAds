/**
 * The Automation write boundary, proven demo fail-closed at the REQUEST level.
 *
 * `demo-write-authority.test.ts` proves the guard answers correctly. This file
 * proves the two routes actually run it, for every state-changing action, and
 * that nothing durable is written when it refuses. Those are different claims:
 * before this change the guard's answer already existed inside
 * `getMetaWriteBlockState` (`reason: "demo_business_read_only"`) and was simply
 * never consulted by six of the seven actions on `POST /api/meta/automation`,
 * nor by `modify`/`dismiss` on the proposals route.
 *
 * Every mutating collaborator is spied, and the assertion is that none of them
 * ran — an endpoint that returns 403 after it has already written a rule row
 * would pass a status-code-only test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));

vi.mock("@/lib/meta/automation-control-plane", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/automation-control-plane")>();
  return {
    ...actual,
    engageMetaAutomationKillSwitch: vi.fn(),
    releaseMetaAutomationKillSwitch: vi.fn(),
    setMetaAutomationDecisionTypeMode: vi.fn(),
    setMetaAutomationGuardrailPolicy: vi.fn(),
    getMetaAutomationControlPlane: vi.fn(),
    getMetaWriteBlockState: vi.fn(),
    writeActivityLedgerRow: vi.fn(),
  };
});

vi.mock("@/lib/meta/automation-rules-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/automation-rules-store")>();
  return {
    ...actual,
    createAutomationRule: vi.fn(),
    setAutomationRuleActive: vi.fn(),
  };
});

vi.mock("@/lib/meta/automation-rules-evaluation", () => ({
  evaluateBusinessAutomationRules: vi.fn(),
}));

vi.mock("@/lib/meta/automation-proposals", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/automation-proposals")>();
  return {
    ...actual,
    claimMetaAutomationProposal: vi.fn(),
    countMetaAutomationProposalHolds: vi.fn(),
    markMetaAutomationProposalDispatchStarted: vi.fn(),
    readMetaAutomationProposal: vi.fn(),
    readMetaAutomationProposalQueue: vi.fn(),
    settleMetaAutomationProposal: vi.fn(),
  };
});

vi.mock("@/lib/meta/automation-proposal-execution", () => ({
  executeMetaAutomationProposal: vi.fn(),
}));

const db = await import("@/lib/db");
const access = await import("@/lib/access");
const accountAssignments = await import("@/lib/meta/creatives-fetchers");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const rulesStore = await import("@/lib/meta/automation-rules-store");
const rulesEvaluation = await import("@/lib/meta/automation-rules-evaluation");
const proposals = await import("@/lib/meta/automation-proposals");
const proposalExecution = await import(
  "@/lib/meta/automation-proposal-execution"
);
const { POST, GET } = await import("./route");
const { POST: PROPOSALS_POST } = await import("./proposals/route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const URL_BASE = `http://localhost/api/meta/automation?businessId=${BUSINESS_ID}&providerAccountId=act_1`;
const PROPOSALS_URL = `http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}&providerAccountId=act_1`;

function postRequest(body: unknown, url = URL_BASE) {
  return new NextRequest(url, { method: "POST", body: JSON.stringify(body) });
}

/** Every state-changing action `POST /api/meta/automation` accepts. */
const CONTROL_ACTIONS: Array<Record<string, unknown>> = [
  { action: "engage_kill_switch", reason: "operator stop" },
  { action: "release_kill_switch" },
  { action: "set_decision_type_mode", decisionType: "pause", mode: "manual" },
  {
    action: "set_guardrail_policy",
    minRoasFloor: 2,
    quietHours: { start: "22:00", end: "06:00", timezone: "Europe/Istanbul" },
  },
  {
    action: "create_rule",
    rule: {
      name: "Pause low ROAS",
      entityLevel: "adset",
      trigger: {},
      action: {},
      mode: "propose",
    },
  },
  { action: "set_rule_active", ruleId: "rule_1", active: true },
  { action: "evaluate_rules" },
];

const PROPOSAL_ACTIONS = ["approve", "modify", "dismiss"] as const;

function everyMutatingCollaborator() {
  return [
    controlPlane.engageMetaAutomationKillSwitch,
    controlPlane.releaseMetaAutomationKillSwitch,
    controlPlane.setMetaAutomationDecisionTypeMode,
    controlPlane.setMetaAutomationGuardrailPolicy,
    controlPlane.writeActivityLedgerRow,
    rulesStore.createAutomationRule,
    rulesStore.setAutomationRuleActive,
    rulesEvaluation.evaluateBusinessAutomationRules,
    proposals.claimMetaAutomationProposal,
    proposals.markMetaAutomationProposalDispatchStarted,
    proposals.settleMetaAutomationProposal,
    proposalExecution.executeMetaAutomationProposal,
  ];
}

function expectNothingWasWritten() {
  for (const fn of everyMutatingCollaborator()) {
    expect(vi.mocked(fn)).not.toHaveBeenCalled();
  }
}

/** The demo flag read, answered however this case needs it answered. */
function stubDemoFlag(answer: "demo" | "live" | "unreadable") {
  const sql = vi.fn(async () => {
    if (answer === "unreadable") throw new Error("db down");
    return [{ is_demo_business: answer === "demo" }];
  });
  vi.mocked(db.getDb).mockReturnValue(sql as never);
  return sql;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue([
    "act_1",
  ]);
  // An ADMIN whose email is not the reviewer's — exactly what
  // `/api/auth/demo-login` mints for the demo business. Both the role gate and
  // the reviewer gate are satisfied here on purpose: if the demo refusal were
  // riding on either of them, these cases would pass for the wrong reason.
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_1", email: "owner@example.com" } },
    membership: { businessId: BUSINESS_ID, role: "admin" },
  } as never);
});

describe("POST /api/meta/automation is demo fail-closed", () => {
  // LAW (docs/creative-decision-center/INVARIANTS.md): "Demo businesses have
  // zero Meta write authority even if a presentation defect supplies an
  // action." Not "zero provider writes" — zero write authority. A rule, a
  // guardrail floor, a quiet-hours window and a decision-type mode are durable
  // rows the next real snapshot reads back, so they are covered too.
  it.each(CONTROL_ACTIONS)("refuses %o in a demo workspace", async (body) => {
    stubDemoFlag("demo");

    const response = await POST(postRequest(body));

    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error.code).toBe("demo_business_read_only");
    expectNothingWasWritten();
  });

  // LAW: missing or unreadable data must never become success. A database that
  // cannot answer "is this workspace demo" has not proved it is live.
  it.each(CONTROL_ACTIONS)(
    "holds %o when the demo flag cannot be read",
    async (body) => {
      stubDemoFlag("unreadable");

      const response = await POST(postRequest(body));

      expect(response.status).toBe(503);
      const payload = await response.json();
      expect(payload.error.code).toBe("demo_status_unverified");
      expectNothingWasWritten();
    },
  );

  // The guard must not become a second role check. A proven live workspace is
  // handed straight through to the action it asked for.
  it("lets a proven live workspace through to its action", async () => {
    stubDemoFlag("live");
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue({
      businessControl: { source: "persisted", killSwitchEngaged: false },
    } as never);

    const response = await POST(
      postRequest({ action: "engage_kill_switch", reason: "operator stop" }),
    );

    expect(response.status).toBe(200);
    expect(
      vi.mocked(controlPlane.engageMetaAutomationKillSwitch),
    ).toHaveBeenCalledTimes(1);
  });

  // Reads are not writes. A demo workspace is a presentation surface; refusing
  // its GET would blank a screen the demo exists to show.
  it("leaves the GET readable in a demo workspace", async () => {
    stubDemoFlag("demo");
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue({
      contractVersion: "meta-automation-control-plane.v1",
    } as never);

    const response = await GET(new NextRequest(URL_BASE));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
  });
});

describe("POST /api/meta/automation/proposals is demo fail-closed", () => {
  // `approve` was already covered downstream by `rejectIfMetaWritesBlocked`.
  // `modify` and `dismiss` were not: `decideWithoutProviderWrite` settles the
  // proposal row and writes an activity-ledger row without ever consulting it.
  it.each(PROPOSAL_ACTIONS)("refuses %s in a demo workspace", async (action) => {
    stubDemoFlag("demo");

    const response = await PROPOSALS_POST(
      postRequest(
        {
          action,
          proposalId: "proposal_1",
          note: "recorded instead",
          manualConfirmation: "CONFIRM",
        },
        PROPOSALS_URL,
      ),
    );

    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error.code).toBe("demo_business_read_only");
    // The proposal is never even read, so it cannot be claimed, settled or
    // dispatched. A refusal that had already taken the claim would leave the
    // row held by a request that was never going to dispatch.
    expect(vi.mocked(proposals.readMetaAutomationProposal)).not.toHaveBeenCalled();
    expectNothingWasWritten();
  });

  it.each(PROPOSAL_ACTIONS)(
    "holds %s when the demo flag cannot be read",
    async (action) => {
      stubDemoFlag("unreadable");

      const response = await PROPOSALS_POST(
        postRequest(
          { action, proposalId: "proposal_1", note: "recorded instead" },
          PROPOSALS_URL,
        ),
      );

      expect(response.status).toBe(503);
      const payload = await response.json();
      expect(payload.error.code).toBe("demo_status_unverified");
      expectNothingWasWritten();
    },
  );
});
