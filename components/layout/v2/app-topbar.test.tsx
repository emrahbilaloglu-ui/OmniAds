// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

const state = vi.hoisted(() => ({
  pathname: "/c/business_A/meta/decisions",
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  selectBusiness: vi.fn(),
  fetch: vi.fn(),
  pickerProps: [] as Array<Record<string, unknown>>,
  hookReferenceDates: [] as Array<string | null>,
  syncOptions: [] as Array<{ providerStatusEnabled?: boolean }>,
  businesses: [
    {
      id: "business_A",
      name: "Business A",
      timezone: "Europe/Istanbul",
      currency: "TRY",
    },
    {
      id: "business_B",
      name: "Business B",
      timezone: "America/New_York",
      currency: "USD",
    },
  ],
  selectedBusinessId: "business_B" as string | null,
  confirmedBusinessId: "business_A" as string | null,
  dateRange: {
    rangePreset: "28d",
    customStart: "",
    customEnd: "",
    comparisonPreset: "previousPeriod",
    comparisonStart: "",
    comparisonEnd: "",
  },
  setDateRange: vi.fn(),
  // The workspace clock the topbar is expected to resolve "today" against.
  todayByTimeZone: {
    "Europe/Istanbul": "2026-08-17",
    "America/New_York": "2026-08-16",
  } as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({
    replace: state.replace,
    refresh: state.refresh,
    push: state.push,
  }),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (value: {
      businesses: typeof state.businesses;
      selectedBusinessId: string | null;
      selectBusiness: typeof state.selectBusiness;
      hasHydrated: boolean;
      authBootstrapStatus: "ready";
    }) => unknown,
  ) =>
    selector({
      businesses: state.businesses,
      selectedBusinessId: state.selectedBusinessId,
      selectBusiness: state.selectBusiness,
      hasHydrated: true,
      authBootstrapStatus: "ready",
    }),
}));

// `hasHydrated` is part of the state the canonicalizer reads, and it must be
// TRUE here: before rehydration the store still holds its defaults, and the
// canonicalizer deliberately waits rather than stating a window the operator
// never chose. These cases exercise the settled state; the waiting behaviour
// is pinned separately below.
const preferencesState = { language: "en" as const, hasHydrated: true };

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (value: typeof preferencesState) => unknown) =>
    selector(preferencesState),
}));

// The canonicalizer is the REAL one: a stub could not tell whether the shell
// states the window it names, which is the entire ITEM 10 question.
vi.mock("@/hooks/use-persistent-date-range", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-persistent-date-range")>();
  return {
    ...actual,
    usePersistentDateRange: (referenceDate?: string | null) => {
      state.hookReferenceDates.push(referenceDate ?? null);
      return [state.dateRange, state.setDateRange];
    },
  };
});

// The window arithmetic is the real implementation: a test that mocked it
// could not tell whether the control states the window it names.
vi.mock("@/components/date-range/DateRangePicker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/date-range/DateRangePicker")>();
  return {
    ...actual,
    DateRangePicker: (props: Record<string, unknown>) => {
      state.pickerProps.push(props);
      return <div data-testid="date-range-picker" />;
    },
    getTodayIsoForTimeZone: (timeZone: string) =>
      state.todayByTimeZone[timeZone] ?? "2026-08-17",
  };
});

vi.mock("@/components/layout/v2/use-shell-signals", () => ({
  useWorkspaceSyncState: (options?: { providerStatusEnabled?: boolean }) => {
    state.syncOptions.push(options ?? {});
    return {
      tone: "fresh",
      label: "Synced 12m ago",
      freshnessState: "ready",
    };
  },
  // The shell's one answer to "which workspace". It is also the ITEM 10 gate:
  // null means the clock is not known yet, and nothing may be stated from it.
  useConfirmedShellBusinessId: () => state.confirmedBusinessId,
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
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("@/lib/auth-diagnostics", () => ({ logClientAuthEvent: vi.fn() }));

import {
  AppTopbar,
  isMetaDecisionsRoute,
  scopedBusinessSwitchDestination,
} from "@/components/layout/v2/app-topbar";

const envelopeA: WorkspaceContextEnvelope = {
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
    id: "business_A",
    name: "Business A",
    configuredCurrency: "TRY",
    businessTimezone: "Europe/Istanbul",
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

/**
 * The window the shell states on its first render (ITEM 10): 28 days of
 * completed days, resolved against Istanbul, ending yesterday.
 *
 * Every switch test below starts from a URL that already states it, because
 * that is the only state a real switch is ever performed from — the shell
 * canonicalizes before anything can be clicked. It also keeps the two
 * behaviours separable: with the window already stated the canonicalizer is a
 * no-op, so any `router.replace` in those tests is the switch's own.
 */
const STATED_WINDOW = "window=28d&startDate=2026-07-20&endDate=2026-08-16";

function renderTopbar() {
  return render(
    <WorkspaceContextProvider value={envelopeA}>
      <AppTopbar userName="Operator" onOpenNav={vi.fn()} />
    </WorkspaceContextProvider>,
  );
}

describe("business-scoped Dashboard v2 topbar", () => {
  beforeEach(() => {
    state.pathname = "/c/business_A/meta/decisions";
    state.selectedBusinessId = "business_B";
    state.confirmedBusinessId = "business_A";
    state.replace.mockReset();
    state.refresh.mockReset();
    state.push.mockReset();
    state.selectBusiness.mockReset();
    state.fetch.mockReset();
    state.fetch.mockResolvedValue({ ok: true });
    state.pickerProps.length = 0;
    state.hookReferenceDates.length = 0;
    state.syncOptions.length = 0;
    state.setDateRange.mockReset();
    state.dateRange = {
      rangePreset: "28d",
      customStart: "",
      customEnd: "",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    };
    window.history.replaceState(
      null,
      "",
      `/c/business_A/meta/decisions?${STATED_WINDOW}`,
    );
    vi.stubGlobal("fetch", state.fetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    "/platforms/meta",
    "/platforms/meta/",
    "/app/meta/decisions",
    "/c/business_A/meta/decisions",
  ])("suppresses both shell provider reads on Decision route %s", (pathname) => {
    state.pathname = pathname;
    window.history.replaceState(null, "", `${pathname}?${STATED_WINDOW}`);

    renderTopbar();

    expect(isMetaDecisionsRoute(pathname)).toBe(true);
    expect(state.syncOptions.length).toBeGreaterThan(0);
    expect(
      state.syncOptions.every(
        (options) => options.providerStatusEnabled === false,
      ),
    ).toBe(true);
  });

  it.each([
    "/platforms/meta/creatives",
    "/app/meta/automation",
    "/app/google/overview",
    "/c/business_A/home",
    "/c/business_A/google/overview",
  ])("preserves shell provider fallback on non-Decision route %s", (pathname) => {
    state.pathname = pathname;
    window.history.replaceState(null, "", `${pathname}?${STATED_WINDOW}`);

    renderTopbar();

    expect(isMetaDecisionsRoute(pathname)).toBe(false);
    expect(state.syncOptions.length).toBeGreaterThan(0);
    expect(
      state.syncOptions.every(
        (options) => options.providerStatusEnabled === true,
      ),
    ).toBe(true);
  });

  it("paints route A and resolves its date clock even when the session store says B", () => {
    const { container } = renderTopbar();
    const trigger = container.querySelector(".adv-topbar > .adv-btn");

    expect(trigger).toHaveTextContent("Business A");
    expect(trigger).not.toHaveTextContent("Business B");
    expect(state.pickerProps[0]).toMatchObject({
      referenceDate: "2026-08-17",
      timeZoneLabel: "Europe/Istanbul",
    });
    // The same clock the picker paints is the one its window is resolved with.
    expect(state.hookReferenceDates.at(-1)).toBe("2026-08-17");
  });

  it("posts first and then navigates A to the equivalent B route without optimistic store drift", async () => {
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => {
      expect(state.replace).toHaveBeenCalledWith(
        `/c/business_B/meta/decisions?${STATED_WINDOW}`,
      );
    });
    expect(state.fetch).toHaveBeenCalledWith("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: "business_B" }),
    });
    expect(state.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      state.replace.mock.invocationCallOrder[0]!,
    );
    expect(state.selectBusiness).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("keeps route A and the store unchanged when the scoped switch is rejected", async () => {
    state.fetch.mockResolvedValue({ ok: false });
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => expect(state.fetch).toHaveBeenCalledOnce());
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.selectBusiness).not.toHaveBeenCalled();
    expect(state.selectedBusinessId).toBe("business_B");
  });

  it("keeps readable /app switching on the existing session-refresh path", async () => {
    state.pathname = "/app/meta/decisions";
    state.selectedBusinessId = "business_A";
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
    expect(state.selectBusiness).toHaveBeenCalledWith("business_B");
    expect(state.replace).not.toHaveBeenCalled();
  });

  /**
   * The `/app/**` path does not change across a workspace switch, so the App
   * Router reuses the layout segment — and the workspace envelope the switcher
   * reads is built in that layout. Observed on :3000: after the switch the page
   * re-rendered as B ("META · GRANDMIX · USD") while the switcher above it
   * still said "TheSwaf". Stripping the query is not enough; the layout the
   * shell reads its business from has to be invalidated too.
   */
  it("refreshes the layout the switcher reads, not just the page below it", async () => {
    state.pathname = "/app/meta/decisions";
    state.selectedBusinessId = "business_A";
    window.history.replaceState(
      null,
      "",
      `/app/meta/decisions?providerAccountId=act_9&${STATED_WINDOW}`,
    );
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
    expect(state.replace).toHaveBeenCalledWith(
      `/app/meta/decisions?${STATED_WINDOW}`,
    );
  });

  /**
   * ITEM 2 — one date-window authority.
   *
   * This control wrote a preferences store and nothing else: no router, no
   * history, no request. Six of the nine Meta surfaces never read that store,
   * and a server-rendered one could not read it at all, so moving the picker
   * changed a label and no data underneath it. The window has to be stated
   * where every surface can see it, and stating it must not disturb the scope
   * parameters that share the URL.
   */
  it("states the picked window on the URL and preserves every other parameter", () => {
    state.pathname = "/platforms/meta";
    // Istanbul is the workspace clock here; the window below is resolved
    // against it rather than against the viewer's browser.
    state.selectedBusinessId = "business_A";
    window.history.replaceState(
      null,
      "",
      "/platforms/meta?businessId=business_A&providerAccountId=act_9&cursor=abc",
    );
    renderTopbar();

    const picker = state.pickerProps[0] as {
      onChange: (value: {
        rangePreset: string;
        customStart: string;
        customEnd: string;
        comparisonPreset: string;
        comparisonStart: string;
        comparisonEnd: string;
      }) => void;
    };
    picker.onChange({
      rangePreset: "7d",
      customStart: "",
      customEnd: "",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    });

    const target = state.replace.mock.calls.at(-1)?.[0] as string;
    expect(target.startsWith("/platforms/meta?")).toBe(true);
    const params = new URLSearchParams(target.slice(target.indexOf("?") + 1));
    // The absolute window, resolved against the workspace clock — not a preset
    // name each surface re-resolves against whatever clock it holds.
    expect(params.get("startDate")).toBe("2026-08-10");
    expect(params.get("endDate")).toBe("2026-08-16");
    // Spelled the way the Meta Decision Center's own parser reads it.
    expect(params.get("window")).toBe("7d");
    expect(params.get("businessId")).toBe("business_A");
    expect(params.get("providerAccountId")).toBe("act_9");
    expect(params.get("cursor")).toBe("abc");
    expect(state.setDateRange).toHaveBeenCalledOnce();
  });

  it("states a window the Decision Center cannot name as exact dates, never as a key it would misread", () => {
    state.pathname = "/platforms/meta";
    state.selectedBusinessId = "business_A";
    window.history.replaceState(null, "", "/platforms/meta");
    renderTopbar();

    const picker = state.pickerProps[0] as {
      onChange: (value: Record<string, string>) => void;
    };
    picker.onChange({
      rangePreset: "yesterday",
      customStart: "",
      customEnd: "",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    });

    const target = state.replace.mock.calls.at(-1)?.[0] as string;
    const params = new URLSearchParams(target.slice(target.indexOf("?") + 1));
    // `yesterday` is not in that parser's vocabulary; writing it would fall
    // back to its 28-day default and answer for a window nobody picked.
    expect(params.get("window")).toBe("custom");
    expect(params.get("startDate")).toBe("2026-08-16");
    expect(params.get("endDate")).toBe("2026-08-16");
  });

  /**
   * ITEM 1 + ITEM 9 — the shell and the body must never name two businesses,
   * and a workspace switch must not carry the previous workspace's account.
   *
   * REWRITTEN. The original version of this test asserted
   * `expect(params.get("providerAccountId")).toBe("act_9")` — it treated
   * carrying A's ad account into B as success, and it passed, because that is
   * what the switcher did. That is the ITEM 9 defect stated as a contract.
   *
   * `act_9` is a fact about A's ad account. In B it names nothing: every
   * downstream reader takes the URL as the surface's scope, so B's rail would
   * mint `?providerAccountId=act_9` links and B's requests would go out asking
   * for A's account — refused as `provider_account_not_assigned` at best, and
   * silently answered for the wrong account if the operator holds both. The
   * business id still moves with the switch (a legacy body reads it); the
   * account is dropped, and B resolves its own.
   */
  it("moves a legacy link's business and drops the previous workspace's account", async () => {
    state.pathname = "/platforms/meta";
    state.selectedBusinessId = "business_A";
    window.history.replaceState(
      null,
      "",
      `/platforms/meta?businessId=business_A&providerAccountId=act_9&${STATED_WINDOW}`,
    );
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => expect(state.replace).toHaveBeenCalled());
    const target = state.replace.mock.calls.at(-1)?.[0] as string;
    const params = new URLSearchParams(target.slice(target.indexOf("?") + 1));
    expect(target.startsWith("/platforms/meta?")).toBe(true);
    expect(params.get("businessId")).toBe("business_B");
    expect(params.get("providerAccountId")).toBeNull();
    expect(target).not.toContain("act_9");
    // The server moved the session before the store was told anything.
    expect(state.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      state.selectBusiness.mock.invocationCallOrder[0]!,
    );
  });

  /**
   * ITEM 9 acceptance, on the scoped family: A active with
   * `providerAccountId=A1`, switch to B, and the new URL carries no A1.
   *
   * Everything account-shaped goes, not just the account id: a row selection, a
   * cursor and a Launchpad handoff reference are all A's entity ids, and a
   * cursor in particular is a position in A's result set that would silently
   * resolve to a different page of B's.
   */
  it("carries no account scope from A into B on a scoped switch", async () => {
    state.pathname = "/c/business_A/meta/decisions";
    window.history.replaceState(
      null,
      "",
      "/c/business_A/meta/decisions?providerAccountId=act_9&cursor=abc" +
        "&row=ad:123&creativeId=cr_7&handoff=hx_1&lane=act" +
        "&window=7d&startDate=2026-08-10&endDate=2026-08-16",
    );
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => expect(state.replace).toHaveBeenCalled());
    const target = state.replace.mock.calls.at(-1)?.[0] as string;
    expect(target.startsWith("/c/business_B/meta/decisions")).toBe(true);
    const params = new URLSearchParams(target.slice(target.indexOf("?") + 1));
    for (const leaked of [
      "providerAccountId",
      "cursor",
      "row",
      "creativeId",
      "handoff",
      "lane",
    ]) {
      expect(params.get(leaked)).toBeNull();
    }
    expect(target).not.toContain("act_9");
    // The date window names days, not accounts. ITEM 9 permits keeping it, and
    // the days are absolute, so B measures the same days A did.
    expect(params.get("window")).toBe("7d");
    expect(params.get("startDate")).toBe("2026-08-10");
    expect(params.get("endDate")).toBe("2026-08-16");
  });

  /**
   * The `/app/**` family used to take the session-refresh branch whenever the
   * URL stated no `businessId` — which left `?providerAccountId=act_9` sitting
   * on the address bar of a workspace that had just changed underneath it.
   * Nothing in the refresh removed it, so every subsequent read on B was
   * scoped to A's account.
   */
  it("strips a readable route's account scope instead of refreshing over it", async () => {
    state.pathname = "/app/meta/decisions";
    state.selectedBusinessId = "business_A";
    window.history.replaceState(
      null,
      "",
      `/app/meta/decisions?providerAccountId=act_9&${STATED_WINDOW}`,
    );
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => expect(state.replace).toHaveBeenCalled());
    // The account went; the days stayed, which is exactly what ITEM 9 permits.
    expect(state.replace.mock.calls.at(-1)?.[0]).toBe(
      `/app/meta/decisions?${STATED_WINDOW}`,
    );
    expect(state.selectBusiness).toHaveBeenCalledWith("business_B");
  });

  /**
   * ITEM 10 — one date-window authority, established before the first read.
   *
   * The proven defect: a persisted 90-day selection with no dates in the URL
   * left the shell's picker naming 90 days while `MetaPlatformPage`\'s
   * `parseMetaWindow(null)` and the server-rendered Intelligence route both
   * measured 28 — two windows for one workspace in one paint. The shell states
   * the window on the URL before anything reads it: `history.replaceState` so
   * client surfaces re-read it, and `router.replace` because a server-rendered
   * surface can only be told through a navigation.
   */
  it("waits for the persisted selection instead of stating the default over it", () => {
    // THE REGRESSION THIS PINS. The canonicalizer used to run before the
    // preferences store rehydrated, so it wrote the DEFAULT window into the
    // URL — and a stated window is exact, so the operator's real 90-day
    // selection could no longer state itself when it arrived a tick later.
    // Symptom: pick 90 days, press reload, land silently on 28.
    preferencesState.hasHydrated = false;
    try {
      state.pathname = "/c/business_A/meta/decisions";
      window.history.replaceState(null, "", "/c/business_A/meta/decisions");
      renderTopbar();
      const params = new URLSearchParams(window.location.search);
      expect(params.get("startDate")).toBeNull();
      expect(params.get("endDate")).toBeNull();
      expect(params.get("window")).toBeNull();
    } finally {
      preferencesState.hasHydrated = true;
    }
  });

  it("states the window on the URL on first render, before any surface reads it", () => {
    state.pathname = "/c/business_A/meta/decisions";
    window.history.replaceState(
      null,
      "",
      "/c/business_A/meta/decisions?providerAccountId=act_9",
    );
    renderTopbar();

    const params = new URLSearchParams(window.location.search);
    // Resolved against Istanbul, the workspace clock the picker also paints —
    // and ending yesterday, because today is a partial day.
    expect(params.get("window")).toBe("28d");
    expect(params.get("startDate")).toBe("2026-07-20");
    expect(params.get("endDate")).toBe("2026-08-16");
    // Canonicalizing the window is not a licence to edit the scope beside it.
    expect(params.get("providerAccountId")).toBe("act_9");
    expect(state.replace).toHaveBeenCalledWith(
      "/c/business_A/meta/decisions?providerAccountId=act_9" +
        "&window=28d&startDate=2026-07-20&endDate=2026-08-16",
    );
  });

  it("states nothing before the shell has confirmed whose clock to use", () => {
    // No confirmed workspace means no confirmed timezone, and the reference
    // date above it is the "UTC" placeholder. Stating a window from a
    // placeholder clock and restating it a moment later is the same defect
    // wearing a different hat, so nothing is stated at all.
    state.confirmedBusinessId = null;
    window.history.replaceState(null, "", "/c/business_A/meta/decisions");
    renderTopbar();

    expect(window.location.search).toBe("");
    expect(state.replace).not.toHaveBeenCalled();
  });

  it("leaves a URL that already names an exact window untouched", () => {
    window.history.replaceState(
      null,
      "",
      "/c/business_A/meta/decisions?window=custom&startDate=2026-07-01&endDate=2026-07-14",
    );
    renderTopbar();

    expect(new URLSearchParams(window.location.search).get("startDate")).toBe(
      "2026-07-01",
    );
    expect(state.replace).not.toHaveBeenCalled();
  });

  it("does not move the store when the unscoped switch is refused", async () => {
    state.pathname = "/platforms/meta";
    state.selectedBusinessId = "business_A";
    state.fetch.mockResolvedValue({ ok: false });
    window.history.replaceState(
      null,
      "",
      `/platforms/meta?businessId=business_A&${STATED_WINDOW}`,
    );
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => expect(state.fetch).toHaveBeenCalledOnce());
    expect(state.selectBusiness).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("builds scoped destinations without carrying A's provider query state", () => {
    expect(
      scopedBusinessSwitchDestination(
        "/c/business_A/google/advisor",
        "business B",
      ),
    ).toBe("/c/business%20B/google/advisor");
    expect(scopedBusinessSwitchDestination("/c/business_A", "business_B")).toBe(
      "/c/business_B/home",
    );
    expect(scopedBusinessSwitchDestination("/app/home", "business_B")).toBeNull();
  });
});
