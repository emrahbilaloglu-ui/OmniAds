// @vitest-environment jsdom

/**
 * The Automation surface's account-scope contract.
 *
 * `providerAccountId === null` short-circuits BOTH client reads — the control
 * plane and the confirmation queue — before any request leaves the browser.
 * That is correct (an unresolved scope must never be guessed at), but it used
 * to be SILENT: the queue count sat at "—" forever, no proposal row could ever
 * appear, and on the legacy mount every card em-dashed with nothing on screen
 * saying why.
 *
 * REWRITTEN, not deleted. The earlier version of this file pinned "and no
 * picker was introduced to fix it", on the reading that the design draws no
 * account control. Stating the reason turned out not to be enough: a business
 * with several assigned accounts could read the sentence "select one assigned
 * Meta ad account" and have no way to select one short of hand-editing the
 * address bar, which is a dead end rather than a refusal. Launchpad had
 * already resolved the same tension the same way, so Automation follows it.
 *
 * The law these tests now pin:
 *
 * - The picker is mounted ONLY where the scope is unresolved. A resolved
 *   screen renders no `select` at all, so the design's surface is untouched in
 *   every state an operator normally sees.
 * - The client may only REQUEST an account: selecting one writes the id into
 *   the URL and the canonical route re-resolves it server-side. A URL
 *   parameter never becomes authority.
 * - Nothing is auto-picked. One assigned account is an unambiguous
 *   resolution, not a choice; the first of several is a guess and is never
 *   made.
 * - While no account is resolved, every mutating control is disabled rather
 *   than rendered live over a scope that cannot carry a write.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scopeMocks = vi.hoisted(() => ({
  fetchAccounts: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectedBusinessId: "store_business" }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: scopeMocks.replace, push: vi.fn() }),
}));
vi.mock("@/lib/meta/history-client", () => ({
  fetchMetaHistoryAccounts: scopeMocks.fetchAccounts,
}));

const MetaAutomationPage = (await import("./automation-view")).default;

function notice(container: HTMLElement) {
  return container.querySelector("[data-field='read-error']");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Meta Automation account scope", () => {
  it("states the reason when more than one assigned account leaves the scope unresolved", async () => {
    const providerFetch = vi.spyOn(globalThis, "fetch");
    scopeMocks.fetchAccounts.mockResolvedValue([
      { id: "act_1", name: "One" },
      { id: "act_2", name: "Two" },
    ]);

    const { container } = render(<MetaAutomationPage />);

    await waitFor(() => {
      expect(notice(container)).not.toBeNull();
    });
    expect(notice(container)?.getAttribute("data-reason")).toBe(
      "provider_account_scope_unresolved",
    );
    expect(notice(container)?.textContent).toContain(
      "No Meta ad account is resolved for this business",
    );
    // The silence was the defect, not the refusal to read: no request may be
    // issued for an unresolved scope.
    expect(providerFetch).not.toHaveBeenCalled();

    // The way out of the dead end. It offers the assigned accounts and
    // pre-selects none of them: picking the first of several on the operator's
    // behalf is exactly the silent scope this screen must never invent.
    const picker = container.querySelector<HTMLSelectElement>(
      "[data-control='account-picker'] select",
    );
    expect(picker).not.toBeNull();
    expect(Array.from(picker!.options).map((option) => option.value)).toEqual([
      "",
      "act_1",
      "act_2",
    ]);
    expect(picker!.value).toBe("");
  });

  it("requests the chosen account through the URL, never by granting it", async () => {
    scopeMocks.fetchAccounts.mockResolvedValue([
      { id: "act_1", name: "One" },
      { id: "act_2", name: "Two" },
    ]);

    const { container } = render(
      <MetaAutomationPage businessId="route_business" providerAccountId={null} />,
    );

    const picker = await waitFor(() => {
      const found = container.querySelector<HTMLSelectElement>(
        "[data-control='account-picker'] select",
      );
      expect(found).not.toBeNull();
      return found!;
    });

    fireEvent.change(picker, { target: { value: "act_2" } });

    // The id goes into the address bar and the canonical route re-runs
    // `resolveProviderAccountId` against this business's assignments. An
    // unassigned id therefore still comes back null: this widens nothing.
    expect(scopeMocks.replace).toHaveBeenCalledTimes(1);
    expect(String(scopeMocks.replace.mock.calls[0]?.[0])).toContain(
      "providerAccountId=act_2",
    );
  });

  it("disables every mutating control while no account is resolved", async () => {
    scopeMocks.fetchAccounts.mockResolvedValue([
      { id: "act_1", name: "One" },
      { id: "act_2", name: "Two" },
    ]);

    const { container } = render(<MetaAutomationPage />);

    await waitFor(() => {
      expect(notice(container)).not.toBeNull();
    });

    // A control rendered live over a null account can only fail: every write
    // this screen issues is account-scoped and the routes refuse it.
    const newRule = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("New rule"),
    );
    expect(newRule).toBeDefined();
    expect(newRule).toBeDisabled();
    expect(
      container.querySelector("[data-control='approve']"),
    ).toBeNull();
  });

  it("distinguishes a business with no assigned account from a failed assignments read", async () => {
    scopeMocks.fetchAccounts.mockResolvedValue([]);
    const empty = render(<MetaAutomationPage />);
    await waitFor(() => {
      expect(notice(empty.container)?.getAttribute("data-reason")).toBe(
        "provider_account_none_assigned",
      );
    });
    cleanup();

    scopeMocks.fetchAccounts.mockRejectedValue(new Error("assignments down"));
    const broken = render(<MetaAutomationPage />);
    await waitFor(() => {
      expect(notice(broken.container)?.getAttribute("data-reason")).toBe(
        "provider_account_scope_unavailable",
      );
    });
    // A failed read must never be reported as "this business has no accounts".
    expect(notice(broken.container)?.textContent).not.toContain(
      "No Meta ad account is assigned",
    );
  });

  it("says why the queue is blank when the server itself resolved a null scope", async () => {
    const providerFetch = vi.spyOn(globalThis, "fetch");
    // Two assigned accounts is what makes the server resolve null in the first
    // place, so that is the state this test describes.
    scopeMocks.fetchAccounts.mockResolvedValue([
      { id: "act_1", name: "One" },
      { id: "act_2", name: "Two" },
    ]);
    const { container } = render(
      <MetaAutomationPage businessId="route_business" providerAccountId={null} />,
    );

    await waitFor(() => {
      expect(notice(container)).not.toBeNull();
    });
    expect(notice(container)?.getAttribute("data-reason")).toBe(
      "provider_account_scope_unresolved",
    );
    // Rewritten with the picker. The old law was "the client must not go
    // looking for an account the server already declined to resolve", which
    // read the assignment list as scope-widening. It is not: it is the very
    // set `resolveProviderAccountId` authorizes against, so asking for it can
    // only ever offer a subset of what the server would already accept — and
    // without it the unresolved state has nothing to offer and stays a dead
    // end. What must NOT happen is a scoped read, and that is what is pinned.
    await waitFor(() => {
      expect(scopeMocks.fetchAccounts).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: "route_business" }),
      );
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  /**
   * ITEM 9. A queue error gets a retry, and that retry must be a READ.
   *
   * The dangerous shape is the obvious one: a failed decision, a control
   * labelled Retry, and a second POST behind it. The first POST may already
   * have reached the provider — the receipt says so — so re-sending it could
   * pause the same entity twice for one decision. The recovery therefore
   * re-runs the read and nothing else; recovering the WRITE is the claim's job
   * on the server, not a button's.
   */
  it("never re-sends a decision from the queue's retry control", async () => {
    scopeMocks.fetchAccounts.mockResolvedValue([{ id: "act_solo", name: "Solo" }]);
    const calls: Array<{ url: string; method: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (method === "POST") {
        return new Response(
          JSON.stringify({
            ok: false,
            error: { code: "proposal_claim_conflict", message: "Held elsewhere." },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("/api/meta/automation/proposals")) {
        return new Response(
          JSON.stringify({
            ok: true,
            readCompleteness: { proposals: "complete" },
            proposals: [
              {
                id: "proposal_1",
                actionLabel: "Pause ad set",
                proposedAction: "pause",
                entityLabel: "Retargeting 7d",
                reason: "ROAS below breakeven.",
                evidenceLabel: "frees $680/d",
                primaryCaption: "Approve & apply",
                expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, automation: null }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch);

    const { container } = render(<MetaAutomationPage />);

    const approve = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        "[data-control='approve']",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(approve);

    // The refused decision empties the queue to `unavailable` — never to an
    // empty success — and surfaces the server's own words.
    const retry = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        "[data-control='retry-queue']",
      );
      expect(found).not.toBeNull();
      return found!;
    });

    const postsBeforeRetry = calls.filter((call) => call.method === "POST").length;
    expect(postsBeforeRetry).toBe(1);

    fireEvent.click(retry);
    await waitFor(() => {
      expect(
        calls.filter((call) => call.url.startsWith("/api/meta/automation/proposals"))
          .length,
      ).toBeGreaterThan(2);
    });

    // The whole point: still exactly one POST. Everything the retry did was a
    // read.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("clears the notice once exactly one assigned account resolves the scope", async () => {
    scopeMocks.fetchAccounts.mockResolvedValue([{ id: "act_solo", name: "Solo" }]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, proposals: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { container } = render(<MetaAutomationPage />);

    await waitFor(() => {
      expect(scopeMocks.fetchAccounts).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        container.querySelector("[data-field='read-error']")?.getAttribute(
          "data-reason",
        ),
      ).not.toBe("provider_account_scope_unresolved");
    });
  });
});
