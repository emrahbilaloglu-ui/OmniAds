import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const requireBusinessAccess = vi.hoisted(() => vi.fn());
const readWorkflowRecords = vi.hoisted(() =>
  vi.fn(async (_input: { businessId: string; decisionKeys: string[] }) => new Map<string, unknown>()),
);
const readWorkflowEvents = vi.hoisted(() =>
  vi.fn(async (_input: { businessId: string; decisionKey: string }) => [] as unknown[]),
);
const readWorkflowRecord = vi.hoisted(() => vi.fn());
const persistWorkflowTransition = vi.hoisted(() => vi.fn());

// An assignee must now be an active member of the same business, so the mock
// supplies one. Returning null here would be the route correctly refusing.
const findMembership = vi.hoisted(() =>
  vi.fn(async () => ({
    id: "mem-1",
    userId: "user-2",
    businessId: "biz-1",
    role: "collaborator",
    status: "active",
    joinedAt: "2026-01-01T00:00:00.000Z",
  })),
);

vi.mock("@/lib/access", () => ({ requireBusinessAccess, findMembership }));
vi.mock("@/lib/decision-workflow-store", () => ({
  readWorkflowRecord,
  persistWorkflowTransition,
  readWorkflowRecords,
  readWorkflowEvents,
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
    /*
     * These cases describe the transitions, so they run with the workflow gate
     * OPEN. It is now a server-side refusal rather than a hidden control, and
     * without this every one of them would be asserting the gate instead of
     * the state machine. The shut-gate behaviour has its own case below, and
     * the default — off — is asserted in `lib/meta/release-gates.test.ts`.
     */
    vi.stubEnv("META_DECISION_WORKFLOW_UI", "true");
    requireBusinessAccess.mockResolvedValue({ session: { user: { id: "user-1" } } });
    readWorkflowRecord.mockResolvedValue(openRecord);
    persistWorkflowTransition.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses every transition while the workflow gate is shut", async () => {
    vi.stubEnv("META_DECISION_WORKFLOW_UI", "");

    const response = await POST(
      postRequest({
        businessId: "biz-1",
        decisionKey: "dec-1",
        action: "acknowledge",
        expectedVersion: 1,
      }),
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("decision_workflow_disabled");
    // No environment variable name in an operator-facing message, and nothing
    // written: the refusal comes before the store is touched at all.
    expect(JSON.stringify(body)).not.toMatch(/META_[A-Z_]+/);
    expect(persistWorkflowTransition).not.toHaveBeenCalled();
  });

  it("refuses a shut gate before it looks up an assignee", async () => {
    // Otherwise a shut gate is a membership oracle: a 422 and a 503 would tell
    // a caller whether a given user id belongs to this business.
    vi.stubEnv("META_DECISION_WORKFLOW_UI", "");

    const response = await POST(
      postRequest({
        businessId: "biz-1",
        decisionKey: "dec-1",
        action: "acknowledge",
        expectedVersion: 1,
        assigneeUserId: "user-2",
      }),
    );

    expect(response.status).toBe(503);
    expect(findMembership).not.toHaveBeenCalled();
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

/**
 * The canonical batched mode.
 *
 * The single-key read still exists and is unchanged; this adds one request for
 * a whole served page, because a per-row GET is an N+1 that grows with the
 * collection.
 */
describe("GET zero-base batched contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireBusinessAccess.mockResolvedValue({
      session: { user: { id: "user-1" } },
      membership: { role: "collaborator" },
    });
    readWorkflowRecords.mockResolvedValue(
      new Map([["ad:1", { ...openRecord, decisionKey: "ad:1", state: "acknowledged" }]]),
    );
    readWorkflowEvents.mockResolvedValue([]);
  });

  it("reads every key in ONE store call rather than one per row", async () => {
    await GET(
      getRequest("contract=zero-base.v1&businessId=biz-1&decisionKeys=ad:1,ad:2,ad:3"),
    );
    expect(readWorkflowRecords).toHaveBeenCalledTimes(1);
    expect(readWorkflowRecords.mock.calls[0][0].decisionKeys).toEqual(["ad:1", "ad:2", "ad:3"]);
    // The single-key reader is not used at all in this mode.
    expect(readWorkflowRecord).not.toHaveBeenCalled();
  });

  it("fills a decision with no row as open rather than omitting it", async () => {
    const body = await (
      await GET(getRequest("contract=zero-base.v1&businessId=biz-1&decisionKeys=ad:1,ad:2"))
    ).json();
    expect(body.workflows).toHaveLength(2);
    expect(body.workflows[1]).toMatchObject({ decisionKey: "ad:2", state: "open" });
    // Which ones actually had a row is reported, so "open" is not mistaken for
    // "somebody set this to open".
    expect(body.persistedKeys).toEqual(["ad:1"]);
  });

  it("de-duplicates keys", async () => {
    await GET(getRequest("contract=zero-base.v1&businessId=biz-1&decisionKeys=ad:1,ad:1,ad:2"));
    expect(readWorkflowRecords.mock.calls[0][0].decisionKeys).toEqual(["ad:1", "ad:2"]);
  });

  it("refuses an oversized batch instead of silently truncating it", async () => {
    const keys = Array.from({ length: 201 }, (_, index) => `ad:${index}`).join(",");
    const response = await GET(
      getRequest(`contract=zero-base.v1&businessId=biz-1&decisionKeys=${keys}`),
    );
    // A silently dropped key would render "nobody owns this" for a decision
    // somebody does own.
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("too_many_keys");
    expect(readWorkflowRecords).not.toHaveBeenCalled();
  });

  it("reads the journal only for the one decision that is open", async () => {
    await GET(
      getRequest("contract=zero-base.v1&businessId=biz-1&decisionKeys=ad:1,ad:2&decisionKey=ad:1"),
    );
    expect(readWorkflowEvents).toHaveBeenCalledTimes(1);
    expect(readWorkflowEvents.mock.calls[0][0].decisionKey).toBe("ad:1");
  });

  it("reads no journal when no decision is selected", async () => {
    await GET(getRequest("contract=zero-base.v1&businessId=biz-1&decisionKeys=ad:1"));
    expect(readWorkflowEvents).not.toHaveBeenCalled();
  });

  it("refuses to fetch a journal for a decision outside the batch", async () => {
    const body = await (
      await GET(
        getRequest("contract=zero-base.v1&businessId=biz-1&decisionKeys=ad:1&decisionKey=ad:99"),
      )
    ).json();
    expect(readWorkflowEvents).not.toHaveBeenCalled();
    expect(body.eventsFor).toBeNull();
  });

  it("authorizes the business before reading anything", async () => {
    requireBusinessAccess.mockResolvedValue({ error: new Response(null, { status: 403 }) });
    await GET(getRequest("contract=zero-base.v1&businessId=biz-1&decisionKeys=ad:1"));
    expect(readWorkflowRecords).not.toHaveBeenCalled();
  });

  it("leaves the legacy single-key mode untouched", async () => {
    readWorkflowRecord.mockResolvedValue(openRecord);
    const body = await (await GET(getRequest("businessId=biz-1&decisionKey=dec-1"))).json();
    // Same two fields, same shape, no contract marker.
    expect(Object.keys(body).sort()).toEqual(["available", "workflow"]);
    expect(readWorkflowRecords).not.toHaveBeenCalled();
  });
});
