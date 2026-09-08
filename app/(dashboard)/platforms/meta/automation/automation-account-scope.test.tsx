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
 * The law these tests now pin:
 *
 * - Account selection stays in the shared topbar on desktop and mobile. The
 *   surface names that recovery path and never mounts a second picker.
 * - A server-authorized account arriving after a topbar switch drives the
 *   account-scoped reads without client-side scope invention.
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

const automationView = await import("./automation-view");
const MetaAutomationPage = automationView.default;

function notice(container: HTMLElement) {
  return container.querySelector("[data-field='read-error']");
}

function mobileSurface(container: HTMLElement) {
  return container.querySelector<HTMLElement>(
    "[data-testid='meta-mobile-automation']",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Meta Automation account scope", () => {
  it("uses fixed buyer-facing freshness reasons", () => {
    expect(
      automationView.metaAutomationFreshnessPartialReason({
        hasProviderAccount: false,
        incomplete: true,
      }),
    ).toBe("Select a Meta account to view automation data.");
    expect(
      automationView.metaAutomationFreshnessPartialReason({
        hasProviderAccount: true,
        incomplete: true,
      }),
    ).toBe("Some automation data is unavailable. Try again.");
    expect(
      automationView.metaAutomationFreshnessPartialReason({
        hasProviderAccount: true,
        incomplete: false,
      }),
    ).toBeNull();
  });

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
      "Choose a Meta ad account in the top bar to see its automation status",
    );
    // The silence was the defect, not the refusal to read: no request may be
    // issued for an unresolved scope.
    expect(providerFetch).not.toHaveBeenCalled();

    const desktopNotice = notice(container);
    expect(
      desktopNotice?.querySelector("[data-control='account-picker']"),
    ).toBeNull();
    expect(
      desktopNotice?.querySelector("[data-control='retry-read']"),
    ).not.toBeNull();

    const mobile = mobileSurface(container);
    expect(mobile).not.toBeNull();
    expect(mobile!.querySelectorAll("[data-field='read-error']")).toHaveLength(
      1,
    );
    expect(
      mobile!
        .querySelector("[data-field='read-error']")
        ?.getAttribute("data-reason"),
    ).toBe("provider_account_scope_unresolved");
    expect(mobile!.textContent).toContain(
      "Choose a Meta ad account in the top bar to see its automation status",
    );
    expect(
      mobile!.querySelectorAll("[data-control='account-picker']"),
    ).toHaveLength(0);
    expect(
      mobile!.querySelectorAll("[data-control='retry-read']"),
    ).toHaveLength(1);

    // One actionable recovery replaces the four repeated unavailable cards on
    // the narrow surface. The invariant that launches always need approval is
    // still visible even though no account-scoped mode could be read.
    expect(
      mobile!.querySelector("[data-field='action-modes-unavailable']"),
    ).toBeNull();
    expect(
      mobile!.querySelector("[data-testid='mobile-stop-control']"),
    ).toBeNull();
    expect(mobile!.textContent).not.toContain("Pending approvals");
    expect(mobile!.textContent).not.toContain("Recent activity");
    const launch = mobile!.querySelector("[data-decision-type='launch']");
    expect(launch).not.toBeNull();
    expect(launch?.textContent).toContain("Launches · new spend");
    expect(launch?.textContent).toContain("Always manual");
  });

  it("accepts a server-authorized topbar switch without mounting a local selector", async () => {
    scopeMocks.fetchAccounts.mockResolvedValue([
      { id: "act_1", name: "One" },
      { id: "act_2", name: "Two" },
    ]);
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, automation: null, proposals: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { container, rerender } = render(
      <MetaAutomationPage
        businessId="route_business"
        providerAccountId={null}
      />,
    );

    await waitFor(() => {
      expect(notice(container)?.getAttribute("data-reason")).toBe(
        "provider_account_scope_unresolved",
      );
    });
    expect(container.querySelector("[data-control='account-picker']")).toBeNull();
    expect(scopeMocks.replace).not.toHaveBeenCalled();

    rerender(
      <MetaAutomationPage
        businessId="route_business"
        providerAccountId="act_2"
      />,
    );

    await waitFor(() => {
      expect(
        providerFetch.mock.calls.some(([input]) =>
          String(input).includes("providerAccountId=act_2"),
        ),
      ).toBe(true);
    });
    expect(container.querySelector("[data-control='account-picker']")).toBeNull();
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
    // this screen issues is account-scoped and the routes refuse it. The four
    // unavailable mode rows therefore collapse to one readable state instead
    // of drawing twelve indistinguishable disabled choices.
    const newRule = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("New rule"),
    );
    expect(newRule).toBeDefined();
    expect(newRule).toBeDisabled();
    expect(container.querySelector("[data-control='approve']")).toBeNull();

    const modeButtons = container.querySelectorAll<HTMLButtonElement>(
      "[data-testid='automation-action-modes-desktop'] [data-mode]",
    );
    expect(modeButtons).toHaveLength(0);
    expect(
      container.querySelector(
        "[data-testid='automation-action-modes-desktop'] [data-field='action-modes-unavailable']",
      ),
    ).not.toBeNull();
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
      <MetaAutomationPage
        businessId="route_business"
        providerAccountId={null}
      />,
    );

    await waitFor(() => {
      expect(notice(container)).not.toBeNull();
    });
    expect(notice(container)?.getAttribute("data-reason")).toBe(
      "provider_account_scope_unresolved",
    );
    // The assignment read distinguishes "none assigned" from "choose in the
    // topbar". It carries no account scope and cannot trigger an Automation
    // data read on its own.
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
    scopeMocks.fetchAccounts.mockResolvedValue([
      { id: "act_solo", name: "Solo" },
    ]);
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
            error: {
              code: "proposal_claim_conflict",
              message: "Held elsewhere.",
            },
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

    const postsBeforeRetry = calls.filter(
      (call) => call.method === "POST",
    ).length;
    expect(postsBeforeRetry).toBe(1);

    fireEvent.click(retry);
    await waitFor(() => {
      expect(
        calls.filter((call) =>
          call.url.startsWith("/api/meta/automation/proposals"),
        ).length,
      ).toBeGreaterThan(2);
    });

    // The whole point: still exactly one POST. Everything the retry did was a
    // read.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("clears the notice once exactly one assigned account resolves the scope", async () => {
    scopeMocks.fetchAccounts.mockResolvedValue([
      { id: "act_solo", name: "Solo" },
    ]);
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
        container
          .querySelector("[data-field='read-error']")
          ?.getAttribute("data-reason"),
      ).not.toBe("provider_account_scope_unresolved");
    });
  });
});
