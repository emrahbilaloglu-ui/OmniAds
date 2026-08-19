// @vitest-environment jsdom

/**
 * The second half of the chain the canonical routes now start.
 *
 * `creative-pages.test.tsx` pins that each route parses `?start`/`?end` on the
 * server and hands the result to its body. That alone proves nothing about what
 * the operator sees: a prop can arrive and be ignored, which is exactly what
 * these four routes did with their parsed window before. So this file asks the
 * bodies the only question that matters — which window did the read actually
 * use — by inspecting the query key each surface reads under AND the request
 * URL its own fetcher builds.
 *
 * The shell range in these tests is a fixed custom window, so "the link won" and
 * "the shell won" are two different, clock-independent dates and a passing
 * assertion cannot be an accident of today's date.
 */

import { useQuery } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CopiesBody from "@/app/(dashboard)/platforms/meta/copies/legacy-page";
import InboxBody from "@/app/(dashboard)/platforms/meta/creative-inbox/legacy-page";
import PerformanceBody from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";
import LandingPagesBody from "@/app/(dashboard)/platforms/meta/landing-pages/legacy-page";

/** The window a pasted link names. */
const LINK_WINDOW = { start: "2026-03-01", end: "2026-03-07" };
/** The window the shell's stored range resolves to for these tests. */
const SHELL_WINDOW = { start: "2026-07-01", end: "2026-07-28" };

const BUSINESS_ID = "biz_route";
const ACCOUNT_ID = "act_authorized";

const navigationState = vi.hoisted(() => ({
  pathname: "/c/biz_route/creative/performance",
  search: "",
}));

/** The query the shell writes when the operator moves the date control. */
const SHELL_STATED_QUERY =
  "window=custom&startDate=2026-07-01&endDate=2026-07-28";

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
  useSearchParams: () => new URLSearchParams(navigationState.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (state: {
      selectedBusinessId: string | null;
      workspaceResolved: boolean;
      businesses: Array<{ id: string; name: string; currency: string }>;
    }) => unknown,
  ) =>
    selector({
      // Deliberately not the route's business: the surfaces under test are
      // server-scoped, so anything they read must come from the props.
      selectedBusinessId: "biz_from_browser_storage",
      workspaceResolved: true,
      businesses: [
        { id: BUSINESS_ID, name: "Nordventure", currency: "EUR" },
        { id: "biz_from_browser_storage", name: "Other", currency: "USD" },
      ],
    }),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "custom",
      customStart: SHELL_WINDOW.start,
      customEnd: SHELL_WINDOW.end,
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/pricing/usePlan", () => ({
  usePlanState: () => ({ plan: "growth", isLoading: false, isReady: true }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

const useQueryMock = vi.mocked(useQuery);

type QueryCall = {
  queryKey: unknown[];
  queryFn?: () => unknown;
  enabled?: boolean;
};

/**
 * A single assigned account, so the account timezone the surfaces resolve
 * "today" against is real and the accounts read is never the thing under test.
 */
const ASSIGNED_ACCOUNTS = [
  {
    id: ACCOUNT_ID,
    name: "Main",
    timezone: "America/New_York",
    currency: "USD",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  navigationState.search = "";
  useQueryMock.mockImplementation((options: unknown) => {
    const call = options as QueryCall;
    const key = String(call.queryKey?.[0] ?? "");
    const data = key === "meta-provider-accounts" ? ASSIGNED_ACCOUNTS : undefined;
    return {
      data,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as never;
  });
});

afterEach(() => {
  cleanup();
});

/** Every `useQuery` the render issued, in order. */
function queryCalls(): QueryCall[] {
  return useQueryMock.mock.calls.map((call) => call[0] as unknown as QueryCall);
}

function queryCallFor(prefix: string): QueryCall {
  const call = queryCalls().find((entry) => entry.queryKey?.[0] === prefix);
  expect(call, `the surface never issued a "${prefix}" read`).toBeDefined();
  return call!;
}

/** Runs a captured `queryFn` against a stub and returns the URL it requested. */
async function requestedUrl(call: QueryCall): Promise<string> {
  const fetchStub = vi.fn(async (input: unknown) => {
    void input;
    return {
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
    };
  });
  vi.stubGlobal("fetch", fetchStub);
  try {
    await Promise.resolve(call.queryFn?.()).catch(() => null);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(fetchStub, "the read never called fetch").toHaveBeenCalled();
  return String(fetchStub.mock.calls[0]![0]);
}

describe("Creative Studio bodies bind the server-parsed window to their reads", () => {
  it("Assets reads the window the link named", async () => {
    navigationState.pathname = "/c/biz_route/creative/performance";
    render(
      <PerformanceBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={LINK_WINDOW}
      />,
    );

    const call = queryCallFor("meta-creative-studio");
    expect(call.queryKey).toEqual([
      "meta-creative-studio",
      BUSINESS_ID,
      ACCOUNT_ID,
      LINK_WINDOW.start,
      LINK_WINDOW.end,
      "creative",
    ]);

    const url = await requestedUrl(call);
    expect(url).toContain(`start=${LINK_WINDOW.start}`);
    expect(url).toContain(`end=${LINK_WINDOW.end}`);
    expect(url).not.toContain(SHELL_WINDOW.start);
  });

  it("Assets keeps the shell's range when the link names no window", () => {
    navigationState.pathname = "/c/biz_route/creative/performance";
    render(
      <PerformanceBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={null}
      />,
    );

    // No window in the URL must not mean "the route picks one". The shell's
    // stored range still owns the surface, so the date control keeps meaning
    // what it shows.
    expect(queryCallFor("meta-creative-studio").queryKey).toEqual([
      "meta-creative-studio",
      BUSINESS_ID,
      ACCOUNT_ID,
      SHELL_WINDOW.start,
      SHELL_WINDOW.end,
      "creative",
    ]);
  });

  it("Assets carries the window it read into every Studio tab link", () => {
    navigationState.pathname = "/c/biz_route/creative/performance";
    const { container } = render(
      <PerformanceBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={LINK_WINDOW}
      />,
    );

    const copiesTab = container.querySelector<HTMLAnchorElement>(
      '[data-creative-studio-tab="copies"]',
    );
    // ITEM 17 — the window travels in BOTH live spellings, from the one window
    // this body actually read with. `window`/`startDate`/`endDate` is what the
    // shell's date control writes and what `usePersistentDateRange` and
    // `windowFromSearchParams` read first; `start`/`end` is the Studio's older
    // pair, still read by `scopeFromSearchParams` on the shares/briefs/detail
    // routes, so dropping it would un-window those links. `window=custom` is
    // the law rather than a shortcut: the exact dates ARE the window, and
    // naming a rolling preset would let the destination re-expand it against
    // its own clock and measure different days from the tab just left.
    expect(copiesTab?.getAttribute("href")).toBe(
      `/c/${BUSINESS_ID}/creative/copies?providerAccountId=${ACCOUNT_ID}` +
        `&window=custom&startDate=${LINK_WINDOW.start}&endDate=${LINK_WINDOW.end}` +
        `&start=${LINK_WINDOW.start}&end=${LINK_WINDOW.end}`,
    );
  });

  it("Assets lets the shell's stated window outrank the link's", () => {
    // Once the operator moves the date control, the shell states its window on
    // the URL and `usePersistentDateRange` reads it back — so the shell range
    // IS the URL's answer. The forwarded window stepping aside here is what
    // keeps the control from becoming a decoration on a deep-linked visit.
    navigationState.pathname = "/c/biz_route/creative/performance";
    navigationState.search = SHELL_STATED_QUERY;
    render(
      <PerformanceBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={LINK_WINDOW}
      />,
    );

    expect(queryCallFor("meta-creative-studio").queryKey).toEqual([
      "meta-creative-studio",
      BUSINESS_ID,
      ACCOUNT_ID,
      SHELL_WINDOW.start,
      SHELL_WINDOW.end,
      "creative",
    ]);
  });

  it("Copies reads the window the link named", async () => {
    navigationState.pathname = "/c/biz_route/creative/copies";
    render(
      <CopiesBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={LINK_WINDOW}
      />,
    );

    const call = queryCallFor("copies-creatives");
    expect(call.queryKey).toEqual([
      "copies-creatives",
      BUSINESS_ID,
      ACCOUNT_ID,
      LINK_WINDOW.start,
      LINK_WINDOW.end,
      "copy",
    ]);

    const url = await requestedUrl(call);
    expect(url).toContain("/api/meta/copies?");
    expect(url).toContain(`start=${LINK_WINDOW.start}`);
    expect(url).toContain(`end=${LINK_WINDOW.end}`);
  });

  it("Copies keeps the shell's range when the link names no window", () => {
    navigationState.pathname = "/c/biz_route/creative/copies";
    render(
      <CopiesBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={null}
      />,
    );

    expect(queryCallFor("copies-creatives").queryKey).toEqual([
      "copies-creatives",
      BUSINESS_ID,
      ACCOUNT_ID,
      SHELL_WINDOW.start,
      SHELL_WINDOW.end,
      "copy",
    ]);
  });

  it("Copies lets the shell's stated window outrank the link's", () => {
    navigationState.pathname = "/c/biz_route/creative/copies";
    navigationState.search = SHELL_STATED_QUERY;
    render(
      <CopiesBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={LINK_WINDOW}
      />,
    );

    expect(queryCallFor("copies-creatives").queryKey).toEqual([
      "copies-creatives",
      BUSINESS_ID,
      ACCOUNT_ID,
      SHELL_WINDOW.start,
      SHELL_WINDOW.end,
      "copy",
    ]);
  });

  it("Landers reads the window the link named", async () => {
    navigationState.pathname = "/c/biz_route/creative/landing-pages";
    render(
      <LandingPagesBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={LINK_WINDOW}
      />,
    );

    const call = queryCallFor("meta-creative-destinations");
    expect(call.queryKey).toEqual([
      "meta-creative-destinations",
      BUSINESS_ID,
      ACCOUNT_ID,
      LINK_WINDOW.start,
      LINK_WINDOW.end,
    ]);

    const url = await requestedUrl(call);
    expect(url).toContain("/api/meta/creatives?");
    expect(url).toContain(`start=${LINK_WINDOW.start}`);
    expect(url).toContain(`end=${LINK_WINDOW.end}`);
  });

  it("Landers keeps the shell's range when the link names no window", () => {
    navigationState.pathname = "/c/biz_route/creative/landing-pages";
    render(
      <LandingPagesBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={null}
      />,
    );

    expect(queryCallFor("meta-creative-destinations").queryKey).toEqual([
      "meta-creative-destinations",
      BUSINESS_ID,
      ACCOUNT_ID,
      SHELL_WINDOW.start,
      SHELL_WINDOW.end,
    ]);
  });

  it("Landers lets the shell's stated window outrank the link's", () => {
    navigationState.pathname = "/c/biz_route/creative/landing-pages";
    navigationState.search = SHELL_STATED_QUERY;
    render(
      <LandingPagesBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={LINK_WINDOW}
      />,
    );

    expect(queryCallFor("meta-creative-destinations").queryKey).toEqual([
      "meta-creative-destinations",
      BUSINESS_ID,
      ACCOUNT_ID,
      SHELL_WINDOW.start,
      SHELL_WINDOW.end,
    ]);
  });

  it("Inbox hands the window on instead of dropping it mid-walk", () => {
    navigationState.pathname = "/c/biz_route/creative/inbox";
    const { container } = render(
      <InboxBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={LINK_WINDOW}
      />,
    );

    // The inbox read is not windowed, so the window is not a filter here. It is
    // forwarded only so Assets -> Inbox -> Copies stops resetting the range.
    const tabs = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("[data-creative-studio-tab]"),
    );
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) {
      expect(tab.getAttribute("href")).toContain(`start=${LINK_WINDOW.start}`);
      expect(tab.getAttribute("href")).toContain(`end=${LINK_WINDOW.end}`);
    }
  });

  it("Inbox invents no window when the link names none", () => {
    navigationState.pathname = "/c/biz_route/creative/inbox";
    const { container } = render(
      <InboxBody
        businessId={BUSINESS_ID}
        providerAccountId={ACCOUNT_ID}
        serverDateWindow={null}
      />,
    );

    for (const tab of Array.from(
      container.querySelectorAll<HTMLAnchorElement>("[data-creative-studio-tab]"),
    )) {
      expect(tab.getAttribute("href")).not.toContain("start=");
      expect(tab.getAttribute("href")).not.toContain("end=");
    }
  });
});
