import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/google-analytics-reporting", () => ({
  resolveGa4AnalyticsContext: vi.fn(),
  runGA4Report: vi.fn(),
}));

vi.mock("@/lib/overview-service", () => ({
  getOverviewTrendBundle: vi.fn(),
}));

const access = await import("@/lib/access");
const googleAnalytics = await import("@/lib/google-analytics-reporting");
const overviewService = await import("@/lib/overview-service");
const { GET } = await import("@/app/api/overview-sparklines/route");

describe("GET /api/overview-sparklines", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      businessId: "biz_1",
    } as never);
    vi.mocked(overviewService.getOverviewTrendBundle).mockResolvedValue({
      combined: [
        { date: "2026-03-01", spend: 10, revenue: 20, purchases: 1 },
        { date: "2026-03-02", spend: 12, revenue: 24, purchases: 2 },
      ],
      providerTrends: {
        meta: [{ date: "2026-03-01", spend: 7, revenue: 14, purchases: 1, impressions: 700, clicks: 14 }],
        google: [{ date: "2026-03-01", spend: 3, revenue: 6, purchases: 0.5, impressions: null, clicks: null }],
      },
      providerTrendSources: { meta: "warehouse_published_account_daily", google: "warehouse_campaign_daily_fallback" },
      shopifyDaily: [
        {
          date: "2026-03-01",
          revenue: 19,
          purchases: 1,
          sessions: 40,
          conversionRate: 2.5,
          newCustomers: null,
          returningCustomers: null,
        },
      ],
      shopifyCommerceAvailable: true,
      shopifyConnectionState: "connected",
    } as never);
    vi.mocked(googleAnalytics.resolveGa4AnalyticsContext).mockResolvedValue({
      propertyId: "prop_1",
      accessToken: "token",
    } as never);
    vi.mocked(googleAnalytics.runGA4Report).mockResolvedValue({
      rows: [
        {
          dimensions: ["20260301"],
          metrics: ["100", "2", "120", "0.5", "60", "2", "1"],
        },
      ],
    } as never);
  });

  it("returns the sparkline contract with wrapped ga4Daily output", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/overview-sparklines?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-02",
    );

    const response = await GET(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toStrictEqual({
      sparklines: {
        combined: [
          { date: "2026-03-01", spend: 10, revenue: 20, purchases: 1 },
          { date: "2026-03-02", spend: 12, revenue: 24, purchases: 2 },
        ],
        // Provider delivery counts pass through unchanged, including unknown (null) ones.
        providerTrends: {
          meta: [{ date: "2026-03-01", spend: 7, revenue: 14, purchases: 1, impressions: 700, clicks: 14 }],
          google: [{ date: "2026-03-01", spend: 3, revenue: 6, purchases: 0.5, impressions: null, clicks: null }],
        },
        providerTrendSources: { meta: "warehouse_published_account_daily", google: "warehouse_campaign_daily_fallback" },
        shopifyDaily: [
          {
            date: "2026-03-01",
            revenue: 19,
            purchases: 1,
            sessions: 40,
            conversionRate: 2.5,
            newCustomers: null,
            returningCustomers: null,
          },
        ],
        shopifyCommerceAvailable: true,
        shopifyConnectionState: "connected",
        ga4Daily: [
          {
            date: "2026-03-01",
            sessions: 100,
            purchases: 2,
            revenue: 120,
            engagementRate: 0.5,
            avgSessionDuration: 60,
            totalPurchasers: 2,
            firstTimePurchasers: 1,
          },
        ],
      },
    });
  });

  it("serializes absent provider trend sources as explicit nulls", async () => {
    const trendBundle = await overviewService.getOverviewTrendBundle({} as never);
    vi.mocked(overviewService.getOverviewTrendBundle).mockResolvedValue({
      ...trendBundle,
      providerTrendSources: undefined,
    } as never);

    const request = new NextRequest(
      "http://localhost:3000/api/overview-sparklines?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-02",
    );
    const response = await GET(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.sparklines.providerTrendSources).toStrictEqual({ meta: null, google: null });
  });

  it("serializes an absent Shopify connection state as unknown", async () => {
    const trendBundle = await overviewService.getOverviewTrendBundle({} as never);
    vi.mocked(overviewService.getOverviewTrendBundle).mockResolvedValue({
      ...trendBundle,
      shopifyConnectionState: undefined,
    } as never);

    const request = new NextRequest(
      "http://localhost:3000/api/overview-sparklines?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-02",
    );
    const response = await GET(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.sparklines.shopifyConnectionState).toBe("unknown");
  });
});
