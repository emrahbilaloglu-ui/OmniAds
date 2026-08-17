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
      shopify: true,
    } as never);
    vi.mocked(analyticsOverview.getAnalyticsOverviewData).mockResolvedValue(null as never);
    vi.mocked(overviewService.getOverviewData).mockResolvedValue({
      businessId: "biz_1",
      dateRange: { startDate: "2026-03-01", endDate: "2026-03-30" },
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
        "pins",
        "platforms",
        "shopifyServing",
        "storeMetrics",
        "webAnalytics",
      ].sort()
    );
    expect(payload.summary.comparison).toEqual({
      mode: "none",
      startDate: null,
      endDate: null,
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
        title: "Conv Rate · GA4",
        value: null,
        status: "unavailable",
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
        titles: ["Spend", "Revenue", "ROAS", "Purchases", "CPA"],
      },
      {
        provider: "google",
        titles: ["Spend", "Revenue", "ROAS", "Purchases", "CPA"],
      },
    ]);
    expect(payload.summary.webAnalytics.map((metric: { id: string }) => metric.id)).toEqual([
      "web-sessions",
      "web-engagement-rate",
      "web-session-duration",
      "web-conversion-rate",
    ]);
  });

  it("binds the reference GA4 tiles to measured analytics fields", async () => {
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
        value: 2.34,
        dataSource: { key: "ga4", label: "GA4" },
      })
    );
    expect(payload.summary.storeMetrics.find((metric: { id: string }) => metric.id === "store-new-customers")).toEqual(
      expect.objectContaining({
        value: 410,
        dataSource: { key: "ga4", label: "GA4" },
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
  });

  it("uses em dashes when target truth or GA4 conversion truth is unavailable", async () => {
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
        // A Shopify value exists, but the reference tile is explicitly GA4.
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
        value: null,
        status: "unavailable",
        dataSource: { key: "unavailable", label: "Unavailable" },
      })
    );
    expect(
      payload.summary.storeMetrics.find((metric: { id: string }) => metric.id === "store-new-customers")?.value
    ).toBeNull();
  });
});
