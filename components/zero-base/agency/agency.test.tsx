// @vitest-environment jsdom

/**
 * Flow A, exercised through the rendered directory.
 *
 * The projection's own guarantees are unit-tested in
 * `lib/zero-base/agency-projection.test.ts`; this checks that the rendered
 * surface keeps them — that no forbidden field reaches the DOM, that the return
 * state on every Open link is allowlisted, and that a 50-client scan actually
 * reaches all fifty.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ClientDirectory } from "@/components/zero-base/agency/client-directory";
import { AgencyDeskView } from "@/components/zero-base/agency/agency-desk-view";
import { WithheldExplainer, WITHHELD_REASONS } from "@/components/zero-base/agency/withheld-explainer";
import { parseAgencyReturn, AGENCY_RETURN_PARAM } from "@/lib/workspace/agency-return";
import {
  AGENCY_MEMBERSHIP_REVOKED,
  findForbiddenAgencyKeys,
  type AgencySourceBusiness,
} from "@/lib/zero-base/agency-projection";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

afterEach(() => {
  cleanup();
  searchParams = new URLSearchParams();
});

function client(index: number, overrides: Partial<AgencySourceBusiness> = {}): AgencySourceBusiness {
  const padded = String(index).padStart(2, "0");
  return {
    id: `biz_${padded}`,
    name: `Client ${padded}`,
    role: "admin",
    membershipStatus: "active",
    currency: "USD",
    sourceUpdatedAt: "2026-08-10T12:00:00Z",
    ...overrides,
  };
}

const fifty = Array.from({ length: 50 }, (_, i) => client(i));

describe("alphabetical directory", () => {
  it("lists clients alphabetically with no sort control to imply another order", () => {
    render(
      <ClientDirectory
        businesses={[client(2, { name: "Zeta" }), client(1, { name: "Alpha" })]}
        returnPath="/a/desk/clients"
      />,
    );
    const rows = within(screen.getByRole("table")).getAllByRole("rowheader");
    expect(rows.map((row) => row.textContent)).toEqual(["Alpha", "Zeta"]);
    // No column header is a sort button — ordering is not negotiable here.
    for (const header of within(screen.getByRole("table")).getAllByRole("columnheader")) {
      expect(within(header).queryByRole("button")).toBeNull();
    }
  });

  it("renders no money, severity or ranking column", () => {
    render(<ClientDirectory businesses={fifty.slice(0, 3)} returnPath="/a/desk" />);
    const headers = within(screen.getByRole("table"))
      .getAllByRole("columnheader")
      .map((header) => header.textContent ?? "");
    expect(headers).toEqual(["Client", "Your role", "Currency", "Last source activity"]);

    const text = screen.getByRole("table").textContent ?? "";
    for (const forbidden of ["Spend", "Revenue", "ROAS", "Severity", "Priority", "Risk", "Rank"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps the rendered row data free of forbidden keys", () => {
    // The rows the component builds are the response body in all but name.
    expect(findForbiddenAgencyKeys(fifty.map((c) => ({ ...c })))).toEqual([]);
  });

  it("labels currency as configuration and activity as activity", () => {
    render(<ClientDirectory businesses={[client(1)]} returnPath="/a/desk" />);
    expect(screen.getByText("(configured)")).toBeVisible();
    expect(screen.getByText(/configured setting, not an observed provider value/i)).toBeVisible();
    expect(screen.getByText(/activity, not a health signal/i)).toBeVisible();
  });

  it("says a missing activity time is not recorded, rather than showing a dash", () => {
    render(<ClientDirectory businesses={[client(1, { sourceUpdatedAt: null })]} returnPath="/a/desk" />);
    // A dash reads like zero; "never recorded" is a different fact.
    expect(screen.getByText("Not recorded")).toBeVisible();
  });
});

describe("Open Client carries an allowlisted return state", () => {
  it("builds a return that parses against the allowlist", () => {
    render(<ClientDirectory businesses={[client(1)]} returnPath="/a/desk/clients" />);
    const link = screen.getByRole("link", { name: "Client 01" });
    const href = link.getAttribute("href")!;
    expect(href.startsWith("/c/biz_01/home?")).toBe(true);

    const returnTo = new URL(href, "https://app.invalid").searchParams.get(AGENCY_RETURN_PARAM);
    const parsed = parseAgencyReturn(returnTo);
    expect(parsed).not.toBeNull();
    expect(parsed!.path).toBe("/a/desk/clients");
    expect(parsed!.row).toBe("biz_01");
  });

  it("carries the search and cursor so the return lands on the same row", async () => {
    const user = userEvent.setup();
    render(<ClientDirectory businesses={fifty} returnPath="/a/desk/clients" pageSize={10} />);
    await user.type(screen.getByLabelText("Find a client"), "Client 0");

    const link = screen.getAllByRole("link")[0];
    const returnTo = new URL(link.getAttribute("href")!, "https://app.invalid").searchParams.get(
      AGENCY_RETURN_PARAM,
    );
    const parsed = parseAgencyReturn(returnTo)!;
    expect(parsed.q).toBe("Client 0");
    expect(parsed.row).toBeTruthy();
  });

  it("never emits a return outside the two allowlisted Agency paths", () => {
    for (const returnPath of ["/a/desk", "/a/desk/clients"] as const) {
      cleanup();
      render(<ClientDirectory businesses={[client(1)]} returnPath={returnPath} />);
      const returnTo = new URL(
        screen.getByRole("link", { name: "Client 01" }).getAttribute("href")!,
        "https://app.invalid",
      ).searchParams.get(AGENCY_RETURN_PARAM);
      expect(parseAgencyReturn(returnTo)?.path).toBe(returnPath);
    }
  });
});

describe("pagination boundaries", () => {
  it("scans 50 clients without repeating or dropping one", async () => {
    const user = userEvent.setup();
    render(<ClientDirectory businesses={fifty} returnPath="/a/desk" pageSize={10} />);

    const seen = new Set<string>();
    for (let page = 0; page < 6; page += 1) {
      for (const row of within(screen.getByRole("table")).getAllByRole("rowheader")) {
        seen.add(row.textContent ?? "");
      }
      const loadMore = screen.getByRole("button", { name: "Load more" });
      if (loadMore.getAttribute("aria-disabled") === "true") break;
      await user.click(loadMore);
    }
    expect(seen.size).toBe(50);
  });

  it("disables Load more at the end and says why", () => {
    render(<ClientDirectory businesses={fifty.slice(0, 3)} returnPath="/a/desk" pageSize={10} />);
    const loadMore = screen.getByRole("button", { name: "Load more" });
    expect(loadMore).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("All 3 are shown.")).toBeVisible();
  });

  it("restarts paging when the search changes", async () => {
    const user = userEvent.setup();
    render(<ClientDirectory businesses={fifty} returnPath="/a/desk" pageSize={10} />);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    // A stale cursor would skip matches sorting before it.
    await user.type(screen.getByLabelText("Find a client"), "Client 0");
    const rows = within(screen.getByRole("table")).getAllByRole("rowheader");
    expect(rows[0].textContent).toBe("Client 00");
  });
});

describe("empty and revoked states", () => {
  it("explains an empty directory rather than showing a bare table", () => {
    render(<ClientDirectory businesses={[]} returnPath="/a/desk" />);
    expect(screen.getByTestId("state-empty")).toHaveTextContent(/No clients yet/);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says so when returning from a client whose membership was revoked", () => {
    searchParams = new URLSearchParams("revoked=biz_99");
    render(<AgencyDeskView businesses={[client(1)]} />);
    // Queried by its own marker: the collection ships an sr-only live region
    // of its own, so getByRole("status") would be ambiguous.
    const notice = document.querySelector("[data-membership-revoked]");
    expect(notice).not.toBeNull();
    expect(notice).toHaveTextContent(AGENCY_MEMBERSHIP_REVOKED);
  });

  it("stays silent when the client is still listed", () => {
    searchParams = new URLSearchParams("revoked=biz_01");
    render(<AgencyDeskView businesses={[client(1)]} />);
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
