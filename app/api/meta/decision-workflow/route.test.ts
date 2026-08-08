import { describe, expect, it, vi, beforeEach } from "vitest";

const requireBusinessAccess = vi.hoisted(() => vi.fn());
const readWorkflowRecord = vi.hoisted(() => vi.fn());
const persistWorkflowTransition = vi.hoisted(() => vi.fn());

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/decision-workflow-store", () => ({
  readWorkflowRecord,
  persistWorkflowTransition,
  readWorkflowRecords: vi.fn(),
}));

import { GET, POST } from "@/app/api/meta/decision-workflow/route";

function getRequest(search: string) {
  return { nextUrl: { searchParams: new URLSearchParams(search) } } as unknown as Parameters<
    typeof GET
  >[0];
}

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

const openRecord = {
  businessId: "biz-1",
  decisionKey: "dec-1",
  state: "open" as const,
  assigneeUserId: null,
  dueAt: null,
  snoozeUntil: null,
  reasonCode: null,
  stateVersion: 1,
};

describe("GET decision workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireBusinessAccess.mockResolvedValue({ session: { user: { id: "user-1" } } });
    readWorkflowRecord.mockResolvedValue(openRecord);
  });

  it("requires both identifiers", async () => {
    expect((await GET(getRequest("businessId=biz-1"))).status).toBe(400);
  });

  it("returns the current ownership state", async () => {
    const body = await (await GET(getRequest("businessId=biz-1&decisionKey=dec-1"))).json();
    expect(body.workflow.state).toBe("open");
    expect(body.available).toBe(true);
  });

  it("says when the overlay is unavailable rather than implying nobody owns it", async () => {
    readWorkflowRecord.mockResolvedValue(null);
    const body = await (await GET(getRequest("businessId=biz-1&decisionKey=dec-1"))).json();
    expect(body.available).toBe(false);
  });
});

describe("POST decision workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireBusinessAccess.mockResolvedValue({ session: { user: { id: "user-1" } } });
    readWorkflowRecord.mockResolvedValue(openRecord);
    persistWorkflowTransition.mockResolvedValue({ ok: true });
  });

  it("acknowledges a decision and returns the advanced version", async () => {
    const response = await POST(
      postRequest({ businessId: "biz-1", decisionKey: "dec-1", action: "acknowledge", expectedVersion: 1 }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.workflow.state).toBe("acknowledged");
    expect(body.workflow.stateVersion).toBe(2);
  });

  it("refuses an unknown action", async () => {
    const response = await POST(
      postRequest({ businessId: "biz-1", decisionKey: "dec-1", action: "delete", expectedVersion: 1 }),
    );
    expect(response.status).toBe(400);
  });

  it("requires an expected version so a stale edit cannot overwrite a newer one", async () => {
    const response = await POST(
      postRequest({ businessId: "biz-1", decisionKey: "dec-1", action: "acknowledge" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("missing_expected_version");
  });

  it("returns a conflict when the caller's version is stale", async () => {
    readWorkflowRecord.mockResolvedValue({ ...openRecord, stateVersion: 5 });
    const response = await POST(
      postRequest({ businessId: "biz-1", decisionKey: "dec-1", action: "acknowledge", expectedVersion: 1 }),
    );
    expect(response.status).toBe(409);
  });

  it("returns a conflict when the database rejects the version at write time", async () => {
    persistWorkflowTransition.mockResolvedValue({ ok: false, reason: "version_conflict" });
    const response = await POST(
      postRequest({ businessId: "biz-1", decisionKey: "dec-1", action: "acknowledge", expectedVersion: 1 }),
    );
    expect(response.status).toBe(409);
  });

  it("never reports success when nothing was recorded", async () => {
    persistWorkflowTransition.mockResolvedValue({ ok: false, reason: "unavailable" });
    const response = await POST(
      postRequest({ businessId: "biz-1", decisionKey: "dec-1", action: "acknowledge", expectedVersion: 1 }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("nothing was recorded");
  });

  it("rejects a rejection with no reason", async () => {
    const response = await POST(
      postRequest({ businessId: "biz-1", decisionKey: "dec-1", action: "reject", expectedVersion: 1 }),
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("reason_required");
  });

  it("requires more than read access to move a decision", async () => {
    await POST(
      postRequest({ businessId: "biz-1", decisionKey: "dec-1", action: "acknowledge", expectedVersion: 1 }),
    );
    expect(requireBusinessAccess.mock.calls[0][0].minRole).toBe("collaborator");
  });

  it("records the acting user, not the assignee, as the actor", async () => {
    await POST(
      postRequest({
        businessId: "biz-1",
        decisionKey: "dec-1",
        action: "assign",
        expectedVersion: 1,
        assigneeUserId: "user-9",
      }),
    );
    expect(persistWorkflowTransition.mock.calls[0][0].event.actorUserId).toBe("user-1");
    expect(persistWorkflowTransition.mock.calls[0][0].next.assigneeUserId).toBe("user-9");
  });
});
