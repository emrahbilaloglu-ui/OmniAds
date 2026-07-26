import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ga4-user-facing-reports", () => ({
  GA4_DEMOGRAPHICS_DIMENSIONS: [
    "country",
    "region",
    "city",
    "language",
    "userAgeBracket",
    "userGender",
    "brandingInterest",
  ],
  GA4_USER_FACING_ROUTE_REPORT_TYPES: [
    "ga4_analytics_overview",
    "ga4_detailed_audience",
    "ga4_detailed_cohorts",
    "ga4_detailed_demographics",
    "ga4_landing_page_performance_v1",
    "ga4_detailed_landing_pages",
    "ga4_detailed_products",
  ],
  getGa4UserFacingRoutePayload: vi.fn(),
}));

vi.mock("@/lib/ga4-ecommerce-fallback", () => ({
  getGa4EcommerceFallbackData: vi.fn(),
}));

vi.mock("@/lib/reporting-cache-writer", () => ({
  writeCachedReportSnapshot: vi.fn(),
  writeCachedRouteReport: vi.fn(),
}));

/**
 * The warmer is a provider call and a durable cache write, so it is admitted
 * like any other source-related work unit. These cases exercise what it writes
 * once admitted; the refusal itself is asserted separately below.
 */
vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertSyncGrowthBoundary: vi.fn() };
});

vi.mock("@/lib/shopify/overview", () => ({
  getShopifyOverviewAggregate: vi.fn(),
}));

const ga4Reports = await import("@/lib/ga4-user-facing-reports");
const fallback = await import("@/lib/ga4-ecommerce-fallback");
const reportingCacheWriter = await import("@/lib/reporting-cache-writer");
const shopifyOverview = await import("@/lib/shopify/overview");
const dbGrowthFence = await import("@/lib/sync/db-growth-fence");
const {
  warmGa4UserFacingRouteReportCache,
  warmGa4EcommerceFallbackCache,
  warmShopifyOverviewReportCache,
} = await import("@/lib/user-facing-report-cache-owners");

describe("user-facing report cache owners", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_SOURCE_INGEST_ENABLED = "enabled";
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockResolvedValue({
      allowed: true,
      reason: "ready",
    } as never);
    vi.resetAllMocks();
    vi.mocked(ga4Reports.getGa4UserFacingRoutePayload).mockResolvedValue({ rows: [] } as never);
    vi.mocked(fallback.getGa4EcommerceFallbackData).mockResolvedValue({
      purchases: 2,
      revenue: 200,
      averageOrderValue: 100,
    });
    vi.mocked(reportingCacheWriter.writeCachedRouteReport).mockResolvedValue(undefined);
    vi.mocked(reportingCacheWriter.writeCachedReportSnapshot).mockResolvedValue(undefined);
    vi.mocked(shopifyOverview.getShopifyOverviewAggregate).mockResolvedValue({
      revenue: 300,
      purchases: 3,
      averageOrderValue: 100,
      sessions: null,
      conversionRate: null,
      newCustomers: null,
      returningCustomers: null,
      dailyTrends: [],
    } as never);
  });

  it("warms GA4 route cache entries through the explicit route writer", async () => {
    const result = await warmGa4UserFacingRouteReportCache({
      businessId: "biz_1",
      reportType: "ga4_detailed_demographics",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      dimension: "invalid_dimension",
    });

    expect(ga4Reports.getGa4UserFacingRoutePayload).toHaveBeenCalledWith({
      businessId: "biz_1",
      reportType: "ga4_detailed_demographics",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      dimension: "country",
    });
    expect(reportingCacheWriter.writeCachedRouteReport).toHaveBeenCalledTimes(1);
    const call = vi.mocked(reportingCacheWriter.writeCachedRouteReport).mock.calls[0]?.[0];
    expect(call).toEqual(
      expect.objectContaining({
        businessId: "biz_1",
        provider: "ga4",
        reportType: "ga4_detailed_demographics",
        payload: { rows: [] },
      }),
    );
    expect(call?.searchParams.get("dimension")).toBe("country");
    expect(result).toEqual(
      expect.objectContaining({
        reportType: "ga4_detailed_demographics",
        cacheType: "route_snapshot",
        dimension: "country",
      }),
    );
  });

  it("skips ecommerce fallback snapshot writes when no payload is available", async () => {
    vi.mocked(fallback.getGa4EcommerceFallbackData).mockResolvedValue(null);

    const result = await warmGa4EcommerceFallbackCache({
      businessId: "biz_1",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });

    expect(reportingCacheWriter.writeCachedReportSnapshot).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        reportType: "ecommerce_fallback",
        wrote: false,
      }),
    );
  });

  it("warms Shopify overview snapshots through the explicit snapshot writer", async () => {
    const result = await warmShopifyOverviewReportCache({
      businessId: "biz_1",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      forceRefresh: true,
    });

    expect(shopifyOverview.getShopifyOverviewAggregate).toHaveBeenCalledWith({
      businessId: "biz_1",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      forceRefresh: true,
    });
    expect(reportingCacheWriter.writeCachedReportSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        provider: "shopify",
        reportType: "overview_shopify_orders_aggregate_v6",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        reportType: "overview_shopify_orders_aggregate_v6",
        wrote: true,
      }),
    );
  });
});

describe("user-facing report cache warmer admission", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("makes no provider call and writes no cache under global-off", async () => {
    // The warmer is invoked from report routes and from the GA4 sweep, which is
    // exactly why it kept calling providers during a quiesce: it sits outside
    // the sync lanes' obvious surface.
    vi.clearAllMocks();
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    await expect(
      warmGa4UserFacingRouteReportCache({
        businessId: "biz_1",
        reportType: "ga4_analytics_overview",
        startDate: "2026-01-01",
        endDate: "2026-01-07",
      }),
    ).rejects.toMatchObject({ name: "SyncLaneDisabledError" });
    expect(ga4Reports.getGa4UserFacingRoutePayload).not.toHaveBeenCalled();
    expect(reportingCacheWriter.writeCachedRouteReport).not.toHaveBeenCalled();
    expect(reportingCacheWriter.writeCachedReportSnapshot).not.toHaveBeenCalled();
  });
});
