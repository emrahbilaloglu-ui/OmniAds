// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup } from "@testing-library/react";

/**
 * The route body, not a hand-written view model.
 *
 * These assertions mount the real controller for `panel="search"` and
 * `panel="products"` with the payloads the real endpoints serve, and prove the
 * served numbers reach the canonical screen — including the target ROAS the
 * commercial-truth read supplies and the keyword tallies the keywords route
 * now returns.
 */

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockSetQueryData = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/platforms/google/search",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: (input: { queryKey: unknown[] }) => mockUseQuery(input),
  useMutation: (input: unknown) => mockUseMutation(input),
  useQueryClient: () => ({ setQueryData: mockSetQueryData }),
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
  canOpenGoogleAdsAdvisor: () => false,
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

const SEARCH_TERM_ROWS = [
  {
    key: "t1",
    searchTerm: "canvas tote with zip",
    campaign: "Search — Non-brand",
    spend: 540,
    revenue: 3120,
    conversions: 38,
    clicks: 412,
    roas: 5.78,
    ctr: 6.1,
    intent: "transactional",
    keywordOpportunityFlag: true,
  },
  {
    key: "t2",
    searchTerm: "refund policy",
    campaign: "Search — Non-brand",
    spend: 212,
    revenue: 0,
    conversions: 0,
    clicks: 164,
    roas: 0,
    ctr: 2.1,
    intent: "informational",
    wasteFlag: true,
  },
];

const KEYWORD_PAYLOAD = {
  rows: [
    {
      criterionId: "k1",
      keywordText: "canvas tote bag",
      matchType: "Exact",
      campaignName: "Search — Non-brand",
      spend: 2410,
      conversions: 186,
      cpa: 12.96,
      roas: 4.62,
      ctr: 5.8,
      impressionShare: 0.52,
      qualityScore: 8,
      expectedCtr: "above avg CTR",
      adRelevance: "high relevance",
      landingPageExperience: "good LP",
    },
  ],
  summary: {
    highCtrLowConvCount: 4,
    highConvLowBudgetCount: 3,
    deserveOwnAdGroupCount: 2,
  },
};

const PRODUCT_ROWS = [
  {
    itemId: "AT-104",
    title: "Aurora Tote — Sand",
    impressions: 51_000,
    clicks: 4210,
    spend: 3180,
    revenue: 14_890,
    roas: 4.68,
    conversions: 96,
  },
  {
    itemId: "CW-310",
    title: "Canvas Weekender",
    impressions: 22_000,
    clicks: 2880,
    spend: 2410,
    revenue: 5590,
    roas: 2.32,
    conversions: 20,
  },
];

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
    if (key === "gads-search-intelligence") {
      return queryState({ data: { rows: SEARCH_TERM_ROWS } });
    }
    if (key === "gads-keywords") {
      return queryState({ data: KEYWORD_PAYLOAD });
    }
    if (key === "gads-products") {
      return queryState({ data: { rows: PRODUCT_ROWS } });
    }
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

async function renderPanel(panel: "search" | "products") {
  const { GoogleAdsIntelligenceDashboard } = await import(
    "@/components/google-ads/GoogleAdsIntelligenceDashboard"
  );
  return renderToStaticMarkup(
    React.createElement(GoogleAdsIntelligenceDashboard, {
      businessId: "biz",
      panel,
      screenTitle: panel === "search" ? "Search intelligence" : "Products & feed",
    }),
  );
}

beforeEach(() => {
  mockUseQuery.mockReset();
  mockUseMutation.mockReset();
  mockSetQueryData.mockReset();
  mockUseMutation.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  });
  installQueries();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Search route body feeds the canonical screen with served data", () => {
  it("renders the exact screen, not the legacy panel", async () => {
    const markup = await renderPanel("search");
    expect(markup).toContain('data-screen-label="Google Ads · Search"');
    expect(markup).toContain('data-google-search-tab="terms"');
    expect(markup).not.toContain("Escape hatch");
    expect(markup).not.toContain("When and where ads showed");
  });

  it("prints the served account, currency and window in the eyebrow", async () => {
    const markup = await renderPanel("search");
    expect(markup).toContain("Google Ads · 4931182201 · USD · 28d window");
  });

  it("prints served search-term rows and the wasted-spend stat", async () => {
    const markup = await renderPanel("search");
    expect(markup).toContain("canvas tote with zip");
    expect(markup).toContain("refund policy");
    expect(markup).toContain("$212");
    expect(markup).toContain("Transactional");
  });

  it("reads the keywords endpoint for the account and window in scope", async () => {
    await renderPanel("search");
    const call = mockUseQuery.mock.calls.find(
      (entry) => (entry[0] as { queryKey: unknown[] }).queryKey[0] === "gads-keywords",
    );
    expect(call?.[0].queryKey).toEqual([
      "gads-keywords",
      "biz",
      "4931182201",
      "2026-03-11",
      "2026-04-07",
    ]);
    expect(call?.[0].enabled).toBe(true);
  });

  it("reads the commercial target pack so the ROAS chip has a bar to clear", async () => {
    await renderPanel("search");
    const call = mockUseQuery.mock.calls.find(
      (entry) =>
        (entry[0] as { queryKey: unknown[] }).queryKey[0] ===
        "business-commercial-targets",
    );
    expect(call?.[0].queryKey).toEqual(["business-commercial-targets", "biz"]);
  });

  it("no longer reads geo or device reports for this screen", async () => {
    await renderPanel("search");
    const keys = mockUseQuery.mock.calls.map(
      (entry) => (entry[0] as { queryKey: unknown[] }).queryKey[0],
    );
    expect(keys).not.toContain("gads-geo");
    expect(keys).not.toContain("gads-devices");
  });
});

describe("the Products route body feeds the canonical screen with served data", () => {
  it("renders the exact screen with the served rows", async () => {
    const markup = await renderPanel("products");
    expect(markup).toContain('data-screen-label="Google Ads · Products"');
    expect(markup).toContain("Aurora Tote — Sand");
    expect(markup).toContain("AT-104");
    expect(markup).toContain("$14,890");
    expect(markup).toContain("Serving");
  });

  it("keeps the four canonical feed tiles and dashes the unread ones", async () => {
    const markup = await renderPanel("products");
    expect(markup).toContain("Products serving");
    expect(markup).toContain("Limited");
    expect(markup).toContain("Disapproved");
    expect(markup).toContain("Feed synced");
    expect(markup).not.toContain("Draining spend");
  });

  it("keeps the allocation read mounted and embeds no advisor panel", async () => {
    const markup = await renderPanel("products");
    expect(markup).toContain("Allocation read");
    expect(markup).toContain(
      "Cluster reads are directional — restructures apply from Advisor → Plan as guarded writes.",
    );
    expect(markup).not.toContain("advisor-panel");
  });
});
