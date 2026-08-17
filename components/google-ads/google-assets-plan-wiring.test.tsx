// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup } from "@testing-library/react";

/**
 * The route body, not a hand-written view model.
 *
 * These assertions mount the real controller for `panel="assets"` and
 * `panel="plan"` with the payloads the real endpoints serve, and prove the
 * served rows reach the canonical screens — including the ad strength the
 * asset-group report now carries, the receipt the execution log stamps, and
 * the retention window the activity route owns.
 */

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockSetQueryData = vi.fn();
const mockInvalidateQueries = vi.fn();

/**
 * The advisor read is a mutation, not a query, so the queue is injected by
 * letting the mocked mutation resolve with a served advisor payload.
 */
const advisorState = vi.hoisted(() => ({
  canOpen: false,
  payload: {
    recommendations: [] as Array<Record<string, unknown>>,
    summary: { campaignRoles: [] as Array<Record<string, unknown>> },
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/platforms/google/assets",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (input: { queryKey: unknown[] }) => mockUseQuery(input),
  useMutation: (input: unknown) => mockUseMutation(input),
  useQueryClient: () => ({
    setQueryData: mockSetQueryData,
    invalidateQueries: mockInvalidateQueries,
  }),
}));

vi.mock("@/components/date-range/DateRangePicker", () => ({
  DateRangePicker: () => React.createElement("div", null, "date-range-picker"),
  getPresetDatesForReferenceDate: () => ({ start: "2026-03-11", end: "2026-04-07" }),
  getTodayIsoForTimeZone: () => "2026-04-08",
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "last_28_days",
      customStart: "",
      customEnd: "",
      comparisonPreset: "none",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/lib/google-ads/advisor-ux", () => ({
  canOpenGoogleAdsAdvisor: () => advisorState.canOpen,
  getGoogleAdsAdvisorButtonLabel: () => "Analyze",
  getGoogleAdsAdvisorCtaState: () => "blocked",
  getGoogleAdsAdvisorHelperText: () => "Helper",
  getGoogleAdsAdvisorIdleState: () => ({ title: "t", description: "d" }),
}));
vi.mock("@/lib/sync/sync-status-pill", () => ({
  resolveGoogleAdsSyncStatusPill: () => null,
}));

function queryState(overrides: Record<string, unknown> = {}) {
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

const ASSET_GROUP_ROWS = [
  {
    id: "ag_1",
    campaign: "PMax — Evergreen",
    name: "Best sellers — US",
    spend: 8120,
    revenue: 33_290,
    roas: 4.1,
    conversionRate: 0,
    coverageScore: 90,
    adStrength: "Excellent",
    searchThemes: [],
    searchThemeCount: 0,
    searchThemeAlignedCount: 0,
  },
  {
    id: "ag_2",
    campaign: "PMax — Clearance",
    name: "Clearance — slow movers",
    spend: 1980,
    revenue: 4320,
    roas: 2.18,
    conversionRate: 0,
    coverageScore: 40,
    adStrength: "Poor",
    searchThemes: [],
    searchThemeCount: 0,
    searchThemeAlignedCount: 0,
  },
];

const ASSET_ROWS = [
  {
    id: "as_1",
    type: "Headline",
    assetText: "Carry less. Go further.",
    // The two labels disagree on purpose: the card's caption says the rating is
    // Google-served, so the served one is the one that may reach the chip.
    servedPerformanceLabel: "Low",
    performanceLabel: "top",
    impressions: 412_000,
    spend: 0,
    conversions: 0,
    roas: 0,
  },
  {
    id: "im_1",
    type: "Image",
    impressions: 100,
    preview: null,
    spend: 0,
    conversions: 0,
    roas: 0,
  },
];

const AUDIENCE_ROWS = [
  {
    criterionId: "9001",
    name: "9001",
    type: "Remarketing",
    spend: 2932.8,
    revenue: 18_212,
    conversions: 312,
    roas: 6.21,
    cpa: 9.4,
  },
];

const ACTIVITY_PAYLOAD = {
  rows: [
    {
      id: "log_1",
      createdAt: "2026-04-05T09:12:00.000Z",
      operation: "apply",
      mutateActionType: "adjust_portfolio_target",
      status: "applied",
      accountId: "4931182201",
      receiptId: "gw_01K2F4",
      detail: null,
    },
  ],
  retentionDays: 30,
};

function installQueries(overrides: Record<string, unknown> = {}) {
  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
    const key = String(queryKey[0]);
    if (key === "google-account-scope") {
      return queryState({
        data: {
          accounts: [
            {
              id: "4931182201",
              name: "Primary Google",
              currency: "USD",
              timezone: "America/Los_Angeles",
            },
          ],
          assignedCount: 1,
        },
      });
    }
    if (key === "gads-status-base" || key === "gads-status") {
      return queryState({
        data: {
          state: "ready",
          connected: true,
          assignedAccountIds: ["4931182201"],
          primaryAccountTimezone: "America/Los_Angeles",
          currentDateInTimezone: "2026-04-07",
          freshness: {
            evidenceAvailable: true,
            scopes: [{ latestObservationAt: new Date().toISOString() }],
          },
        },
        state: { data: { state: "ready" } },
      });
    }
    if (key === "gads-asset-groups") return queryState({ data: { rows: ASSET_GROUP_ROWS } });
    if (key === "gads-assets") return queryState({ data: { rows: ASSET_ROWS } });
    if (key === "gads-audiences") return queryState({ data: { rows: AUDIENCE_ROWS } });
    if (key === "gads-activity") return queryState({ data: ACTIVITY_PAYLOAD });
    if (key === "business-commercial-targets") {
      return queryState({
        data: { snapshot: { targetPack: { targetRoas: 3.8, breakEvenRoas: 3 } } },
      });
    }
    const override = overrides[key];
    if (override) return queryState(override as Record<string, unknown>);
    return queryState();
  });
}

async function renderPanel(panel: "assets" | "assetGroupAudience" | "plan") {
  const { GoogleAdsIntelligenceDashboard } = await import(
    "@/components/google-ads/GoogleAdsIntelligenceDashboard"
  );
  return renderToStaticMarkup(
    React.createElement(GoogleAdsIntelligenceDashboard, {
      businessId: "biz",
      panel,
      screenTitle: panel === "plan" ? "Plan & activity" : "Assets & Audiences",
    }),
  );
}

beforeEach(() => {
  mockUseQuery.mockReset();
  mockUseMutation.mockReset();
  mockSetQueryData.mockReset();
  mockInvalidateQueries.mockReset();
  advisorState.canOpen = false;
  advisorState.payload = { recommendations: [], summary: { campaignRoles: [] } };
  mockUseMutation.mockImplementation(
    (options: { onSuccess?: (payload: unknown) => void } | undefined) => ({
      mutate: () => options?.onSuccess?.(advisorState.payload),
      mutateAsync: async () => {
        options?.onSuccess?.(advisorState.payload);
        return advisorState.payload;
      },
      isPending: false,
      isError: false,
    }),
  );
  installQueries();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Assets & Audiences route body feeds the canonical screen", () => {
  it("renders the exact screen, not the legacy panel", async () => {
    const markup = await renderPanel("assets");
    expect(markup).toContain('data-screen-label="Google Ads · Assets &amp; Audiences"');
    expect(markup).toContain('data-google-asset-tab="groups"');
    expect(markup).not.toContain("Asset Performance Radar");
    expect(markup).not.toContain("Asset read");
    expect(markup).not.toContain("Instantly highlights weak headline");
  });

  it("prints the served account, currency and window in the eyebrow", async () => {
    expect(await renderPanel("assets")).toContain(
      "Google Ads · 4931182201 · USD · 28d window",
    );
  });

  it("prints the served asset-group rows including Google's ad strength", async () => {
    const markup = await renderPanel("assets");
    expect(markup).toContain("Best sellers — US");
    expect(markup).toContain("PMax — Evergreen");
    expect(markup).toContain("$33,290");
    expect(markup).toContain("4.10");
    expect(markup).toContain("Excellent");
    expect(markup).toContain("Poor");
  });

  it("reads the text and image assets on both panels that mount the screen", async () => {
    for (const panel of ["assets", "assetGroupAudience"] as const) {
      mockUseQuery.mockClear();
      await renderPanel(panel);
      const call = mockUseQuery.mock.calls.find(
        (entry) => (entry[0] as { queryKey: unknown[] }).queryKey[0] === "gads-assets",
      );
      expect(call?.[0].enabled, panel).toBe(true);
    }
  });

  it("chips Google's served asset verdict, never the derived one", async () => {
    // ASSET_ROWS serves Google "Low" against a derived "top", so the Text
    // assets card under the "ratings are Google-served" caption must read Low.
    const { render, fireEvent } = await import("@testing-library/react");
    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    const { container } = render(
      React.createElement(GoogleAdsIntelligenceDashboard, {
        businessId: "biz",
        panel: "assets" as const,
        screenTitle: "Assets & Audiences",
      }),
    );
    fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-google-asset-tab="assets"]')!,
    );

    const row = container.querySelector('[data-google-text-asset="as_1"]');
    expect(row?.textContent).toContain("Carry less. Go further.");
    expect(row?.textContent).toContain("Low");
    expect(row?.textContent).not.toContain("Best");
  });

  it("scopes all three reads to the resolved account and window", async () => {
    await renderPanel("assets");
    for (const key of ["gads-asset-groups", "gads-assets", "gads-audiences"]) {
      const call = mockUseQuery.mock.calls.find(
        (entry) => (entry[0] as { queryKey: unknown[] }).queryKey[0] === key,
      );
      expect(call?.[0].queryKey, key).toEqual([
        key,
        "biz",
        "4931182201",
        "2026-03-11",
        "2026-04-07",
      ]);
      expect(call?.[0].enabled, key).toBe(true);
    }
  });
});

describe("the Plan route body feeds the canonical screen", () => {
  it("renders the exact screen and appends no budget workspace", async () => {
    const markup = await renderPanel("plan");
    expect(markup).toContain('data-screen-label="Google Ads · Plan"');
    expect(markup).toContain("Execution queue");
    expect(markup).toContain("Batch apply — guarded");
    expect(markup).not.toContain("Budget headroom");
    expect(markup).not.toContain("Spend Concentration");
  });

  it("renders the activity table from the execution log, receipt included", async () => {
    const markup = await renderPanel("plan");
    expect(markup).toContain("Applied");
    expect(markup).toContain("gw_01K2F4");
    expect(markup).not.toContain("Activity history is unavailable");
  });

  it("states the retention boundary the activity route served", async () => {
    expect(await renderPanel("plan")).toContain("are past retention and cannot be shown");
  });

  it("reads the activity endpoint for the business and account in scope", async () => {
    await renderPanel("plan");
    const call = mockUseQuery.mock.calls.find(
      (entry) => (entry[0] as { queryKey: unknown[] }).queryKey[0] === "gads-activity",
    );
    expect(call?.[0].queryKey[1]).toBe("biz");
    expect(call?.[0].enabled).toBe(true);
  });

  it("leaves the write controls disarmed on the legacy entry with no server scope", async () => {
    const markup = await renderPanel("plan");
    // No authorizedScope prop means no server-owned write authority.
    const applyAll = markup.match(
      /<button type="button" class="_primaryButton[^"]*"([^>]*)>/,
    );
    expect(applyAll?.[1]).toContain("disabled");
  });
});

describe("the guarded write boundary on Plan", () => {
  const authorizedScope = {
    businessId: "biz",
    businessName: "Route Business",
    providerAccountId: "4931182201",
    accountLabel: "Primary Google",
    currency: "USD",
    timezone: "America/Los_Angeles",
    viewerReadOnly: false,
    demo: false,
  };

  const applyStep = {
    id: "rec_1",
    title: "Raise Shopping tROAS to 2.6",
    rankScore: 90,
    blockers: [],
    recommendationFingerprint: "fp_1",
    recommendedAction: "Raise the target",
    whyNow: "Headroom above target",
    mutateActionType: "adjust_portfolio_target",
    mutatePayloadPreview: { value: 2.6 },
    rollbackActionType: "restore_portfolio_target",
    rollbackPayloadPreview: { value: 2.4 },
  };

  async function mountPlan(scope: typeof authorizedScope | undefined) {
    const { render } = await import("@testing-library/react");
    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );
    return render(
      React.createElement(GoogleAdsIntelligenceDashboard, {
        businessId: "biz",
        panel: "plan",
        screenTitle: "Plan & activity",
        authorizedScope: scope,
      }),
    );
  }

  function installAdvisor(step: Record<string, unknown>) {
    advisorState.canOpen = true;
    advisorState.payload = {
      recommendations: [step],
      summary: { campaignRoles: [] },
    };
  }

  it("sends apply_mutate with the advisor's own payload through the guarded endpoint", async () => {
    installAdvisor(applyStep);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = await mountPlan(authorizedScope);
    const apply = container.querySelector<HTMLButtonElement>(
      '[data-google-plan-apply="rec_1"]',
    );
    // The queue is served straight from the advisor read, so the control exists.
    expect(apply).not.toBeNull();
    expect(apply!.disabled).toBe(false);

    const { fireEvent, waitFor } = await import("@testing-library/react");
    fireEvent.click(apply!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/google-ads/advisor-memory");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      businessId: "biz",
      accountId: "4931182201",
      recommendationFingerprint: "fp_1",
      executionAction: "apply_mutate",
      mutateActionType: "adjust_portfolio_target",
      mutatePayloadPreview: { value: 2.6 },
    });
  });

  it("sends rollback_mutate once the server says the step is applied", async () => {
    installAdvisor({
      ...applyStep,
      executionStatus: "applied",
      transactionId: "gw_01K2F4",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = await mountPlan(authorizedScope);
    const { fireEvent, waitFor } = await import("@testing-library/react");
    fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-google-plan-apply="rec_1"]')!,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({
      executionAction: "rollback_mutate",
      rollbackActionType: "restore_portfolio_target",
      rollbackPayloadPreview: { value: 2.4 },
    });
  });

  it("never calls the write endpoint for a read-only viewer", async () => {
    installAdvisor(applyStep);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = await mountPlan({ ...authorizedScope, viewerReadOnly: true });
    const apply = container.querySelector<HTMLButtonElement>(
      '[data-google-plan-apply="rec_1"]',
    );
    expect(apply!.disabled).toBe(true);

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(apply!);

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("advisor-memory"),
      ),
    ).toHaveLength(0);
  });

  it("never calls the write endpoint for a step with no served mutate payload", async () => {
    installAdvisor({
      ...applyStep,
      mutateActionType: null,
      mutatePayloadPreview: null,
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = await mountPlan(authorizedScope);
    const apply = container.querySelector<HTMLButtonElement>(
      '[data-google-plan-apply="rec_1"]',
    );
    expect(apply!.disabled).toBe(true);

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(apply!);

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("advisor-memory"),
      ),
    ).toHaveLength(0);
  });
});
