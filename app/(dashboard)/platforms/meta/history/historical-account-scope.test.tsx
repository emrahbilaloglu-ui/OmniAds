// @vitest-environment jsdom
//
// D078 R4 rendered proof: an assigned-but-DESELECTED account remains an
// explicit read-only scope in the account picker. Failure of the optional
// past-account lookup stays visible and does not silently redirect a requested
// historical scope to the first assigned account.
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
const SECOND_SELECTED: MetaHistoryAccount = {
  id: "act_backup",
  name: "Backup",
  currency: "EUR",
  timezone: "Europe/Berlin",
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
  url.searchParams.delete("businessId");
  url.searchParams.delete("row");
  url.searchParams.delete("cursor");
  url.searchParams.delete("q");
  url.searchParams.delete("inspector");
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
  it("requires an explicit responsive selection when multiple accounts are assigned", async () => {
    clientMock.fetchMetaHistoryAccountScopes.mockResolvedValue({
      accounts: [SELECTED, SECOND_SELECTED],
      historicalAccounts: [],
    });

    render(<MetaHistoryView />);

    const picker = await screen.findByLabelText("Meta account for History");
    await waitFor(() => expect(picker).toHaveValue(""));
    expect(
      screen.getByRole("option", { name: "Select account" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("history-account-required")).toHaveTextContent(
      "Choose an account above to view its history.",
    );
    expect(clientMock.fetchMetaHistoryPage).not.toHaveBeenCalled();
  });

  it("keeps duplicate assigned and historical names distinguishable by full account id", async () => {
    clientMock.fetchMetaHistoryAccountScopes.mockResolvedValue({
      accounts: [
        { ...SELECTED, name: "Same name" },
        { ...SECOND_SELECTED, name: "Same name" },
      ],
      historicalAccounts: [{ ...HISTORICAL, name: "Same name" }],
    });

    render(<MetaHistoryView />);

    const picker = await screen.findByLabelText("Meta account for History");
    await waitFor(() => expect(picker).toHaveValue(""));
    expect(
      Array.from((picker as HTMLSelectElement).options).map(
        (option) => option.text,
      ),
    ).toEqual([
      "Select account",
      "Same name · ID act_main",
      "Same name · ID act_backup",
      "Same name · ID act_second · past",
    ]);
  });

  it("clears account-bound URL and replay state before reading the selected account", async () => {
    clientMock.fetchMetaHistoryAccountScopes.mockResolvedValue({
      accounts: [SELECTED, SECOND_SELECTED],
      historicalAccounts: [],
    });
    const url = new URL(window.location.href);
    url.searchParams.set("businessId", "biz_1");
    url.searchParams.set("providerAccountId", SELECTED.id);
    url.searchParams.set("mode", "replay");
    url.searchParams.set("replayDate", "2026-08-20");
    url.searchParams.set("row", "ad:old");
    url.searchParams.set("cursor", "old-page");
    url.searchParams.set("q", "old search");
    url.searchParams.set("inspector", "open");
    window.history.replaceState({}, "", url);

    render(<MetaHistoryView />);
    await waitFor(() =>
      expect(clientMock.fetchMetaHistoryPage).toHaveBeenCalledWith(
        expect.objectContaining({ providerAccountId: SELECTED.id }),
      ),
    );
    clientMock.fetchMetaHistoryPage.mockClear();

    fireEvent.change(screen.getByLabelText("Meta account for History"), {
      target: { value: SECOND_SELECTED.id },
    });

    const switched = new URL(window.location.href);
    expect(switched.searchParams.get("businessId")).toBe("biz_1");
    expect(switched.searchParams.get("window")).toBe("28d");
    expect(switched.searchParams.get("startDate")).toBe("2026-08-09");
    expect(switched.searchParams.get("endDate")).toBe("2026-09-05");
    expect(switched.searchParams.get("providerAccountId")).toBe(
      SECOND_SELECTED.id,
    );
    for (const dropped of [
      "mode",
      "replayDate",
      "row",
      "cursor",
      "q",
      "inspector",
    ]) {
      expect(switched.searchParams.get(dropped), dropped).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Activity" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(clientMock.fetchMetaHistoryPage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerAccountId: SECOND_SELECTED.id,
          filters: expect.objectContaining({
            from: "2026-08-09",
            to: "2026-09-05",
          }),
        }),
      ),
    );
  });

  it("keeps account-catalog failures unavailable without claiming no assignment", async () => {
    clientMock.fetchMetaHistoryAccountScopes.mockRejectedValue(
      new Error("assignments down"),
    );

    render(<MetaHistoryView />);

    expect(
      await screen.findByText("Meta accounts are temporarily unavailable."),
    ).toBeInTheDocument();
    const picker = screen.getByLabelText("Meta account for History");
    expect(picker).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "Meta accounts unavailable" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No assigned Meta account")).toBeNull();
    expect(clientMock.fetchMetaHistoryPage).not.toHaveBeenCalled();
  });

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
    expect(option?.textContent).toContain("Second · ID act_second · past");
    // The selected group keeps its own clean labelling.
    const mainOption = screen.getByRole("option", {
      name: "Main · ID act_main",
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
