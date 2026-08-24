import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mockUseQuery = vi.fn();
const mockGetTodayIsoForTimeZone = vi.fn();
const mockGetPresetDatesForReferenceDate = vi.fn();
const capturedPickerProps: Array<Record<string, unknown>> = [];

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: (input: { queryKey: unknown[] }) => mockUseQuery(input),
}));

vi.mock("@/components/date-range/DateRangePicker", () => ({
  DateRangePicker: (props: Record<string, unknown>) => {
    capturedPickerProps.push(props);
    return React.createElement("div", null, "date-range-picker");
  },
  getTodayIsoForTimeZone: (...args: [string]) => mockGetTodayIsoForTimeZone(...args),
  getPresetDatesForReferenceDate: (...args: [string, string, string | undefined, string | undefined]) =>
    mockGetPresetDatesForReferenceDate(...args),
}));

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));
vi.mock("@/components/states/error-state", () => ({
  ErrorState: () => React.createElement("div", null, "error-state"),
}));
vi.mock("@/components/overview/CostModelSheet", () => ({
  CostModelSheet: () => React.createElement("div", null, "cost-model-sheet"),
}));

// This suite mocks `DateRangePicker` wholesale, so the real hook module cannot
// load here. `useCanonicalDateWindowUrl` is therefore inert for these tests;
// its real behaviour — the shell stating the window on the URL before anything
// reads it — is pinned in `components/layout/v2/app-topbar.test.tsx` and
// `hooks/use-persistent-date-range.test.tsx`, not here. What this suite asserts
// is only that the topbar resolves the WORKSPACE clock.
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
  useCanonicalDateWindowUrl: () => {},
}));

vi.mock("@/lib/overview-metric-catalog", () => ({
  buildOverviewMetricCatalog: () => [],
  DEFAULT_PINNED_METRICS: ["revenue"],
}));
vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      language: "en",
      overviewPinsByContext: {},
      setOverviewPins: vi.fn(),
      pinOverviewMetric: vi.fn(),
      unpinOverviewMetric: vi.fn(),
      moveOverviewMetric: vi.fn(),
    }),
}));
vi.mock("@/lib/business-mode", () => ({
  isDemoBusinessSelected: () => false,
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      businesses: [
        {
          id: "biz",
          name: "Biz",
          timezone: "America/Los_Angeles",
          currency: "USD",
        },
      ],
      selectedBusinessId: "biz",
      workspaceOwnerId: "owner_1",
    }),
}));
vi.mock("@/store/integrations-support", () => ({
  buildDefaultProviderDomains: () => ({ ga4: {} }),
  deriveProviderViewState: () => ({ isConnected: false }),
}));
vi.mock("@/store/integrations-store", () => ({
  useIntegrationsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      domainsByBusinessId: {},
      ensureBusiness: vi.fn(),
    }),
}));
vi.mock("@/lib/sync/sync-status-pill", () => ({
  resolveProviderSyncStatusPill: () => null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/overview",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/layout/v2/use-shell-signals", () => ({
  useMetaActionNowCount: () => null,
  useWorkspaceSyncState: () => ({ tone: "fresh", label: "Synced 12m ago" }),
  // The one business the shell may name. It is also the gate on stating a date
  // window: no confirmed workspace means no confirmed clock.
  useConfirmedShellBusinessId: () => "biz_1",
}));
vi.mock("@/src/services", () => ({
  getOverviewSummary: vi.fn(),
  getOverviewSparklines: vi.fn(),
  getLatestAiInsight: vi.fn(),
  generateAiInsight: vi.fn(),
  upsertBusinessCostModel: vi.fn(),
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

function metric(id: string, title: string, unit = "count") {
  return {
    id,
    title,
    value: 1,
    previousValue: null,
    changePct: null,
    sparklineData: [],
    previousSparklineData: [],
    trendDirection: "neutral",
    trendSentiment: "neutral",
    dataSource: { key: "test", label: "Test" },
    status: "available",
    unit,
  };
}

describe("OverviewPage timezone date selection", () => {
  beforeEach(() => {
    capturedPickerProps.length = 0;
    mockUseQuery.mockReset();
    mockGetTodayIsoForTimeZone.mockReset();
    mockGetPresetDatesForReferenceDate.mockReset();
    mockGetTodayIsoForTimeZone.mockReturnValue("2026-04-07");
    mockGetPresetDatesForReferenceDate.mockReturnValue({
      start: "2026-04-07",
      end: "2026-04-07",
    });
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      const key = String(queryKey[0]);
      if (key === "overview-summary") {
        return baseQueryState({
          data: {
            comparison: { startDate: null, endDate: null },
            pins: [],
            storeMetrics: [],
            ltv: [],
            expenses: [],
            customMetrics: [],
            webAnalytics: [],
            platforms: [],
            attribution: [],
            costModel: { configured: false, values: null },
            shopifyServing: null,
          },
        });
      }
      return baseQueryState();
    });
  });

  it("uses workspace timezone for overview preset resolution and picker props", async () => {
    const { default: OverviewPage } = await import("@/app/(dashboard)/overview/legacy-page");

    const html = renderToStaticMarkup(React.createElement(OverviewPage));

    expect(mockGetTodayIsoForTimeZone).toHaveBeenCalledWith("America/Los_Angeles");
    expect(mockGetPresetDatesForReferenceDate).toHaveBeenCalledWith("today", "2026-04-07", "", "");

    const overviewSummaryCall = mockUseQuery.mock.calls.find((call) => {
      const input = call[0] as { queryKey: unknown[] } | undefined;
      return input?.queryKey?.[0] === "overview-summary";
    });
    expect(overviewSummaryCall?.[0].queryKey).toEqual(["overview-summary", "biz", "2026-04-07", "2026-04-07", "none"]);

    // Dashboard v2 moves the range control into the shell topbar, so the page
    // itself must not render a second picker.
    expect(capturedPickerProps).toHaveLength(0);
    expect(html).toContain('data-screen-label="Overview"');
    expect(html).toContain("Edit cost model");
    expect(html).toContain("Share snapshot");
    expect(html).not.toContain("Set cost model");
    expect(html).not.toContain("cost-model-sheet");
    expect(html).not.toContain("Headline metrics");
    expect(html).toContain('class="flex flex-wrap items-end justify-between gap-4"');
    expect(html).not.toContain("adv-page-head");

    // The reference fixes every Overview surface and order. Missing data keeps
    // those surfaces in place with em dashes instead of deleting cards.
    for (const label of [
      "Revenue",
      "Ad Spend",
      "Blended ROAS · target —",
      "Orders",
      "Conv Rate · GA4",
      "Attribution by channel",
      "Meta Ads",
      "Google Ads",
      "Klaviyo",
      "Organic · GA4",
      "Store &amp; customer value",
      "New customers",
      "Repeat rate",
      "LTV : CAC",
      "Web analytics · GA4",
      "Engagement",
      "Avg session",
      "Conv rate",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("keeps the shell topbar picker resolving against the workspace timezone", async () => {
    const { AppTopbar } = await import("@/components/layout/v2/app-topbar");

    renderToStaticMarkup(
      React.createElement(AppTopbar, {
        userName: "Reviewer",
        onOpenNav: () => {},
      })
    );

    expect(mockGetTodayIsoForTimeZone).toHaveBeenCalledWith("America/Los_Angeles");
    expect(capturedPickerProps).toHaveLength(1);
    expect(capturedPickerProps[0]?.referenceDate).toBe("2026-04-07");
    expect(capturedPickerProps[0]?.timeZoneLabel).toBe("America/Los_Angeles");
    expect(capturedPickerProps[0]?.variant).toBe("v2");
  });

  it("enforces the fixed reference sections and rejects injected extra rows", async () => {
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (queryKey[0] !== "overview-summary") return baseQueryState();
      return baseQueryState({
        data: {
          comparison: { startDate: null, endDate: null },
          pins: [
            metric("pins-orders", "Wrong order", "count"),
            metric("pins-mer", "MER injected", "ratio"),
            metric("pins-revenue", "Wrong title", "currency"),
            metric("pins-conversion-rate", "Wrong conversion", "percent"),
            metric("pins-spend", "Wrong spend", "currency"),
            metric("pins-blended-roas", "Blended ROAS · target 4.20", "ratio"),
          ],
          storeMetrics: [
            metric("store-new-customers", "New customers"),
            metric("store-gross-sales", "Gross Sales injected", "currency"),
            metric("store-aov", "AOV", "currency"),
          ],
          ltv: [
            metric("ltv-cac", "LTV : CAC", "ratio"),
            metric("ltv-average", "Average LTV injected", "currency"),
            metric("ltv-repeat-rate", "Repeat rate", "percent"),
          ],
          expenses: [],
          customMetrics: [],
          webAnalytics: [
            metric("web-conversion-rate", "Conv rate", "percent"),
            metric("web-extra", "Web extra injected"),
            metric("web-session-duration", "Avg session", "duration_seconds"),
            metric("web-sessions", "Sessions"),
            metric("web-engagement-rate", "Engagement", "percent"),
          ],
          platforms: [
            {
              id: "tiktok",
              provider: "tiktok",
              title: "TikTok injected",
              metrics: [],
            },
            { id: "google", provider: "google", title: "Google", metrics: [] },
            { id: "meta", provider: "meta", title: "Meta", metrics: [] },
          ],
          attribution: [
            {
              channel: "TikTok injected",
              spend: 999,
              spendShare: 99,
              revenue: 999,
              roas: 1,
              conversions: 1,
              clicks: null,
              ctr: null,
              cpa: 1,
              aov: 1,
              source: "test",
            },
            ...["Organic · GA4", "Google Ads", "Klaviyo", "Meta Ads"].map((channel) => ({
              channel,
              spend: null,
              spendShare: null,
              revenue: null,
              roas: null,
              conversions: null,
              clicks: null,
              ctr: null,
              cpa: null,
              aov: null,
              source: "test",
            })),
          ],
          costModel: { configured: false, values: null },
          shopifyServing: null,
        },
      });
    });

    const { default: OverviewPage } = await import("@/app/(dashboard)/overview/legacy-page");
    const html = renderToStaticMarkup(React.createElement(OverviewPage));

    expect(Array.from(html.matchAll(/data-overview-section="([^"]+)"/g), (match) => match[1])).toEqual([
      "headline",
      "attribution-and-brief",
      "platforms",
      "store-and-web",
    ]);
    expect(Array.from(html.matchAll(/data-overview-metric-id="([^"]+)"/g), (match) => match[1])).toEqual([
      "pins-revenue",
      "pins-spend",
      "pins-blended-roas",
      "pins-orders",
      "pins-conversion-rate",
      "store-aov",
      "store-new-customers",
      "ltv-repeat-rate",
      "ltv-cac",
      "web-sessions",
      "web-engagement-rate",
      "web-session-duration",
      "web-conversion-rate",
    ]);
    expect(Array.from(html.matchAll(/data-overview-provider="([^"]+)"/g), (match) => match[1])).toEqual([
      "meta",
      "google",
    ]);
    expect(Array.from(html.matchAll(/data-overview-channel="([^"]+)"/g), (match) => match[1])).toEqual([
      "Meta Ads",
      "Google Ads",
      "Klaviyo",
      "Organic · GA4",
    ]);
    expect(Array.from(html.matchAll(/data-overview-brief-kind="([^"]+)"/g), (match) => match[1])).toEqual([
      "Opportunity",
      "Risk",
      "Action",
    ]);
    for (const extra of [
      "MER injected",
      "Gross Sales injected",
      "Average LTV injected",
      "Web extra injected",
      "TikTok injected",
    ]) {
      expect(html).not.toContain(extra);
    }
  });
});
