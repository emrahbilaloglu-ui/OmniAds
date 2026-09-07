// @vitest-environment jsdom
//
// D078 R4 rendered proof: an assigned-but-DESELECTED account remains an
// explicit read-only scope in the account picker. Failure of the optional
// past-account lookup stays visible and does not silently redirect a requested
// historical scope to the first assigned account.
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MetaHistoryAccount,
  MetaHistoryHistoricalAccount,
  MetaHistoryResponse,
} from "@/lib/meta/history-contract";

const clientMock = vi.hoisted(() => ({
  fetchMetaHistoryAccounts: vi.fn(),
  fetchMetaHistoryAccountScopes: vi.fn(),
  fetchMetaHistoryPage: vi.fn(),
}));
const storeMock = vi.hoisted(() => ({
  selectedBusinessId: "biz_1",
  businesses: [{ id: "biz_1", name: "TheSwaf" }],
}));

vi.mock("@/lib/meta/history-client", () => ({
  fetchMetaHistoryAccounts: clientMock.fetchMetaHistoryAccounts,
  fetchMetaHistoryAccountScopes: clientMock.fetchMetaHistoryAccountScopes,
  fetchMetaHistoryPage: clientMock.fetchMetaHistoryPage,
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeMock),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/tier-zero-freshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

const MetaHistoryView = (
  await import("@/app/(dashboard)/platforms/meta/history/history-view")
).default;

const SELECTED: MetaHistoryAccount = {
  id: "act_main",
  name: "Main",
  currency: "USD",
  timezone: "America/Chicago",
};
const HISTORICAL: MetaHistoryHistoricalAccount = {
  id: "act_second",
  name: "Second",
  currency: "USD",
  timezone: "America/Chicago",
  selectionState: "deselected_historical",
  latestFactDate: "2026-08-20",
  spend14d: 1652.29,
  latestDecisionAsOf: "2026-08-21",
  latestDecisionRows: 126,
  policy:
    "Deselected — read-only historical evidence; excluded from serving and from every write control. Re-selecting it (or stopping its production) is an explicit operator decision.",
};

function journalResponse(providerAccountId: string): MetaHistoryResponse {
  return {
    mode: "read_only",
    accountScope:
      providerAccountId === HISTORICAL.id
        ? "deselected_historical"
        : "selected",
    scope: {
      businessId: "biz_1",
      providerAccountId,
      providerAccountName: null,
      currency: "USD",
      timezone: "America/Chicago",
    },
    filters: {
      businessId: "biz_1",
      providerAccountId,
      kind: null,
      entity: null,
      label: null,
      outcome: null,
      from: null,
      to: null,
      q: null,
    },
    entries: [],
    page: { limit: 50, returned: 0, total: null, nextCursor: null },
    identityContract: {
      canonicalDecisionIdAvailable: false,
      grouping: "persisted_source_rows",
      limitation: "none",
    },
    limitations: [],
  } as MetaHistoryResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  const url = new URL(window.location.href);
  url.searchParams.delete("providerAccountId");
  url.searchParams.delete("mode");
  url.searchParams.delete("replayDate");
  url.searchParams.set("window", "28d");
  url.searchParams.set("startDate", "2026-08-09");
  url.searchParams.set("endDate", "2026-09-05");
  window.history.replaceState({}, "", url);
  clientMock.fetchMetaHistoryAccountScopes.mockResolvedValue({
    accounts: [SELECTED],
    historicalAccounts: [HISTORICAL],
  });
  clientMock.fetchMetaHistoryPage.mockImplementation(
    async (input: { providerAccountId: string }) =>
      journalResponse(input.providerAccountId),
  );
});
afterEach(cleanup);

describe("History account picker — deselected/historical scopes (D078 R4)", () => {
  it("renders the deselected account in a clearly-marked read-only group, not the selected group", async () => {
    render(<MetaHistoryView />);
    await waitFor(() =>
      expect(clientMock.fetchMetaHistoryAccountScopes).toHaveBeenCalled(),
    );

    const group = (await screen.findByRole("group", {
      name: "Past accounts",
    })) as HTMLOptGroupElement;
    const option = Array.from(group.querySelectorAll("option")).find((item) =>
      item.value.includes("act_second"),
    );
    expect(option?.textContent).toContain("Second · past");
    // The selected group keeps its own clean labelling.
    const mainOption = screen.getByRole("option", {
      name: "Main",
    }) as HTMLOptionElement;
    expect(mainOption.closest("optgroup")).toBeNull();
  });

  it("a deep link to the deselected scope resolves and shows the read-only policy note with facts", async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("providerAccountId", HISTORICAL.id);
    window.history.replaceState({}, "", url);
    try {
      render(<MetaHistoryView />);
      const note = await screen.findByTestId("historical-account-scope-note");
      expect(note.textContent).toContain("This account is no longer assigned.");
      expect(note.textContent).toContain(
        "Its past activity remains available here.",
      );
      expect(note.textContent).not.toContain("read-only historical evidence");
      expect(note.textContent).not.toContain("produced decision rows");
      // The journal fetch really targeted the historical scope.
      await waitFor(() =>
        expect(
          clientMock.fetchMetaHistoryPage.mock.calls.some(
            ([input]) => input.providerAccountId === HISTORICAL.id,
          ),
        ).toBe(true),
      );
    } finally {
      const reset = new URL(window.location.href);
      reset.searchParams.delete("providerAccountId");
      window.history.replaceState({}, "", reset);
    }
  });

  it("defaults to the assigned account only when no account was requested", async () => {
    clientMock.fetchMetaHistoryAccountScopes.mockResolvedValue({
      accounts: [SELECTED],
      historicalAccounts: null,
    });
    render(<MetaHistoryView />);
    await waitFor(() =>
      expect(clientMock.fetchMetaHistoryPage).toHaveBeenCalled(),
    );
    const lookupNotice = screen.getByTestId("historical-scope-unavailable");
    expect(lookupNotice).toHaveAttribute("role", "status");
    expect(lookupNotice).toHaveTextContent(
      "Past account details are temporarily unavailable.",
    );
    expect(screen.getByLabelText("Meta account for History")).toHaveValue(
      SELECTED.id,
    );
    expect(
      screen.queryByRole("group", {
        name: "Past accounts",
      }),
    ).toBeNull();
  });

  it("preserves a deep-linked account when the past-account lookup fails", async () => {
    clientMock.fetchMetaHistoryAccountScopes.mockResolvedValue({
      accounts: [SELECTED],
      historicalAccounts: null,
    });
    const url = new URL(window.location.href);
    url.searchParams.set("providerAccountId", HISTORICAL.id);
    window.history.replaceState({}, "", url);

    render(<MetaHistoryView />);

    await waitFor(() =>
      expect(clientMock.fetchMetaHistoryPage).toHaveBeenCalled(),
    );
    expect(clientMock.fetchMetaHistoryPage).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: HISTORICAL.id }),
    );
    expect(screen.getByLabelText("Meta account for History")).toHaveValue(
      HISTORICAL.id,
    );
    expect(
      screen.getByRole("option", { name: "Requested account unavailable" }),
    ).toBeInTheDocument();
    const lookupNotice = screen.getByTestId("historical-scope-unavailable");
    expect(lookupNotice).toHaveAttribute("role", "status");
    expect(lookupNotice).toHaveTextContent(
      "Past account details are temporarily unavailable.",
    );
    expect(
      clientMock.fetchMetaHistoryPage.mock.calls.some(
        ([input]) => input.providerAccountId === SELECTED.id,
      ),
    ).toBe(false);
  });

  it("shows no note for the selected scope", async () => {
    render(<MetaHistoryView />);
    await waitFor(() =>
      expect(clientMock.fetchMetaHistoryPage).toHaveBeenCalled(),
    );
    expect(screen.queryByTestId("historical-account-scope-note")).toBeNull();
  });
});
