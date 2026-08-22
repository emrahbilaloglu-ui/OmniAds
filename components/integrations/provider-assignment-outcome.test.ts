import { afterEach, describe, expect, it, vi } from "vitest";

import { saveProviderAssignments } from "@/components/integrations/provider-assignment-drawer-support";

/**
 * WP3 item 8: `selectionSaved` and `syncScheduled` are reported separately.
 *
 * The server has always distinguished them. The client collapsed both into
 * "did fetch throw", so a 202 — committed, nothing enqueued — and a demo 200 —
 * nothing committed at all — were indistinguishable from a clean success.
 */

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

const REQUEST = {
  provider: "meta" as const,
  businessId: "biz_1",
  draftIds: ["act_1", "act_2"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveProviderAssignments", () => {
  it("reports a clean save", async () => {
    respond(200, {
      success: true,
      assigned_accounts: ["act_1", "act_2"],
      selectionSaved: true,
      syncScheduled: true,
    });

    const result = await saveProviderAssignments(REQUEST);
    expect(result).toMatchObject({
      assignedIds: ["act_1", "act_2"],
      error: null,
      selectionSaved: true,
      syncScheduled: true,
      demo: false,
      notice: null,
    });
  });

  it("keeps a 202 saved but reports that no sync was scheduled", async () => {
    // `response.ok` is true for a 202, which is exactly why this used to read as
    // a plain success and the operator waited for data nothing was fetching.
    respond(202, {
      success: false,
      assigned_accounts: ["act_1"],
      selectionSaved: true,
      syncScheduled: false,
      message: "Your account selection was saved, but the first sync could not be scheduled.",
    });

    const result = await saveProviderAssignments(REQUEST);
    expect(result.error).toBeNull();
    expect(result.selectionSaved).toBe(true);
    expect(result.syncScheduled).toBe(false);
    expect(result.notice).toContain("could not be scheduled");
    expect(result.assignedIds).toEqual(["act_1"]);
  });

  it("does not treat a demo response as a save", async () => {
    respond(200, {
      success: false,
      demo: true,
      persisted: false,
      assigned_accounts: [],
      selectionSaved: false,
      syncScheduled: false,
      message: "This is a demo workspace, so account assignments are not saved.",
    });

    const result = await saveProviderAssignments(REQUEST);
    expect(result.demo).toBe(true);
    expect(result.selectionSaved).toBe(false);
    expect(result.assignedIds).toEqual([]);
    expect(result.notice).toContain("demo");
  });

  it("never returns the caller's own draft ids as the result", async () => {
    /**
     * The specific defect: the request's input presented as its result. A
     * caller reading `assignedIds` without also checking `error` would have
     * shown a confirmed selection for a write that never happened.
     */
    for (const [status, body] of [
      [500, { error: "assignment_save_failed", message: "nope" }],
      [409, { error: "account_list_not_fresh", message: "stale" }],
      [200, null],
      [200, { success: true }],
    ] as const) {
      respond(status, body);
      const result = await saveProviderAssignments(REQUEST);
      expect(result.assignedIds, `${status} ${JSON.stringify(body)}`).toEqual([]);
      expect(result.selectionSaved).toBe(false);
    }
  });

  it("treats an unreadable success body as not committed", async () => {
    // A 200 whose body cannot be parsed is not evidence of a write.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })),
    );
    const result = await saveProviderAssignments(REQUEST);
    expect(result.selectionSaved).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.assignedIds).toEqual([]);
  });

  it("reports a transport failure as a failure, not as an empty save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const result = await saveProviderAssignments(REQUEST);
    expect(result.error).toBe("Could not save account assignments.");
    expect(result.selectionSaved).toBe(false);
    expect(result.syncScheduled).toBe(false);
  });

  it("surfaces the server's own refusal message rather than a generic one", async () => {
    respond(409, {
      error: "account_list_from_previous_connection",
      message:
        "This account list was loaded under a previous connection. Reconnect and refresh the account list before saving.",
      selectionSaved: false,
      syncScheduled: false,
    });
    const result = await saveProviderAssignments(REQUEST);
    expect(result.error).toContain("previous connection");
  });
});
