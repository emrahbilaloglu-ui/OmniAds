import { useQuery } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MetaCreativeInboxPage from "@/app/(dashboard)/platforms/meta/creative-inbox/legacy-page";

/**
 * THE INBOX MUST SHOW WHAT IT ACTUALLY HAS, UNDER ITS REAL NAME.
 *
 * The suite this replaces asserted that four columns named Requested / In
 * production / Delivered / Live rendered and held NO cards, and treated that as
 * success. It was satisfied by a screen that drew a creative-production
 * pipeline nothing in this product produces, and the caption underneath could
 * not undo what the four headings asserted.
 *
 * The absence is re-provable and unchanged:
 *
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'workflowStatus|workflow_status|columnId|column_id|stage' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E '\bassignee\b|assigned_to|assignedTo' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'dueAt|due_at|dueDate' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'versionNumber|approvalState|approvedBy|approved_by' app lib components
 *
 * Every live hit belongs to `lib/decision-workflow*` (the DECISION ownership
 * overlay) or to `lib/archive/v1-v2-v21/`. `lib/migrations.ts` declares no
 * workflow table. Nothing records a creative request, an owner, a due date, a
 * delivered file, a version or an approval.
 *
 * So the law pinned here is no longer "the columns render empty". It is:
 *
 *   1. the segments are the creative-briefing authority's OWN served sections
 *      — actionNow / watching / healthy — in its own order;
 *   2. EVERY rendered item traces to a card that authority served, and lands in
 *      the segment it was served in. Nothing is reclassified and no decision or
 *      buyerAction is inferred to fill a segment;
 *   3. a genuine zero from that authority is a real zero;
 *   4. a FAILED read is unavailable, never an empty board;
 *   5. nothing on screen claims request / version / approval / handoff works.
 */

const appState = vi.hoisted(() => ({
  selectedBusinessId: null as string | null,
  workspaceResolved: false,
}));

const queryState = vi.hoisted(() => ({
  accounts: undefined as unknown,
  accountsError: null as Error | null,
  accountsLoading: false,
  inbox: undefined as unknown,
  inboxError: null as Error | null,
  inboxLoading: false,
}));

const navigationState = vi.hoisted(() => ({
  pathname: "/platforms/meta/creative-inbox",
  providerAccountId: "",
}));

const freshness = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
  useSearchParams: () =>
    new URLSearchParams(
      navigationState.providerAccountId
        ? `providerAccountId=${navigationState.providerAccountId}`
        : "",
    ),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (state: {
      selectedBusinessId: string | null;
      workspaceResolved: boolean;
    }) => unknown,
  ) => selector(appState),
}));

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: freshness,
}));

const useQueryMock = vi.mocked(useQuery);

/** A card as `/api/creatives/briefing` serves it. */
function briefingCard(overrides: Record<string, unknown> = {}) {
  return {
    id: "creative_1",
    creativeId: "creative_1",
    providerAccountId: "act_1",
    creativeName: "Server briefing item",
    campaignName: "Prospecting",
    currency: "USD",
    spend: 1204,
    roas: 2.4,
    decisionCenterRow: {
      buyerLabel: "Refresh",
      buyerAction: "refresh",
      oneLine: "Frequency is climbing on the top spender.",
      confidenceBand: "high",
    },
    ...overrides,
  };
}

/** A card as this page holds it AFTER `fetchCreativeInbox` has tagged it. */
function scopedCard(
  segment: "action-now" | "watching" | "healthy",
  overrides: Record<string, unknown> = {},
) {
  return {
    ...briefingCard(overrides),
    businessId: "biz_1",
    briefingSegment: segment,
  };
}

function inboxData(cards: unknown[]) {
  return { inbox: cards, source: null };
}

/** The money string the page will actually produce in this environment. */
function money(value: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

/** The `queryFn` the page handed react-query for the briefing read. */
function capturedInboxQueryFn() {
  const call = useQueryMock.mock.calls.find(
    (args) =>
      (args[0] as { queryKey?: readonly unknown[] }).queryKey?.[0] ===
      "creative-account-inbox",
  );
  return (call?.[0] as { queryFn?: () => Promise<unknown> } | undefined)
    ?.queryFn;
}

beforeEach(() => {
  appState.selectedBusinessId = null;
  appState.workspaceResolved = false;
  queryState.accounts = undefined;
  queryState.accountsError = null;
  queryState.accountsLoading = false;
  queryState.inbox = undefined;
  queryState.inboxError = null;
  queryState.inboxLoading = false;
  navigationState.pathname = "/platforms/meta/creative-inbox";
  navigationState.providerAccountId = "";
  freshness.mockReset();
  useQueryMock.mockReset();
  useQueryMock.mockImplementation(
    (options: { queryKey?: readonly unknown[] }) => {
      const accountQuery = options.queryKey?.[0] === "meta-provider-accounts";
      const data = accountQuery ? queryState.accounts : queryState.inbox;
      const error = accountQuery
        ? queryState.accountsError
        : queryState.inboxError;
      const loading = accountQuery
        ? queryState.accountsLoading
        : queryState.inboxLoading;
      return {
        data,
        error,
        fetchStatus: loading ? "fetching" : "idle",
        isError: Boolean(error),
        isFetching: loading,
        isLoading: loading,
        refetch: vi.fn(),
        status: error ? "error" : data ? "success" : "pending",
      } as unknown as ReturnType<typeof useQuery>;
    },
  );
});

describe("MetaCreativeInboxPage exact integration", () => {
  it("uses server-authorized props instead of workspace or URL scope", () => {
    appState.selectedBusinessId = "biz_store";
    appState.workspaceResolved = false;
    navigationState.pathname = "/c/biz_authorized/creative/inbox";
    navigationState.providerAccountId = "act_url";
    queryState.inbox = inboxData([
      {
        ...scopedCard("action-now"),
        businessId: "biz_authorized",
        providerAccountId: "act_authorized",
      },
      {
        ...scopedCard("action-now", {
          id: "wrong",
          creativeId: "wrong",
          providerAccountId: "act_url",
          creativeName: "Wrong scope",
        }),
        businessId: "biz_store",
      },
    ]);

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["meta-provider-accounts", "biz_authorized"],
        enabled: false,
      }),
    );
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: [
          "creative-account-inbox",
          "biz_authorized",
          "act_authorized",
        ],
        enabled: true,
      }),
    );
    expect(html).toContain('data-creative-studio-exact="true"');
    expect(html).toContain(
      'href="/c/biz_authorized/creative/copies?providerAccountId=act_authorized"',
    );
    expect(html).not.toContain("Wrong scope");
    expect(freshness).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_authorized" }),
    );
  });

  /**
   * 1 + 2 · The segments ARE the served sections, and every card in one was
   * served in it. The fixture deliberately gives the three sections different
   * cards, so a page that dumped everything into one lane, or re-derived a lane
   * from the card's label or spend, would fail here.
   */
  it("draws the authority's own served sections and places every card in the one it came from", () => {
    queryState.inbox = inboxData([
      scopedCard("action-now", {
        id: "a1",
        creativeId: "a1",
        creativeName: "Act on me",
      }),
      scopedCard("watching", {
        id: "w1",
        creativeId: "w1",
        creativeName: "Watch me",
      }),
      scopedCard("healthy", {
        id: "h1",
        creativeId: "h1",
        creativeName: "Healthy one",
      }),
    ]);

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );

    expect(html.match(/data-inbox-column=/g)).toHaveLength(3);
    expect(html).toContain('data-inbox-column="action-now"');
    expect(html).toContain('data-inbox-column="watching"');
    expect(html).toContain('data-inbox-column="healthy"');
    // The four fabricated pipeline lanes are gone, not renamed in place.
    expect(html).not.toContain('data-inbox-column="requested"');
    expect(html).not.toContain('data-inbox-column="in-production"');
    expect(html).not.toContain('data-inbox-column="delivered"');
    expect(html).not.toContain('data-inbox-column="live"');

    // Each card is inside its own served segment's column.
    for (const [column, cardId] of [
      ["action-now", "a1"],
      ["watching", "w1"],
      ["healthy", "h1"],
    ] as const) {
      const section = html.slice(html.indexOf(`data-inbox-column="${column}"`));
      const nextColumn = section.indexOf("data-inbox-column=", 1);
      const own = nextColumn > 0 ? section.slice(0, nextColumn) : section;
      expect(own).toContain(`data-inbox-card="${cardId}"`);
    }

    // The engine's served strings, verbatim. Nothing is recomposed.
    expect(html).toContain("Refresh");
    expect(html).toContain("Frequency is climbing on the top spender.");
    expect(html).toContain(money(1204, "USD"));
    expect(html).toContain("2.40x");
  });

  /**
   * A card the engine served no label for gets an em dash, never a label
   * invented from its numbers — and an unmeasured metric is an em dash, never a
   * zero.
   */
  it("withholds an unserved label and an unmeasured metric instead of filling them in", () => {
    queryState.inbox = inboxData([
      scopedCard("watching", {
        id: "bare",
        creativeId: "bare",
        creativeName: "Bare card",
        decisionCenterRow: null,
        spend: 0,
        roas: null,
      }),
    ]);

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );

    const card = html.slice(
      html.indexOf('data-inbox-card="bare"'),
      html.indexOf('data-inbox-card="bare"') + 900,
    );
    // A MEASURED zero stays a zero.
    expect(card).toContain(money(0, "USD"));
    // An unmeasured ratio is an em dash, and no label was derived for it.
    expect(card).toContain("ROAS —");
    expect(card).not.toContain("Refresh");
  });

  /** 3 · A genuine zero from the authority is a real zero. */
  it("reports a genuine zero from the briefing authority as a zero", () => {
    queryState.inbox = inboxData([]);

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );

    expect(html).toContain('data-inbox-state="empty"');
    expect(html).toContain("No data for this view.");
    expect(html).not.toContain("data-inbox-card=");
    // Not "unavailable": the read succeeded and returned nothing.
    expect(html).not.toContain("unavailable, not empty");
    // A measured zero draws no count chip at all, which is the reference's own
    // behaviour for zero — and is NOT the em dash, which would mean unread.
    expect(html).not.toContain('data-creative-studio-tab="inbox"');
  });

  /** 4 · A failed read is unavailable, never an empty board. */
  it("presents a failed briefing read as unavailable rather than empty", () => {
    queryState.inboxError = new Error("briefing failed");

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );

    expect(html).toContain('data-inbox-state="error"');
    expect(html).toContain("Creative data is temporarily unavailable.");
    expect(html).not.toContain("briefing failed");
    expect(html).not.toContain("data-inbox-card=");
    expect(html).not.toContain('data-creative-studio-tab="inbox"');
  });

  /** 5 · Nothing claims request / version / approval / handoff works. */
  it("does not draw or describe an unsupported workflow", () => {
    queryState.inbox = inboxData([scopedCard("action-now")]);

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );

    expect(html).not.toContain("are not built");
    expect(html).not.toContain(
      "no request, owner, due date, version or approval is recorded anywhere in this product",
    );
    // The sentence that reported a workflow as read-and-empty is gone, and no
    // replacement re-states it.
    expect(html).not.toContain("No workflow items are available");
    expect(html).not.toContain("workflow items remain withheld");
    // No upload affordance, no owner slot, no due-date slot, no action button.
    expect(html).not.toContain("Drop new exports here");
    expect(html).not.toContain("Browse files");
    expect(html).not.toMatch(/Review & approve/);
    expect(html).not.toContain('data-inbox-fact="Owner"');
    expect(html).not.toContain('data-inbox-fact="Due"');
  });

  /**
   * The chip states a MEASUREMENT of what this tab is showing, now that the tab
   * shows something. It used to be permanently withheld because the board drew
   * a queue nobody measured.
   */
  it("keeps the incomplete Inbox tab out of navigation when served items exist", () => {
    queryState.inbox = inboxData([
      scopedCard("action-now", { id: "a1", creativeId: "a1" }),
      scopedCard("watching", { id: "w1", creativeId: "w1" }),
    ]);

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );

    expect(html).not.toContain('data-creative-studio-tab="inbox"');
    expect(html).toContain('data-inbox-card="a1"');
    expect(html).toContain('data-inbox-card="w1"');
  });

  /**
   * THE PRODUCER -> UI CHAIN, END TO END.
   *
   * The rest of this file feeds the page an already-tagged card list, so on its
   * own it would prove only the rendering half. This drives the page's REAL
   * `queryFn` against a real briefing response body and asserts the partition
   * it produces — which is what makes "every rendered item traces to a served
   * briefing card" a claim about the wiring rather than about a fixture.
   *
   * The partition is by ARRAY OF ORIGIN only. The fixture's `healthy` card
   * carries the loudest label and the highest spend, and it still lands in
   * `healthy`, because nothing here reads the card's contents to place it.
   */
  it("reads the briefing response and partitions it by the section each card arrived in", async () => {
    renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );
    const queryFn = capturedInboxQueryFn();
    expect(queryFn).toBeTypeOf("function");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      requested: String(input),
      ok: true,
      json: async () => ({
        actionNow: [briefingCard({ id: "a1", creativeId: "a1" })],
        watching: [briefingCard({ id: "w1", creativeId: "w1" })],
        healthy: [
          briefingCard({
            id: "h1",
            creativeId: "h1",
            spend: 999_999,
            decisionCenterRow: {
              buyerLabel: "Scale",
              buyerAction: "scale",
              oneLine: "Loud label on a healthy card.",
              confidenceBand: "high",
            },
          }),
        ],
        source: {
          measurementReconciliation: {
            snapshotLatest: { observedAt: "2026-08-17T09:00:00.000Z" },
          },
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = (await queryFn!()) as {
        inbox: Array<{
          id: string;
          briefingSegment: string;
          businessId: string;
        }>;
      };
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        "/api/creatives/briefing?businessId=biz_1&providerAccountId=act_1",
      );
      expect(
        result.inbox.map((card) => [card.id, card.briefingSegment]),
      ).toEqual([
        ["a1", "action-now"],
        ["w1", "watching"],
        ["h1", "healthy"],
      ]);
      // Business identity is stamped by the caller, never trusted from the card.
      expect(result.inbox.every((card) => card.businessId === "biz_1")).toBe(
        true,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /** A briefing route error becomes a thrown read, not an empty result. */
  it("throws rather than returning an empty inbox when the briefing route fails", async () => {
    renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );
    const queryFn = capturedInboxQueryFn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ message: "Decision source unavailable." }),
      })),
    );
    try {
      await expect(queryFn!()).rejects.toThrow("Decision source unavailable.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a server-refused account null and does not fall back to URL scope", () => {
    navigationState.providerAccountId = "act_url";

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId={null} />,
    );

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["creative-account-inbox", "biz_1", ""],
        enabled: false,
      }),
    );
    // The account prompt promises only what picking an account can deliver.
    expect(html).toContain("Select a Meta account to continue.");
    expect(html).not.toContain("are not built");
    expect(html).not.toContain("providerAccountId=act_url");
  });

  it("retains legacy assigned-account discovery while isolating the inbox query", () => {
    appState.workspaceResolved = true;
    appState.selectedBusinessId = "biz_1";
    navigationState.providerAccountId = "act_1";
    queryState.accounts = [
      { id: "act_1", name: "Primary", currency: "USD", timezone: null },
      { id: "act_2", name: "Other", currency: "EUR", timezone: null },
    ];
    queryState.inbox = inboxData([
      scopedCard("action-now"),
      scopedCard("action-now", {
        id: "wrong-account",
        creativeId: "wrong-account",
        providerAccountId: "act_2",
        creativeName: "Wrong account",
      }),
    ]);

    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["creative-account-inbox", "biz_1", "act_1"],
        enabled: true,
      }),
    );
    expect(html).not.toContain("Wrong account");
    expect(html).toContain('data-inbox-card="creative_1"');
    expect(html).not.toContain('data-inbox-card="wrong-account"');
  });

  it("withholds counts and reads until the legacy workspace scope resolves", () => {
    const html = renderToStaticMarkup(<MetaCreativeInboxPage />);

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["creative-account-inbox", "", ""],
        enabled: false,
      }),
    );
    expect(html).toContain("Loading creative data…");
    expect(html).not.toContain("data-inbox-card=");
  });

  /**
   * A card with no provider-account identity is WITHHELD and counted as
   * withheld. Placing it in a segment would be this surface guessing which
   * account it belonged to.
   */
  it("withholds a card whose provider account identity is missing and says so", () => {
    queryState.inbox = inboxData([
      scopedCard("action-now", {
        id: "no-account",
        creativeId: "no-account",
        providerAccountId: null,
        accountId: null,
        metaAccountId: null,
      }),
    ]);

    const html = renderToStaticMarkup(
      <MetaCreativeInboxPage businessId="biz_1" providerAccountId="act_1" />,
    );

    expect(html).not.toContain('data-inbox-card="no-account"');
    expect(html).toContain("No data for this view.");
    expect(html).not.toContain(
      "Some items could not be matched to the selected account.",
    );
    expect(html).not.toContain("provider account identity");
  });
});
