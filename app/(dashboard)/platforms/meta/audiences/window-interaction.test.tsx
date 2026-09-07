// @vitest-environment jsdom
/**
 * ITEM 17 — THE SHELL DATE PICKER MUST DRIVE THE AUDIENCES BREAKDOWN READ.
 *
 * Typing `?startDate=…&endDate=…` into a URLSearchParams and watching the page
 * obey it proves only that the page parses a URL. It cannot fail for the bug
 * that was actually shipped here: this surface read `?start`/`?end` alone, a
 * spelling the shell's date control does not write, so moving the control at
 * the top of the screen changed the caption and NOT ONE PARAMETER of the
 * request underneath it.
 *
 * So the test starts at the control and ends at the request:
 *
 *   real DateRangePicker click
 *     -> real AppTopbar.applyDateRange
 *       -> real applyDateWindowToParams
 *         -> the href the real router.replace was handed  (= the address bar)
 *           -> real MetaAudiencesPage re-render
 *             -> real windowFromSearchParams
 *               -> the /api/meta/breakdowns URL the page's own queryFn fetches
 *
 * The dates are never typed into the assertions as literals: they are read back
 * out of the href the picker produced, so a picker that resolves a different
 * window than it displays, or a page that ignores what the picker wrote, breaks
 * the test rather than moving it.
 *
 * Only the leaves are stubbed — the react-query cache (so the page's own
 * `queryFn` can be invoked against a captured `fetch`), the freshness bar, and
 * the shell's sync/dropdown chrome. The window authority
 * (`lib/dashboard/date-window-url.ts`) and the tab-href builder are used, not
 * modified.
 */
import React, { useEffect, useReducer } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

const BUSINESS_ID = "biz_studio";
const ACCOUNT_ID = "act_studio_1";
/** A real workspace clock, so presets are not resolved against the runner's. */
const WORKSPACE_TIME_ZONE = "America/New_York";
const WORKSPACE_TODAY = "2026-08-18";

const shell = vi.hoisted(() => ({
  pathname: "/platforms/meta/audiences",
  search: `providerAccountId=act_studio_1`,
  /** Every href the real router was handed, oldest first. */
  hrefs: [] as string[],
  rerender: null as null | (() => void),
  dashboardDateRange: null as unknown,
  setDashboardDateRange: vi.fn(),
}));

/** What the real `router.replace` does to a browser: move the address bar. */
function applyHref(href: string): void {
  const [path = "", query = ""] = href.split("?", 2);
  shell.pathname = path;
  shell.search = query;
  window.history.replaceState(null, "", href);
  shell.hrefs.push(href);
  shell.rerender?.();
}

vi.mock("next/navigation", () => ({
  usePathname: () => shell.pathname,
  useSearchParams: () => new URLSearchParams(shell.search),
  useRouter: () => ({
    replace: (href: string) => applyHref(href),
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const appState = vi.hoisted(() => ({
  businesses: [
    {
      id: "biz_studio",
      name: "Studio Business",
      timezone: "America/New_York",
      currency: "USD",
    },
  ],
  selectedBusinessId: "biz_studio" as string | null,
  selectBusiness: vi.fn(),
  hasHydrated: true,
  authBootstrapStatus: "ready" as const,
  workspaceResolved: true,
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (value: typeof appState) => unknown) =>
    selector(appState),
}));

// The persisted range is a store, not an authority: the URL outranks it. It is
// stubbed so the test owns the starting selection; what the picker DOES with a
// click is real.
vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (
    selector: (value: {
      language: "en";
      dashboardDateRange: unknown;
      setDashboardDateRange: (value: unknown) => void;
    }) => unknown,
  ) =>
    selector({
      language: "en",
      dashboardDateRange: shell.dashboardDateRange,
      setDashboardDateRange: shell.setDashboardDateRange,
    }),
}));

/**
 * The picker itself is REAL — that is the whole point. Only its "what day is
 * it" helper is pinned, so a preset resolves to the same two days on any runner
 * AND so the topbar and the Audiences body are provably reading one clock.
 */
vi.mock("@/components/date-range/DateRangePicker", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/date-range/DateRangePicker")
    >();
  return { ...actual, getTodayIsoForTimeZone: () => WORKSPACE_TODAY };
});

vi.mock("@/components/layout/v2/use-shell-signals", () => ({
  useWorkspaceSyncState: () => ({
    tone: "fresh",
    label: "Synced 12m ago",
    freshnessState: "ready",
  }),
  useConfirmedShellBusinessId: () => BUSINESS_ID,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
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

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

/**
 * The cache is stubbed, the REQUEST is not: the options the page hands
 * `useQuery` are captured so its own `queryFn` can be invoked and the URL it
 * fetches inspected. That URL is the assertion.
 */
const query = vi.hoisted(() => ({
  lastOptions: null as {
    queryKey?: unknown;
    queryFn?: () => Promise<unknown>;
  } | null,
}));
vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: (options: unknown) => {
    query.lastOptions = options as {
      queryKey?: unknown;
      queryFn?: () => Promise<unknown>;
    };
    return {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { AppTopbar } = await import("@/components/layout/v2/app-topbar");
const MetaAudiencesPage = (await import("./legacy-page")).default;

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
    name: "Studio Business",
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

/** The shell and the surface on one page, exactly as the frame mounts them. */
function Screen() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    shell.rerender = force;
    return () => {
      shell.rerender = null;
    };
  }, [force]);
  return (
    <WorkspaceContextProvider value={envelope}>
      <AppTopbar userName="Operator" onOpenNav={vi.fn()} />
      <MetaAudiencesPage />
    </WorkspaceContextProvider>
  );
}

/**
 * Move the REAL picker to a named preset and hand back the href the shell's
 * router was actually given.
 *
 * The panel's preset button sets the draft on the first click and applies on
 * the second (`resolveRangePresetSelection`'s `shouldApply`) — the control's own
 * confirm step. Both clicks are performed here rather than reaching past the UI
 * to `onChange`.
 */
async function pickPreset(presetLabel: string): Promise<string> {
  const before = shell.hrefs.length;
  fireEvent.click(screen.getByTestId("shell-date-range-picker-trigger"));
  const option = await screen.findByText(presetLabel);
  fireEvent.click(option);
  fireEvent.click(option);
  await waitFor(() => expect(shell.hrefs.length).toBeGreaterThan(before));
  return shell.hrefs.at(-1)!;
}

/** The params the page's own read would actually be issued with. */
async function readRequestParams(): Promise<URLSearchParams> {
  const fetchStub = vi.fn(async (_url: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ status: "ok", age: [], placement: [] }),
  }));
  vi.stubGlobal("fetch", fetchStub);
  await act(async () => {
    await query.lastOptions?.queryFn?.();
  });
  const url = String(fetchStub.mock.calls[0]?.[0]);
  expect(url.startsWith("/api/meta/breakdowns?")).toBe(true);
  return new URLSearchParams(url.split("?", 2)[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  shell.pathname = "/platforms/meta/audiences";
  shell.search = `providerAccountId=${ACCOUNT_ID}`;
  shell.hrefs = [];
  shell.dashboardDateRange = {
    rangePreset: "28d",
    customStart: "",
    customEnd: "",
    comparisonPreset: "previousPeriod",
    comparisonStart: "",
    comparisonEnd: "",
  };
  query.lastOptions = null;
  window.history.replaceState(
    null,
    "",
    `/platforms/meta/audiences?providerAccountId=${ACCOUNT_ID}`,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("the shell's date picker drives the Audiences breakdown read", () => {
  it("turns one real picker click into the window the breakdowns request carries", async () => {
    render(<Screen />);

    const href = await pickPreset("Last 7 days");
    const picked = new URLSearchParams(href.split("?", 2)[1] ?? "");

    // The control changed a REQUEST, not just a label: the shell stated the
    // window on the URL of the surface being viewed, and kept the account.
    expect(href.startsWith("/platforms/meta/audiences?")).toBe(true);
    expect(picked.get("providerAccountId")).toBe(ACCOUNT_ID);
    expect(picked.get("window")).toBe("7d");
    // Completed days on the WORKSPACE clock — today is a part day and is
    // excluded (`DATE_WINDOW_INCLUDES_CURRENT_DAY`). Stated so a picker that
    // silently re-expands against another clock cannot pass by agreeing with
    // itself.
    expect(picked.get("startDate")).toBe("2026-08-11");
    expect(picked.get("endDate")).toBe("2026-08-17");

    const requested = await readRequestParams();

    expect(requested.get("businessId")).toBe(BUSINESS_ID);
    expect(requested.get("providerAccountId")).toBe(ACCOUNT_ID);
    expect(requested.get("startDate")).toBe(picked.get("startDate"));
    expect(requested.get("endDate")).toBe(picked.get("endDate"));
  });

  it("moves the read again when the picker moves again", async () => {
    render(<Screen />);

    const first = new URLSearchParams(
      (await pickPreset("Last 7 days")).split("?", 2)[1] ?? "",
    );
    const firstRequest = await readRequestParams();
    expect(firstRequest.get("startDate")).toBe(first.get("startDate"));

    // The stored selection follows the applied one, as the real store would.
    shell.dashboardDateRange = {
      ...(shell.dashboardDateRange as Record<string, unknown>),
      rangePreset: "7d",
    };
    const second = new URLSearchParams(
      (await pickPreset("Last 90 days")).split("?", 2)[1] ?? "",
    );

    // A different window, not a re-render of the same one — otherwise this test
    // would pass against a page that ignores the control entirely.
    expect(second.get("startDate")).not.toBe(first.get("startDate"));
    expect(second.get("endDate")).toBe(first.get("endDate"));

    const secondRequest = await readRequestParams();
    expect(secondRequest.get("startDate")).toBe(second.get("startDate"));
    expect(secondRequest.get("endDate")).toBe(second.get("endDate"));
    expect(secondRequest.get("startDate")).not.toBe(
      firstRequest.get("startDate"),
    );
  });

  /**
   * The window the operator picked is the window the tab links hand to the next
   * screen. A tab hop that dropped it is how one walk came to measure two
   * ranges — and it dropped it precisely on this tab, which minted its links
   * through `buildMetaScopedHref` and emitted no dates at all.
   */
  it("hands the picked window to every Studio tab link", async () => {
    render(<Screen />);

    const picked = new URLSearchParams(
      (await pickPreset("Last 7 days")).split("?", 2)[1] ?? "",
    );

    const tabs = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        "[data-creative-studio-tab]",
      ),
    );
    expect(tabs.length).toBe(4);
    for (const tab of tabs) {
      const linked = new URLSearchParams(
        tab.getAttribute("href")?.split("?", 2)[1] ?? "",
      );
      expect(linked.get("providerAccountId")).toBe(ACCOUNT_ID);
      expect(linked.get("startDate")).toBe(picked.get("startDate"));
      expect(linked.get("endDate")).toBe(picked.get("endDate"));
      // The Studio's older spelling carries the same two days, so the routes
      // that still read only `start`/`end` are not silently un-windowed.
      expect(linked.get("start")).toBe(picked.get("startDate"));
      expect(linked.get("end")).toBe(picked.get("endDate"));
    }
  });
});
