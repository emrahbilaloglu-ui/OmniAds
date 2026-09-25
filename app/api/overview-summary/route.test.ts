import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/account-store", () => ({
  getBusinessTimezone: vi.fn(),
}));

vi.mock("@/lib/analytics-overview", () => ({
  GA4AuthError: class GA4AuthError extends Error {},
  getAnalyticsOverviewData: vi.fn(),
}));

vi.mock("@/lib/business-cost-model", () => ({
  getBusinessCostModel: vi.fn(),
}));

vi.mock("@/lib/business-commercial", () => ({
  getBusinessCommercialTruthSnapshot: vi.fn(),
}));

vi.mock("@/lib/integration-status", () => ({
  getIntegrationStatusByBusiness: vi.fn(),
}));

vi.mock("@/lib/overview-service", () => ({
  getOverviewData: vi.fn(),
  getShopifyOverviewServingData: vi.fn(),
}));

vi.mock("@/lib/overview-summary-support", async () => {
  const actual = await vi.importActual<object>("@/lib/overview-summary-support");
  return {
    ...actual,
    getGa4DailyTrendSnapshot: vi.fn().mockResolvedValue([]),
    getGa4LtvSnapshot: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("@/lib/request-language", () => ({
  resolveRequestLanguage: vi.fn(),
}));

const access = await import("@/lib/access");
const accountStore = await import("@/lib/account-store");
const analyticsOverview = await import("@/lib/analytics-overview");
const businessCommercial = await import("@/lib/business-commercial");
const businessCostModel = await import("@/lib/business-cost-model");
const integrationStatus = await import("@/lib/integration-status");
const overviewService = await import("@/lib/overview-service");
const overviewSummarySupport = await import("@/lib/overview-summary-support");
const requestLanguage = await import("@/lib/request-language");
const { GET } = await import("@/app/api/overview-summary/route");

describe("GET /api/overview-summary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requestLanguage.resolveRequestLanguage).mockResolvedValue("en" as never);
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      businessId: "biz_1",
    } as never);
    vi.mocked(accountStore.getBusinessTimezone).mockResolvedValue("UTC" as never);
    vi.mocked(businessCostModel.getBusinessCostModel).mockResolvedValue(null as never);
    vi.mocked(businessCommercial.getBusinessCommercialTruthSnapshot).mockResolvedValue({
      targetPack: { targetRoas: 3.8 },
    } as never);
    vi.mocked(integrationStatus.getIntegrationStatusByBusiness).mockResolvedValue({
      meta: false,
      google: false,
      tiktok: false,
      pinterest: false,
      snapchat: false,
      klaviyo: false,
      shopify: true,
      ga4: false,
      search_console: false,
    });
    vi.mocked(analyticsOverview.getAnalyticsOverviewData).mockResolvedValue(null as never);
    vi.mocked(overviewService.getOverviewData).mockResolvedValue({
      businessId: "biz_1",
      dateRange: { startDate: "2026-03-01", endDate: "2026-03-30" },
      shopifyConnectionState: "connected",
      kpis: {
        spend: 100,
        revenue: 200,
        roas: 2,
        purchases: 2,
        cpa: 50,
        aov: 100,
      },
      kpiSources: {
        revenue: {
          source: "shopify_live_fallback",
          label: "Shopify Live Fallback",
        },
        purchases: {
          source: "shopify_live_fallback",
          label: "Shopify Live Fallback",
        },
        aov: {
          source: "shopify_live_fallback",
          label: "Shopify Live Fallback",
        },
        roas: {
          source: "shopify_live_fallback",
          label: "Shopify Live Fallback",
        },
      },
      totals: {
        impressions: 10,
        clicks: 5,
        purchases: 2,
        spend: 100,
        conversions: 2,
        revenue: 200,
        ctr: 50,
        cpm: 10,
        cpc: 20,
        cpa: 50,
        roas: 2,
      },
      platformEfficiency: [],
      trends: { "7d": [], "14d": [], "30d": [], custom: [] },
      shopifyServing: {
        source: "live",
        provider: "shopify",
        trustState: "live_fallback",
        fallbackReason: "pending_repair",
        lastSyncedAt: "2026-04-02T10:00:00.000Z",
        coverageStatus: "historical_incomplete",
        productionMode: "auto",
        pendingRepair: true,
        pendingRepairStartedAt: "2026-04-02T10:05:00.000Z",
        pendingRepairLastTopic: "REFUNDS_CREATE",
        pendingRepairLastReceivedAt: "2026-04-02T10:05:00.000Z",
        selectedRevenueTruthBasis: "current_total_price",
        basisSelectionReason: "closest_current_order_revenue",
        transactionCoverageOrderRate: 70,
        transactionCoverageAmountRate: 82,
        explainedAdjustmentRevenue: 5,
        unexplainedAdjustmentRevenue: 0,
      },
    } as never);
    vi.mocked(overviewService.getShopifyOverviewServingData).mockResolvedValue({
      aggregate: {
        revenue: 200,
        grossRevenue: 240,
        refundedRevenue: 40,
        purchases: 2,
        returnEvents: 1,
        averageOrderValue: 100,
        conversionRate: null,
        newCustomers: null,
        returningCustomers: null,
        sessions: null,
        dailyTrends: [
          {
            date: "2026-03-01",
            revenue: 200,
            grossRevenue: 240,
            refundedRevenue: 40,
            purchases: 2,
            returnEvents: 1,
            sessions: null,
            conversionRate: null,
            newCustomers: null,
            returningCustomers: null,
          },
        ],
      },
      serving: {
        source: "live",
      },
    } as never);
  });

  it("returns a non-blank summary contract with shopify serving metadata", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/overview-summary?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-30&compareMode=none"
    );

    const response = await GET(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(integrationStatus.getIntegrationStatusByBusiness).toHaveBeenCalledTimes(1);
    expect(Object.keys(payload)).toEqual(["summary"]);
    expect(Object.keys(payload.summary).sort()).toEqual(
      [
        "attribution",
        "businessId",
        "comparison",
        "costModel",
        "customMetrics",
        "dateRange",
        "expenses",
        "insights",
        "ltv",
        "paidProviderScope",
        "pins",
        "platforms",
        "providerSources",
        "shopifyServing",
        "shopifyConnectionState",
        "storeMetrics",
        "webAnalytics",
      ].sort()
    );
    expect(payload.summary.comparison).toEqual({
      mode: "none",
      startDate: null,
      endDate: null,
    });
    // No comparison window, so no previous scalar sources; an overview without
    // provider sources reports them as unknown (null), never as a guess.
    expect(payload.summary.providerSources).toEqual({
      current: { meta: null, google: null },
      previous: null,
    });
    expect(payload.summary.paidProviderScope).toEqual({
      current: { providers: [], complete: true },
      previous: null,
    });
    expect(payload.summary.pins.map((metric: { id: string }) => metric.id)).toEqual([
      "pins-revenue",
      "pins-spend",
      "pins-mer",
      "pins-blended-roas",
      "pins-conversion-rate",
      "pins-orders",
    ]);
    expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-blended-roas")?.title).toBe(
      "Blended ROAS · target 3.80"
    );
    expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-conversion-rate")).toEqual(
      expect.objectContaining({
        title: "Conversion Rate",
        value: null,
        status: "unavailable",
        dataSource: { key: "shopify_unavailable", label: "Shopify" },
      })
    );
    expect(payload.summary.shopifyServing).toEqual(
      expect.objectContaining({
        source: "live",
        trustState: "live_fallback",
        fallbackReason: "pending_repair",
      })
    );
    expect(Array.isArray(payload.summary.storeMetrics)).toBe(true);
    expect(payload.summary.storeMetrics.map((metric: { id: string }) => metric.id)).toEqual([
      "store-aov",
      "store-new-customers",
      "store-gross-sales",
      "store-refunded-revenue",
      "store-refund-rate",
      "store-return-events",
      "store-return-rate",
    ]);
    expect(payload.summary.attribution.map((row: { channel: string }) => row.channel)).toEqual([
      "Meta Ads",
      "Google Ads",
      "Klaviyo",
      "Organic · GA4",
    ]);
    expect(payload.summary.attribution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "Klaviyo",
          spend: null,
          spendShare: null,
        }),
        expect.objectContaining({ channel: "Organic · GA4", revenue: null }),
      ])
    );
    expect(payload.summary.platforms).toHaveLength(2);
    expect(
      payload.summary.platforms.map((platform: { provider: string; metrics: Array<{ title: string }> }) => ({
        provider: platform.provider,
        titles: platform.metrics.map((metric) => metric.title),
      }))
    ).toEqual([
      {
        provider: "meta",
        titles: ["Spend", "Revenue", "ROAS", "Purchases", "CPA", "CPM", "All-click CTR", "All-click CPC"],
      },
      {
        provider: "google",
        titles: ["Spend", "Conversion value", "ROAS", "Conversions", "Cost / conv.", "CTR", "CPC", "Conversion rate"],
      },
    ]);
    expect(payload.summary.webAnalytics.map((metric: { id: string }) => metric.id)).toEqual([
      "web-sessions",
      "web-engagement-rate",
      "web-session-duration",
      "web-conversion-rate",
    ]);
  });

  describe("provider cards across two windows", () => {
    async function summaryFor(sources: {
      current: { meta: string | null; google: string | null };
      previous: { meta: string | null; google: string | null };
    }, options?: {
      currentMetaEnd?: string;
      omitCurrentRows?: Array<"meta" | "google">;
      omitPreviousRows?: Array<"meta" | "google">;
      connections?: { meta: boolean; google: boolean };
      currentMetaSpend?: number;
      currentGoogleSpend?: number;
    }) {
      vi.mocked(integrationStatus.getIntegrationStatusByBusiness).mockResolvedValue({
        meta: options?.connections?.meta ?? true,
        google: options?.connections?.google ?? true,
        tiktok: false,
        pinterest: false,
        snapchat: false,
        klaviyo: false,
        shopify: true,
        ga4: false,
        search_console: false,
      });
      const baseOverview = await overviewService.getOverviewData({} as never);
      const windowOverview = (isCurrent: boolean) => {
        const range = isCurrent
          ? { startDate: "2026-03-01", endDate: "2026-03-30" }
          : { startDate: "2026-01-30", endDate: "2026-02-28" };
        const omittedRows = new Set(isCurrent ? options?.omitCurrentRows : options?.omitPreviousRows);
        return {
          ...baseOverview,
          dateRange: range,
          providerSources: isCurrent ? sources.current : sources.previous,
          providerScalarRanges: {
            meta:
              omittedRows.has("meta") && (isCurrent ? sources.current.meta : sources.previous.meta) === null
                ? null
                : { ...range, endDate: isCurrent ? (options?.currentMetaEnd ?? range.endDate) : range.endDate },
            google:
              omittedRows.has("google") && (isCurrent ? sources.current.google : sources.previous.google) === null
                ? null
                : range,
          },
          // Deliberately inconsistent blended totals: provider cards must ignore them.
          totals: { ...baseOverview.totals, impressions: 1, clicks: 1, ctr: 100, cpm: 999, cpc: 999 },
          platformEfficiency: [
            {
              platform: "meta",
              spend: isCurrent ? (options?.currentMetaSpend ?? 100) : 80,
              revenue: 300,
              roas: 3,
              purchases: 10,
              cpa: 10,
              impressions: 20_000,
              clicks: 400,
            },
            {
              platform: "google",
              spend: isCurrent ? (options?.currentGoogleSpend ?? 60) : 60,
              revenue: 120,
              roas: 2,
              purchases: 2.5,
              cpa: 24,
              impressions: 3_000,
              clicks: 50,
            },
          ].filter((row) => !omittedRows.has(row.platform as "meta" | "google")),
        };
      };
      vi.mocked(overviewService.getOverviewData).mockImplementation((async (params: { startDate?: string | null }) =>
        windowOverview(params.startDate === "2026-03-01")) as never);

      const request = new NextRequest(
        "http://localhost:3000/api/overview-summary?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-30&compareMode=previous_period"
      );
      const response = await GET(request as never);
      const payload = await response.json();
      const metrics = Object.fromEntries(
        payload.summary.platforms.flatMap((platform: { metrics: Array<{ id: string }> }) =>
          platform.metrics.map((metric) => [metric.id, metric]),
        ),
      ) as Record<
        string,
        { value: number | null; previousValue: number | null; changePct: number | null; trendSentiment?: string }
      >;
      return { response, payload, metrics };
    }

    it("builds each window from its own provider primitives, never from blended totals", async () => {
      const sources = {
        current: { meta: "warehouse_published_campaign_daily", google: "warehouse_account_aggregate" },
        previous: { meta: "warehouse_published_campaign_daily", google: "warehouse_account_aggregate" },
      };
      const { response, payload, metrics } = await summaryFor(sources);

      expect(response.status).toBe(200);
      // Current and previous scalar sources travel separately so each window's
      // deltas and sparklines are gated against its own read.
      expect(payload.summary.providerSources).toEqual(sources);
      expect(metrics["meta-cpm"]).toEqual(
        expect.objectContaining({ value: 5, previousValue: 4, changePct: 25, trendSentiment: "negative" }),
      );
      expect(metrics["meta-ctr"]).toEqual(expect.objectContaining({ value: 2, previousValue: 2, changePct: 0 }));
      expect(metrics["meta-cpc"]).toEqual(expect.objectContaining({ value: 0.25, previousValue: 0.2 }));
      expect(metrics["google-purchases"]).toEqual(expect.objectContaining({ value: 2.5, previousValue: 2.5 }));
      expect(metrics["google-conversion-rate"]).toEqual(expect.objectContaining({ value: 5 }));
      expect(metrics["google-ctr"]?.value).toBeCloseTo(1.6667, 4);

      const pins = Object.fromEntries(
        payload.summary.pins.map((metric: { id: string }) => [metric.id, metric]),
      ) as Record<
        string,
        {
          value: number | null;
          previousValue: number | null;
          changePct: number | null;
          subtitle?: string;
          dataSource: { key: string };
        }
      >;
      // Platform-attributed conversion value: (300 + 120) / (100 + 60).
      expect(pins["pins-blended-roas"]).toEqual(
        expect.objectContaining({
          value: 2.625,
          previousValue: 3,
          changePct: -12.5,
          subtitle:
            "Attributed conversion value (Meta Ads + Google Ads) / combined spend (Meta Ads + Google Ads)",
          dataSource: expect.objectContaining({ key: "ad_platforms" }),
        }),
      );
      // Store truth remains independent: Shopify revenue 200 / verified provider spend 160.
      expect(pins["pins-mer"]).toEqual(
        expect.objectContaining({
          value: 1.25,
          subtitle: "Shopify revenue / combined spend (Meta Ads + Google Ads)",
          dataSource: expect.objectContaining({ key: "shopify_live_fallback" }),
        }),
      );
      // Blended CPA uses the same complete paid-spend numerator and store-order
      // denominator; the raw overview KPI is deliberately inconsistent here.
      expect(payload.summary.customMetrics.find((metric: { id: string }) => metric.id === "custom-blended-cpa"))
        .toEqual(expect.objectContaining({
          value: 80,
          previousValue: 70,
          subtitle: "Paid spend / store orders",
        }));
    });

    it("drops previous values and deltas when a provider's two windows came from different sources", async () => {
      const sources = {
        current: { meta: "live_historical_fallback", google: "warehouse_account_aggregate" },
        previous: { meta: "warehouse_published_account_daily", google: "warehouse_campaign_aggregate_fallback" },
      };
      const { payload, metrics } = await summaryFor(sources);

      expect(payload.summary.providerSources).toEqual(sources);
      const providerMetrics = Object.values(metrics);
      expect(providerMetrics).toHaveLength(16);
      // Current values remain; no provider card compares rows from another read.
      expect(metrics["meta-cpm"]?.value).toBe(5);
      expect(metrics["google-spend"]?.value).toBe(60);
      expect(providerMetrics.every((metric) => metric.previousValue === null && metric.changePct === null)).toBe(true);
      expect(
        payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-blended-roas"),
      ).toEqual(expect.objectContaining({ value: 2.625, previousValue: null, changePct: null }));
      expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-mer")).toEqual(
        expect.objectContaining({ value: 1.25, previousValue: null, changePct: null }),
      );
      expect(payload.summary.customMetrics.find((metric: { id: string }) => metric.id === "custom-blended-cpa"))
        .toEqual(expect.objectContaining({ value: 80, previousValue: null, changePct: null }));
    });

    it("shows partial provider data while keeping full-window paid aggregates closed", async () => {
      const sources = {
        current: { meta: "warehouse_published_campaign_daily", google: "warehouse_account_aggregate" },
        previous: { meta: "warehouse_published_campaign_daily", google: "warehouse_account_aggregate" },
      };
      const { payload, metrics } = await summaryFor(sources, { currentMetaEnd: "2026-03-29" });

      expect(payload.summary.providerSources).toEqual({
        current: { meta: null, google: "warehouse_account_aggregate" },
        previous: sources.previous,
      });
      expect(payload.summary.paidProviderScope.current).toEqual({
        providers: ["google"],
        complete: false,
      });
      expect(metrics["meta-spend"]).toEqual(expect.objectContaining({ value: 100, previousValue: null, changePct: null }));
      expect(payload.summary.platforms.find((section: { provider: string }) => section.provider === "meta")?.coverageNote)
        .toContain("2026-03-29");
      expect(payload.summary.attribution[0]).toEqual(expect.objectContaining({ spend: null, revenue: null }));
      expect(metrics["google-spend"]?.previousValue).toBe(60);
      expect(metrics["google-spend"]?.changePct).toBe(0);
      expect(
        payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-blended-roas"),
      ).toEqual(expect.objectContaining({ value: null, previousValue: null, changePct: null }));
      expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-spend")).toEqual(
        expect.objectContaining({ value: null, previousValue: null, status: "unavailable" }),
      );
      expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-mer")).toEqual(
        expect.objectContaining({ value: null, previousValue: null, changePct: null }),
      );
      expect(payload.summary.customMetrics.find((metric: { id: string }) => metric.id === "custom-blended-cpa"))
        .toEqual(expect.objectContaining({ value: null, previousValue: null, changePct: null, sparklineData: [] }));
    });

    it("fails every paid aggregate closed when a connected provider source is unknown", async () => {
      const sources = {
        current: { meta: null, google: "warehouse_account_aggregate" },
        previous: { meta: null, google: "warehouse_account_aggregate" },
      };
      const { payload, metrics } = await summaryFor(sources);
      const blended = payload.summary.pins.find(
        (metric: { id: string }) => metric.id === "pins-blended-roas",
      );

      expect(blended).toEqual(
        expect.objectContaining({
          value: null,
          previousValue: null,
          dataSource: { key: "unavailable", label: "Unavailable" },
        }),
      );
      expect(metrics["meta-spend"]).toEqual(
        expect.objectContaining({ value: null, status: "unavailable" }),
      );
      expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-mer")).toEqual(
        expect.objectContaining({ value: null, previousValue: null, status: "unavailable" }),
      );
      expect(payload.summary.attribution[0]).toEqual(
        expect.objectContaining({ channel: "Meta Ads", spend: null, revenue: null }),
      );
    });

    it("fails Spend, Blended ROAS, and MER closed when a connected provider read is absent", async () => {
      const sources = {
        current: { meta: null, google: "warehouse_account_aggregate" },
        previous: { meta: "warehouse_published_campaign_daily", google: "warehouse_account_aggregate" },
      };
      const { payload } = await summaryFor(sources, { omitCurrentRows: ["meta"] });
      const pins = Object.fromEntries(
        payload.summary.pins.map((metric: { id: string }) => [metric.id, metric]),
      ) as Record<
        string,
        { value: number | null; previousValue: number | null; status: string; subtitle?: string }
      >;

      expect(pins["pins-blended-roas"]).toEqual(
        expect.objectContaining({
          value: null,
          previousValue: null,
          status: "unavailable",
        }),
      );
      expect(pins["pins-spend"]).toEqual(
        expect.objectContaining({ value: null, previousValue: null, status: "unavailable" }),
      );
      expect(pins["pins-mer"]).toEqual(
        expect.objectContaining({
          value: null,
          previousValue: null,
          status: "unavailable",
        }),
      );
    });

    it("fails paid aggregates closed when integration status is unknown and a provider read is absent", async () => {
      const sources = {
        current: { meta: null, google: "warehouse_account_aggregate" },
        previous: { meta: null, google: "warehouse_account_aggregate" },
      };
      vi.mocked(integrationStatus.getIntegrationStatusByBusiness).mockRejectedValueOnce(
        new Error("integration status unavailable"),
      );
      const { payload } = await summaryFor(sources, {
        omitCurrentRows: ["meta"],
        omitPreviousRows: ["meta"],
      });

      expect(payload.summary.paidProviderScope.current).toEqual({
        providers: ["google"],
        complete: false,
      });
      expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-spend")).toEqual(
        expect.objectContaining({ value: null, status: "unavailable" }),
      );
    });

    it("skips an absent provider only when integrations confirms it is disconnected", async () => {
      const sources = {
        current: { meta: null, google: "warehouse_account_aggregate" },
        previous: { meta: null, google: "warehouse_account_aggregate" },
      };
      const { payload } = await summaryFor(sources, {
        omitCurrentRows: ["meta"],
        omitPreviousRows: ["meta"],
        connections: { meta: false, google: true },
      });
      const pins = Object.fromEntries(
        payload.summary.pins.map((metric: { id: string }) => [metric.id, metric]),
      ) as Record<string, { value: number | null; previousValue: number | null; status: string }>;

      expect(payload.summary.paidProviderScope).toEqual({
        current: { providers: ["google"], complete: true },
        previous: { providers: ["google"], complete: true },
      });
      expect(pins["pins-spend"]).toEqual(expect.objectContaining({ value: 60, previousValue: 60 }));
      expect(pins["pins-blended-roas"]).toEqual(expect.objectContaining({ value: 2, previousValue: 2 }));
      expect(pins["pins-mer"]).toEqual(expect.objectContaining({ value: 200 / 60 }));
    });

    it("retains verified historical rows after a provider is disconnected", async () => {
      const sources = {
        current: { meta: "warehouse_published_campaign_daily", google: "warehouse_account_aggregate" },
        previous: { meta: "warehouse_published_campaign_daily", google: "warehouse_account_aggregate" },
      };
      const { payload } = await summaryFor(sources, {
        connections: { meta: false, google: true },
      });

      expect(payload.summary.paidProviderScope.current).toEqual({
        providers: ["meta", "google"],
        complete: true,
      });
      expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-spend")).toEqual(
        expect.objectContaining({ value: 160, status: "available" }),
      );
    });

    it("preserves a verified measured zero instead of treating it as missing", async () => {
      const sources = {
        current: { meta: "warehouse_published_campaign_daily", google: "warehouse_account_aggregate" },
        previous: { meta: "warehouse_published_campaign_daily", google: "warehouse_account_aggregate" },
      };
      const { payload } = await summaryFor(sources, {
        currentMetaSpend: 0,
        currentGoogleSpend: 0,
      });
      const spend = payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-spend");

      expect(payload.summary.paidProviderScope.current.complete).toBe(true);
      expect(spend).toEqual(
        expect.objectContaining({
          value: 0,
          status: "available",
          dataSource: { key: "ad_platforms", label: "Meta Ads + Google Ads" },
        }),
      );
    });
  });

  it("keeps commerce on Shopify while still using GA4 for web analytics", async () => {
    vi.mocked(analyticsOverview.getAnalyticsOverviewData).mockResolvedValue({
      kpis: {
        sessions: 12_345,
        engagementRate: 0.634,
        avgSessionDuration: 161,
        purchaseCvr: 0.0234,
        firstTimePurchasers: 410,
      },
    } as never);

    const request = new NextRequest(
      "http://localhost:3000/api/overview-summary?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-30&compareMode=none"
    );
    const response = await GET(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-conversion-rate")).toEqual(
      expect.objectContaining({
        value: null,
        dataSource: { key: "shopify_unavailable", label: "Shopify" },
      })
    );
    expect(payload.summary.storeMetrics.find((metric: { id: string }) => metric.id === "store-new-customers")).toEqual(
      expect.objectContaining({
        value: null,
        dataSource: { key: "shopify_unavailable", label: "Shopify" },
      })
    );
    expect(
      payload.summary.webAnalytics.map((metric: { id: string; value: number | null }) => [metric.id, metric.value])
    ).toEqual([
      ["web-sessions", 12_345],
      ["web-engagement-rate", 63.4],
      ["web-session-duration", 161],
      ["web-conversion-rate", 2.34],
    ]);
    expect(overviewSummarySupport.getGa4LtvSnapshot).not.toHaveBeenCalled();
  });

  it("uses Shopify conversion and customer values without rescaling percentages", async () => {
    vi.mocked(businessCommercial.getBusinessCommercialTruthSnapshot).mockRejectedValue(
      new Error("commercial truth unavailable")
    );
    vi.mocked(analyticsOverview.getAnalyticsOverviewData).mockResolvedValue(null as never);
    vi.mocked(overviewService.getShopifyOverviewServingData).mockResolvedValue({
      aggregate: {
        revenue: 200,
        grossRevenue: 240,
        refundedRevenue: 40,
        purchases: 2,
        returnEvents: 1,
        averageOrderValue: 100,
        conversionRate: 87,
        newCustomers: 999,
        returningCustomers: 999,
        sessions: 1_000,
        dailyTrends: [],
      },
      serving: { source: "live" },
    } as never);

    const request = new NextRequest(
      "http://localhost:3000/api/overview-summary?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-30&compareMode=none"
    );
    const response = await GET(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-blended-roas")?.title).toBe(
      "Blended ROAS · target —"
    );
    expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-conversion-rate")).toEqual(
      expect.objectContaining({
        value: 87,
        status: "available",
        dataSource: { key: "shopify_customer_events", label: "Shopify" },
      })
    );
    expect(payload.summary.storeMetrics.find((metric: { id: string }) => metric.id === "store-new-customers")).toEqual(
      expect.objectContaining({
        value: 999,
        dataSource: { key: "shopify", label: "Shopify" },
      })
    );
  });

  it("uses GA4 commerce only when Shopify is confirmed disconnected", async () => {
    vi.mocked(analyticsOverview.getAnalyticsOverviewData).mockResolvedValue({
      kpis: {
        sessions: 12_345,
        engagementRate: 0.634,
        avgSessionDuration: 161,
        purchaseCvr: 0.0234,
        firstTimePurchasers: 410,
      },
    } as never);
    const baseOverview = await overviewService.getOverviewData({} as never);
    vi.mocked(overviewService.getOverviewData).mockResolvedValue({
      ...baseOverview,
      shopifyConnectionState: "disconnected",
      kpis: {
        ...baseOverview.kpis,
        revenue: 1_800,
        purchases: 15,
        aov: 120,
        roas: 18,
      },
      kpiSources: {
        ...baseOverview.kpiSources,
        revenue: { source: "ga4_fallback", label: "GA4" },
        purchases: { source: "ga4_fallback", label: "GA4" },
        aov: { source: "ga4_fallback", label: "GA4" },
        roas: { source: "ga4_fallback", label: "GA4" },
      },
      shopifyServing: null,
    } as never);
    vi.mocked(overviewService.getShopifyOverviewServingData).mockResolvedValue({
      aggregate: null,
      serving: { source: "none" },
    } as never);

    const request = new NextRequest(
      "http://localhost:3000/api/overview-summary?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-30&compareMode=none"
    );
    const response = await GET(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-conversion-rate")).toEqual(
      expect.objectContaining({
        value: 2.34,
        dataSource: { key: "ga4_fallback", label: "GA4 fallback" },
      })
    );
    expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-mer")).toEqual(
      expect.objectContaining({
        subtitle: "GA4 ecommerce revenue fallback / combined spend (verified paid platforms)",
        dataSource: { key: "ga4_fallback", label: "GA4 + ad platforms" },
      })
    );
    expect(payload.summary.storeMetrics.find((metric: { id: string }) => metric.id === "store-aov")).toEqual(
      expect.objectContaining({
        value: 120,
        dataSource: { key: "ga4_fallback", label: "GA4" },
      })
    );
    expect(payload.summary.storeMetrics.find((metric: { id: string }) => metric.id === "store-new-customers")).toEqual(
      expect.objectContaining({
        value: 410,
        dataSource: { key: "ga4_fallback", label: "GA4 fallback" },
      })
    );
  });

  it("fails closed when the Shopify connection state is unknown", async () => {
    const baseOverview = await overviewService.getOverviewData({} as never);
    vi.mocked(overviewService.getOverviewData).mockResolvedValue({
      ...baseOverview,
      shopifyConnectionState: "unknown",
      kpis: {
        ...baseOverview.kpis,
        revenue: 1_800,
        purchases: 15,
        aov: 120,
        roas: 18,
      },
      kpiSources: {
        ...baseOverview.kpiSources,
        revenue: { source: "ga4_fallback", label: "GA4" },
        purchases: { source: "ga4_fallback", label: "GA4" },
        aov: { source: "ga4_fallback", label: "GA4" },
        roas: { source: "ga4_fallback", label: "GA4" },
      },
    } as never);

    const request = new NextRequest(
      "http://localhost:3000/api/overview-summary?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-30&compareMode=none"
    );
    const response = await GET(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.summary.shopifyConnectionState).toBe("unknown");
    expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-revenue")).toEqual(
      expect.objectContaining({
        value: null,
        status: "unavailable",
        dataSource: { key: "unavailable", label: "Unavailable" },
      }),
    );
    expect(overviewSummarySupport.getGa4LtvSnapshot).not.toHaveBeenCalled();
  });

  it("discards a concurrent GA4 result when Shopify is observed connected", async () => {
    const baseOverview = await overviewService.getOverviewData({} as never);
    vi.mocked(overviewService.getOverviewData).mockResolvedValue({
      ...baseOverview,
      kpis: {
        ...baseOverview.kpis,
        revenue: 1_800,
        purchases: 15,
        aov: 120,
        roas: 18,
      },
      kpiSources: {
        ...baseOverview.kpiSources,
        revenue: { source: "ga4_fallback", label: "GA4" },
        purchases: { source: "ga4_fallback", label: "GA4" },
        aov: { source: "ga4_fallback", label: "GA4" },
        roas: { source: "ga4_fallback", label: "GA4" },
      },
      shopifyServing: null,
    } as never);
    vi.mocked(overviewService.getShopifyOverviewServingData).mockResolvedValue({
      aggregate: null,
      serving: { source: "none" },
    } as never);

    const request = new NextRequest(
      "http://localhost:3000/api/overview-summary?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-30&compareMode=none"
    );
    const response = await GET(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.summary.pins.find((metric: { id: string }) => metric.id === "pins-revenue")).toEqual(
      expect.objectContaining({
        value: null,
        status: "unavailable",
        dataSource: { key: "shopify_unavailable", label: "Shopify" },
      })
    );
    expect(payload.summary.storeMetrics.find((metric: { id: string }) => metric.id === "store-aov")).toEqual(
      expect.objectContaining({
        value: null,
        status: "unavailable",
        dataSource: { key: "shopify_unavailable", label: "Shopify" },
      })
    );
    expect(overviewSummarySupport.getGa4LtvSnapshot).not.toHaveBeenCalled();
  });
});
