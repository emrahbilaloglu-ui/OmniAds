// @vitest-environment jsdom
/**
 * ITEM 21 — THE SHELL DATE PICKER MUST DRIVE ACCOUNT INTELLIGENCE.
 *
 * Hand-writing `?startDate=…&endDate=…` into the address bar and watching the
 * page obey it proves only that the ROUTE parses a URL. It cannot fail when the
 * control at the top of the screen is wired to nothing, which is exactly the
 * bug that was shipped: the picker wrote a preferences store and no router, so
 * on a server-rendered surface "moving the picker" changed the label above the
 * page and not one request underneath it
 * (`components/layout/v2/app-topbar.tsx`, and the module header of
 * `lib/dashboard/date-window-url.ts`).
 *
 * So this test starts at the control and ends at the read models. Nothing in
 * the chain is stubbed except the eight leaf authorities, whose call arguments
 * are the assertion:
 *
 *   real DateRangePicker click
 *     -> real AppTopbar.applyDateRange
 *       -> the href the real router.replace was handed
 *         -> real MetaIntelligencePage(searchParams)   [the server route]
 *           -> real readMetaIntelligence               [the composer]
 *             -> every windowed section query
 *               -> the sentence rendered on screen
 *
 * The dates are never typed into this file as a literal the way a URL test
 * would type them: they are read back out of the href the picker produced, so a
 * picker that resolved a different window than it displays, or a route that
 * ignored what the picker wrote, breaks the test rather than moving it.
 *
 * The window authority itself (`lib/dashboard/date-window-url.ts`) is used, not
 * modified: URL `startDate`/`endDate` ARE the window and travel verbatim.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import type { DateRangeValue } from "@/components/date-range/DateRangePicker";
import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

/**
 * The workspace clock. TheSwaf — the live two-account business this surface's
 * scoping law was written against — runs on America/New_York, so the presets
 * are resolved against a real workspace timezone rather than the runner's.
 */
const WORKSPACE_TIME_ZONE = "America/New_York";
const WORKSPACE_TODAY = "2026-08-18";

const shell = vi.hoisted(() => ({
  pathname: "/app/meta/intelligence",
  search: "providerAccountId=act_921275999286619",
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  // Typed as the picker's own value shape, not as the literal it starts on:
  // the second test moves the stored selection the way the real store would.
  dateRange: {
    rangePreset: "28d",
    customStart: "",
    customEnd: "",
    comparisonPreset: "previousPeriod",
    comparisonStart: "",
    comparisonEnd: "",
  } as DateRangeValue,
  setDateRange: vi.fn(),
}));

/* ------------------------------------------------------ shell-side mocks */

vi.mock("next/navigation", () => ({
  usePathname: () => shell.pathname,
  useSearchParams: () => new URLSearchParams(shell.search),
  useRouter: () => ({
    replace: shell.replace,
    refresh: shell.refresh,
    push: shell.push,
  }),
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  },
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (value: {
      businesses: Array<{
        id: string;
        name: string;
        timezone: string;
        currency: string;
      }>;
      selectedBusinessId: string | null;
      selectBusiness: () => void;
      hasHydrated: boolean;
      authBootstrapStatus: "ready";
    }) => unknown,
  ) =>
    selector({
      businesses: [
        {
          id: "biz_theswaf",
          name: "TheSwaf",
          timezone: WORKSPACE_TIME_ZONE,
          currency: "USD",
        },
      ],
      selectedBusinessId: "biz_theswaf",
      selectBusiness: vi.fn(),
      hasHydrated: true,
      authBootstrapStatus: "ready",
    }),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (
    selector: (value: {
      language: "en";
      dashboardDateRange: DateRangeValue;
      setDashboardDateRange: (value: DateRangeValue) => void;
    }) => unknown,
  ) =>
    selector({
      language: "en",
      // The SEED the shell canonicalizes onto the URL. It is served from the
      // same object the picker stub reports, so the store and the control
      // cannot start the test disagreeing about what is selected.
      dashboardDateRange: shell.dateRange,
      setDashboardDateRange: shell.setDateRange,
    }),
}));

/**
 * The persisted range is a store, not an authority, so the hook that READS it is
 * stubbed and the test controls the starting selection.
 *
 * `useCanonicalDateWindowUrl` is deliberately left REAL. It is the half of the
 * chain that reaches a server-rendered surface: the shell states the stored
 * window on the URL and calls `router.replace`, and without that navigation this
 * route would keep rendering its own default under a caption naming another
 * window. Stubbing it would make this file unable to fail for the very defect it
 * is about.
 */
vi.mock("@/hooks/use-persistent-date-range", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-persistent-date-range")>();
  return {
    ...actual,
    usePersistentDateRange: () => [shell.dateRange, shell.setDateRange],
  };
});

/**
 * The picker itself is REAL — this is the whole point of the test. Only its
 * "what day is it" helper is pinned, so a preset resolves to the same two dates
 * on any runner. Stubbing the picker, as the topbar's own unit test does, would
 * make this test unable to fail for the bug it exists to catch.
 */
vi.mock("@/components/date-range/DateRangePicker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/date-range/DateRangePicker")>();
  return { ...actual, getTodayIsoForTimeZone: () => WORKSPACE_TODAY };
});

vi.mock("@/components/layout/v2/use-shell-signals", () => ({
  useWorkspaceSyncState: () => ({
    tone: "fresh",
    label: "Synced 12m ago",
    freshnessState: "ready",
  }),
  // The shell only canonicalizes the window once it has CONFIRMED the
  // workspace, because the workspace supplies the clock
  // (`useCanonicalDateWindowUrl`'s `enabled` gate). Confirming it here is what
  // makes this test exercise the real mounted shell rather than a shell frozen
  // before its first write.
  useConfirmedShellBusinessId: () => "biz_theswaf",
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/lib/auth-diagnostics", () => ({ logClientAuthEvent: vi.fn() }));

/* ------------------------------------------------------ route-side mocks */

vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));
vi.mock("@/lib/access", () => ({ listUserBusinesses: vi.fn() }));
vi.mock("@/lib/zero-base/auth-routing", () => ({
  loginUrlFor: (next: string) => `/login?next=${encodeURIComponent(next)}`,
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
    const { resolveProviderAccountId: resolveId } = (await import(
      "@/lib/zero-base/provider-scope-server"
    )) as { resolveProviderAccountId: (value: unknown) => Promise<string | null> };
    const id = await resolveId(input);
    return id
      ? { providerAccountId: id, refusal: null, requestedButUnassigned: null }
      : {
          providerAccountId: null,
          refusal: "provider_account_none_assigned" as const,
          requestedButUnassigned: null,
        };
  },
  readProviderScopeCatalog: async () => ({ provider: "meta" as const, accounts: [] }),
  resolveProviderAccountId: vi.fn(),
}));

/* ---------------------------------------- the eight leaf authorities only */

const getIntegrationStatusByBusiness = vi.hoisted(() => vi.fn());
const getProviderAccountAssignments = vi.hoisted(() => vi.fn());
const getMetaCanonicalOverviewSummary = vi.hoisted(() => vi.fn());
const getMetaCanonicalOverviewTrends = vi.hoisted(() => vi.fn());
const getMetaBreakdownsForRange = vi.hoisted(() => vi.fn());
const getMetaCampaignsForRange = vi.hoisted(() => vi.fn());
const readMetaAnomaliesForBusiness = vi.hoisted(() => vi.fn());
const readMetaDecisionsWorkspaceReadModel = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integration-status", () => ({ getIntegrationStatusByBusiness }));
vi.mock("@/lib/provider-account-assignments", () => ({ getProviderAccountAssignments }));
vi.mock("@/lib/meta/canonical-overview", () => ({
  getMetaCanonicalOverviewSummary,
  getMetaCanonicalOverviewTrends,
}));
vi.mock("@/lib/meta/breakdowns-source", () => ({ getMetaBreakdownsForRange }));
vi.mock("@/lib/meta/campaigns-source", () => ({ getMetaCampaignsForRange }));
vi.mock("@/lib/meta/anomalies", () => ({ readMetaAnomaliesForBusiness }));
vi.mock("@/lib/meta/decisions-workspace-read-model", () => ({
  readMetaDecisionsWorkspaceReadModel,
}));

const { resolveIntelligenceWindow } = await import(
  "@/lib/zero-base/meta/intelligence-window"
);
const { AppTopbar } = await import("@/components/layout/v2/app-topbar");
const MetaIntelligencePage = (
  await import("@/app/c/[businessId]/meta/intelligence/page")
).default;
const auth = await import("@/lib/auth");
const businessPageAccess = await import(
  "@/lib/access/require-business-page-context"
);
const access = await import("@/lib/access");
const providerScope = await import("@/lib/zero-base/provider-scope-server");

const BUSINESS_ID = "biz_theswaf";
const ACCOUNT_ID = "act_921275999286619";

const envelope: WorkspaceContextEnvelope = {
  actor: {
    userId: "user_1",
    name: "Operator",
    language: "en",
    membershipRole: "admin",
    reviewerReadOnly: false,
    demo: false,
  },
  mode: "client",
  business: {
    id: BUSINESS_ID,
    name: "TheSwaf",
    configuredCurrency: "USD",
    businessTimezone: WORKSPACE_TIME_ZONE,
  },
  provider: null,
  evidence: {
    windowLabel: null,
    snapshotAt: null,
    sourceUpdatedAt: null,
    freshness: "unknown",
  },
  proof: { currency: "configured-only", timezone: "unknown" },
  rollout: { zeroBaseEnabled: true, mutationUiEnabled: false },
};

function session() {
  return {
    sessionId: "session_1",
    user: {
      id: "user_1",
      name: "Operator",
      email: "operator@example.com",
      avatar: null,
      language: "en",
    },
    activeBusinessId: BUSINESS_ID,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

/**
 * Move the REAL picker to a named preset and hand back the href the shell's
 * router was actually given.
 *
 * The panel's preset button sets the draft on the first click and applies on
 * the second (`resolveRangePresetSelection`'s `shouldApply`), which is the
 * control's own confirm step; both clicks are performed here rather than
 * reaching past the UI to `onChange`.
 */
async function pickPresetAndReadHref(presetLabel: string): Promise<string> {
  const before = shell.replace.mock.calls.length;
  fireEvent.click(screen.getByTestId("shell-date-range-picker-trigger"));
  const option = await screen.findByText(presetLabel);
  fireEvent.click(option);
  fireEvent.click(option);
  await waitFor(() =>
    expect(shell.replace.mock.calls.length).toBeGreaterThan(before),
  );
  const href = shell.replace.mock.calls.at(-1)?.[0] as string;
  expect(typeof href).toBe("string");
  // The real router would have moved the address bar; the shell reads the live
  // URL when it composes the next query (`currentQueryString` prefers
  // `window.location.search`), so a test that skipped this would let the second
  // pick compose against a stale URL and prove less than the browser does.
  window.history.replaceState(null, "", href);
  shell.search = href.split("?", 2)[1] ?? "";
  return href;
}

function windowFromHref(href: string) {
  const query = new URLSearchParams(href.split("?", 2)[1] ?? "");
  return {
    startDate: query.get("startDate"),
    endDate: query.get("endDate"),
    preset: query.get("window"),
    query,
  };
}

async function renderIntelligence(query: URLSearchParams) {
  const searchParams = Object.fromEntries(query.entries());
  const element = await MetaIntelligencePage({
    params: Promise.resolve({ businessId: BUSINESS_ID }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  shell.pathname = "/app/meta/intelligence";
  shell.search = `providerAccountId=${ACCOUNT_ID}`;
  // The URL the operator is standing on. The shell composes the next query from
  // the live address bar, so this is the real input to the control.
  window.history.replaceState(
    null,
    "",
    `/app/meta/intelligence?providerAccountId=${ACCOUNT_ID}`,
  );
  shell.dateRange = {
    rangePreset: "28d",
    customStart: "",
    customEnd: "",
    comparisonPreset: "previousPeriod",
    comparisonStart: "",
    comparisonEnd: "",
  };

  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(businessPageAccess.requireBusinessPageContext).mockResolvedValue({
    kind: "ok",
    context: {
      session: session(),
      membership: {
        businessId: BUSINESS_ID,
        userId: "user_1",
        role: "admin",
        status: "active",
      },
      businessId: BUSINESS_ID,
      role: "admin",
      reviewerReadOnly: false,
      demo: false,
    },
  } as never);
  vi.mocked(access.listUserBusinesses).mockResolvedValue([
    {
      id: BUSINESS_ID,
      name: "TheSwaf",
      timezone: WORKSPACE_TIME_ZONE,
      currency: "USD",
    },
  ] as never);
  vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(ACCOUNT_ID);

  getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
  // One assigned account, so the business-wide summary authority is allowed to
  // stand for it and the summary section is actually read in this test rather
  // than withheld. The multi-account withhold has its own coverage in
  // intelligence-server.test.ts.
  getProviderAccountAssignments.mockResolvedValue({ account_ids: [ACCOUNT_ID] });
  getMetaCampaignsForRange.mockResolvedValue({ rows: [{}, {}] });
  getMetaCanonicalOverviewSummary.mockResolvedValue({
    readSource: "warehouse_published",
    isPartial: false,
  });
  getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [{}], isPartial: false });
  getMetaBreakdownsForRange.mockResolvedValue({ status: "ready", isPartial: false });
  readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [], snapshotDate: null });
  readMetaDecisionsWorkspaceReadModel.mockResolvedValue({
    status: "available",
    unavailable: null,
    queue: { sourcePreCapCount: 0, queuedPreCapCount: 0, sections: {} },
  });
});

afterEach(() => cleanup());

describe("the shell's date picker drives Account Intelligence", () => {
  it("turns one real picker click into the window every section is read with", async () => {
    render(
      <WorkspaceContextProvider value={envelope}>
        <AppTopbar userName="Operator" onOpenNav={vi.fn()} />
      </WorkspaceContextProvider>,
    );

    const href = await pickPresetAndReadHref("Last 7 days");
    const picked = windowFromHref(href);

    // The control changed a REQUEST, not just a label: the shell wrote the
    // window onto the URL of the surface being viewed, keeping the account.
    expect(href.startsWith("/app/meta/intelligence?")).toBe(true);
    expect(picked.query.get("providerAccountId")).toBe(ACCOUNT_ID);
    expect(picked.preset).toBe("7d");
    // Completed days on the workspace clock — today is a part-day and is
    // excluded (DATE_WINDOW_INCLUDES_CURRENT_DAY). Asserted so a picker that
    // silently re-expands against another clock cannot pass by agreeing with
    // itself.
    expect(picked.startDate).toBe("2026-08-11");
    expect(picked.endDate).toBe("2026-08-17");

    const html = await renderIntelligence(picked.query);

    // Every windowed authority, read with the picked window and no other.
    for (const spy of [
      getMetaCampaignsForRange,
      getMetaCanonicalOverviewSummary,
      getMetaCanonicalOverviewTrends,
      getMetaBreakdownsForRange,
    ]) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({
        startDate: picked.startDate,
        endDate: picked.endDate,
      });
    }
    // The anomalies authority takes MAX(snapshot_date) over all time unless it
    // is bounded, so the picked END date has to reach it or a historical window
    // sits beside today's anomaly snapshot under one "same range" sentence.
    expect(readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ endDate: picked.endDate }),
    );

    // And the sentence on screen names the window that was actually read.
    expect(html).toContain(
      `Every windowed source below covers ${picked.startDate} to ${picked.endDate}.`,
    );
  });

  it("moves every section together when the picker moves again", async () => {
    render(
      <WorkspaceContextProvider value={envelope}>
        <AppTopbar userName="Operator" onOpenNav={vi.fn()} />
      </WorkspaceContextProvider>,
    );

    const first = windowFromHref(await pickPresetAndReadHref("Last 7 days"));
    await renderIntelligence(first.query);
    const firstCalls = {
      campaigns: getMetaCampaignsForRange.mock.calls[0]![0],
      summary: getMetaCanonicalOverviewSummary.mock.calls[0]![0],
      trends: getMetaCanonicalOverviewTrends.mock.calls[0]![0],
      breakdowns: getMetaBreakdownsForRange.mock.calls[0]![0],
      anomalies: readMetaAnomaliesForBusiness.mock.calls[0]![0],
    };

    // The stored selection follows the applied one, as the real store would.
    shell.dateRange = { ...shell.dateRange, rangePreset: "7d" };
    const second = windowFromHref(await pickPresetAndReadHref("Last 90 days"));

    expect(second.startDate).not.toBe(first.startDate);
    expect(second.endDate).toBe(first.endDate);

    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: [ACCOUNT_ID] });
    getMetaCampaignsForRange.mockResolvedValue({ rows: [] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({ readSource: "warehouse_published" });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [] });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready" });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [], snapshotDate: null });
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue({
      status: "available",
      unavailable: null,
      queue: { sourcePreCapCount: 0, queuedPreCapCount: 0, sections: {} },
    });
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(ACCOUNT_ID);

    await renderIntelligence(second.query);

    // Not one section left behind on the previous range. A surface where the
    // picker moved four of five sources is worse than one where it moved none:
    // the page still prints a single "same range" sentence over both.
    for (const spy of [
      getMetaCampaignsForRange,
      getMetaCanonicalOverviewSummary,
      getMetaCanonicalOverviewTrends,
      getMetaBreakdownsForRange,
    ]) {
      expect(spy.mock.calls[0]![0]).toMatchObject({
        startDate: second.startDate,
        endDate: second.endDate,
      });
    }
    expect(readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ endDate: second.endDate }),
    );
    expect(getMetaCampaignsForRange.mock.calls[0]![0]).not.toMatchObject({
      startDate: firstCalls.campaigns.startDate,
    });
  });

  it("scopes every section to the one server-resolved account, never a wider read", async () => {
    render(
      <WorkspaceContextProvider value={envelope}>
        <AppTopbar userName="Operator" onOpenNav={vi.fn()} />
      </WorkspaceContextProvider>,
    );

    const picked = windowFromHref(await pickPresetAndReadHref("Last 7 days"));
    await renderIntelligence(picked.query);

    // The URL states the account; the SERVER decides whether it holds. Every
    // section then reads the one id the server returned — a section that
    // dropped the filter would read every account assigned to the business and
    // report A+B under a heading that means B.
    expect(providerScope.resolveProviderAccountId).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      provider: "meta",
      requestedAccountId: ACCOUNT_ID,
    });
    expect(getMetaCampaignsForRange.mock.calls[0]![0]).toMatchObject({
      accountId: ACCOUNT_ID,
    });
    for (const spy of [
      getMetaCanonicalOverviewTrends,
      getMetaBreakdownsForRange,
      readMetaAnomaliesForBusiness,
      readMetaDecisionsWorkspaceReadModel,
    ]) {
      expect(spy.mock.calls[0]![0]).toMatchObject({ providerAccountId: ACCOUNT_ID });
    }
  });

  it("refuses the window rather than reading a picker-shaped guess when the account does not resolve", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(null);

    render(
      <WorkspaceContextProvider value={envelope}>
        <AppTopbar userName="Operator" onOpenNav={vi.fn()} />
      </WorkspaceContextProvider>,
    );

    const picked = windowFromHref(await pickPresetAndReadHref("Last 7 days"));
    const html = await renderIntelligence(picked.query);

    // A picked window is not authority to read something. With no account
    // resolved, no account-scoped authority may be read at all — a business-wide
    // read in an account-scoped row is a wrong number, not a partial one.
    for (const spy of [
      getMetaCampaignsForRange,
      getMetaCanonicalOverviewSummary,
      getMetaCanonicalOverviewTrends,
      getMetaBreakdownsForRange,
      readMetaAnomaliesForBusiness,
      readMetaDecisionsWorkspaceReadModel,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(html).toContain("No single Meta account is selected");
    // The window it could not read with is still stated, not hidden.
    expect(html).toContain(
      `Every windowed source below covers ${picked.startDate} to ${picked.endDate}.`,
    );
  });
});

/**
 * ITEM 13 — the same window, stated the other way.
 *
 * Everything above starts at the picker and follows the exact `startDate`/
 * `endDate` pair it writes. That pair is not the only shape this URL takes: the
 * shell writes a `window` KEY beside the dates, links get truncated, and an
 * operator types `?window=7d` by hand. The private resolver this route used to
 * carry read the dates and nothing else, so every one of those URLs silently
 * produced 28 days ending TODAY — a different length AND a part-day on the end.
 */
describe("the window key alone resolves to the window the picker means", () => {
  /**
   * Render the route with the workspace's clock pinned to `WORKSPACE_TODAY`.
   *
   * The route resolves "today" from the real clock; the picker's is pinned by
   * the module mock. Leaving the two apart would make these assertions pass only
   * on the day they were written and start lying the next morning — the exact
   * class of defect this file is about.
   */
  async function renderIntelligenceOnWorkspaceToday(query: URLSearchParams) {
    vi.useFakeTimers();
    // Midday UTC is still `WORKSPACE_TODAY` in America/New_York, so the pinned
    // instant names the same day on both clocks.
    vi.setSystemTime(new Date(`${WORKSPACE_TODAY}T12:00:00.000Z`));
    try {
      return await renderIntelligence(query);
    } finally {
      vi.useRealTimers();
    }
  }

  /** The href the real picker writes for a named preset, as its query. */
  async function pickedQuery(presetLabel: string) {
    render(
      <WorkspaceContextProvider value={envelope}>
        <AppTopbar userName="Operator" onOpenNav={vi.fn()} />
      </WorkspaceContextProvider>,
    );
    return windowFromHref(await pickPresetAndReadHref(presetLabel));
  }

  it("reads `?window=7d` with no dates as the very days the picker writes for it", async () => {
    const picked = await pickedQuery("Last 7 days");
    expect(picked.preset).toBe("7d");

    // Strip the dates the shell wrote. What is left is what a truncated link, a
    // hand-typed URL, or a first paint before canonicalization actually carries.
    const keyOnly = new URLSearchParams(picked.query);
    keyOnly.delete("startDate");
    keyOnly.delete("endDate");
    expect(keyOnly.get("startDate")).toBeNull();

    const html = await renderIntelligenceOnWorkspaceToday(keyOnly);

    for (const spy of [
      getMetaCampaignsForRange,
      getMetaCanonicalOverviewSummary,
      getMetaCanonicalOverviewTrends,
      getMetaBreakdownsForRange,
    ]) {
      expect(spy).toHaveBeenCalledTimes(1);
      // The dates are not typed here — they are the ones the picker itself
      // produced for this preset, so the server agreeing with the topbar is
      // what makes this pass, not two literals agreeing with each other.
      expect(spy.mock.calls[0]![0]).toMatchObject({
        startDate: picked.startDate,
        endDate: picked.endDate,
      });
    }
    expect(html).toContain(
      `Every windowed source below covers ${picked.startDate} to ${picked.endDate}.`,
    );
  });

  it("recovers the same LABEL the picker is displaying, not just the same dates", async () => {
    // Dates alone do not prove agreement: a server that measured the right week
    // while calling it something else would still put two names on one window.
    // The preset the server recovers is asserted against the key the picker
    // wrote, for both URL shapes.
    const picked = await pickedQuery("Last 7 days");
    const keyOnly = new URLSearchParams(picked.query);
    keyOnly.delete("startDate");
    keyOnly.delete("endDate");

    for (const query of [picked.query, keyOnly]) {
      expect(
        resolveIntelligenceWindow({
          searchParams: query,
          referenceDate: WORKSPACE_TODAY,
        }),
      ).toEqual({
        startDate: picked.startDate,
        endDate: picked.endDate,
        preset: picked.preset,
      });
    }
  });

  it("carries a HISTORICAL end date into the anomalies read, not the newest snapshot", async () => {
    // `readMetaAnomaliesForBusiness` takes MAX(snapshot_date) over all time when
    // it is not bounded. A March window beside today's anomaly snapshot, under
    // one sentence claiming every windowed source covers the same range, is two
    // periods presented as one.
    const march = new URLSearchParams({
      providerAccountId: ACCOUNT_ID,
      window: "custom",
      startDate: "2026-03-02",
      endDate: "2026-03-09",
    });

    await renderIntelligence(march);

    expect(readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: ACCOUNT_ID,
        endDate: "2026-03-09",
      }),
    );
    // And every other windowed source is on the same two days.
    for (const spy of [
      getMetaCampaignsForRange,
      getMetaCanonicalOverviewSummary,
      getMetaCanonicalOverviewTrends,
      getMetaBreakdownsForRange,
    ]) {
      expect(spy.mock.calls[0]![0]).toMatchObject({
        startDate: "2026-03-02",
        endDate: "2026-03-09",
      });
    }
  });

  it("falls back to the canonical default for a mangled pair rather than repairing it", async () => {
    // `endDate` lost to a bad copy-paste. The half that survived must not become
    // the window: 08-01..08-01 and 08-01..today are both windows nobody asked
    // for wearing the shape of the one they did.
    const mangled = new URLSearchParams({
      providerAccountId: ACCOUNT_ID,
      startDate: "2026-08-01",
      endDate: "nope",
    });

    const html = await renderIntelligenceOnWorkspaceToday(mangled);

    const call = getMetaCampaignsForRange.mock.calls[0]![0];
    expect(call).toMatchObject({ startDate: "2026-07-21", endDate: "2026-08-17" });
    expect(call.startDate).not.toBe("2026-08-01");
    // The window that was actually read is the one printed, so the operator is
    // never shown a caption for a window nobody measured.
    expect(html).toContain(
      "Every windowed source below covers 2026-07-21 to 2026-08-17.",
    );
  });
});
