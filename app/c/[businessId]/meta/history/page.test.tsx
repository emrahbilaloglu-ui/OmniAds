// @vitest-environment jsdom

/**
 * Meta History canonical route — provider scope.
 *
 * The law these pin: the journal is read for the account the operator selected,
 * and for no other. The route used to accept no `searchParams` at all and pick
 * `accounts[0]`, so with two assigned accounts the shell said "B", the URL said
 * "B", and the surface read A's journal while printing A's name. Every later
 * read (search, outcome filter, Load more, Replay) inherited that scope, because
 * the client is handed the account the server chose.
 *
 * Falling back to a first account is therefore never acceptable: a requested id
 * this business does not hold must refuse, and several assigned accounts with no
 * selection must ask, because either fallback prints one account's history under
 * another account's heading.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((href: string): never => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});
const notFound = vi.fn((): never => {
  throw new Error("NEXT_NOT_FOUND");
});

// The account picker is a client component; this server-render harness has to
// stand in for the router hooks it holds. Only its markup is asserted here.
const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  notFound,
  redirect,
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
  usePathname: () => "/c/biz_route/meta/history",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
// The workspace clock. The route reads `businesses.timezone` through this — the
// same column `components/layout/v2/app-topbar.tsx` resolves its own presets
// against — so a rolling preset cannot expand to a different week here than in
// the chip above the page.
vi.mock("@/lib/access", () => ({ listUserBusinesses: vi.fn() }));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));
vi.mock("@/lib/zero-base/auth-routing", () => ({
  loginUrlFor: vi.fn(
    (next: string) => `/login?next=${encodeURIComponent(next)}`,
  ),
}));
vi.mock("@/lib/zero-base/provider-scope-server", () => ({
  /**
   * The surface-state resolver reads the SCOPE, not just the id: it needs the
   * refusal reason to tell "nothing assigned" from "several assigned, none
   * chosen". Derived from the same mock so the two can never disagree about
   * which account this request resolved to.
   */
  resolveProviderAccountScope: async (input: unknown) => {
    // Reaches the same mock through the module itself, because the factory
    // runs before the file's own bindings exist and cannot close over one.
    const { resolveProviderAccountId: resolveId } =
      (await import("@/lib/zero-base/provider-scope-server")) as {
        resolveProviderAccountId: (value: unknown) => Promise<string | null>;
      };
    const id = await resolveId(input);
    return id
      ? { providerAccountId: id, refusal: null, requestedButUnassigned: null }
      : {
          providerAccountId: null,
          refusal: "provider_account_none_assigned" as const,
          requestedButUnassigned: null,
        };
  },
  readProviderScopeCatalog: async () => ({
    provider: "meta" as const,
    accounts: [],
  }),
  resolveProviderAccountId: vi.fn(),
}));
vi.mock("@/lib/meta/history-read-model", () => ({
  readMetaHistoryAccounts: vi.fn(),
  readMetaHistoryAssignedAccountIds: vi.fn(),
  readMetaHistoryJournal: vi.fn(),
}));
// The client boundary owns router hooks this server-render harness cannot
// provide; only the scope it is handed matters here.
type ClientProps = {
  providerAccountId?: string;
  dateWindow?: {
    start: string;
    end: string;
    preset: string;
    source: "url" | "default";
  };
};
const historyClient = vi.fn((_props: ClientProps) => null);
vi.mock("@/components/zero-base/meta/history/history-client", () => ({
  HistoryClient: (props: ClientProps) => historyClient(props),
}));

const MetaHistoryPage = (await import("@/app/c/[businessId]/meta/history/page"))
  .default;
const auth = await import("@/lib/auth");
const businessPageAccess =
  await import("@/lib/access/require-business-page-context");
const providerScope = await import("@/lib/zero-base/provider-scope-server");
const readModel = await import("@/lib/meta/history-read-model");
const access = await import("@/lib/access");

/**
 * TheSwaf's clock — the live workspace this surface's scoping law was written
 * against, and a zone that is genuinely not UTC.
 */
const WORKSPACE_TIME_ZONE = "America/New_York";
/** The instant every window assertion below is resolved against. Midday UTC is
 *  still 2026-08-18 in New York, so both clocks name the same day. */
const WORKSPACE_NOW = "2026-08-18T12:00:00.000Z";

const ACCOUNT_A = {
  id: "act_A",
  name: "First account",
  currency: "USD",
  timezone: "UTC",
};
const ACCOUNT_B = {
  id: "act_B",
  name: "Second account",
  currency: "EUR",
  timezone: "UTC",
};

function session() {
  return {
    sessionId: "session_1",
    user: {
      id: "user_1",
      name: "Route Operator",
      email: "operator@example.com",
      avatar: null,
      language: "en",
    },
    activeBusinessId: "biz_route",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function authorizedContext(businessId: string) {
  return {
    kind: "ok" as const,
    context: {
      session: session(),
      membership: {
        businessId,
        userId: "user_1",
        role: "admin" as const,
        status: "active" as const,
      },
      businessId,
      role: "admin" as const,
      reviewerReadOnly: false,
      demo: false,
    },
  };
}

function journal(providerAccountId: string, providerAccountName: string) {
  return {
    mode: "read_only",
    scope: {
      businessId: "biz_route",
      providerAccountId,
      providerAccountName,
      currency: "USD",
      timezone: "UTC",
    },
    filters: {
      businessId: "biz_route",
      providerAccountId,
      kind: null,
      entity: null,
      label: null,
      from: null,
      to: null,
      q: null,
    },
    entries: [],
    page: { limit: 40, returned: 0, total: null, nextCursor: null },
    identityContract: {
      canonicalDecisionIdAvailable: false,
      grouping: "persisted_source_rows",
      limitation: "",
    },
    limitations: [],
  };
}

async function renderPage(
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  const element = await MetaHistoryPage({
    params: Promise.resolve({ businessId: "biz_route" }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(access.listUserBusinesses).mockResolvedValue([
    {
      id: "biz_route",
      name: "Route Business",
      timezone: WORKSPACE_TIME_ZONE,
      timezoneSource: null,
      currency: "USD",
      role: "admin",
      membershipStatus: "active",
    },
  ] as never);
  vi.mocked(businessPageAccess.requireBusinessPageContext).mockResolvedValue(
    authorizedContext("biz_route") as never,
  );
  vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([
    ACCOUNT_A,
    ACCOUNT_B,
  ] as never);
  vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
    "act_A",
    "act_B",
  ] as never);
  vi.mocked(readModel.readMetaHistoryJournal).mockImplementation(
    (async (input: { account: { id: string; name: string | null } }) =>
      journal(
        input.account.id,
        input.account.name ?? input.account.id,
      )) as never,
  );
});

describe("Meta History reads the selected account", () => {
  it("reads the requested account, not the first assigned one", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
      "act_B",
    );

    await renderPage({ providerAccountId: "act_B" });

    expect(providerScope.resolveProviderAccountId).toHaveBeenCalledWith({
      businessId: "biz_route",
      provider: "meta",
      requestedAccountId: "act_B",
    });
    const call = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0];
    // Both the query scope and the account identity must be B. Reading B while
    // labelling A is the exact failure the fallback produced.
    expect(call?.query.providerAccountId).toBe("act_B");
    expect(call?.account.id).toBe("act_B");
    // And the client keeps reading B for search, filter, Load more and Replay.
    expect(historyClient.mock.calls[0]?.[0].providerAccountId).toBe("act_B");
  });

  it("refuses an account this business is not assigned instead of falling back", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(null);

    const html = await renderPage({ providerAccountId: "act_FOREIGN" });

    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
    expect(html).toContain(
      "That Meta ad account is not assigned to this business.",
    );
    expect(html).not.toContain("act_FOREIGN");
    expect(html).not.toContain("journal");
  });

  it("asks for a choice rather than picking one of several assigned accounts", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(null);

    const html = await renderPage();

    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
    expect(html).toContain("Select a Meta ad account to view its history.");
  });

  it("still resolves the single assigned account with no parameter in the URL", async () => {
    // One assigned account is not a choice, so the operator is not asked to make
    // one; `resolveProviderAccountId` owns that rule.
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([
      ACCOUNT_A,
    ] as never);
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
      "act_A",
    );

    await renderPage();

    expect(
      vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0].account.id,
    ).toBe("act_A");
  });

  it("refuses when the resolved account is absent from the journal's account read", async () => {
    // Never invent a MetaHistoryAccount for an id the journal read did not
    // return: the currency and name on the surface would then be guesses.
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
      "act_C",
    );

    const html = await renderPage({ providerAccountId: "act_C" });

    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
    expect(html).toContain(
      "History is unavailable for the selected Meta ad account.",
    );
    expect(html).not.toContain("account act_C");
  });

  it("refuses an account whose assignment was withdrawn, even if the shared guard says yes", async () => {
    // Defence in depth, and the reason `readMetaHistoryAssignedAccountIds` is
    // read here at all. `business_provider_accounts` keeps the identity binding
    // forever and records the CURRENT selection in `is_selected`; History's own
    // account projection is a different statement and can outlive a
    // deselection. If the shared resolver ever answers with a stale id, the
    // page must still refuse — a deselected account's journal, currency and
    // name are not this business's to show.
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
      "act_A",
    ] as never);
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
      "act_B",
    );

    const html = await renderPage({ providerAccountId: "act_B" });

    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
    expect(html).toContain(
      "History is unavailable for the selected Meta ad account.",
    );
    expect(html).not.toContain("account act_B");
  });

  it("refuses an id belonging to another business, and never widens to one of its own", async () => {
    // Both reads are scoped by `businessId`, so a foreign id is absent from
    // both. The refusal must name the id that was asked for and read nothing —
    // silently substituting an account this business does hold would answer a
    // question about somebody else's account with our own data.
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
      "act_FOREIGN_BUSINESS",
    );

    const html = await renderPage({
      providerAccountId: "act_FOREIGN_BUSINESS",
    });

    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
    expect(html).toContain(
      "History is unavailable for the selected Meta ad account.",
    );
    expect(html).not.toContain("account act_FOREIGN_BUSINESS");
    expect(historyClient).not.toHaveBeenCalled();
  });

  it("reads only the selected account when a second one is merely a stale identity row", async () => {
    // History's projection still names B; the assignment says only A is
    // selected. One assigned account is not a choice, so A is read — and B is
    // nowhere on the surface.
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
      "act_A",
    ] as never);
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
      "act_A",
    );

    await renderPage();

    const call = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0];
    expect(call?.query.providerAccountId).toBe("act_A");
    expect(call?.account.id).toBe("act_A");
    expect(historyClient.mock.calls[0]?.[0].providerAccountId).toBe("act_A");
  });

  it('says unavailable when the assignment cannot be read, not "none assigned"', async () => {
    // A failed read is unknown. Reporting it as an empty assignment states a
    // fact about the business's configuration that nobody established, and the
    // operator would go looking for a setting that is already correct. It must
    // equally never fall the other way and read every account it can find.
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockRejectedValue(
      new Error("assignment read failed"),
    );

    const html = await renderPage({ providerAccountId: "act_B" });

    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
    expect(html).toMatch(/unavailable right now/);
    expect(html).not.toMatch(/Assign a Meta ad account/);
    expect(html).not.toContain("persisted Meta journal");
  });

  it("explains an unassigned business without journal terminology", async () => {
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([] as never);
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue(
      [] as never,
    );

    const html = await renderPage();

    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
    expect(html).toContain("Assign a Meta ad account to view its history.");
    expect(html).not.toContain("persisted Meta journal");
    expect(html).not.toContain("journal to read");
  });

  it("uses concise buyer copy when the selected account history read fails", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
      "act_B",
    );
    vi.mocked(readModel.readMetaHistoryJournal).mockRejectedValue(
      new Error("history source failed"),
    );

    const html = await renderPage({ providerAccountId: "act_B" });

    expect(html).toContain(
      "History could not be loaded for this Meta ad account. Refresh to try again.",
    );
    expect(html).not.toContain("persisted Meta journal");
    expect(html).not.toContain("journal could not be read");
  });

  it("offers the assigned accounts as a choice instead of a dead end", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(null);

    const html = await renderPage();

    expect(html).toContain('data-control="account-picker"');
    expect(html).toContain("First account");
    expect(html).toContain("Second account");
    // Nothing is pre-selected: offering a choice must not quietly make one.
    expect(html).toContain(">Select account</option>");
    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
  });

  it("does not offer a deselected account in the picker", async () => {
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([
      ACCOUNT_A,
      ACCOUNT_B,
    ] as never);
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
      "act_A",
      "act_C",
    ] as never);
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(null);

    const html = await renderPage();

    // Only A survives the intersection, so this is not a choice at all — and
    // certainly not one that lists an account the business no longer holds.
    expect(html).not.toContain("Second account");
  });

  it("resolves scope only after authentication and access have passed", async () => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValueOnce(null as never);

    await expect(
      MetaHistoryPage({
        params: Promise.resolve({ businessId: "biz_route" }),
        searchParams: Promise.resolve({ providerAccountId: "act_B" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:");

    expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
    expect(readModel.readMetaHistoryAccounts).not.toHaveBeenCalled();
  });
});

/**
 * ITEM 12 — the window the shell states is the window History reads.
 *
 * Both the first page read here and every later read the client issues used to
 * send `from: null, to: null`. The date control at the top of the screen
 * therefore changed the caption and nothing else: under "Last 7 days" the table
 * was the entire journal for the account, newest first, capped at a page.
 *
 * The first repair covered only the URL shape the shell writes — exact dates —
 * because the shared expansion was re-exported from a `"use client"` module and
 * calling it from a Server Component threw. Two shapes were left reading
 * UNBOUNDED underneath a chip that named a window: a bare `?window=7d`, and a
 * URL with no window parameters at all. `lib/dashboard/date-window-presets.ts`
 * has no client boundary now, so both are answerable, and these pin both.
 */
describe("Meta History reads the window the shell states", () => {
  beforeEach(() => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
      "act_B",
    );
    // Every rolling preset below is expanded against a pinned instant, so these
    // assertions cannot start lying tomorrow morning.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(WORKSPACE_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the URL's exact dates verbatim, for the read and for the client", async () => {
    await renderPage({
      providerAccountId: "act_B",
      window: "7d",
      startDate: "2026-08-11",
      endDate: "2026-08-17",
    });

    const call = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0];
    expect(call?.query.from).toBe("2026-08-11");
    expect(call?.query.to).toBe("2026-08-17");
    // The preset key is a LABEL. Re-expanding "7d" against this server's clock
    // is what made two surfaces measure two different weeks from one click.
    expect(historyClient.mock.calls[0]?.[0].dateWindow).toEqual({
      start: "2026-08-11",
      end: "2026-08-17",
      preset: "7d",
      source: "url",
    });
  });

  it("expands a bare preset through the shared authority, on the workspace clock", async () => {
    // RESTATED LAW. The old assertion here was that a bare `?window=7d` read
    // UNBOUNDED, and the comment beside it said why: the one expansion lives in
    // `lib/dashboard/date-window-url`, that expansion could not run in a Server
    // Component, and a private copy in this page would be a second expander free
    // to disagree with the shell about which week it meant.
    //
    // The premise is gone. The expansion moved to
    // `lib/dashboard/date-window-presets.ts`, which has no client boundary, so
    // the page expands the preset THROUGH THE SHARED AUTHORITY. There is still
    // exactly one expander; it is simply reachable now.
    //
    // Unbounded was never the neutral reading it looked like. The chip above the
    // table always asserts a window, so a table that ignored it answered a
    // question nobody asked while the control named the one they did.
    await renderPage({ providerAccountId: "act_B", window: "7d" });

    const call = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0];
    expect(call?.query.from).toBe("2026-08-11");
    expect(call?.query.to).toBe("2026-08-17");
    expect(historyClient.mock.calls[0]?.[0].dateWindow).toEqual({
      start: "2026-08-11",
      end: "2026-08-17",
      preset: "7d",
      source: "url",
    });
  });

  it("expands that preset on the WORKSPACE clock, not the server's", async () => {
    // 02:00 UTC on the 19th is still the 18th in New York. A server-zone
    // expansion would read 2026-08-12..2026-08-18 — a different week from the
    // one the chip is naming, and one that counts a part-day as a whole day.
    vi.setSystemTime(new Date("2026-08-19T02:00:00.000Z"));

    await renderPage({ providerAccountId: "act_B", window: "7d" });

    const call = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0];
    expect({ from: call?.query.from, to: call?.query.to }).toEqual({
      from: "2026-08-11",
      to: "2026-08-17",
    });
  });

  it("still honours exact dates that sit beside a preset key", async () => {
    // The pair the shell actually writes. The preset key is a label; the dates
    // are the window, and they are what gets read.
    await renderPage({
      providerAccountId: "act_B",
      window: "7d",
      startDate: "2026-08-11",
      endDate: "2026-08-17",
    });

    const call = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0];
    expect(call?.query.from).toBe("2026-08-11");
    expect(call?.query.to).toBe("2026-08-17");
  });

  it("falls back to the shell's own default when the URL states no window", async () => {
    // RESTATED LAW, and the one that reversed.
    //
    // The old assertion was `from: null, to: null`, on the reasoning that an
    // invented default "would hide entries nobody asked to exclude, and would do
    // it without saying so". The first half of that is right and is why the
    // second half is now false rather than accepted: the shell states the
    // fallback while the body reads that same bounded window.
    //
    // What the old reading actually produced was the opposite lie. The topbar
    // always asserts a window — before hydration it asserts the default, after
    // it the stored preset — so "the URL states nothing" never means "the
    // operator asked for everything". The table showed the whole journal back to
    // the beginning of the account under a chip reading "Last 28 days".
    //
    // The default is the shell's own (`DASHBOARD_V2_DEFAULT_DATE_RANGE`), so the
    // two fall back to the same length, and `useCanonicalDateWindowUrl` closes
    // the remaining gap by writing the stored selection onto the URL.
    const html = await renderPage({ providerAccountId: "act_B" });

    const call = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0];
    expect({ from: call?.query.from, to: call?.query.to }).toEqual({
      from: "2026-07-21",
      to: "2026-08-17",
    });
    expect(historyClient.mock.calls[0]?.[0].dateWindow).toEqual({
      start: "2026-07-21",
      end: "2026-08-17",
      preset: "28d",
      source: "default",
    });
    // `source` reaches the boundary as audit metadata. Its rendering is pinned
    // in `history-surface.test.tsx`; here HistoryClient is stubbed.
    //
    // What DOES render here is the §9 surface-state region, which the page owns
    // rather than the body. It is asserted rather than stripped: a page that
    // stopped stating its read state would otherwise pass this test unchanged.
    expect(html).toContain('data-meta-surface-state="meta-history"');
    expect(html).toContain('data-read-state="empty-proven"');
    expect(
      html.replace(/<div data-meta-surface-state[\s\S]*?<\/div>/, ""),
    ).toBe("");
  });

  it("marks a window the URL did state as coming from the URL, not from a default", async () => {
    // The two cases must be distinguishable downstream: agreeing with the chip
    // is not the same claim as falling back because the link said nothing.
    await renderPage({
      providerAccountId: "act_B",
      startDate: "2026-08-11",
      endDate: "2026-08-17",
    });

    expect(historyClient.mock.calls[0]?.[0].dateWindow?.source).toBe("url");
  });

  it("ignores an inverted date pair rather than repairing it into a plausible window", async () => {
    // Unchanged law, new landing place. An inverted pair is not a window and is
    // never repaired — 08-17..08-11 does not become 08-11..08-17, and neither
    // half becomes an endpoint. It falls through to the canonical default, which
    // is marked as a default, exactly as an empty URL is: a window nobody asked
    // for wearing the shape of the one they typed is the outcome that must never
    // ship, and it is the one thing NOT produced here.
    await renderPage({
      providerAccountId: "act_B",
      startDate: "2026-08-17",
      endDate: "2026-08-11",
    });

    const call = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0];
    expect({ from: call?.query.from, to: call?.query.to }).toEqual({
      from: "2026-07-21",
      to: "2026-08-17",
    });
    expect(call?.query.from).not.toBe("2026-08-11");
    expect(call?.query.to).not.toBe("2026-08-11");
    expect(historyClient.mock.calls[0]?.[0].dateWindow?.source).toBe("default");
  });

  it("does not repair a half pair either", async () => {
    // `?startDate=2026-08-01` with no end. It must not become 08-01..08-01, and
    // it must not become 08-01..today.
    await renderPage({ providerAccountId: "act_B", startDate: "2026-08-01" });

    const call = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0];
    expect(call?.query.from).not.toBe("2026-08-01");
    expect(call?.query.to).not.toBe("2026-08-18");
    expect({ from: call?.query.from, to: call?.query.to }).toEqual({
      from: "2026-07-21",
      to: "2026-08-17",
    });
  });

  it("keeps reading a window when the workspace timezone cannot be read", async () => {
    // A failed business read must not take the journal down, and must not invent
    // a zone: UTC is the placeholder the topbar uses before it has confirmed the
    // workspace, so the two agree even while degraded. Midday UTC on the 18th is
    // the 18th in both zones, so the window is unchanged here — what is asserted
    // is that the page still answers.
    vi.mocked(access.listUserBusinesses).mockRejectedValue(
      new Error("business read failed"),
    );

    await renderPage({ providerAccountId: "act_B", window: "7d" });

    const call = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0];
    expect({ from: call?.query.from, to: call?.query.to }).toEqual({
      from: "2026-08-11",
      to: "2026-08-17",
    });
  });
});
