import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MetaAudiencesPage from "./legacy-page";

const state = {
  selectedBusinessId: "biz_1" as string | null,
  workspaceResolved: true,
  // The shell's own business list, which is where this page reads the workspace
  // clock from — the same source `app-topbar.tsx` resolves "today" against.
  businesses: [
    { id: "biz_1", name: "Biz One", timezone: "UTC", currency: "USD" },
    {
      id: "biz_authorized",
      name: "Authorized",
      timezone: "UTC",
      currency: "USD",
    },
  ],
};
let pathname = "/platforms/meta/audiences";
let searchParamsValue = new URLSearchParams("providerAccountId=act_1");

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParamsValue,
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
}));

/**
 * The shell's stored range. It is a store, not an authority — a URL window
 * outranks it — so it is pinned here to two fixed days, and the tests below
 * assert which of the two answers actually reached the request.
 */
const shellRange = {
  rangePreset: "custom" as const,
  customStart: "2026-06-01",
  customEnd: "2026-06-28",
  comparisonPreset: "previousPeriod" as const,
  comparisonStart: "",
  comparisonEnd: "",
};
vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [shellRange, vi.fn()],
}));

const tierZeroFreshness = vi.fn();
vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: (input: unknown) => tierZeroFreshness(input),
}));

// The page reads /api/meta/breakdowns. The query is stubbed so each of the five
// declared states can be rendered on demand; the request the page would issue is
// exercised separately by invoking the captured `queryFn`.
interface StubQueryState {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => void;
}
let queryState: StubQueryState;
let lastQueryOptions: { queryFn?: () => Promise<unknown> } | null = null;
const breakdownQuery = vi.fn((options: unknown) => {
  lastQueryOptions = options as { queryFn?: () => Promise<unknown> };
  return queryState;
});
vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: (...args: unknown[]) => breakdownQuery(...(args as [unknown])),
}));

const freshnessInput = () =>
  tierZeroFreshness.mock.calls.at(-1)?.[0] as
    Record<string, unknown> | undefined;

describe("MetaAudiencesPage", () => {
  beforeEach(() => {
    state.selectedBusinessId = "biz_1";
    state.workspaceResolved = true;
    pathname = "/platforms/meta/audiences";
    searchParamsValue = new URLSearchParams("providerAccountId=act_1");
    lastQueryOptions = null;
    tierZeroFreshness.mockClear();
    queryState = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("withholds empty audience panels when no measured rows exist", () => {
    const html = renderToStaticMarkup(<MetaAudiencesPage />);

    expect(html).toContain('data-creative-studio-exact="true"');
    expect(html).toContain('data-creative-studio-tab="audiences"');
    expect(html).not.toContain("data-audience-summary=");
    expect(html).not.toContain("data-audience-breakdown=");
    expect(html).not.toContain("Creative × audience matrix");
    expect(html).toContain("No data for this view.");
    expect(html).not.toContain("No live audience score");
    expect(html).not.toContain("buyerAction");
  });

  it("uses the server-authorized scope and keeps every tab in the scoped route family", () => {
    pathname = "/c/biz_authorized/creative/audiences";
    const html = renderToStaticMarkup(
      <MetaAudiencesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );

    expect(html).toContain("/c/biz_authorized/creative/performance?");
    expect(html).toContain("/c/biz_authorized/creative/audiences?");
    expect(html).toContain("providerAccountId=act_authorized");
    expect(html).not.toContain("biz_1");
    expect(html).not.toContain("act_1");
  });

  /**
   * ITEM 17 — a tab hop carries the WINDOW, not just the account.
   *
   * These links were built by `dashboardHrefForRouteFamily(
   * buildMetaScopedHref(...))`, which emits no dates at all, so leaving
   * Audiences silently reset the range to whatever the destination had stored.
   * The assertion is the window this surface actually read with, in both live
   * spellings, on every one of the five tabs.
   */
  it("carries the account and the measured window onto every tab link", () => {
    searchParamsValue = new URLSearchParams(
      "providerAccountId=act_1&start=2026-03-01&end=2026-03-14",
    );
    const html = renderToStaticMarkup(<MetaAudiencesPage />);

    for (const path of [
      "/platforms/meta/creatives",
      "/platforms/meta/copies",
      "/platforms/meta/landing-pages",
      "/platforms/meta/audiences",
    ]) {
      expect(html).toContain(
        `${path}?businessId=biz_1&amp;providerAccountId=act_1&amp;window=custom` +
          "&amp;startDate=2026-03-01&amp;endDate=2026-03-14" +
          "&amp;start=2026-03-01&amp;end=2026-03-14",
      );
    }
  });

  it("shows the account-required state without inventing a default account", () => {
    const html = renderToStaticMarkup(
      <MetaAudiencesPage
        businessId="biz_authorized"
        providerAccountId={null}
      />,
    );

    expect(html).toContain('data-audiences-state="account_required"');
    expect(html).toContain("Select a Meta account to continue.");
    expect(html).not.toContain("USD");
    expect(html).not.toContain("$0");
  });

  /**
   * ITEM 17 — with no window on the URL, the SHELL's range is what gets read.
   *
   * The old fallback was `defaultCreativeWindow(new Date())`: 28 days ending
   * TODAY on the runner's UTC clock. The shell's unstated window is 28 days
   * ending YESTERDAY on the workspace clock, because today is a part day. Two
   * constants both named "28 days" that resolve to different days is the defect
   * this item exists to remove, so the page expands the shell's own selection
   * rather than keeping a second one of its own.
   */
  it("reads the shell's range when the URL states no window", async () => {
    renderToStaticMarkup(
      <MetaAudiencesPage
        businessId="biz_authorized"
        providerAccountId="act_authorized"
      />,
    );
    const fetchStub = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", age: [], placement: [] }),
    }));
    vi.stubGlobal("fetch", fetchStub);

    await lastQueryOptions?.queryFn?.();

    const url = String(fetchStub.mock.calls[0]?.[0]);
    expect(url).toContain("businessId=biz_authorized");
    expect(url).toContain("providerAccountId=act_authorized");
    expect(url).toContain(`startDate=${shellRange.customStart}`);
    expect(url).toContain(`endDate=${shellRange.customEnd}`);
  });

  /**
   * ITEM 17 — BOTH live URL spellings reach the same reader.
   *
   * `start`/`end` is the Creative Studio's own pair, minted by the shared tab
   * href builder and still carried by links in the wild. Reading it is what
   * makes a pasted canonical link render the range it names.
   */
  it("honours the Studio's ?start=/?end= spelling from the URL", async () => {
    searchParamsValue = new URLSearchParams(
      "providerAccountId=act_1&start=2026-03-01&end=2026-03-14",
    );
    renderToStaticMarkup(<MetaAudiencesPage />);
    const fetchStub = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", age: [], placement: [] }),
    }));
    vi.stubGlobal("fetch", fetchStub);

    await lastQueryOptions?.queryFn?.();

    const url = String(fetchStub.mock.calls[0]?.[0]);
    expect(url).toContain("startDate=2026-03-01");
    expect(url).toContain("endDate=2026-03-14");
    // Not the shell's stored range: the URL outranks the store.
    expect(url).not.toContain(shellRange.customStart);
  });

  /**
   * ITEM 17 — the SHELL's spelling, which this page could not read at all.
   *
   * `?window`/`?startDate`/`?endDate` is what the date control at the top of the
   * screen writes. The page read only `?start`/`?end`, so moving that control
   * changed nothing about this request. This is the regression test for that
   * exact blindness.
   */
  it("honours the shell's ?startDate=/?endDate= spelling from the URL", async () => {
    searchParamsValue = new URLSearchParams(
      "providerAccountId=act_1&window=custom&startDate=2026-04-02&endDate=2026-04-08",
    );
    renderToStaticMarkup(<MetaAudiencesPage />);
    const fetchStub = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", age: [], placement: [] }),
    }));
    vi.stubGlobal("fetch", fetchStub);

    await lastQueryOptions?.queryFn?.();

    const url = String(fetchStub.mock.calls[0]?.[0]);
    expect(url).toContain("startDate=2026-04-02");
    expect(url).toContain("endDate=2026-04-08");
  });

  /**
   * Precedence, not preference. The shell's pair is the one the operator's own
   * control just wrote, so a stale Studio pair left further along the query
   * cannot outrank the range they chose a moment ago.
   */
  it("lets the shell's pair outrank a stale Studio pair on the same URL", async () => {
    searchParamsValue = new URLSearchParams(
      "providerAccountId=act_1&start=2026-03-01&end=2026-03-14&startDate=2026-04-02&endDate=2026-04-08",
    );
    renderToStaticMarkup(<MetaAudiencesPage />);
    const fetchStub = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", age: [], placement: [] }),
    }));
    vi.stubGlobal("fetch", fetchStub);

    await lastQueryOptions?.queryFn?.();

    const url = String(fetchStub.mock.calls[0]?.[0]);
    expect(url).toContain("startDate=2026-04-02");
    expect(url).toContain("endDate=2026-04-08");
    expect(url).not.toContain("2026-03-01");
  });

  /**
   * A malformed pair is not a window and is not repaired into one: it falls
   * through to the shell's range, so a mistyped URL can never become authority
   * for what was measured.
   */
  it("falls back to the shell's range rather than repairing a malformed window", async () => {
    searchParamsValue = new URLSearchParams(
      "providerAccountId=act_1&start=2026-02-30&end=2026-03-14",
    );
    renderToStaticMarkup(<MetaAudiencesPage />);
    const fetchStub = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", age: [], placement: [] }),
    }));
    vi.stubGlobal("fetch", fetchStub);

    await lastQueryOptions?.queryFn?.();

    const url = String(fetchStub.mock.calls[0]?.[0]);
    expect(url).toContain(`startDate=${shellRange.customStart}`);
    expect(url).toContain(`endDate=${shellRange.customEnd}`);
    expect(url).not.toContain("2026-02-30");
  });

  /**
   * Loading, error and empty are three different facts. Collapsing them told the
   * operator the account had no audience data whenever a read merely failed or
   * had not finished.
   */
  it("renders a read in flight as loading, not as an empty account", () => {
    queryState.isLoading = true;
    const html = renderToStaticMarkup(<MetaAudiencesPage />);

    expect(html).toContain('data-audiences-state="loading"');
    expect(html).toContain("Loading creative data…");
    expect(html).not.toContain(
      "Audience-level creative evidence is unavailable for this assigned Meta account.",
    );
  });

  it("renders a failed read as an error carrying its own reason", () => {
    queryState.isError = true;
    queryState.error = new Error("Meta breakdowns could not be read (500).");
    const html = renderToStaticMarkup(<MetaAudiencesPage />);

    expect(html).toContain('data-audiences-state="error"');
    expect(html).toContain("Creative data is temporarily unavailable.");
    expect(html).not.toContain("Meta breakdowns could not be read (500).");
    expect(html).not.toContain(
      "Audience-level creative evidence is unavailable for this assigned Meta account.",
    );
  });

  /**
   * The route names why a non-"ok" payload is empty — not connected, no token,
   * account not assigned. Discarding that reason and printing one generic
   * sentence made a broken integration look like an idle account.
   */
  it("prefers the served reason over the generic unavailable sentence", () => {
    queryState.data = {
      status: "no_connection",
      notReadyReason: "Meta integration is not connected.",
    };
    const html = renderToStaticMarkup(<MetaAudiencesPage />);

    expect(html).toContain('data-audiences-state="empty"');
    expect(html).toContain("No data for this view.");
    expect(html).not.toContain("Meta integration is not connected.");
  });

  it("says a range is still being prepared even when rows already drew", () => {
    queryState.data = {
      status: "ok",
      age: [
        {
          key: "25-34",
          label: "25-34",
          spend: 10,
          revenue: 20,
          purchases: 1,
          clicks: 2,
          impressions: 40,
        },
      ],
      placement: [],
      isPartial: true,
      notReadyReason: "Breakdown warehouse data is still being prepared.",
    };
    const html = renderToStaticMarkup(<MetaAudiencesPage />);

    expect(html).toContain('data-audiences-state="ready"');
    expect(html).toContain("Some audience data is unavailable. Try again.");
    expect(html).not.toContain(
      "Breakdown warehouse data is still being prepared.",
    );
  });

  /**
   * The freshness bar must report THIS read. It used to report a hardcoded
   * `isFetching: false, error: null, asOf: null`, so a stale or failed panel
   * looked exactly as authoritative as a fresh one.
   */
  it("reports the breakdown read to the freshness bar", () => {
    queryState.isFetching = true;
    queryState.data = {
      status: "ok",
      age: [],
      placement: [],
      freshness: { lastSyncedAt: "2026-04-04T09:15:00.000Z" },
    };
    renderToStaticMarkup(<MetaAudiencesPage />);

    const input = freshnessInput();
    expect(input?.isFetching).toBe(true);
    expect(input?.asOf).toBe("2026-04-04T09:15:00.000Z");
    expect(typeof input?.onRetry).toBe("function");
  });

  it("surfaces the read's error to the freshness bar rather than a null", () => {
    queryState.isError = true;
    queryState.error = new Error("Meta breakdowns could not be read (500).");
    renderToStaticMarkup(<MetaAudiencesPage />);

    expect((freshnessInput()?.error as Error)?.message).toBe(
      "Meta breakdowns could not be read (500).",
    );
  });

  /**
   * A calendar date is a range label, not an observation time, and an absent
   * timestamp is not a reason to invent one from this machine's clock.
   */
  it("keeps the as-of null when the route serves no measured instant", () => {
    queryState.data = { status: "ok", age: [], placement: [], freshness: null };
    renderToStaticMarkup(<MetaAudiencesPage />);

    expect(freshnessInput()?.asOf).toBeNull();
  });
});
