// @vitest-environment jsdom

/**
 * Flow A through the rendered directory, against a **server-paginated** source.
 *
 * The browser is given one bounded page and must ask the server for the next.
 * These tests therefore assert what the client does with pages — that it
 * appends without gaps, duplicates or reordering, that search filters only the
 * rows already served, and that the return state stays allowlisted.
 *
 * The pagination itself is proved against real PostgreSQL in
 * `scripts/ephemeral-postgres-agency-directory-seam-child.ts`; a mocked
 * database here would only prove the mock.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ClientDirectory,
  type AgencyDirectoryPageData,
} from "@/components/zero-base/agency/client-directory";
import { AgencyDeskView } from "@/components/zero-base/agency/agency-desk-view";
import { WithheldExplainer, WITHHELD_REASONS } from "@/components/zero-base/agency/withheld-explainer";
import { parseAgencyReturn, AGENCY_RETURN_PARAM } from "@/lib/workspace/agency-return";
import {
  AGENCY_MEMBERSHIP_REVOKED,
  findForbiddenAgencyKeys,
  type AgencyClientRow,
} from "@/lib/zero-base/agency-projection";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({ useSearchParams: () => searchParams }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

afterEach(() => {
  cleanup();
  searchParams = new URLSearchParams();
});

/** 121 clients: more than one page at every size used below. */
const TOTAL = 121;

function row(index: number, overrides: Partial<AgencyClientRow> = {}): AgencyClientRow {
  const padded = String(index).padStart(3, "0");
  return {
    businessId: `biz_${padded}`,
    name: `Client ${padded}`,
    role: "admin",
    membershipStatus: "active",
    configuredCurrency: "USD",
    sourceUpdatedAt: "2026-08-10T12:00:00Z",
    href: `/c/biz_${padded}/home`,
    ...overrides,
  };
}

const ALL = Array.from({ length: TOTAL }, (_, index) => row(index));

/** Stands in for the server: slices the fixed order by opaque cursor. */
function serverPage(cursor: string | null, pageSize: number): AgencyDirectoryPageData {
  const start = cursor ? ALL.findIndex((r) => r.businessId === cursor) + 1 : 0;
  const items = ALL.slice(start, start + pageSize);
  const nextCursor =
    start + pageSize < ALL.length ? (items[items.length - 1]?.businessId ?? null) : null;
  return {
    items,
    servedCount: items.length,
    totalCount: cursor ? null : TOTAL,
    nextCursor,
    truncated: nextCursor !== null,
    disclosure: null,
  };
}

function renderDirectory(pageSize = 25, overrides: Partial<React.ComponentProps<typeof ClientDirectory>> = {}) {
  const fetchPage = vi.fn(async (cursor: string) => serverPage(cursor, pageSize));
  const utils = render(
    <ClientDirectory
      initialPage={serverPage(null, pageSize)}
      returnPath="/a/desk/clients"
      fetchPage={fetchPage}
      {...overrides}
    />,
  );
  return { ...utils, fetchPage };
}

function servedNames(): string[] {
  return within(screen.getByRole("table"))
    .getAllByRole("rowheader")
    .map((cell) => cell.textContent ?? "");
}

describe("the browser receives one bounded page, not the whole list", () => {
  it("renders only the first page", () => {
    renderDirectory(25);
    expect(servedNames()).toHaveLength(25);
    // The remaining 96 clients are not in the DOM at all.
    expect(screen.queryByText("Client 100")).toBeNull();
  });

  it("asks the server for each subsequent page", async () => {
    const user = userEvent.setup();
    const { fetchPage } = renderDirectory(25);
    expect(fetchPage).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(servedNames()).toHaveLength(50));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    // The cursor is opaque to the client: it is echoed, never constructed.
    expect(fetchPage.mock.calls[0][0]).toBe("biz_024");
  });
});

describe("appending pages is gap-free, duplicate-free and order-preserving", () => {
  it("scans all 121 clients across pages", async () => {
    const user = userEvent.setup();
    renderDirectory(25);

    for (let page = 0; page < 6; page += 1) {
      const loadMore = screen.getByRole("button", { name: "Load more" });
      if (loadMore.getAttribute("aria-disabled") === "true") break;
      await user.click(loadMore);
      await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy());
    }

    const names = servedNames();
    expect(names).toHaveLength(TOTAL);
    expect(new Set(names).size).toBe(TOTAL);
    // Server order preserved exactly — the client never re-sorts.
    expect(names).toEqual(ALL.map((r) => r.name));
  });

  it("does not duplicate a row if the same page arrives twice", async () => {
    const user = userEvent.setup();
    // A retry or a double click must not append the same rows again.
    const fetchPage = vi.fn(async () => serverPage(null, 25));
    render(
      <ClientDirectory
        initialPage={serverPage(null, 25)}
        returnPath="/a/desk"
        fetchPage={fetchPage}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(servedNames()).toHaveLength(25);
  });

  it("keeps what is already shown when a page request fails", async () => {
    const user = userEvent.setup();
    const fetchPage = vi.fn(async () => {
      throw new Error("network");
    });
    render(
      <ClientDirectory
        initialPage={serverPage(null, 25)}
        returnPath="/a/desk"
        fetchPage={fetchPage}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(servedNames()).toHaveLength(25);
    expect(screen.getByRole("alert")).toHaveTextContent(/Nothing already shown was lost/);
  });

  it("disables Load more at the end of the directory, with the reason", async () => {
    const user = userEvent.setup();
    render(
      <ClientDirectory
        initialPage={{ ...serverPage(null, 25), nextCursor: null, truncated: false, totalCount: 25 }}
        returnPath="/a/desk"
        fetchPage={vi.fn()}
      />,
    );
    const loadMore = screen.getByRole("button", { name: "Load more" });
    expect(loadMore).toHaveAttribute("aria-disabled", "true");
    await user.click(loadMore);
    expect(screen.getByText("All 25 are shown.")).toBeVisible();
  });
});

describe("search is scoped to the rows already served", () => {
  it("filters the loaded page and never queries the server", async () => {
    const user = userEvent.setup();
    const { fetchPage } = renderDirectory(25);

    await user.type(screen.getByLabelText("Find a client"), "Client 01");
    expect(servedNames()).toEqual(["Client 010", "Client 011", "Client 012", "Client 013", "Client 014", "Client 015", "Client 016", "Client 017", "Client 018", "Client 019"]);
    // A server round trip here would make it an unbounded cross-client search.
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("cannot surface a client that has not been paged to", async () => {
    const user = userEvent.setup();
    renderDirectory(25);
    await user.type(screen.getByLabelText("Find a client"), "Client 100");
    // No empty table: the state says which of the three situations this is.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByTestId("state-empty")).toHaveTextContent(
      /No match for .Client 100. among the 25 clients loaded so far/,
    );
  });

  it("searches across every page loaded so far", async () => {
    const user = userEvent.setup();
    renderDirectory(25);
    for (let page = 0; page < 5; page += 1) {
      await user.click(screen.getByRole("button", { name: "Load more" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy());
    }
    await user.type(screen.getByLabelText("Find a client"), "Client 100");
    expect(servedNames()).toEqual(["Client 100"]);
  });

  it("states how much of the loaded set matched", async () => {
    const user = userEvent.setup();
    renderDirectory(25);
    await user.type(screen.getByLabelText("Find a client"), "Client 003");
    expect(screen.getByText(/Showing 1 of 25 loaded clients/)).toBeVisible();
  });
});

describe("safe projection survives rendering", () => {
  it("renders no money, severity or ranking column", () => {
    renderDirectory(25);
    const headers = within(screen.getByRole("table"))
      .getAllByRole("columnheader")
      .map((header) => header.textContent ?? "");
    expect(headers).toEqual(["Client", "Your role", "Currency", "Last source activity"]);

    const text = screen.getByRole("table").textContent ?? "";
    for (const forbidden of ["Spend", "Revenue", "ROAS", "Severity", "Priority", "Risk", "Rank"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("carries no forbidden key in the page payload", () => {
    expect(findForbiddenAgencyKeys(serverPage(null, 25))).toEqual([]);
  });

  it("labels currency as configuration and activity as activity", () => {
    renderDirectory(25);
    expect(screen.getAllByText("(configured)").length).toBeGreaterThan(0);
    expect(screen.getByText(/configured setting, not an observed provider value/i)).toBeVisible();
    expect(screen.getByText(/activity, not a health signal/i)).toBeVisible();
  });

  it("says a missing activity time is not recorded, rather than showing a dash", () => {
    render(
      <ClientDirectory
        initialPage={{ ...serverPage(null, 1), items: [row(0, { sourceUpdatedAt: null })] }}
        returnPath="/a/desk"
        fetchPage={vi.fn()}
      />,
    );
    expect(screen.getByText("Not recorded")).toBeVisible();
  });

  it("offers no sort control that would imply another order", () => {
    renderDirectory(25);
    for (const header of within(screen.getByRole("table")).getAllByRole("columnheader")) {
      expect(within(header).queryByRole("button")).toBeNull();
    }
  });
});

describe("Open Client carries an allowlisted return state", () => {
  it("parses back to the allowlist, with the row anchor", () => {
    renderDirectory(25);
    const href = screen.getByRole("link", { name: "Client 000" }).getAttribute("href")!;
    expect(href.startsWith("/c/biz_000/home?")).toBe(true);

    const returnTo = new URL(href, "https://app.invalid").searchParams.get(AGENCY_RETURN_PARAM);
    const parsed = parseAgencyReturn(returnTo)!;
    expect(parsed.path).toBe("/a/desk/clients");
    expect(parsed.row).toBe("biz_000");
  });

  it("points the return at the page the row is actually on", async () => {
    const user = userEvent.setup();
    renderDirectory(25);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(servedNames()).toHaveLength(50));

    // A row from the second page must return to the second page, not page one.
    const href = screen.getByRole("link", { name: "Client 030" }).getAttribute("href")!;
    const parsed = parseAgencyReturn(
      new URL(href, "https://app.invalid").searchParams.get(AGENCY_RETURN_PARAM),
    )!;
    expect(parsed.cursor).toBe("biz_024");
    expect(parsed.row).toBe("biz_030");
  });

  it("carries the search term so the return restores it", async () => {
    const user = userEvent.setup();
    renderDirectory(25);
    await user.type(screen.getByLabelText("Find a client"), "Client 003");
    const href = screen.getByRole("link", { name: "Client 003" }).getAttribute("href")!;
    const parsed = parseAgencyReturn(
      new URL(href, "https://app.invalid").searchParams.get(AGENCY_RETURN_PARAM),
    )!;
    expect(parsed.q).toBe("Client 003");
  });

  it("never emits a return outside the two allowlisted Agency paths", () => {
    for (const returnPath of ["/a/desk", "/a/desk/clients"] as const) {
      cleanup();
      renderDirectory(25, { returnPath });
      const returnTo = new URL(
        screen.getByRole("link", { name: "Client 000" }).getAttribute("href")!,
        "https://app.invalid",
      ).searchParams.get(AGENCY_RETURN_PARAM);
      expect(parseAgencyReturn(returnTo)?.path).toBe(returnPath);
    }
  });
});

describe("empty and revoked states", () => {
  const emptyPage: AgencyDirectoryPageData = {
    items: [],
    servedCount: 0,
    totalCount: 0,
    nextCursor: null,
    truncated: false,
    disclosure: null,
  };

  it("explains an empty directory rather than showing a bare table", () => {
    render(<ClientDirectory initialPage={emptyPage} returnPath="/a/desk" fetchPage={vi.fn()} />);
    expect(screen.getByTestId("state-empty")).toHaveTextContent(/No clients yet/);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says so when returning from a client whose membership was revoked", () => {
    searchParams = new URLSearchParams("revoked=biz_999");
    render(<AgencyDeskView initialPage={serverPage(null, 25)} />);
    const notice = document.querySelector("[data-membership-revoked]");
    expect(notice).not.toBeNull();
    expect(notice).toHaveTextContent(AGENCY_MEMBERSHIP_REVOKED);
  });

  it("stays silent when the client is still listed", () => {
    searchParams = new URLSearchParams("revoked=biz_000");
    render(<AgencyDeskView initialPage={serverPage(null, 25)} />);
    expect(document.querySelector("[data-membership-revoked]")).toBeNull();
  });
});

describe("Withheld explainer", () => {
  it("gives every reason an unlock, so the state has an exit", () => {
    render(<WithheldExplainer />);
    for (const reason of WITHHELD_REASONS) {
      const panel = document.querySelector(`[data-withheld-reason="${reason.id}"]`);
      expect(panel, reason.id).not.toBeNull();
      expect(panel!.textContent).toContain("Unlocks when");
    }
  });

  it("states that ranking is unavailable for the same reason totals are", () => {
    render(<WithheldExplainer />);
    expect(screen.getByText(/No client is ranked by inferred urgency/)).toBeVisible();
  });

  it("mentions no plan or tier — security is never gated on Scale", () => {
    render(<WithheldExplainer />);
    const text = document.body.textContent ?? "";
    for (const word of ["Scale", "plan", "upgrade", "tier"]) {
      expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
    }
  });
});
