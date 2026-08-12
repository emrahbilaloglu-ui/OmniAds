// @vitest-environment jsdom

/**
 * The direct-page cursor boundary.
 *
 * A cursor arriving in the URL is attacker- and bookmark-controllable, so the
 * page must decide what it is *before* spending a query on it. The version
 * these tests were written against caught the store's rejection, quietly served
 * page one, and then handed the rejected cursor back to the client as
 * `restoredCursor` — so every row on that page advertised a return the API
 * boundary would 400. Both halves are asserted here: no read, and no
 * propagation.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/zero-base/agency-directory-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/zero-base/agency-directory-store")
  >("@/lib/zero-base/agency-directory-store");
  // decodeAgencyCursor stays real: it is the validator under test.
  return { ...actual, readAgencyDirectoryPage: vi.fn() };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

const AgencyClientsPage = (await import("@/app/a/desk/clients/page")).default;
const auth = await import("@/lib/auth");
const store = await import("@/lib/zero-base/agency-directory-store");
const { AGENCY_RETURN_PARAM } = await import("@/lib/workspace/agency-return");

function session() {
  return {
    sessionId: "sess_1",
    user: { id: "user_1", name: "Ada", email: "ada@example.com", avatar: null, language: "en" },
    activeBusinessId: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function page(items: number, cursor: string | null = null) {
  return {
    items: Array.from({ length: items }, (_, index) => ({
      businessId: `biz_${String(index).padStart(3, "0")}`,
      name: `Client ${String(index).padStart(3, "0")}`,
      role: "admin" as const,
      membershipStatus: "active" as const,
      configuredCurrency: "USD",
      sourceUpdatedAt: null,
      href: `/c/biz_${String(index).padStart(3, "0")}/home`,
    })),
    servedCount: items,
    totalCount: items,
    nextCursor: cursor,
    truncated: cursor !== null,
    disclosure: null,
  };
}

async function renderPage(query: Record<string, string> = {}) {
  const element = await AgencyClientsPage({ searchParams: Promise.resolve(query) });
  return render(element as React.ReactElement);
}

/** A cursor the real validator accepts. */
const VALID_CURSOR = Buffer.from(JSON.stringify({ k: "client 024", i: "biz_024" }), "utf8").toString(
  "base64url",
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(store.readAgencyDirectoryPage).mockResolvedValue(page(3) as never);
});

afterEach(cleanup);

describe("a malformed cursor fails closed", () => {
  const bad = {
    "not base64": "not-a-cursor!",
    oversized: "A".repeat(600),
    "wrong shape": Buffer.from(JSON.stringify({ nope: 1 }), "utf8").toString("base64url"),
    "missing id": Buffer.from(JSON.stringify({ k: "client 024" }), "utf8").toString("base64url"),
    "empty id": Buffer.from(JSON.stringify({ k: "a", i: "" }), "utf8").toString("base64url"),
    "non-string key": Buffer.from(JSON.stringify({ k: 1, i: "biz_1" }), "utf8").toString("base64url"),
  };

  for (const [label, cursor] of Object.entries(bad)) {
    it(`refuses a ${label} cursor without reading anything`, async () => {
      await renderPage({ cursor });
      // The whole point: a bad cursor costs no query.
      expect(store.readAgencyDirectoryPage).not.toHaveBeenCalled();
    });

    it(`renders the recovery state rather than a normal page for a ${label} cursor`, async () => {
      await renderPage({ cursor });
      expect(document.querySelector("[data-invalid-cursor]")).not.toBeNull();
      // No directory: silently serving page one would hide that a link broke.
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.queryByLabelText("Find a client")).toBeNull();
    });
  }

  it("offers exactly one recovery action, to a clean URL", async () => {
    await renderPage({ cursor: "not-a-cursor!" });
    const recovery = screen.getByRole("link", { name: "Return to first page" });
    expect(recovery).toHaveAttribute("href", "/a/desk/clients");
  });

  it("never propagates the rejected cursor anywhere on the page", async () => {
    const cursor = "tampered-cursor-value";
    const { container } = await renderPage({ cursor, q: "acme" });

    // Not in a link, not in an attribute, not in the text.
    expect(container.innerHTML).not.toContain(cursor);
    for (const link of screen.getAllByRole("link")) {
      const href = link.getAttribute("href") ?? "";
      expect(href).not.toContain(cursor);
      expect(href).not.toContain(AGENCY_RETURN_PARAM);
      expect(href).not.toContain("cursor=");
    }
  });

  it("does not carry a stale search term into the recovery link", async () => {
    await renderPage({ cursor: "bad!", q: "acme" });
    // A clean URL means clean: the recovery must not re-apply a filter the
    // operator did not ask for on the first page.
    expect(screen.getByRole("link", { name: "Return to first page" })).toHaveAttribute(
      "href",
      "/a/desk/clients",
    );
  });
});

describe("a valid cursor is honoured", () => {
  it("reads the requested page and restores its provenance", async () => {
    vi.mocked(store.readAgencyDirectoryPage).mockResolvedValue(page(3, null) as never);
    await renderPage({ cursor: VALID_CURSOR });

    expect(store.readAgencyDirectoryPage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(store.readAgencyDirectoryPage).mock.calls[0][0];
    expect(call.cursor).toBe(VALID_CURSOR);
    expect(call.userId).toBe("user_1");
    expect(call.withTotal).toBe(true);

    // Rows served from that page carry it as their restore cursor.
    const href = screen.getByRole("link", { name: "Open Client 000" }).getAttribute("href")!;
    const returnTo = new URL(href, "https://app.invalid").searchParams.get(AGENCY_RETURN_PARAM)!;
    expect(decodeURIComponent(returnTo)).toContain(`cursor=${encodeURIComponent(VALID_CURSOR)}`);
  });

  it("renders the directory with no cursor at all", async () => {
    await renderPage({});
    expect(store.readAgencyDirectoryPage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.readAgencyDirectoryPage).mock.calls[0][0].cursor).toBeNull();
    expect(screen.getByRole("table")).toBeVisible();
  });
});

describe("membership disappearing between navigation and read", () => {
  it("shows the empty state rather than a stale page", async () => {
    // The cursor is well-formed, but the actor's membership was revoked in the
    // meantime, so the authorized query now returns nothing for that position.
    vi.mocked(store.readAgencyDirectoryPage).mockResolvedValue(page(0) as never);
    await renderPage({ cursor: VALID_CURSOR });

    expect(screen.getByTestId("state-empty")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("still refuses to render a client the query did not return", async () => {
    vi.mocked(store.readAgencyDirectoryPage).mockResolvedValue(page(0) as never);
    await renderPage({ cursor: VALID_CURSOR });
    // Nothing from a previous page can leak through: the page renders only
    // what this authorized read returned.
    expect(screen.queryByText(/Client 0/)).toBeNull();
  });
});

describe("authentication", () => {
  it("redirects an unauthenticated visitor before touching the cursor", async () => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValue(null as never);
    await expect(
      AgencyClientsPage({ searchParams: Promise.resolve({ cursor: "bad!" }) }),
    ).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    expect(store.readAgencyDirectoryPage).not.toHaveBeenCalled();
  });
});
