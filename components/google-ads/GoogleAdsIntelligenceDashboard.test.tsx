// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { GoogleAdvisorResponse } from "@/lib/google-ads/growth-advisor-types";

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockSetQueryData = vi.fn();
const mockGetPresetDatesForReferenceDate = vi.fn();
const mockGetTodayIsoForTimeZone = vi.fn();
const capturedPickerProps: Array<Record<string, unknown>> = [];
const mockCanOpenGoogleAdsAdvisor = vi.fn((_input?: unknown) => false);
const mockRouterPush = vi.fn();
let mockNavigationSearch = "";

vi.mock("next/navigation", () => ({
  usePathname: () => "/platforms/google",
  useRouter: () => ({ push: mockRouterPush }),
  useSearchParams: () => new URLSearchParams(mockNavigationSearch),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (input: { queryKey: unknown[] }) => mockUseQuery(input),
  useMutation: (input: unknown) => mockUseMutation(input),
  useQueryClient: () => ({ setQueryData: mockSetQueryData }),
}));

vi.mock("@/components/date-range/DateRangePicker", () => ({
  DateRangePicker: (props: Record<string, unknown>) => {
    capturedPickerProps.push(props);
    return React.createElement("div", null, "date-range-picker");
  },
  getPresetDatesForReferenceDate: (
    ...args: [string, string, string | undefined, string | undefined]
  ) => mockGetPresetDatesForReferenceDate(...args),
  getTodayIsoForTimeZone: (...args: [string]) => mockGetTodayIsoForTimeZone(...args),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "today",
      customStart: "",
      customEnd: "",
      comparisonPreset: "none",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => React.createElement("div", null, "skeleton"),
}));
vi.mock("@/components/overview/MiniTrendAreaChart", () => ({
  MiniTrendAreaChart: () => React.createElement("div", null, "mini-trend"),
}));
vi.mock("@/components/sync/sync-status-pill", () => ({
  SyncStatusPill: () => React.createElement("div", null, "sync-pill"),
  SyncStatusPillSkeleton: () => React.createElement("div", null, "sync-pill-skeleton"),
}));
vi.mock("@/components/states/empty-state", () => ({
  EmptyState: () => React.createElement("div", null, "empty-state"),
}));
vi.mock("@/components/states/error-state", () => ({
  ErrorState: () => React.createElement("div", null, "error-state"),
}));
vi.mock("@/components/google/google-advisor-panel", () => ({
  GoogleAdvisorPanel: () => React.createElement("div", null, "advisor-panel"),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
  DropdownMenuCheckboxItem: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
  DropdownMenuContent: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
  DropdownMenuItem: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
  DropdownMenuLabel: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
  DropdownMenuSeparator: () => React.createElement("div", null, "separator"),
  DropdownMenuTrigger: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
}));

vi.mock("@/components/google-ads/google-ads-dashboard-support", () => ({
  ACTION_CONFIG: [],
  fmtCurrency: (value: number) => String(value),
  fmtCurrencyPrecise: (value: number) => String(value),
  fmtNumber: (value: number) => String(value),
  fmtPct: (value: number) => String(value),
  fmtRoas: (value: number) => String(value),
  isCampaignActive: () => true,
  mapRangePresetToApi: (preset: string) => (preset === "today" ? "custom" : preset),
  normaliseBudgetRecommendations: () => [],
  ASSET_VIEWS: [],
  PANEL_ITEMS: [],
  resolveTrendTimeline: () => ({ labelMode: "day" }),
}));
vi.mock("@/lib/google-ads/advisor-ux", () => ({
  canOpenGoogleAdsAdvisor: (input: unknown) => mockCanOpenGoogleAdsAdvisor(input),
  getGoogleAdsAdvisorButtonLabel: () => "Analyze",
  getGoogleAdsAdvisorCtaState: () => "blocked",
  getGoogleAdsAdvisorHelperText: () => "Helper",
  getGoogleAdsAdvisorIdleState: () => ({
    title: "Advisor unavailable",
    description: "Advisor is unavailable for this test.",
  }),
}));
vi.mock("@/lib/sync/sync-status-pill", () => ({
  resolveGoogleAdsSyncStatusPill: () => null,
}));

function baseQueryState(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    state: { data: undefined },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function exactAdvisorResponse(
  overrides: Partial<GoogleAdvisorResponse> = {},
): GoogleAdvisorResponse {
  const recommendation = {
    id: "rec_1",
    title: "Move budget",
    type: "budget_reallocation",
    recommendationFingerprint: "fp_1",
    decisionState: "act",
    doBucket: "do_now",
    integrityState: "ready",
    confidence: "high",
    level: "campaign",
    blockers: [],
    currentStatus: "new",
    executionStatus: "not_started",
    decision: { riskLevel: "low", blockers: [] },
    operatorActionCard: {
      contractVersion: "google_ads_advisor_action_v2",
      contractSource: "native",
      recommendationType: "budget_reallocation",
      primaryAction: "Move budget with a bounded preview.",
      scope: {
        level: "campaign",
        label: "2 campaigns",
        governedEntityCount: 2,
      },
      exactChanges: [],
      exactChangePayload: {
        kind: "budget_reallocation",
        sourceCampaigns: [],
        destinationCampaigns: [],
        budgetBand: null,
        estimateMode: "bounded_preview",
        netDelta: null,
      },
      expectedEffect: {
        summary: "Bounded effect.",
        estimationMode: "bounded_range",
        estimateLabel: "+$100/mo",
        note: "Bounded.",
      },
      whyThisNow: "Current evidence supports a bounded plan.",
      validation: ["Validate after 14 days."],
      rollback: ["Restore the prior budgets."],
      blockedBecause: [],
    },
  };
  return {
    summary: {} as GoogleAdvisorResponse["summary"],
    recommendations: [recommendation] as unknown as GoogleAdvisorResponse["recommendations"],
    sections: [],
    clusters: [],
    metadata: {
      asOfDate: "2026-08-17",
    } as GoogleAdvisorResponse["metadata"],
    ...overrides,
  };
}

function setDesktopViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("GoogleAdsIntelligenceDashboard timezone date selection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    capturedPickerProps.length = 0;
    mockUseQuery.mockReset();
    mockUseMutation.mockReset();
    mockSetQueryData.mockReset();
    mockGetPresetDatesForReferenceDate.mockReset();
    mockGetTodayIsoForTimeZone.mockReset();
    mockCanOpenGoogleAdsAdvisor.mockReset();
    mockRouterPush.mockReset();
    mockNavigationSearch = "";
    mockCanOpenGoogleAdsAdvisor.mockReturnValue(false);

    mockUseMutation.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
    });
    mockGetPresetDatesForReferenceDate.mockReturnValue({
      start: "2026-04-07",
      end: "2026-04-07",
    });
    mockGetTodayIsoForTimeZone.mockReturnValue("2026-04-08");

    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      const key = String(queryKey[0]);
      if (key === "google-account-scope") {
        return baseQueryState({
          data: {
            accounts: [
              {
                id: "acc_1",
                name: "Primary Google",
                currency: "USD",
                timezone: "America/Los_Angeles",
              },
            ],
            assignedCount: 1,
          },
        });
      }
      if (key === "gads-status-base") {
        return baseQueryState({
          data: {
            state: "ready",
            connected: true,
            assignedAccountIds: ["acc_1"],
            primaryAccountTimezone: "America/Los_Angeles",
            currentDateInTimezone: "2026-04-07",
          },
          state: {
            data: {
              state: "ready",
            },
          },
        });
      }
      if (key === "gads-status") {
        return baseQueryState({
          data: {
            state: "ready",
            connected: true,
            assignedAccountIds: ["acc_1"],
          },
          state: {
            data: {
              state: "ready",
            },
          },
        });
      }
      return baseQueryState();
    });
  });

  it("publishes the last real Advisor response for the shell count", async () => {
    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    renderToStaticMarkup(
      <GoogleAdsIntelligenceDashboard businessId="biz" panel="insights" />,
    );

    const mutationOptions = mockUseMutation.mock.calls[0]?.[0] as
      { onSuccess?: (payload: unknown) => void } | undefined;
    const payload = { recommendations: [{ id: "rec_1" }] };
    mutationOptions?.onSuccess?.(payload);

    expect(mockSetQueryData).toHaveBeenCalledWith(
      ["google-advisor", "biz"],
      payload,
    );
  });

  it("loads the persisted advisor snapshot when an Advisor-backed route opens", async () => {
    const runAdvisor = vi.fn();
    mockCanOpenGoogleAdsAdvisor.mockReturnValue(true);
    mockUseMutation.mockReturnValue({
      mutate: runAdvisor,
      isPending: false,
      isError: false,
    });

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );

    render(
      React.createElement(GoogleAdsIntelligenceDashboard, {
        businessId: "biz",
        panel: "insights",
      }),
    );

    await waitFor(() => expect(runAdvisor).toHaveBeenCalledWith({ refresh: false }));
    expect(runAdvisor).toHaveBeenCalledTimes(1);
  });

  it("uses provider timezone for the shell-owned range and renders no second picker", async () => {
    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );

    renderToStaticMarkup(
      React.createElement(GoogleAdsIntelligenceDashboard, { businessId: "biz" })
    );

    expect(mockGetPresetDatesForReferenceDate).toHaveBeenCalledWith(
      "today",
      "2026-04-07",
      "",
      ""
    );
    expect(mockGetTodayIsoForTimeZone).not.toHaveBeenCalled();

    const statusBaseCall = mockUseQuery.mock.calls.find((call) => {
      const input = call[0] as { queryKey: unknown[] } | undefined;
      return input?.queryKey?.[0] === "gads-status-base";
    });
    expect(statusBaseCall?.[0].queryKey).toEqual(["gads-status-base", "biz", "acc_1"]);

    const campaignsCall = mockUseQuery.mock.calls.find((call) => {
      const input = call[0] as { queryKey: unknown[] } | undefined;
      return input?.queryKey?.[0] === "gads-campaigns";
    });
    expect(campaignsCall?.[0].queryKey).toEqual([
      "gads-campaigns",
      "biz",
      "acc_1",
      "2026-04-07",
      "2026-04-07",
      "none",
    ]);

    expect(capturedPickerProps).toHaveLength(0);
  });

  it("honors an explicitly requested assigned account on the legacy Overview route", async () => {
    mockNavigationSearch = "providerAccountId=493-118-2201";
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      const key = String(queryKey[0]);
      if (key === "google-account-scope") {
        return baseQueryState({
          data: {
            accounts: [
              {
                id: "222",
                name: "Primary Google",
                currency: "USD",
                timezone: "America/Los_Angeles",
              },
              {
                id: "4931182201",
                name: "Secondary Google",
                currency: "EUR",
                timezone: "Europe/Berlin",
              },
            ],
            assignedCount: 2,
          },
        });
      }
      return baseQueryState();
    });

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    renderToStaticMarkup(
      <GoogleAdsIntelligenceDashboard businessId="biz" panel="summary" />,
    );

    const optionsFor = (key: string) =>
      mockUseQuery.mock.calls.find((call) => call[0]?.queryKey?.[0] === key)?.[0] as
        | { enabled?: boolean; queryKey: unknown[] }
        | undefined;
    expect(optionsFor("gads-status-base")?.queryKey).toEqual([
      "gads-status-base",
      "biz",
      "4931182201",
    ]);
    expect(optionsFor("gads-campaigns")?.queryKey).toContain("4931182201");
    expect(optionsFor("gads-campaigns")?.enabled).toBe(true);
    expect(optionsFor("gads-overview-exact")?.queryKey).toContain("4931182201");
    expect(optionsFor("gads-overview-exact")?.enabled).toBe(true);
  });

  it.each([
    ["an unassigned explicit account", "providerAccountId=foreign_account"],
    ["multiple assigned accounts without an explicit account", ""],
  ])("withholds every exact read for %s", async (_label, search) => {
    mockNavigationSearch = search;
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (queryKey[0] === "google-account-scope") {
        return baseQueryState({
          data: {
            accounts: [
              {
                id: "acc_1",
                name: "Primary Google",
                currency: "USD",
                timezone: "America/Los_Angeles",
              },
              {
                id: "acc_2",
                name: "Secondary Google",
                currency: "EUR",
                timezone: "Europe/Berlin",
              },
            ],
            assignedCount: 2,
          },
        });
      }
      return baseQueryState();
    });

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    renderToStaticMarkup(
      <GoogleAdsIntelligenceDashboard businessId="biz" panel="summary" />,
    );

    const optionsFor = (key: string) =>
      mockUseQuery.mock.calls.find((call) => call[0]?.queryKey?.[0] === key)?.[0] as
        | { enabled?: boolean; queryKey: unknown[] }
        | undefined;
    expect(optionsFor("gads-status-base")?.queryKey).toEqual([
      "gads-status-base",
      "biz",
      null,
    ]);
    expect(optionsFor("gads-status-base")?.enabled).toBe(false);
    expect(optionsFor("gads-campaigns")?.enabled).toBe(false);
    expect(optionsFor("gads-budget")?.enabled).toBe(false);
    expect(optionsFor("gads-trends")?.enabled).toBe(false);
    expect(optionsFor("gads-overview-exact")?.enabled).toBe(false);
  });

  it("uses immutable route account and timezone for every Overview/Advisor data request", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => ({
      ok: true,
      json: async () =>
        String(url).includes("/api/google-ads/advisor?")
          ? exactAdvisorResponse()
          : {},
    }));
    vi.stubGlobal("fetch", fetchMock);
    mockGetTodayIsoForTimeZone.mockReturnValueOnce("2026-04-09");

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );

    renderToStaticMarkup(
      <GoogleAdsIntelligenceDashboard
        businessId="stale_client_business"
        panel="summary"
        authorizedScope={{
          businessId: "biz",
          businessName: "Authorized Business",
          providerAccountId: "4931182201",
          accountLabel: "Primary Google",
          currency: "USD",
          timezone: "America/New_York",
          viewerReadOnly: false,
          demo: false,
        }}
      />,
    );

    expect(mockGetTodayIsoForTimeZone).toHaveBeenCalledWith("America/New_York");
    expect(mockGetPresetDatesForReferenceDate).toHaveBeenCalledWith(
      "today",
      "2026-04-09",
      "",
      "",
    );
    expect(
      mockUseQuery.mock.calls.find(
        (call) => call[0]?.queryKey?.[0] === "gads-status-base",
      )?.[0].queryKey,
    ).toEqual(["gads-status-base", "biz", "4931182201"]);

    const queryOptions = (key: string) =>
      mockUseQuery.mock.calls.find((call) => call[0]?.queryKey?.[0] === key)?.[0] as
        | { enabled?: boolean; queryFn?: () => Promise<unknown>; queryKey: unknown[] }
        | undefined;
    const campaigns = queryOptions("gads-campaigns");
    const budget = queryOptions("gads-budget");
    const trends = queryOptions("gads-trends");
    const overview = queryOptions("gads-overview-exact");

    expect(campaigns?.enabled).toBe(true);
    expect(budget?.enabled).toBe(true);
    expect(trends?.enabled).toBe(true);
    expect(overview?.enabled).toBe(true);
    expect(campaigns?.queryKey).toContain("4931182201");
    expect(budget?.queryKey).toContain("4931182201");
    expect(trends?.queryKey).toContain("4931182201");
    expect(overview?.queryKey).toContain("4931182201");

    await campaigns?.queryFn?.();
    await budget?.queryFn?.();
    await trends?.queryFn?.();
    await overview?.queryFn?.();
    const advisorMutation = mockUseMutation.mock.calls[0]?.[0] as
      | { mutationFn?: (input: { refresh: boolean }) => Promise<unknown> }
      | undefined;
    await advisorMutation?.mutationFn?.({ refresh: false });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(5);
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/api\/google-ads\/campaigns\?.*accountId=4931182201/),
        expect.stringMatching(/\/api\/google-ads\/budget\?.*accountId=4931182201/),
        expect.stringMatching(/\/api\/google-ads\/trends\?.*accountId=4931182201/),
        expect.stringMatching(/\/api\/google-ads\/overview\?.*accountId=4931182201/),
        expect.stringMatching(/\/api\/google-ads\/advisor\?.*accountId=4931182201/),
      ]),
    );
  });

  it("rejects an invalid Advisor payload before it can become a measured empty response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );
    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    renderToStaticMarkup(
      <GoogleAdsIntelligenceDashboard
        businessId="biz"
        panel="insights"
        authorizedScope={{
          businessId: "biz",
          businessName: "Authorized Business",
          providerAccountId: "4931182201",
          accountLabel: "Primary Google",
          currency: "USD",
          timezone: "America/New_York",
          viewerReadOnly: false,
          demo: false,
        }}
      />,
    );
    const mutationOptions = mockUseMutation.mock.calls[0]?.[0] as
      | { mutationFn?: (input: { refresh: boolean }) => Promise<unknown> }
      | undefined;

    await expect(mutationOptions?.mutationFn?.({ refresh: false })).rejects.toThrow(
      "advisor response invalid",
    );
    expect(mockSetQueryData).not.toHaveBeenCalled();
  });

  it("withholds all Overview/Advisor reads when server scope is explicitly unresolved", async () => {
    const runAdvisor = vi.fn();
    mockCanOpenGoogleAdsAdvisor.mockReturnValue(true);
    mockUseMutation.mockReturnValue({
      mutate: runAdvisor,
      isPending: false,
      isError: false,
    });

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );

    render(
      <GoogleAdsIntelligenceDashboard
        businessId="biz"
        panel="summary"
        authorizedScope={{
          businessId: "biz",
          businessName: "Authorized Business",
          providerAccountId: null,
          accountLabel: null,
          currency: null,
          timezone: null,
          viewerReadOnly: true,
          demo: false,
        }}
      />,
    );

    const queryOptions = (key: string) =>
      mockUseQuery.mock.calls.find((call) => call[0]?.queryKey?.[0] === key)?.[0] as
        | { enabled?: boolean }
        | undefined;
    expect(queryOptions("gads-campaigns")?.enabled).toBe(false);
    expect(queryOptions("gads-budget")?.enabled).toBe(false);
    expect(queryOptions("gads-trends")?.enabled).toBe(false);
    expect(queryOptions("gads-overview-exact")?.enabled).toBe(false);
    await waitFor(() => expect(runAdvisor).not.toHaveBeenCalled());
  });

  it("mounts the exact Overview and Advisor bodies instead of the legacy extras", async () => {
    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    const authorizedScope = {
      businessId: "biz",
      businessName: "Authorized Business",
      providerAccountId: "4931182201",
      accountLabel: "Primary Google",
      currency: "USD",
      timezone: "America/New_York",
      viewerReadOnly: false,
      demo: false,
    } as const;

    const overview = renderToStaticMarkup(
      <GoogleAdsIntelligenceDashboard
        businessId="stale_client_business"
        panel="summary"
        authorizedScope={authorizedScope}
      />,
    );
    expect(overview).toContain('data-screen-label="Google Ads · Overview"');
    expect(overview.match(/data-testid="google-overview-hero-card"/g)).toHaveLength(4);
    expect(overview).not.toContain("date-range-picker");
    expect(overview).not.toContain(">Filters<");
    expect(overview).not.toContain("advisor-panel");

    const advisor = renderToStaticMarkup(
      <GoogleAdsIntelligenceDashboard
        businessId="stale_client_business"
        panel="insights"
        authorizedScope={authorizedScope}
      />,
    );
    expect(advisor).toContain('data-screen-label="Google Ads · Advisor"');
    expect(advisor.match(/data-advisor-tile=/g)).toHaveLength(4);
    expect(advisor).not.toContain("Account decisions");
    expect(advisor).not.toContain("Opportunity Queue");
    expect(advisor).not.toContain("advisor-panel");
  });

  it.each([
    ["loading", true, false],
    ["error", false, true],
    ["unavailable", false, false],
  ] as const)(
    "keeps missing Advisor data as dashes in the %s state",
    async (state, isPending, isError) => {
      mockUseMutation.mockReturnValue({
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        isPending,
        isError,
      });
      const { GoogleAdsIntelligenceDashboard } = await import(
        "@/components/google-ads/GoogleAdsIntelligenceDashboard"
      );
      const html = renderToStaticMarkup(
        <GoogleAdsIntelligenceDashboard
          businessId="biz"
          panel="insights"
          authorizedScope={{
            businessId: "biz",
            businessName: "Authorized Business",
            providerAccountId: "4931182201",
            accountLabel: "Primary Google",
            currency: "USD",
            timezone: "America/New_York",
            viewerReadOnly: false,
            demo: false,
          }}
        />,
      );
      const host = document.createElement("div");
      host.innerHTML = html;
      const surface = host.querySelector('[data-screen-label="Google Ads · Advisor"]')!;
      const values = Array.from(surface.querySelectorAll("[data-advisor-tile] p:nth-child(2)"))
        .map((node) => node.textContent);

      expect(surface.getAttribute("data-advisor-state")).toBe(state);
      expect(values).toEqual(["—", "—", "—", "—"]);
      expect(surface.querySelectorAll(":scope > [data-advisor-card]")).toHaveLength(0);
    },
  );

  it("keeps Dismiss pending until an awaited readback proves the card absent", async () => {
    setDesktopViewport();
    mockCanOpenGoogleAdsAdvisor.mockReturnValue(true);
    const post = deferred<Response>();
    const readback = deferred<GoogleAdvisorResponse>();
    const runAdvisor = vi.fn();
    let mutationOptions:
      | { onSuccess?: (payload: GoogleAdvisorResponse) => void }
      | undefined;
    const readAdvisor = vi.fn(async () => {
      const payload = await readback.promise;
      mutationOptions?.onSuccess?.(payload);
      return payload;
    });
    mockUseMutation.mockImplementation((options: unknown) => {
      mutationOptions = options as typeof mutationOptions;
      return {
        mutate: runAdvisor,
        mutateAsync: readAdvisor,
        isPending: false,
        isError: false,
      };
    });
    const fetchMock = vi.fn(() => post.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    const { container } = render(
      <GoogleAdsIntelligenceDashboard
        businessId="biz"
        panel="insights"
        authorizedScope={{
          businessId: "biz",
          businessName: "Authorized Business",
          providerAccountId: "4931182201",
          accountLabel: "Primary Google",
          currency: "USD",
          timezone: "America/New_York",
          viewerReadOnly: false,
          demo: false,
        }}
      />,
    );
    act(() => mutationOptions?.onSuccess?.(exactAdvisorResponse()));

    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    await waitFor(() => expect(dismiss).toBeEnabled());
    fireEvent.click(dismiss);

    expect(dismiss).toBeDisabled();
    expect(screen.getByText("Dismissing recommendation…")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/google-ads/advisor-memory");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      businessId: "biz",
      accountId: "4931182201",
      recommendationFingerprint: "fp_1",
      action: "dismissed",
    });

    post.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          action: "dismissed",
          accountId: "4931182201",
          recommendationFingerprint: "fp_1",
          currentStatus: "suppressed",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await waitFor(() => expect(readAdvisor).toHaveBeenCalledWith({ refresh: false }));
    expect(dismiss).toBeDisabled();
    expect(screen.queryByText("Recommendation dismissed.")).toBeNull();

    readback.resolve(exactAdvisorResponse({ recommendations: [] }));
    await waitFor(() => expect(screen.getByText("Recommendation dismissed.")).toBeTruthy());
    expect(container.querySelector('[data-advisor-card="rec_1"]')).toBeNull();
  });

  it.each([
    ["missing recommendations", {}],
    ["a still-active matching card", exactAdvisorResponse()],
  ])("fails closed when Dismiss readback returns %s", async (_label, readbackPayload) => {
    setDesktopViewport();
    mockCanOpenGoogleAdsAdvisor.mockReturnValue(true);
    let mutationOptions:
      | { onSuccess?: (payload: GoogleAdvisorResponse) => void }
      | undefined;
    const readAdvisor = vi.fn().mockResolvedValue(readbackPayload);
    mockUseMutation.mockImplementation((options: unknown) => {
      mutationOptions = options as typeof mutationOptions;
      return {
        mutate: vi.fn(),
        mutateAsync: readAdvisor,
        isPending: false,
        isError: false,
      };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            action: "dismissed",
            accountId: "4931182201",
            recommendationFingerprint: "fp_1",
            currentStatus: "suppressed",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    render(
      <GoogleAdsIntelligenceDashboard
        businessId="biz"
        panel="insights"
        authorizedScope={{
          businessId: "biz",
          businessName: "Authorized Business",
          providerAccountId: "4931182201",
          accountLabel: "Primary Google",
          currency: "USD",
          timezone: "America/New_York",
          viewerReadOnly: false,
          demo: false,
        }}
      />,
    );
    act(() => mutationOptions?.onSuccess?.(exactAdvisorResponse()));

    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    await waitFor(() => expect(dismiss).toBeEnabled());
    fireEvent.click(dismiss);

    await waitFor(() =>
      expect(screen.getByText("Dismiss readback could not be verified.")).toBeTruthy(),
    );
    expect(screen.queryByText("Recommendation dismissed.")).toBeNull();
    expect(dismiss).toBeEnabled();
  });

  it("surfaces a Dismiss POST error and never starts readback", async () => {
    setDesktopViewport();
    mockCanOpenGoogleAdsAdvisor.mockReturnValue(true);
    let mutationOptions:
      | { onSuccess?: (payload: GoogleAdvisorResponse) => void }
      | undefined;
    const readAdvisor = vi.fn();
    mockUseMutation.mockImplementation((options: unknown) => {
      mutationOptions = options as typeof mutationOptions;
      return {
        mutate: vi.fn(),
        mutateAsync: readAdvisor,
        isPending: false,
        isError: false,
      };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Account authority changed." }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    render(
      <GoogleAdsIntelligenceDashboard
        businessId="biz"
        panel="insights"
        authorizedScope={{
          businessId: "biz",
          businessName: "Authorized Business",
          providerAccountId: "4931182201",
          accountLabel: "Primary Google",
          currency: "USD",
          timezone: "America/New_York",
          viewerReadOnly: false,
          demo: false,
        }}
      />,
    );
    act(() => mutationOptions?.onSuccess?.(exactAdvisorResponse()));

    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    await waitFor(() => expect(dismiss).toBeEnabled());
    fireEvent.click(dismiss);

    await waitFor(() => expect(screen.getByText("Account authority changed.")).toBeTruthy());
    expect(readAdvisor).not.toHaveBeenCalled();
    expect(screen.queryByText("Recommendation dismissed.")).toBeNull();
    expect(dismiss).toBeEnabled();
  });

  it("preserves unavailable daily CPA, CTR and CPC as null trend points", async () => {
    const { aggregateExactOverviewTrends } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );

    const result = aggregateExactOverviewTrends({
      meta: { complete: true, incompleteDates: [] },
      rows: [
        {
          date: "2026-04-07",
          complete: true,
          rows: [
            {
              id: "campaign-1",
              name: "No delivery",
              status: "enabled",
              channel: "Search",
              spend: 0,
              revenue: 0,
              conversions: 0,
              impressions: 0,
              clicks: 0,
              impressionShare: null,
              lostIsBudget: null,
            },
          ],
        },
      ],
    });

    expect(result?.points[0]).toMatchObject({
      roas: 0,
      cpa: null,
      ctr: null,
      cpc: null,
    });
  });

  it("withholds the whole trend when even one daily read is incomplete", async () => {
    const { aggregateExactOverviewTrends } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );

    expect(
      aggregateExactOverviewTrends({
        meta: { complete: false, incompleteDates: ["2026-04-07"] },
        rows: [
          {
            date: "2026-04-07",
            complete: false,
            rows: [],
          },
        ],
      }),
    ).toBeNull();
  });

  it("renders unread campaign and budget empties as dashes but proven empties as zero", async () => {
    let complete = false;
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      const key = String(queryKey[0]);
      if (key === "google-account-scope") {
        return baseQueryState({
          data: {
            accounts: [
              {
                id: "acc_1",
                name: "Primary Google",
                currency: "USD",
                timezone: "America/Los_Angeles",
              },
            ],
            assignedCount: 1,
          },
        });
      }
      if (key === "gads-campaigns" || key === "gads-budget") {
        return baseQueryState({
          data: {
            rows: [],
            meta: complete
              ? {
                  dataState: "ready",
                  partial: false,
                  isPartial: false,
                  completion: {
                    evidenceAvailable: true,
                    state: "settled",
                  },
                }
              : {
                  dataState: "partial",
                  partial: true,
                  isPartial: true,
                  completion: {
                    evidenceAvailable: false,
                    state: "unknown",
                  },
                },
          },
        });
      }
      return baseQueryState();
    });

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    const renderOverview = () => {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(
        <GoogleAdsIntelligenceDashboard businessId="biz" panel="summary" />,
      );
      return host;
    };

    const unread = renderOverview();
    expect(
      unread.querySelector('[data-testid="google-overview-campaigns"]')?.textContent,
    ).toContain("— active");
    expect(
      unread.querySelectorAll('[data-testid="google-overview-budget-kpi"]')[1]
        ?.textContent,
    ).toContain("Budget-limited—");

    complete = true;
    const measuredEmpty = renderOverview();
    expect(
      measuredEmpty.querySelector('[data-testid="google-overview-campaigns"]')
        ?.textContent,
    ).toContain("0 active");
    expect(
      measuredEmpty.querySelectorAll('[data-testid="google-overview-budget-kpi"]')[1]
        ?.textContent,
    ).toContain("Budget-limited0");
  });

  it("keeps access failure in the exact freshness pill without an extra banner", async () => {
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      const key = String(queryKey[0]);
      if (key === "gads-status-base") {
        return baseQueryState({
          data: {
            state: "action_required",
            connected: true,
            assignedAccountIds: ["acc_1"],
            primaryAccountTimezone: "America/Los_Angeles",
            currentDateInTimezone: "2026-04-07",
          },
          state: {
            data: {
              state: "action_required",
            },
          },
        });
      }
      if (key === "gads-status") {
        return baseQueryState({
          data: {
            state: "action_required",
            connected: true,
            assignedAccountIds: ["acc_1"],
            actionRequired: {
              reconnectCta: true,
              partitions: 3,
              blockingPartitions: 3,
              scopes: ["product_daily", "keyword_daily"],
              blockingScopes: ["product_daily"],
            },
          },
          state: {
            data: {
              state: "action_required",
            },
          },
        });
      }
      return baseQueryState();
    });

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );

    const html = renderToStaticMarkup(
      React.createElement(GoogleAdsIntelligenceDashboard, { businessId: "biz" })
    );

    expect(html).toContain("Reconnect required");
    expect(html).not.toContain("Reconnect Google Ads");
    expect(html).not.toContain("Google Ads access is blocking sync for:");
  });
});
