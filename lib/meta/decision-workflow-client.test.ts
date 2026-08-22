import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKFLOW_READ_UNAVAILABLE,
  readDecisionWorkflow,
  submitDecisionWorkflow,
} from "@/lib/meta/decision-workflow-client";

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

const RECORD = {
  businessId: "biz_1",
  decisionKey: "rec_1",
  state: "acknowledged" as const,
  assigneeUserId: null,
  dueAt: null,
  snoozeUntil: null,
  reasonCode: null,
  stateVersion: 4,
};

describe("readDecisionWorkflow", () => {
  it("returns the served records", async () => {
    respond(200, { workflows: [RECORD], events: [] });
    const outcome = await readDecisionWorkflow({
      businessId: "biz_1",
      decisionKeys: ["rec_1"],
    });
    expect(outcome).toEqual({ ok: true, workflows: [RECORD], events: [] });
  });

  it("does not call the endpoint with an empty key list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await readDecisionWorkflow({
      businessId: "biz_1",
      decisionKeys: [],
    });
    expect(outcome).toEqual({ ok: true, workflows: [], events: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a failed read as unknown, never as 'nobody owns these'", async () => {
    /**
     * The rule this pins: an unread overlay is unknown, and rendering the
     * default "open" state would be a statement about other people's work made
     * on no evidence.
     */
    for (const [status, body] of [
      [500, { error: "boom" }],
      [403, { error: "forbidden" }],
      [200, { events: [] }],
      [200, null],
    ] as const) {
      respond(status, body);
      const outcome = await readDecisionWorkflow({
        businessId: "biz_1",
        decisionKeys: ["rec_1"],
      });
      expect(outcome.ok, `${status}`).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe(WORKFLOW_READ_UNAVAILABLE);
    }
  });

  it("treats a transport failure as unknown too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const outcome = await readDecisionWorkflow({
      businessId: "biz_1",
      decisionKeys: ["rec_1"],
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("submitDecisionWorkflow", () => {
  const submit = {
    action: "acknowledge" as const,
    expectedVersion: 3,
    mutationId: "m1",
    assigneeUserId: null,
    dueAt: null,
    snoozeUntil: null,
    reasonCode: null,
  };

  it("returns the server's new record", async () => {
    respond(200, { workflow: RECORD, replayed: false });
    const outcome = await submitDecisionWorkflow({
      businessId: "biz_1",
      decisionKey: "rec_1",
      submit,
    });
    expect(outcome).toEqual({ ok: true, workflow: RECORD, replayed: false });
  });

  it("carries expectedVersion so a stale edit cannot overwrite a newer one", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ workflow: RECORD }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await submitDecisionWorkflow({
      businessId: "biz_1",
      decisionKey: "rec_1",
      submit,
    });
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(body.expectedVersion).toBe(3);
    expect(body.decisionKey).toBe("rec_1");
    expect(body.businessId).toBe("biz_1");
  });

  it("reports a 409 as a conflict and carries the CURRENT record", async () => {
    /**
     * A conflict is not an error state: nothing was applied, and the server is
     * telling the surface what the decision is now. Showing that beats telling
     * the operator to reload and guess.
     */
    respond(409, {
      current: { ...RECORD, state: "resolved", stateVersion: 9 },
      message: "This decision changed while you were looking at it.",
    });
    const outcome = await submitDecisionWorkflow({
      businessId: "biz_1",
      decisionKey: "rec_1",
      submit,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.kind === "conflict") {
      expect(outcome.current.stateVersion).toBe(9);
      expect(outcome.current.state).toBe("resolved");
    } else {
      throw new Error("expected a conflict outcome");
    }
  });

  it("says the outcome is unknown when the request never came back", async () => {
    // Whether it landed is unknown, and the surface must not assume either way.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const outcome = await submitDecisionWorkflow({
      businessId: "biz_1",
      decisionKey: "rec_1",
      submit,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("unknown");
  });

  it("does not treat a 200 without a workflow as applied", async () => {
    respond(200, { replayed: true });
    const outcome = await submitDecisionWorkflow({
      businessId: "biz_1",
      decisionKey: "rec_1",
      submit,
    });
    expect(outcome.ok).toBe(false);
  });
});
