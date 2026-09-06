/**
 * The control-row bootstrap is a WRITE, so it must sit below every refusal.
 *
 * `POST /api/meta/automation` calls `ensureBusinessControlRow`, which runs an
 * INSERT against `meta_automation_business_controls`. It used to run
 * immediately after `requireBusinessAccess`, i.e. ABOVE the reviewer gate, the
 * demo gate and the demo-status read's own failure path. A reviewer session, a
 * demo workspace, and a request whose demo flag could not be read therefore
 * each persisted the initial control state — stamped with their own user id —
 * on the way to a 403 or a 503 that promises the opposite.
 *
 * `demo-fail-closed.test.ts` already proves those refusals fire and that the
 * action collaborators do not run, but `ensureBusinessControlRow` is not in its
 * `everyMutatingCollaborator()` list, so the bootstrap slipped through a
 * status-code-and-collaborator assertion.
 *
 * Both directions are asserted here: a refused actor writes nothing, and a
 * permitted actor still gets its row. The second half is the regression the
 * reordering could have caused.
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
    ensureBusinessControlRow: vi.fn(async () => ({ created: false })),
    engageMetaAutomationKillSwitch: vi.fn(),
    releaseMetaAutomationKillSwitch: vi.fn(),
    setMetaAutomationDecisionTypeMode: vi.fn(),
    setMetaAutomationGuardrailPolicy: vi.fn(),
    getMetaAutomationControlPlane: vi.fn(),
    getMetaWriteBlockState: vi.fn(),
    writeActivityLedgerRow: vi.fn(),
  };
});

const db = await import("@/lib/db");
const access = await import("@/lib/access");
const accountAssignments = await import("@/lib/meta/creatives-fetchers");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const { SHOPIFY_REVIEWER_EMAIL } = await import("@/lib/reviewer-access");
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const URL_BASE =
  `http://localhost/api/meta/automation?businessId=${BUSINESS_ID}&providerAccountId=act_1`;

function postRequest(body: unknown) {
  return new NextRequest(URL_BASE, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** The demo flag read, answered however this case needs it answered. */
function stubDemoFlag(answer: "demo" | "live" | "unreadable") {
  vi.mocked(db.getDb).mockReturnValue(
    vi.fn(async () => {
      if (answer === "unreadable") throw new Error("db down");
      return [{ is_demo_business: answer === "demo" }];
    }) as never,
  );
}

/** An ADMIN, so the role floor is never what a case below is measuring. */
function stubSession(email: string) {
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_1", email } },
    membership: { businessId: BUSINESS_ID, role: "admin" },
  } as never);
}

/**
 * A collaborator-floor, business-wide action with no provider dependency, so
 * the only thing separating the cases below is which guard refuses.
 */
const ACTION = {
  action: "set_decision_type_mode",
  decisionType: "pause",
  mode: "manual",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue([
    "act_1",
  ]);
  stubSession("owner@example.com");
  vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
    { businessControl: { source: "persisted", killSwitchEngaged: false } } as never,
  );
});

describe("POST /api/meta/automation control-row bootstrap ordering", () => {
  it("writes no control row for a reviewer session", async () => {
    stubDemoFlag("live");
    stubSession(SHOPIFY_REVIEWER_EMAIL);

    const response = await POST(postRequest(ACTION));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("reviewer_read_only");
    expect(vi.mocked(controlPlane.ensureBusinessControlRow)).not.toHaveBeenCalled();
  });

  it("writes no control row for a demo workspace", async () => {
    stubDemoFlag("demo");

    const response = await POST(postRequest(ACTION));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("demo_business_read_only");
    expect(vi.mocked(controlPlane.ensureBusinessControlRow)).not.toHaveBeenCalled();
  });

  it("writes no control row when the demo flag cannot be read", async () => {
    stubDemoFlag("unreadable");

    const response = await POST(postRequest(ACTION));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("demo_status_unverified");
    expect(vi.mocked(controlPlane.ensureBusinessControlRow)).not.toHaveBeenCalled();
  });

  // The regression the reordering could have caused: an operator who clears
  // every gate must still get the default-closed row, or the first Meta write
  // afterwards is refused `control_state_unavailable` with no visible cause.
  it("still bootstraps the row for a permitted operator", async () => {
    stubDemoFlag("live");

    const response = await POST(postRequest(ACTION));

    expect(response.status).toBe(200);
    expect(vi.mocked(controlPlane.ensureBusinessControlRow)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(controlPlane.ensureBusinessControlRow)).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      userId: "user_1",
    });
    // Ordered before the action itself, so the action never finds the row
    // missing.
    expect(
      vi.mocked(controlPlane.setMetaAutomationDecisionTypeMode),
    ).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(controlPlane.ensureBusinessControlRow).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(controlPlane.setMetaAutomationDecisionTypeMode).mock
        .invocationCallOrder[0],
    );
  });
});
