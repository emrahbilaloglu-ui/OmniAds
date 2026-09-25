import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SparklineBundle } from "@/src/services/data-service-overview";

const mockUseQuery = vi.fn();
const mockGetTodayIsoForTimeZone = vi.fn();
const mockGetPresetDatesForReferenceDate = vi.fn();
const capturedPickerProps: Array<Record<string, unknown>> = [];
const mockPreferencesState = {
  language: "en",
  overviewPinsByContext: {} as Record<string, string[]>,
  setOverviewPins: vi.fn(),
  clearOverviewPins: vi.fn(),
  pinOverviewMetric: vi.fn(),
  unpinOverviewMetric: vi.fn(),
  replaceOverviewMetric: vi.fn(),
  moveOverviewMetric: vi.fn(),
};

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

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockPreferencesState),
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
    mockPreferencesState.overviewPinsByContext = {};
    mockPreferencesState.setOverviewPins.mockReset();
    mockPreferencesState.pinOverviewMetric.mockReset();
    mockPreferencesState.unpinOverviewMetric.mockReset();
    mockPreferencesState.replaceOverviewMetric.mockReset();
    mockPreferencesState.moveOverviewMetric.mockReset();
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
            pins: [
              metric("pins-revenue", "Revenue", "currency"),
              metric("pins-spend", "Ad Spend", "currency"),
              metric("pins-blended-roas", "Blended ROAS · target —", "ratio"),
              metric("pins-orders", "Orders", "count"),
              metric("pins-conversion-rate", "Conversion Rate", "percent"),
            ],
            storeMetrics: [metric("store-aov", "AOV", "currency")],
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
    // One entry point for KPI and section customization; no second per-band or legacy toggle.
    expect(html.match(/>Customize<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain("Arrange layout");
    expect(html).not.toContain("Edit KPIs");
    expect(html).not.toContain("Save changes");
    expect(html).not.toContain(">Add metric<");
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
      "Conversion Rate",
      "Attribution by channel",
      "Meta Ads",
      "Google Ads",
      "Klaviyo",
      "Organic · GA4",
      "Store &amp; customer value",
      "Gross Sales",
      "Refunded Revenue",
      "Refund Rate",
      "Web analytics · GA4",
      "Engagement",
      "Avg session",
      "Conv rate",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("renders every persisted KPI in the saved order and makes the first one primary", async () => {
    mockPreferencesState.overviewPinsByContext = {
      "owner_1:biz": [
        "aov",
        "orders",
        "revenue",
        "spend",
        "blended_roas",
        "conversion_rate",
      ],
    };
    const { default: OverviewPage } = await import("@/app/(dashboard)/overview/legacy-page");

    const html = renderToStaticMarkup(React.createElement(OverviewPage));
    const headlineStart = html.indexOf('data-overview-section="headline"');
    const headlineEnd = html.indexOf('data-overview-section="mobile-triage"');
    const headlineHtml = html.slice(headlineStart, headlineEnd);

    expect(
      Array.from(
        headlineHtml.matchAll(/data-overview-metric-id="([^"]+)"/g),
        (match) => match[1],
      ),
    ).toEqual([
      "store-aov",
      "pins-orders",
      "pins-revenue",
      "pins-spend",
      "pins-blended-roas",
      "pins-conversion-rate",
    ]);
    expect(headlineHtml).toMatch(
      /data-overview-kpi-slot="primary"[\s\S]*?data-overview-metric-id="store-aov"/,
    );
  });

  it("keeps default KPI slots visible when their sources are unavailable", async () => {
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (String(queryKey[0]) !== "overview-summary") return baseQueryState();
      const unavailable = (id: string, title: string, unit: string) => ({
        ...metric(id, title, unit),
        value: null,
        status: "unavailable",
        helperText: "No verified data for this window",
        dataSource: { key: "unavailable", label: "Unavailable" },
      });
      return baseQueryState({
        data: {
          comparison: { startDate: null, endDate: null },
          pins: [
            unavailable("pins-revenue", "Revenue", "currency"),
            unavailable("pins-spend", "Ad Spend", "currency"),
            unavailable("pins-blended-roas", "Blended ROAS · target —", "ratio"),
            unavailable("pins-orders", "Orders", "count"),
            unavailable("pins-conversion-rate", "Conversion Rate", "percent"),
          ],
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
    });
    const { default: OverviewPage } = await import("@/app/(dashboard)/overview/legacy-page");

    const html = renderToStaticMarkup(React.createElement(OverviewPage));
    const headline = html.slice(
      html.indexOf('data-overview-section="headline"'),
      html.indexOf('data-overview-section="mobile-triage"'),
    );

    expect(Array.from(headline.matchAll(/data-overview-metric-id="([^"]+)"/g), (match) => match[1])).toEqual([
      "pins-revenue",
      "pins-spend",
      "pins-blended-roas",
      "pins-orders",
      "pins-conversion-rate",
    ]);
    expect(headline).toContain("No verified data for this window");
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

  it("keeps the safe default section order and rejects injected extra rows", async () => {
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

    /*
     * The server-rendered default order. Browser-local layout preferences apply
     * only after hydration. Source readiness is intentionally outside that
     * persisted layout and rendered last as a collapsed footnote. `economics`
     * is absent here because the fixture serves no target pack — an unread pack
     * is not "break-even 0", so the panel is simply not drawn rather than
     * stating a boundary nobody served.
     */
    expect(Array.from(html.matchAll(/data-overview-section="([^"]+)"/g), (match) => match[1])).toEqual([
      "headline",
      "mobile-triage",
      "trend",
      "meta-morning",
      "ai-brief",
      "attribution",
      "meta-platform",
      "google-platform",
      "store-value",
      "web-analytics",
      "source-readiness",
    ]);
    expect(html).toContain(
      'data-layout-id="meta-platform" data-layout-size="full" data-layout-effective-span="12"',
    );
    expect(html).toContain(
      'data-layout-id="google-platform" data-layout-size="full" data-layout-effective-span="12"',
    );
    expect(html).toMatch(
      /<details[^>]*data-overview-section="source-readiness"[^>]*><summary[^>]*>/,
    );
    expect(html).not.toMatch(
      /<details[^>]*data-overview-section="source-readiness"[^>]*\sopen(?:=|\s|>)/,
    );
    /*
     * The design-contract markers H03, H04 and B01 name, on the body a route
     * actually mounts.
     *
     * They are asserted here rather than only in the frame harness because the
     * harness renders a body no route mounts: a green anatomy gate over that
     * body says the leaf compiles, not that the product carries the anatomy.
     */
    expect(html).toContain('data-el="home-kpis"');
    expect(html).toContain('data-el="source-readiness"');
    expect(html).toContain('data-collection="sources"');
    expect(html).toContain('data-trend-chart=""');
    expect(html).not.toContain('data-ctl="live:chart-table-toggle"');
    expect(html).toContain('data-ctl="live:MOBILE-01"');
    /*
     * `live:INTEGRATION-03 connect` is deliberately NOT asserted here.
     *
     * This fixture never answers the integrations read, so every source is
     * "the read did not complete" — and offering "Connect this source" on that
     * would be advice given without knowing whether it is already connected.
     * The row states the unread posture instead, which is the honest one, and
     * the connect control is proven where a source is genuinely disconnected:
     * `components/zero-base/interactions/interactions-core.test.tsx` and the
     * H04 frame.
     */
    expect(html).toContain('data-source-state="unavailable"');
    expect(html).toContain("did not complete");
    expect(html).not.toContain('data-ctl="live:INTEGRATION-03 connect"');

    expect(Array.from(html.matchAll(/data-overview-metric-id="([^"]+)"/g), (match) => match[1])).toEqual([
      "pins-revenue",
      "pins-spend",
      "pins-blended-roas",
      "pins-orders",
      "pins-conversion-rate",
      "store-aov",
      "store-gross-sales",
      "store-refunded-revenue",
      "store-refund-rate",
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
    expect(Array.from(html.matchAll(/data-overview-brief-kind="([^"]+)"/g), (match) => match[1])).toEqual([]);
    expect(html).toContain("No daily brief is available yet. Generate one");
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

  it("never relabels ad-platform revenue as Shopify commerce in charts", async () => {
    const { buildSparklineMap, sourceSafeOverviewTrendPoints } = await import(
      "@/app/(dashboard)/overview/legacy-page"
    );
    const providerSources = {
      current: { meta: "warehouse_published_account_daily", google: null },
      previous: null,
    } as const;
    const summary = {
      shopifyConnectionState: "connected",
      providerSources,
      pins: [
        {
          id: "pins-revenue",
          dataSource: { key: "shopify_warehouse", label: "Shopify Warehouse" },
        },
      ],
      storeMetrics: [],
      costModel: { values: null },
    } as never;
    const bundle: SparklineBundle = {
      combined: [{ date: "2026-03-01", spend: 10, revenue: 999, purchases: 9 }],
      providerTrends: {
        meta: [{ date: "2026-03-01", spend: 10, revenue: 20, purchases: 1 }],
      },
      providerTrendSources: { meta: "warehouse_published_account_daily", google: null },
      shopifyDaily: [],
      shopifyCommerceAvailable: false,
      shopifyConnectionState: "connected",
      ga4Daily: [],
    };

    expect(buildSparklineMap(bundle, null, summary)["pins-revenue"]).toEqual([]);
    expect(sourceSafeOverviewTrendPoints(bundle, summary)).toEqual([
      { date: "2026-03-01", spend: 10, roas: 2 },
    ]);

    const ga4Summary = {
      shopifyConnectionState: "disconnected",
      providerSources,
      pins: [
        {
          id: "pins-revenue",
          dataSource: { key: "ga4_fallback", label: "GA4" },
        },
      ],
      storeMetrics: [],
      costModel: { values: null },
    } as never;
    const ga4Bundle: SparklineBundle = {
      ...bundle,
      shopifyConnectionState: "disconnected",
      ga4Daily: [
        {
          date: "2026-03-01",
          sessions: 100,
          purchases: 2,
          revenue: 30,
          engagementRate: 0.5,
          avgSessionDuration: 60,
          totalPurchasers: 2,
          firstTimePurchasers: 1,
        },
      ],
    };
    expect(buildSparklineMap(ga4Bundle, null, ga4Summary)["pins-revenue"]).toEqual([
      { date: "2026-03-01", value: 30 },
    ]);
    expect(sourceSafeOverviewTrendPoints(ga4Bundle, ga4Summary)).toEqual([
      { date: "2026-03-01", spend: 10, roas: 2 },
    ]);
  });

  it.each(["connected", "unknown"] as const)(
    "masks GA4 commerce when the sparkline read reports Shopify %s while preserving web analytics",
    async (sparklineState) => {
      const {
        buildSparklineMap,
        reconcileOverviewCommerceSource,
        sourceSafeOverviewTrendPoints,
      } = await import("@/app/(dashboard)/overview/legacy-page");
      const revenue = {
        ...metric("pins-revenue", "Revenue", "currency"),
        value: 30,
        dataSource: { key: "ga4_fallback", label: "GA4" },
      };
      const spend = {
        ...metric("pins-spend", "Ad Spend", "currency"),
        value: 10,
        dataSource: { key: "ad_platforms", label: "Ad platforms" },
      };
      const blendedRoas = {
        ...metric("pins-blended-roas", "Blended ROAS", "ratio"),
        value: 2.5,
        dataSource: { key: "ad_platforms", label: "Meta Ads + Google Ads" },
      };
      const web = {
        ...metric("web-sessions", "Sessions"),
        value: 100,
        dataSource: { key: "ga4", label: "GA4" },
      };
      const webConversion = {
        ...metric("web-conversion-rate", "Conv rate", "percent"),
        value: 2,
        dataSource: { key: "ga4", label: "GA4" },
      };
      const metaMetric = {
        ...metric("meta-spend", "Spend", "currency"),
        value: 7,
        dataSource: { key: "meta", label: "Meta" },
      };
      const summary = {
        shopifyConnectionState: "disconnected",
        pins: [revenue, spend, blendedRoas],
        storeMetrics: [],
        ltv: [],
        expenses: [],
        customMetrics: [],
        webAnalytics: [web, webConversion],
        platforms: [{ id: "meta", title: "Meta Ads", provider: "meta", metrics: [metaMetric] }],
        costModel: { values: null },
      } as never;
      const bundle: SparklineBundle = {
        combined: [{ date: "2026-03-01", spend: 10, revenue: 0, purchases: 0 }],
        providerTrends: {},
        shopifyDaily: [],
        shopifyCommerceAvailable: false,
        shopifyConnectionState: sparklineState,
        ga4Daily: [
          {
            date: "2026-03-01",
            sessions: 100,
            purchases: 2,
            revenue: 30,
            engagementRate: 0.5,
            avgSessionDuration: 60,
            totalPurchasers: 2,
            firstTimePurchasers: 1,
          },
        ],
      };

      const reconciled = reconcileOverviewCommerceSource(summary, bundle);
      expect(reconciled.pins.find((card) => card.id === "pins-revenue")).toEqual(
        expect.objectContaining({ value: null, status: "unavailable" }),
      );
      expect(reconciled.pins.find((card) => card.id === "pins-spend")?.value).toBe(10);
      expect(reconciled.pins.find((card) => card.id === "pins-blended-roas")?.value).toBe(2.5);
      expect(reconciled.webAnalytics[0]?.value).toBe(100);
      expect(reconciled.webAnalytics[1]?.value).toBe(2);
      expect(reconciled.platforms[0]?.metrics[0]?.value).toBe(7);
      expect(buildSparklineMap(bundle, null, summary)["pins-revenue"]).toEqual([]);
      expect(buildSparklineMap(bundle, null, summary)["web-sessions"]).toEqual([
        { date: "2026-03-01", value: 100 },
      ]);
      expect(buildSparklineMap(bundle, null, summary)["web-conversion-rate"]).toEqual([
        { date: "2026-03-01", value: 2 },
      ]);
      expect(sourceSafeOverviewTrendPoints(bundle, summary)).toEqual([]);
    },
  );

  it("keeps MER on store revenue and builds Blended ROAS from provider-attributed values", async () => {
    const { buildSparklineMap } = await import("@/app/(dashboard)/overview/legacy-page");
    const summary = {
      shopifyConnectionState: "connected",
      providerSources: {
        current: {
          meta: "warehouse_published_account_daily",
          google: "warehouse_account_aggregate",
        },
        previous: null,
      },
      pins: [
        {
          ...metric("pins-revenue", "Revenue", "currency"),
          dataSource: { key: "shopify_warehouse", label: "Shopify Warehouse" },
        },
        { ...metric("pins-mer", "MER", "ratio"), value: 3 },
      ],
      storeMetrics: [],
      ltv: [],
      expenses: [],
      customMetrics: [],
      webAnalytics: [],
      platforms: [],
      costModel: { values: null },
    } as never;
    const bundle: SparklineBundle = {
      combined: [{ date: "2026-03-01", spend: 30, revenue: 999, purchases: 4 }],
      providerTrends: {
        meta: [{ date: "2026-03-01", spend: 10, revenue: 30, purchases: 2 }],
        google: [{ date: "2026-03-01", spend: 20, revenue: 20, purchases: 2 }],
      },
      providerTrendSources: {
        meta: "warehouse_published_account_daily",
        google: "warehouse_account_daily",
      },
      shopifyDaily: [
        {
          date: "2026-03-01",
          revenue: 90,
          purchases: 4,
          conversionRate: null,
          newCustomers: null,
          returningCustomers: null,
        },
      ],
      shopifyCommerceAvailable: true,
      shopifyConnectionState: "connected",
      ga4Daily: [],
    };

    const map = buildSparklineMap(bundle, null, summary);
    expect(map["pins-mer"]).toEqual([{ date: "2026-03-01", value: 3 }]);
    expect(map["pins-blended-roas"]).toEqual([{ date: "2026-03-01", value: 1.6667 }]);
  });

  it("fails closed when a MER spend trend does not match every active scalar source", async () => {
    const { buildSparklineMap, sourceSafeOverviewTrendPoints } = await import(
      "@/app/(dashboard)/overview/legacy-page"
    );
    const summary = {
      shopifyConnectionState: "connected",
      providerSources: {
        current: {
          meta: "warehouse_published_account_daily",
          google: "warehouse_account_aggregate",
        },
        previous: null,
      },
      pins: [
        {
          ...metric("pins-revenue", "Revenue", "currency"),
          dataSource: { key: "shopify_warehouse", label: "Shopify Warehouse" },
        },
        { ...metric("pins-mer", "MER", "ratio"), value: 3 },
      ],
      storeMetrics: [],
      ltv: [],
      expenses: [],
      customMetrics: [],
      webAnalytics: [],
      platforms: [],
      costModel: { values: null },
    } as never;
    const bundle: SparklineBundle = {
      combined: [{ date: "2026-03-01", spend: 30, revenue: 90, purchases: 4 }],
      providerTrends: {
        meta: [{ date: "2026-03-01", spend: 10, revenue: 30, purchases: 2 }],
        google: [{ date: "2026-03-01", spend: 20, revenue: 20, purchases: 2 }],
      },
      providerTrendSources: { meta: null, google: "warehouse_account_daily" },
      shopifyDaily: [
        {
          date: "2026-03-01",
          revenue: 90,
          purchases: 4,
          conversionRate: null,
          newCustomers: null,
          returningCustomers: null,
        },
      ],
      shopifyCommerceAvailable: true,
      shopifyConnectionState: "connected",
      ga4Daily: [],
    };

    expect(buildSparklineMap(bundle, null, summary)["pins-mer"]).toEqual([]);
    expect(sourceSafeOverviewTrendPoints(bundle, summary)).toEqual([]);
  });

  it("omits dates missing an active paid provider from spend, MER, and the main chart", async () => {
    const { buildSparklineMap, sourceSafeOverviewTrendPoints } = await import(
      "@/app/(dashboard)/overview/legacy-page"
    );
    const summary = {
      shopifyConnectionState: "connected",
      providerSources: {
        current: {
          meta: "warehouse_published_account_daily",
          google: "warehouse_account_aggregate",
        },
        previous: null,
      },
      pins: [
        {
          ...metric("pins-revenue", "Revenue", "currency"),
          dataSource: { key: "shopify_warehouse", label: "Shopify Warehouse" },
        },
        { ...metric("pins-mer", "MER", "ratio"), value: 3 },
      ],
      storeMetrics: [],
      ltv: [],
      expenses: [{ ...metric("expenses-ad-spend", "Ad Spend", "currency"), value: 30 }],
      customMetrics: [],
      webAnalytics: [],
      platforms: [],
      costModel: { values: null },
    } as never;
    const bundle: SparklineBundle = {
      combined: [
        { date: "2026-03-01", spend: 30, revenue: 90, purchases: 4 },
        // The aggregate builder records the missing Google date as partial spend.
        { date: "2026-03-02", spend: 12, revenue: 60, purchases: 2 },
      ],
      providerTrends: {
        meta: [
          { date: "2026-03-01", spend: 10, revenue: 30, purchases: 2 },
          { date: "2026-03-02", spend: 12, revenue: 24, purchases: 1 },
        ],
        google: [{ date: "2026-03-01", spend: 20, revenue: 20, purchases: 2 }],
      },
      providerTrendSources: {
        meta: "warehouse_published_account_daily",
        google: "warehouse_account_daily",
      },
      shopifyDaily: [
        {
          date: "2026-03-01",
          revenue: 90,
          purchases: 4,
          conversionRate: null,
          newCustomers: null,
          returningCustomers: null,
        },
        {
          date: "2026-03-02",
          revenue: 60,
          purchases: 2,
          conversionRate: null,
          newCustomers: null,
          returningCustomers: null,
        },
      ],
      shopifyCommerceAvailable: true,
      shopifyConnectionState: "connected",
      ga4Daily: [],
    };

    const map = buildSparklineMap(bundle, null, summary);
    expect(map["pins-spend"]).toEqual([{ date: "2026-03-01", value: 30 }]);
    expect(map["expenses-ad-spend"]).toEqual([{ date: "2026-03-01", value: 30 }]);
    expect(map["pins-mer"]).toEqual([{ date: "2026-03-01", value: 3 }]);
    expect(sourceSafeOverviewTrendPoints(bundle, summary)).toEqual([
      { date: "2026-03-01", spend: 30, roas: 1.6667 },
    ]);
  });

  it("keeps the main chart spend and title on the same single-provider scope as ROAS", async () => {
    const { overviewTrendTitle, sourceSafeOverviewTrendPoints } = await import(
      "@/app/(dashboard)/overview/legacy-page"
    );
    const summary = {
      providerSources: {
        current: { meta: null, google: "warehouse_account_aggregate" },
        previous: null,
      },
      paidProviderScope: {
        current: { providers: ["google"], complete: true },
        previous: null,
      },
    } as never;
    const bundle: SparklineBundle = {
      combined: [{ date: "2026-03-01", spend: 30, revenue: 90, purchases: 4 }],
      providerTrends: {
        meta: [{ date: "2026-03-01", spend: 10, revenue: 30, purchases: 2 }],
        google: [{ date: "2026-03-01", spend: 20, revenue: 20, purchases: 2 }],
      },
      providerTrendSources: {
        meta: "warehouse_published_account_daily",
        google: "warehouse_account_daily",
      },
      shopifyDaily: [],
      shopifyCommerceAvailable: false,
      shopifyConnectionState: "connected",
      ga4Daily: [],
    };

    expect(sourceSafeOverviewTrendPoints(bundle, summary)).toEqual([
      { date: "2026-03-01", spend: 20, roas: 1 },
    ]);
    expect(overviewTrendTitle(summary)).toBe("Google Ads Spend & ROAS");
  });

  it("suppresses every aggregate paid series when the scalar provider scope is incomplete", async () => {
    const { buildSparklineMap, overviewTrendTitle, sourceSafeOverviewTrendPoints } = await import(
      "@/app/(dashboard)/overview/legacy-page"
    );
    const summary = {
      providerSources: {
        current: { meta: null, google: "warehouse_account_aggregate" },
        previous: null,
      },
      paidProviderScope: {
        current: { providers: ["google"], complete: false },
        previous: null,
      },
      pins: [{ ...metric("pins-spend", "Ad Spend", "currency"), value: null, status: "unavailable" }],
      storeMetrics: [],
      ltv: [],
      expenses: [],
      customMetrics: [],
      webAnalytics: [],
      platforms: [],
      costModel: { values: null },
    } as never;
    const bundle: SparklineBundle = {
      combined: [{ date: "2026-03-01", spend: 20, revenue: 20, purchases: 2 }],
      providerTrends: {
        google: [{ date: "2026-03-01", spend: 20, revenue: 20, purchases: 2 }],
      },
      providerTrendSources: { meta: null, google: "warehouse_account_daily" },
      shopifyDaily: [],
      shopifyCommerceAvailable: false,
      shopifyConnectionState: "connected",
      ga4Daily: [],
    };

    expect(buildSparklineMap(bundle, null, summary)["pins-spend"]).toEqual([]);
    expect(sourceSafeOverviewTrendPoints(bundle, summary)).toEqual([]);
    expect(overviewTrendTitle(summary)).toBe("Spend & Blended ROAS");
  });

  it("keeps a verified zero-spend day in the complete paid-provider series", async () => {
    const { buildSparklineMap, sourceSafeOverviewTrendPoints } = await import(
      "@/app/(dashboard)/overview/legacy-page"
    );
    const summary = {
      providerSources: {
        current: { meta: null, google: "warehouse_account_aggregate" },
        previous: null,
      },
      paidProviderScope: {
        current: { providers: ["google"], complete: true },
        previous: null,
      },
      pins: [{ ...metric("pins-spend", "Ad Spend", "currency"), value: 0 }],
      storeMetrics: [],
      ltv: [],
      expenses: [],
      customMetrics: [],
      webAnalytics: [],
      platforms: [],
      costModel: { values: null },
    } as never;
    const bundle: SparklineBundle = {
      combined: [{ date: "2026-03-01", spend: 0, revenue: 0, purchases: 0 }],
      providerTrends: {
        google: [{ date: "2026-03-01", spend: 0, revenue: 0, purchases: 0 }],
      },
      providerTrendSources: { meta: null, google: "warehouse_account_daily" },
      shopifyDaily: [],
      shopifyCommerceAvailable: false,
      shopifyConnectionState: "connected",
      ga4Daily: [],
    };

    expect(buildSparklineMap(bundle, null, summary)["pins-spend"]).toEqual([
      { date: "2026-03-01", value: 0 },
    ]);
    expect(sourceSafeOverviewTrendPoints(bundle, summary)).toEqual([
      { date: "2026-03-01", spend: 0, roas: null },
    ]);
  });

  it.each(["disconnected", "unknown"] as const)(
    "masks Shopify commerce when the sparkline read reports %s",
    async (sparklineState) => {
      const { reconcileOverviewCommerceSource } = await import(
        "@/app/(dashboard)/overview/legacy-page"
      );
      const summary = {
        shopifyConnectionState: "connected",
        pins: [
          {
            ...metric("pins-revenue", "Revenue", "currency"),
            value: 50,
            dataSource: { key: "shopify_warehouse", label: "Shopify" },
          },
        ],
        storeMetrics: [],
        ltv: [],
        expenses: [],
        customMetrics: [],
        webAnalytics: [],
        platforms: [],
        costModel: { values: null },
      } as never;
      const bundle: SparklineBundle = {
        combined: [{ date: "2026-03-01", spend: 10, revenue: 0, purchases: 0 }],
        providerTrends: {},
        shopifyDaily: [],
        shopifyCommerceAvailable: false,
        shopifyConnectionState: sparklineState,
        ga4Daily: [],
      };

      expect(reconcileOverviewCommerceSource(summary, bundle).pins[0]).toEqual(
        expect.objectContaining({ value: null, status: "unavailable" }),
      );
    },
  );
  it("draws provider rate trends from daily primitives and skips days without a denominator", async () => {
    const { buildSparklineMap } = await import("@/app/(dashboard)/overview/legacy-page");
    const summary = {
      shopifyConnectionState: "connected",
      pins: [],
      storeMetrics: [],
      ltv: [],
      expenses: [],
      customMetrics: [],
      webAnalytics: [],
      platforms: [],
      costModel: { values: null },
    } as never;
    const bundle: SparklineBundle = {
      combined: [],
      providerTrends: {
        meta: [
          { date: "2026-03-01", spend: 10, revenue: 30, purchases: 1, impressions: 1_000, clicks: 20 },
          { date: "2026-03-02", spend: 0, revenue: 0, purchases: 0, impressions: null, clicks: null },
          { date: "2026-03-03", spend: 12, revenue: 24, purchases: 0, impressions: 1_500, clicks: 0 },
        ],
        google: [
          // An older payload without delivery counts: rates stay undrawn.
          { date: "2026-03-01", spend: 5, revenue: 15, purchases: 1.25 },
          { date: "2026-03-02", spend: 6, revenue: 12, purchases: 2.5, impressions: 300, clicks: 12 },
        ],
      },
      shopifyDaily: [],
      shopifyCommerceAvailable: false,
      shopifyConnectionState: "connected",
      ga4Daily: [],
    };

    const map = buildSparklineMap(bundle, null, summary);

    expect(map["meta-spend"]).toEqual([
      { date: "2026-03-01", value: 10 },
      { date: "2026-03-02", value: 0 },
      { date: "2026-03-03", value: 12 },
    ]);
    expect(map["meta-roas"]).toEqual([
      { date: "2026-03-01", value: 3 },
      { date: "2026-03-03", value: 2 },
    ]);
    expect(map["meta-cpa"]).toEqual([{ date: "2026-03-01", value: 10 }]);
    expect(map["meta-cpm"]).toEqual([
      { date: "2026-03-01", value: 10 },
      { date: "2026-03-03", value: 8 },
    ]);
    expect(map["meta-ctr"]).toEqual([
      { date: "2026-03-01", value: 2 },
      { date: "2026-03-03", value: 0 },
    ]);
    expect(map["meta-cpc"]).toEqual([{ date: "2026-03-01", value: 0.5 }]);
    expect(map["meta-conversion-rate"]).toBeUndefined();

    expect(map["google-purchases"]).toEqual([
      { date: "2026-03-01", value: 1.25 },
      { date: "2026-03-02", value: 2.5 },
    ]);
    expect(map["google-ctr"]).toEqual([{ date: "2026-03-02", value: 4 }]);
    expect(map["google-cpc"]).toEqual([{ date: "2026-03-02", value: 0.5 }]);
    expect(map["google-conversion-rate"]).toEqual([{ date: "2026-03-02", value: 20.8333 }]);
    expect(map["google-cpm"]).toBeUndefined();
  });
  describe("provider sparkline source gating", () => {
    const providerPoint = (date: string) => ({
      date,
      spend: 10,
      revenue: 30,
      purchases: 2,
      impressions: 1_000,
      clicks: 40,
    });
    const staleSeries = [
      { date: "2026-02-01", value: 99 },
      { date: "2026-02-02", value: 99 },
    ];

    function providerSummary(providerSources: unknown) {
      const card = (id: string, title: string, unit: string) => ({
        ...metric(id, title, unit),
        // A series that arrived with the summary must not survive a mismatch.
        sparklineData: staleSeries,
        previousSparklineData: staleSeries,
      });
      return {
        shopifyConnectionState: "connected",
        providerSources,
        pins: [],
        storeMetrics: [],
        ltv: [],
        expenses: [],
        customMetrics: [],
        webAnalytics: [],
        platforms: [
          { id: "meta", title: "Meta Ads", provider: "meta", metrics: [card("meta-cpm", "CPM", "currency")] },
          { id: "google", title: "Google Ads", provider: "google", metrics: [card("google-ctr", "CTR", "percent")] },
        ],
        costModel: { values: null },
      } as never;
    }

    function providerBundle(providerTrendSources: SparklineBundle["providerTrendSources"]): SparklineBundle {
      return {
        combined: [],
        providerTrends: {
          meta: [providerPoint("2026-03-01"), providerPoint("2026-03-02")],
          google: [providerPoint("2026-03-01"), providerPoint("2026-03-02")],
        },
        providerTrendSources,
        shopifyDaily: [],
        shopifyCommerceAvailable: false,
        shopifyConnectionState: "connected",
        ga4Daily: [],
      };
    }

    function platformMetric(summary: { platforms: Array<{ metrics: Array<{ id: string }> }> }, id: string) {
      return summary.platforms.flatMap((platform) => platform.metrics).find((metricCard) => metricCard.id === id) as
        | { sparklineData: unknown[]; previousSparklineData?: unknown[]; value: number | null }
        | undefined;
    }

    it("patches provider cards only from a trend read of the same warehouse family", async () => {
      const { patchSummarySparklines } = await import("@/app/(dashboard)/overview/legacy-page");
      const patched = patchSummarySparklines(
        providerSummary({
          current: { meta: "warehouse_published_account_daily", google: "warehouse_account_aggregate" },
          previous: null,
        }),
        providerBundle({ meta: "warehouse_published_account_daily", google: "warehouse_account_daily" }),
      );

      expect(platformMetric(patched, "meta-cpm")?.sparklineData).toEqual([
        { date: "2026-03-01", value: 10 },
        { date: "2026-03-02", value: 10 },
      ]);
      expect(platformMetric(patched, "google-ctr")?.sparklineData).toEqual([
        { date: "2026-03-01", value: 4 },
        { date: "2026-03-02", value: 4 },
      ]);
    });

    it.each([
      [
        "live scalars with warehouse trends",
        { current: { meta: "current_day_live", google: "live_overlay_current_day" }, previous: null },
        { meta: "warehouse_published_account_daily", google: "warehouse_account_daily" },
      ],
      [
        "a Meta live historical fallback and a Google campaign fallback against account daily trends",
        { current: { meta: "live_historical_fallback", google: "warehouse_campaign_aggregate_fallback" }, previous: null },
        { meta: "warehouse_published_account_daily", google: "warehouse_account_daily" },
      ],
      [
        "an older summary without provider sources",
        undefined,
        { meta: "warehouse_published_account_daily", google: "warehouse_account_daily" },
      ],
      [
        "an older sparkline payload without trend sources",
        { current: { meta: "warehouse_published_account_daily", google: "warehouse_account_aggregate" }, previous: null },
        undefined,
      ],
    ])("clears provider sparklines for %s while keeping the scalar", async (_case, sources, trendSources) => {
      const { patchSummarySparklines } = await import("@/app/(dashboard)/overview/legacy-page");
      const patched = patchSummarySparklines(providerSummary(sources), providerBundle(trendSources));

      expect(platformMetric(patched, "meta-cpm")).toEqual(expect.objectContaining({ value: 1, sparklineData: [] }));
      expect(platformMetric(patched, "google-ctr")).toEqual(expect.objectContaining({ value: 1, sparklineData: [] }));
    });

    it("gates comparison sparklines against the previous window's scalar sources", async () => {
      const { patchSummaryComparisonSparklines } = await import("@/app/(dashboard)/overview/legacy-page");
      const comparisonBundle = providerBundle({ meta: "warehouse_published_account_daily", google: "warehouse_account_daily" });

      const mixed = patchSummaryComparisonSparklines(
        providerSummary({
          current: { meta: "warehouse_published_account_daily", google: "warehouse_account_aggregate" },
          // The previous window's Meta total was a live fallback; Google stayed warehouse.
          previous: { meta: "live_historical_fallback", google: "warehouse_account_aggregate" },
        }),
        comparisonBundle,
      );
      expect(platformMetric(mixed, "meta-cpm")?.previousSparklineData).toEqual([]);
      expect(platformMetric(mixed, "google-ctr")?.previousSparklineData).toEqual([
        { date: "2026-03-01", value: 4 },
        { date: "2026-03-02", value: 4 },
      ]);

      const noComparison = patchSummaryComparisonSparklines(
        providerSummary({
          current: { meta: "warehouse_published_account_daily", google: "warehouse_account_aggregate" },
          previous: null,
        }),
        comparisonBundle,
      );
      expect(platformMetric(noComparison, "meta-cpm")?.previousSparklineData).toEqual([]);
      expect(platformMetric(noComparison, "google-ctr")?.previousSparklineData).toEqual([]);
    });

    it("draws no comparison sparkline when the two windows used different grains, even if each is self-consistent", async () => {
      const { patchSummaryComparisonSparklines } = await import("@/app/(dashboard)/overview/legacy-page");
      const patched = patchSummaryComparisonSparklines(
        providerSummary({
          current: { meta: "warehouse_published_campaign_daily", google: "warehouse_campaign_aggregate_fallback" },
          previous: { meta: "warehouse_published_account_daily", google: "warehouse_account_aggregate" },
        }),
        // The previous trend matches the previous scalar exactly.
        providerBundle({ meta: "warehouse_published_account_daily", google: "warehouse_account_daily" }),
      );

      expect(platformMetric(patched, "meta-cpm")?.previousSparklineData).toEqual([]);
      expect(platformMetric(patched, "google-ctr")?.previousSparklineData).toEqual([]);
    });

    it("does not pair a campaign-grain Meta scalar with an account-grain Meta trend", async () => {
      const { patchSummarySparklines } = await import("@/app/(dashboard)/overview/legacy-page");
      const patched = patchSummarySparklines(
        providerSummary({
          current: { meta: "warehouse_published_campaign_daily", google: "warehouse_account_aggregate" },
          previous: null,
        }),
        providerBundle({ meta: "warehouse_published_account_daily", google: "warehouse_account_daily" }),
      );

      expect(platformMetric(patched, "meta-cpm")?.sparklineData).toEqual([]);
      expect(platformMetric(patched, "google-ctr")?.sparklineData).toHaveLength(2);
    });
  });
});
