// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LAUNCHPAD_LIBRARY_REFUSED_MESSAGE,
  LaunchpadExactLanding,
  loadLaunchpadWorkspace,
  readLaunchpadDraftValidation,
} from "./legacy-page";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";

afterEach(cleanup);

function intent(overrides: Partial<MetaLaunchIntent> = {}): MetaLaunchIntent {
  return {
    id: "li_real_1",
    businessId: "biz_1",
    providerAccountId: "act_1",
    operation: "new_campaign",
    idempotencyKey: "idem_1",
    requestedStatus: "PAUSED",
    // No separate activation authorization: the fixture is a created-paused
    // intent, which is what every intent is until somebody approves turning
    // it on.
    activationApproval: null,
    lineage: {
      sourceDecisionId: "decision_1",
      sourceDecisionSnapshotId: "snapshot_1",
      creativeBriefId: null,
      sourceDraftId: "draft_1",
    },
    requestPayload: { campaign: { name: "Real Campaign" } },
    requestFingerprint: "fingerprint",
    status: "succeeded",
    validationReceipt: null,
    resultReceipt: {
      completedAt: "2026-08-11T16:40:00.000Z",
      providerAccountId: "act_1",
      campaignId: "campaign_1",
      adsetIds: ["adset_1"],
      adIds: ["ad_1"],
      steps: [],
      recovery: { retrySupported: false, rollbackSupported: false },
    },
    errorReceipt: null,
    createdBy: "operator_1",
    createdAt: "2026-08-11T16:39:00.000Z",
    updatedAt: "2026-08-11T16:40:00.000Z",
    startedAt: "2026-08-11T16:39:30.000Z",
    completedAt: "2026-08-11T16:40:00.000Z",
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft_1",
    providerAccountId: "act_1",
    name: "Real account draft",
    payload: { mode: "add_to_existing", copyMode: "reuse_creative" },
    status: "draft",
    updatedAt: "2026-08-11T14:12:00.000Z",
    ...overrides,
  } as never;
}

describe("LaunchpadExactLanding", () => {
  it("renders only the canonical landing inventory in canonical order", () => {
    const { container } = render(
      <LaunchpadExactLanding
        drafts={[draft()]}
        intents={[intent()]}
        loading={false}
        verifiedRole={null}
        verifiedHandoffName={null}
        onStartRole={vi.fn()}
        onApplyDraft={vi.fn()}
      />,
    );

    expect(screen.getByText("Meta · Guarded write surface")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "Launchpad" }),
    ).toBeTruthy();
    // Unrouted cards title themselves; a quoted em dash is not a name. The
    // chip carries the same word, so this asserts inside each card.
    for (const role of ["rebuild", "duplicate"]) {
      const card = screen.getByTestId(`launchpad-start-${role}`);
      expect(card.textContent).not.toContain("“—”");
    }
    expect(screen.queryByText("Rebuild “—”")).toBeNull();
    expect(screen.getByText("Start from scratch")).toBeTruthy();
    expect(
      screen.getByText("validation runs before any provider call"),
    ).toBeTruthy();
    expect(screen.getByText("Real account draft")).toBeTruthy();
    expect(screen.getByText("Real Campaign")).toBeTruthy();

    const labels = Array.from(
      container.querySelectorAll("[data-testid='launchpad-exact'] > *"),
    ).map((node) => node.getAttribute("data-testid") ?? node.tagName);
    expect(labels).toEqual([
      "DIV",
      "launchpad-notice",
      "launchpad-starts",
      "launchpad-drafts",
      "launchpad-receipts",
    ]);
    expect(container.textContent).not.toContain("Templates");
    expect(container.textContent).not.toContain("Source & mode");
    expect(container.textContent).not.toContain("Delete");
    expect(container.textContent).not.toContain("no automatic retry");
    expect(container.querySelector("details")).toBeNull();
  });

  it("only enables an explicitly authorized presentation role and keeps Manual available", () => {
    const onStartRole = vi.fn();
    render(
      <LaunchpadExactLanding
        drafts={[]}
        intents={[]}
        loading={false}
        verifiedRole="rebuild"
        verifiedHandoffName="Verified creative"
        onStartRole={onStartRole}
        onApplyDraft={vi.fn()}
      />,
    );

    expect(screen.getByText("Rebuild “Verified creative”")).toBeTruthy();
    expect(
      screen.getByTestId("launchpad-start-duplicate").textContent,
    ).not.toContain("“—”");
    const rebuild = within(
      screen.getByTestId("launchpad-start-rebuild"),
    ).getByRole("button");
    const duplicate = within(
      screen.getByTestId("launchpad-start-duplicate"),
    ).getByRole("button");
    const manual = screen.getByRole("button", { name: "New blank draft →" });
    expect(rebuild).not.toBeDisabled();
    expect(duplicate).toBeDisabled();
    expect(manual).not.toBeDisabled();

    fireEvent.click(rebuild);
    fireEvent.click(duplicate);
    fireEvent.click(manual);
    expect(onStartRole.mock.calls).toEqual([["rebuild"], ["manual"]]);
  });

  it("renders one draft action, no inferred validation verdict, and forwards resume", () => {
    const onApplyDraft = vi.fn();
    const realDraft = draft();
    render(
      <LaunchpadExactLanding
        drafts={[realDraft]}
        intents={[]}
        loading={false}
        verifiedRole={null}
        verifiedHandoffName={null}
        onStartRole={vi.fn()}
        onApplyDraft={onApplyDraft}
      />,
    );

    const row = screen.getByTestId("launchpad-draft-row");
    expect(within(row).getAllByRole("button")).toHaveLength(1);
    expect(within(row).getByText("—")).toBeTruthy();
    expect(within(row).queryByText("Ready")).toBeNull();
    fireEvent.click(
      within(row).getByRole("button", { name: "Resume editing" }),
    );
    expect(onApplyDraft).toHaveBeenCalledWith(realDraft);
  });

  it("binds draft mode only to persisted copyMode and withholds unproven new-campaign roles", () => {
    render(
      <LaunchpadExactLanding
        drafts={[
          draft({
            id: "reuse",
            name: "Reuse",
            payload: { mode: "add_to_existing", copyMode: "reuse_creative" },
          }),
          draft({
            id: "rebuild",
            name: "Rebuild source",
            payload: { mode: "add_to_existing", copyMode: "rebuild_creative" },
          }),
          draft({
            id: "new",
            name: "Unknown source",
            payload: { mode: "new_campaign" },
          }),
        ]}
        intents={[]}
        loading={false}
        verifiedRole={null}
        verifiedHandoffName={null}
        onStartRole={vi.fn()}
        onApplyDraft={vi.fn()}
      />,
    );

    expect(
      within(screen.getByText("Reuse").closest("tr")!).getByText("Duplicate"),
    ).toBeTruthy();
    expect(
      within(screen.getByText("Rebuild source").closest("tr")!).getByText(
        "Rebuild",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByText("Unknown source").closest("tr")!).getAllByText(
        "—",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      within(screen.getByText("Unknown source").closest("tr")!).queryByText(
        "Manual",
      ),
    ).toBeNull();
  });

  it("preserves the exact shell with dashes and disables all writes when scope is unavailable", () => {
    render(
      <LaunchpadExactLanding
        drafts={[]}
        intents={[]}
        loading={false}
        scopeReady={false}
        verifiedRole="duplicate"
        verifiedHandoffName="Verified source"
        onStartRole={vi.fn()}
        onApplyDraft={vi.fn()}
      />,
    );

    expect(screen.getByTestId("launchpad-exact")).toBeTruthy();
    expect(screen.getByTestId("launchpad-draft-empty")).toBeTruthy();
    expect(screen.getByTestId("launchpad-receipt-empty")).toBeTruthy();
    expect(
      screen
        .getAllByRole("button")
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });
});

describe("Launchpad drafts validation column", () => {
  function renderWithValidation(
    validation: Parameters<typeof LaunchpadExactLanding>[0]["draftValidations"],
  ) {
    render(
      <LaunchpadExactLanding
        drafts={[draft()]}
        intents={[]}
        loading={false}
        verifiedRole={null}
        verifiedHandoffName={null}
        draftValidations={validation}
        onStartRole={vi.fn()}
        onApplyDraft={vi.fn()}
      />,
    );
    return screen.getByTestId("launchpad-draft-row");
  }

  it("renders the server's clean verdict", () => {
    const row = renderWithValidation({
      draft_1: { status: "checked", ok: true, blockerCount: 0 },
    });
    const chip = within(row).getByText("Ready");
    expect(chip.getAttribute("data-status")).toBe("ready");
  });

  it("counts the blockers the server actually returned", () => {
    const row = renderWithValidation({
      draft_1: { status: "checked", ok: false, blockerCount: 2 },
    });
    const chip = within(row).getByText("2 blockers");
    expect(chip.getAttribute("data-status")).toBe("failed");
  });

  it("keeps the count singular for one blocker", () => {
    const row = renderWithValidation({
      draft_1: { status: "checked", ok: false, blockerCount: 1 },
    });
    expect(within(row).getByText("1 blocker")).toBeTruthy();
  });

  it.each(["pending", "unavailable"] as const)(
    "shows a dash rather than a verdict while the answer is %s",
    (status) => {
      const row = renderWithValidation({ draft_1: { status } });
      expect(within(row).queryByText("Ready")).toBeNull();
      expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
    },
  );
});

describe("readLaunchpadDraftValidation", () => {
  const draftPayload = { mode: "add_to_existing", copyMode: "reuse_creative" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the draft's own payload and reports the server's blockers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ ok: false, blockers: [{ code: "a" }, { code: "b" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readLaunchpadDraftValidation({
      businessId: "biz_1",
      providerAccountId: "act_1",
      draft: { payload: draftPayload as never },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/launchpad/meta/validate");
    expect(JSON.parse(init.body)).toEqual({
      businessId: "biz_1",
      providerAccountId: "act_1",
      payload: draftPayload,
    });
    expect(result).toEqual({ status: "checked", ok: false, blockerCount: 2 });
  });

  it("reports a bodiless response as unavailable rather than as Ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ error: { code: "meta_account_not_assigned" } }),
      }),
    );

    await expect(
      readLaunchpadDraftValidation({
        businessId: "biz_1",
        providerAccountId: "act_1",
        draft: { payload: draftPayload as never },
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("reports a transport failure as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(
      readLaunchpadDraftValidation({
        businessId: "biz_1",
        providerAccountId: "act_1",
        draft: { payload: draftPayload as never },
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });
});

describe("loadLaunchpadWorkspace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function workspace(body: Record<string, unknown>, ok = true, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const COMPLETE = { status: "complete", errorCode: null, observedAt: "t" };

  it("asks one endpoint for the whole first load", async () => {
    const fetchMock = workspace({ ok: true, accounts: [], sections: {} });

    await loadLaunchpadWorkspace("biz_1", "act_1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url.startsWith("/api/launchpad/meta/workspace?")).toBe(true);
    expect(url).toContain("businessId=biz_1");
    expect(url).toContain("providerAccountId=act_1");
  });

  it("returns the configured target CPA from the business target pack", async () => {
    workspace({
      ok: true,
      accounts: [],
      sections: { targetCpa: COMPLETE },
      targetCpa: 42.5,
    });

    await expect(
      loadLaunchpadWorkspace("biz_1", "act_1").then((read) => read.targetCpa),
    ).resolves.toBe(42.5);
  });

  it("returns null when no target CPA is configured", async () => {
    workspace({
      ok: true,
      accounts: [],
      sections: { targetCpa: COMPLETE },
      targetCpa: null,
    });

    await expect(
      loadLaunchpadWorkspace("biz_1", "act_1").then((read) => read.targetCpa),
    ).resolves.toBeNull();
  });

  it("reports a section the server did not report on as unread, not as empty", async () => {
    workspace({
      ok: true,
      accounts: [],
      // `drafts` complete, the other three never reached.
      sections: { drafts: COMPLETE },
      drafts: [],
    });

    const read = await loadLaunchpadWorkspace("biz_1", "act_1");

    expect(
      read.readOutcomes.map((source) => [source.id, source.outcome]),
    ).toEqual([
      ["templates", "failed"],
      ["recent-templates", "failed"],
      ["drafts", "empty"],
      ["receipts", "failed"],
    ]);
    expect(read.unavailableMessage).not.toBeNull();
  });

  it("says nothing is unread when every section answered", async () => {
    workspace({
      ok: true,
      accounts: [],
      sections: {
        accounts: COMPLETE,
        templates: COMPLETE,
        recentTemplates: COMPLETE,
        drafts: COMPLETE,
        intents: COMPLETE,
      },
      templates: [],
      recentTemplates: [],
      drafts: [],
      intents: [],
    });

    const read = await loadLaunchpadWorkspace("biz_1", "act_1");

    expect(read.unavailableMessage).toBeNull();
    expect(read.accountsRead).toBe(true);
    expect(read.readOutcomes.every((source) => source.outcome === "empty")).toBe(
      true,
    );
  });

  /*
   * LAW: missing or unreadable data must never become 0 or success.
   *
   * The composite route substituted an empty array for a store its capability
   * said could not be read, then stamped the section `complete` — so an
   * unmigrated schema reached the surface as "this workspace has no drafts".
   * §9 has a distinct outcome for exactly this: `not-ready`, whose §9.1 code
   * `schema_not_ready` says "It is unavailable, not empty."
   */
  it("reports an unmigrated store as not-ready, never as empty", async () => {
    workspace({
      ok: true,
      accounts: [],
      sections: {
        accounts: COMPLETE,
        templates: {
          status: "unavailable",
          errorCode: "schema_not_ready",
          observedAt: "t",
        },
        recentTemplates: {
          status: "unavailable",
          errorCode: "schema_not_ready",
          observedAt: "t",
        },
        drafts: COMPLETE,
        intents: COMPLETE,
      },
      templates: [],
      recentTemplates: [],
      drafts: [],
      intents: [],
    });

    const read = await loadLaunchpadWorkspace("biz_1", "act_1");

    expect(
      read.readOutcomes.map((source) => [
        source.id,
        source.outcome,
        source.failureCode,
      ]),
    ).toEqual([
      ["templates", "not-ready", "schema_not_ready"],
      ["recent-templates", "not-ready", "schema_not_ready"],
      ["drafts", "empty", undefined],
      ["receipts", "empty", undefined],
    ]);
    // And the sentence is the migration's, not "could not be read" — an
    // operator told that would go looking for an outage.
    expect(read.unavailableMessage).toContain("pending database migration");
  });

  it("calls a guest's refusal a refusal, and names the role", async () => {
    workspace({
      ok: true,
      accounts: [],
      sections: {
        accounts: COMPLETE,
        templates: {
          status: "unavailable",
          errorCode: "insufficient_role",
          observedAt: "t",
        },
      },
    });

    const read = await loadLaunchpadWorkspace("biz_1", "act_1");

    expect(read.readOutcomes[0]).toMatchObject({
      id: "templates",
      outcome: "failed",
      failureCode: "insufficient_role",
    });
    expect(read.unavailableMessage).toBe(LAUNCHPAD_LIBRARY_REFUSED_MESSAGE);
  });

  it("ignores a section code the closed vocabulary does not declare", async () => {
    workspace({
      ok: true,
      accounts: [],
      sections: {
        templates: {
          status: "unavailable",
          errorCode: "something_invented",
          observedAt: "t",
        },
      },
    });

    const read = await loadLaunchpadWorkspace("biz_1", "act_1");

    // Falls back to the transport-derived code rather than carrying a string
    // §9.1 never declared and no surface has a sentence for.
    expect(read.readOutcomes[0]!.failureCode).toBe("source_read_failed");
  });

  it("calls a refusal a refusal, not an empty workspace", async () => {
    workspace({}, false, 403);

    const read = await loadLaunchpadWorkspace("biz_1", "act_1");

    expect(
      read.readOutcomes.every(
        (source) =>
          source.outcome === "failed" &&
          source.failureCode === "capability_read_denied",
      ),
    ).toBe(true);
    expect(read.accountsRead).toBe(false);
    expect(read.templates).toEqual([]);
  });

  it("keeps rows from another account out of this account's view", async () => {
    workspace({
      ok: true,
      accounts: [],
      sections: {
        templates: COMPLETE,
        recentTemplates: COMPLETE,
        drafts: COMPLETE,
        intents: COMPLETE,
        recentAdActions: COMPLETE,
      },
      templates: [
        { id: "t_1", providerAccountId: "act_1" },
        { id: "t_2", providerAccountId: "act_other" },
      ],
      recentTemplates: [],
      drafts: [{ id: "d_1", providerAccountId: "act_other" }],
      intents: [{ id: "i_1", providerAccountId: "act_1" }],
      recentAdActions: [
        { resultingAdId: "a_1", accountId: "act_1" },
        { resultingAdId: "a_2", accountId: "act_other" },
      ],
    });

    const read = await loadLaunchpadWorkspace("biz_1", "act_1");

    expect(read.templates.map((row) => row.id)).toEqual(["t_1"]);
    expect(read.drafts).toEqual([]);
    expect(read.intents.map((row) => row.id)).toEqual(["i_1"]);
    expect(read.recentAdActions.map((row) => row.resultingAdId)).toEqual([
      "a_1",
    ]);
  });

  it("carries the server's account blocker instead of failing the whole read", async () => {
    workspace({
      ok: true,
      accounts: [{ id: "act_1" }, { id: "act_2" }],
      sections: { accounts: COMPLETE },
      accountBlocker: {
        code: "account_not_assigned",
        message: "Select one assigned Meta ad account.",
      },
    });

    const read = await loadLaunchpadWorkspace("biz_1", "");

    expect(read.accounts).toHaveLength(2);
    expect(read.accountsRead).toBe(true);
    expect(read.accountBlocker).toEqual({
      code: "account_not_assigned",
      message: "Select one assigned Meta ad account.",
    });
  });
});
