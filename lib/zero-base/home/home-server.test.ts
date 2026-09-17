import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/overview-service", () => ({ getOverviewData: vi.fn() }));
vi.mock("@/lib/integration-status", () => ({ getIntegrationStatusByBusiness: vi.fn() }));
vi.mock("@/lib/account-store", () => ({ getBusinessCurrency: vi.fn() }));
vi.mock("@/lib/business-commercial", () => ({ getBusinessCommercialTruthSnapshot: vi.fn() }));

import { getOverviewData } from "@/lib/overview-service";
import { getIntegrationStatusByBusiness } from "@/lib/integration-status";
import { getBusinessCurrency } from "@/lib/account-store";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import { readHomePageModel } from "@/lib/zero-base/home/home-server";

function overview(revenueSource: "shopify_warehouse" | "ga4_fallback" | "ad_platforms") {
  const commerceLabel =
    revenueSource === "shopify_warehouse"
      ? "Shopify Warehouse"
      : revenueSource === "ga4_fallback"
        ? "GA4"
        : "Ad platforms";
  return {
    businessId: "biz_1",
    dateRange: { startDate: "2026-08-01", endDate: "2026-08-13" },
    shopifyConnectionState: revenueSource === "ga4_fallback" ? "disconnected" : "connected",
    // Deliberately wrong aggregate ratios prove Home derives both formulas
    // from verified primitives instead of trusting a pre-blended field.
    kpis: { spend: 100, revenue: 1200, roas: 99, purchases: 8, cpa: 12.5, aov: 150 },
    kpiSources: {
      spend: { source: "ad_platforms", label: "Ad platforms" },
      revenue: { source: revenueSource, label: commerceLabel },
      roas: { source: revenueSource, label: commerceLabel },
      purchases: { source: revenueSource, label: commerceLabel },
    },
    totals: { impressions: 0, clicks: 0, purchases: 5, spend: 100, conversions: 5, revenue: 400, ctr: 0, cpm: 0, cpc: 0, cpa: 20, roas: 99 },
    providerSources: {
      meta: "warehouse_published_account_daily",
      google: "warehouse_account_aggregate",
    },
    providerScalarRanges: {
      meta: { startDate: "2026-08-01", endDate: "2026-08-13" },
      google: { startDate: "2026-08-01", endDate: "2026-08-13" },
    },
    providerTrendSources: {
      meta: "warehouse_published_account_daily",
      google: "warehouse_account_daily",
    },
    providerTrends: {
      meta: [{ date: "2026-08-13", spend: 60, revenue: 180, purchases: 3 }],
      google: [{ date: "2026-08-13", spend: 40, revenue: 220, purchases: 2 }],
    },
    platformEfficiency: [
      { platform: "meta", spend: 60, revenue: 180, roas: 3, purchases: 3, cpa: 20 },
      { platform: "google", spend: 40, revenue: 220, roas: 5.5, purchases: 2, cpa: 20 },
    ],
    trends: {
      "7d": [],
      "14d": [],
      "30d": [{ date: "2026-08-13", spend: 100, revenue: 1200, purchases: 8 }],
      custom: [{ date: "2026-08-13", spend: 100, revenue: 1200, purchases: 8 }],
    },
  };
}

describe("Home Shopify revenue", () => {
  beforeEach(() => {
    vi.mocked(getIntegrationStatusByBusiness).mockResolvedValue({
      meta: true,
      google: true,
      shopify: true,
    } as never);
    vi.mocked(getBusinessCurrency).mockResolvedValue("USD");
    vi.mocked(getBusinessCommercialTruthSnapshot).mockResolvedValue(null as never);
  });

  it("adds total sales from the Shopify-served revenue KPI", async () => {
    vi.mocked(getOverviewData).mockResolvedValue(overview("shopify_warehouse") as never);
    const model = await readHomePageModel({ businessId: "biz_1" });
    const revenue = model.contract.metrics[0];

    expect(revenue).toMatchObject({
      key: "revenue",
      title: "Total sales",
      value: 1200,
      availability: "available",
      source: { key: "shopify_warehouse", label: "Shopify Warehouse" },
    });
    expect(revenue.sparkline).toEqual([{ date: "2026-08-13", value: 1200 }]);
  });

  it("does not relabel ad-platform revenue as Shopify sales", async () => {
    vi.mocked(getOverviewData).mockResolvedValue(overview("ad_platforms") as never);
    const model = await readHomePageModel({ businessId: "biz_1" });

    expect(model.contract.metrics[0]).toMatchObject({
      key: "revenue",
      value: null,
      availability: "unavailable",
    });
  });

  it("keeps platform Blended ROAS separate from store MER in scalars and trends", async () => {
    vi.mocked(getOverviewData).mockResolvedValue(overview("shopify_warehouse") as never);
    const model = await readHomePageModel({ businessId: "biz_1" });
    const blended = model.contract.metrics.find((metric) => metric.key === "blended_roas");
    const mer = model.contract.metrics.find((metric) => metric.key === "mer");
    const spend = model.contract.metrics.find((metric) => metric.key === "spend");

    expect(blended).toMatchObject({
      title: "Blended ROAS vs target",
      value: 4,
      source: {
        key: "ad_platforms",
        label: "Meta Ads + Google Ads attributed conversion value / verified Meta Ads + Google Ads spend",
      },
    });
    expect(blended?.sparkline).toEqual([{ date: "2026-08-13", value: 4 }]);
    expect(mer).toMatchObject({
      value: 12,
      source: {
        key: "shopify_warehouse",
        label: "Shopify revenue / verified Meta Ads + Google Ads spend",
      },
    });
    expect(mer?.sparkline).toEqual([{ date: "2026-08-13", value: 12 }]);
    expect(spend?.sparkline).toEqual([{ date: "2026-08-13", value: 100 }]);
    expect(spend).toMatchObject({
      value: 100,
      source: { key: "ad_platforms", label: "Verified Meta Ads + Google Ads spend" },
    });
    expect(model.trend?.points).toEqual([{ date: "2026-08-13", spend: 100, roas: 4 }]);
  });

  it("serves a legitimate single-provider scope when the absent provider is confirmed disconnected", async () => {
    const data = overview("shopify_warehouse");
    data.providerSources.google = null as never;
    data.providerScalarRanges.google = null as never;
    data.providerTrendSources.google = null as never;
    data.providerTrends.google = undefined as never;
    data.platformEfficiency = data.platformEfficiency.filter((row) => row.platform !== "google");
    vi.mocked(getIntegrationStatusByBusiness).mockResolvedValue({
      meta: true,
      google: false,
      shopify: true,
    } as never);
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    expect(model.contract.metrics.find((metric) => metric.key === "spend")).toMatchObject({
      value: 60,
      availability: "available",
      source: { label: "Verified Meta Ads spend" },
    });
    expect(model.contract.metrics.find((metric) => metric.key === "blended_roas")).toMatchObject({
      value: 3,
      availability: "available",
      source: { label: "Meta Ads attributed conversion value / verified Meta Ads spend" },
    });
    expect(model.contract.metrics.find((metric) => metric.key === "mer")).toMatchObject({
      value: 20,
      availability: "available",
      source: { label: "Shopify revenue / verified Meta Ads spend" },
    });
    expect(model.trend?.points).toEqual([{ date: "2026-08-13", spend: 60, roas: 3 }]);
  });

  it("keeps verified historical rows in scope even when the provider is now disconnected", async () => {
    vi.mocked(getIntegrationStatusByBusiness).mockResolvedValue({
      meta: false,
      google: false,
      shopify: true,
    } as never);
    vi.mocked(getOverviewData).mockResolvedValue(overview("shopify_warehouse") as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    expect(model.contract.metrics.find((metric) => metric.key === "spend")?.value).toBe(100);
    expect(model.contract.metrics.find((metric) => metric.key === "blended_roas")?.value).toBe(4);
    expect(model.contract.metrics.find((metric) => metric.key === "mer")?.value).toBe(12);
  });

  it("fails the whole paid scope closed when a connected provider has no scalar evidence", async () => {
    const data = overview("shopify_warehouse");
    data.providerSources.google = null as never;
    data.providerScalarRanges.google = null as never;
    data.providerTrendSources.google = null as never;
    data.providerTrends.google = undefined as never;
    data.platformEfficiency = data.platformEfficiency.filter((row) => row.platform !== "google");
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    for (const key of ["spend", "blended_roas", "mer"]) {
      expect(model.contract.metrics.find((metric) => metric.key === key)).toMatchObject({
        value: null,
        availability: "unavailable",
        reason: "Paid-provider scope is missing a connected or unverified provider.",
      });
    }
    expect(model.trend).toBeNull();
  });

  it("fails the whole paid scope closed when provider connection status is unknown", async () => {
    const data = overview("shopify_warehouse");
    data.providerSources.google = null as never;
    data.providerScalarRanges.google = null as never;
    data.providerTrendSources.google = null as never;
    data.providerTrends.google = undefined as never;
    data.platformEfficiency = data.platformEfficiency.filter((row) => row.platform !== "google");
    vi.mocked(getIntegrationStatusByBusiness).mockRejectedValueOnce(new Error("status unavailable"));
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    expect(model.contract.metrics.find((metric) => metric.key === "spend")).toMatchObject({
      value: null,
      availability: "unavailable",
      reason: "Paid-provider scope is missing a connected or unverified provider.",
    });
    expect(model.trend).toBeNull();
  });

  it("fails scalar and daily paid metrics closed when a provider scalar range is short", async () => {
    const data = overview("shopify_warehouse");
    data.providerScalarRanges.meta.endDate = "2026-08-12";
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    for (const key of ["spend", "blended_roas", "mer"]) {
      expect(model.contract.metrics.find((metric) => metric.key === key)).toMatchObject({
        value: null,
        availability: "unavailable",
        reason: "Paid-provider scalar coverage does not cover the requested window.",
        sparkline: [],
      });
    }
    expect(model.trend).toBeNull();
  });

  it("omits dates missing an active provider from spend, MER and chart series", async () => {
    const data = overview("shopify_warehouse");
    data.providerTrends.meta = [
      { date: "2026-08-12", spend: 50, revenue: 150, purchases: 2 },
      { date: "2026-08-13", spend: 60, revenue: 180, purchases: 3 },
    ];
    data.trends.custom = [
      { date: "2026-08-12", spend: 50, revenue: 500, purchases: 4 },
      { date: "2026-08-13", spend: 100, revenue: 1200, purchases: 8 },
    ];
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    expect(model.contract.metrics.find((metric) => metric.key === "spend")?.sparkline).toEqual([
      { date: "2026-08-13", value: 100 },
    ]);
    expect(model.contract.metrics.find((metric) => metric.key === "blended_roas")?.sparkline).toEqual([
      { date: "2026-08-13", value: 4 },
    ]);
    expect(model.contract.metrics.find((metric) => metric.key === "mer")?.sparkline).toEqual([
      { date: "2026-08-13", value: 12 },
    ]);
    expect(model.trend?.points).toEqual([{ date: "2026-08-13", spend: 100, roas: 4 }]);
  });

  it("keeps a complete measured-zero spend day while omitting undefined ratio points", async () => {
    const data = overview("shopify_warehouse");
    data.providerTrends.meta = [
      { date: "2026-08-12", spend: 0, revenue: 0, purchases: 0 },
      ...data.providerTrends.meta,
    ];
    data.providerTrends.google = [
      { date: "2026-08-12", spend: 0, revenue: 0, purchases: 0 },
      ...data.providerTrends.google,
    ];
    data.trends.custom = [
      { date: "2026-08-12", spend: 0, revenue: 0, purchases: 0 },
      ...data.trends.custom,
    ];
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    expect(model.contract.metrics.find((metric) => metric.key === "spend")?.sparkline).toEqual([
      { date: "2026-08-12", value: 0 },
      { date: "2026-08-13", value: 100 },
    ]);
    expect(model.contract.metrics.find((metric) => metric.key === "blended_roas")?.sparkline).toEqual([
      { date: "2026-08-13", value: 4 },
    ]);
    expect(model.contract.metrics.find((metric) => metric.key === "mer")?.sparkline).toEqual([
      { date: "2026-08-13", value: 12 },
    ]);
    expect(model.trend?.points).toEqual([
      { date: "2026-08-12", spend: 0, roas: null },
      { date: "2026-08-13", spend: 100, roas: 4 },
    ]);
  });

  it("fails Spend, Blended ROAS and MER closed when a paid-provider scalar source is unverified", async () => {
    const data = overview("shopify_warehouse");
    data.providerSources.google = null as never;
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    expect(model.contract.metrics.find((metric) => metric.key === "spend")).toMatchObject({
      value: null,
      availability: "unavailable",
      reason: "Paid-provider scope contains an unverified or incomplete source.",
    });
    expect(model.contract.metrics.find((metric) => metric.key === "blended_roas")).toMatchObject({
      value: null,
      availability: "unavailable",
      reason: "Paid-provider scope contains an unverified or incomplete source.",
    });
    expect(model.contract.metrics.find((metric) => metric.key === "mer")).toMatchObject({
      value: null,
      availability: "unavailable",
      reason: "Paid-provider scope contains an unverified or incomplete source.",
    });
    expect(model.trend).toBeNull();
  });

  it("fails Blended ROAS and MER closed when verified paid spend is zero", async () => {
    const data = overview("shopify_warehouse");
    data.platformEfficiency = data.platformEfficiency.map((row) => ({
      ...row,
      spend: 0,
      revenue: 0,
      roas: 0,
      cpa: 0,
    }));
    data.providerTrends.meta = [{ date: "2026-08-13", spend: 0, revenue: 0, purchases: 0 }];
    data.providerTrends.google = [{ date: "2026-08-13", spend: 0, revenue: 0, purchases: 0 }];
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    expect(model.contract.metrics.find((metric) => metric.key === "spend")).toMatchObject({
      value: 0,
      availability: "available",
      sparkline: [{ date: "2026-08-13", value: 0 }],
    });
    expect(model.contract.metrics.find((metric) => metric.key === "blended_roas")).toMatchObject({
      value: null,
      availability: "unavailable",
      reason: "Verified paid-provider spend is zero for this window.",
    });
    expect(model.contract.metrics.find((metric) => metric.key === "mer")).toMatchObject({
      value: null,
      availability: "unavailable",
      reason: "Verified paid-provider spend is zero for this window.",
    });
    expect(model.trend?.points).toEqual([{ date: "2026-08-13", spend: 0, roas: null }]);
  });

  it("uses the full requested custom commerce series for windows longer than 30 days", async () => {
    const data = overview("shopify_warehouse");
    data.dateRange = { startDate: "2026-07-01", endDate: "2026-08-13" };
    data.providerScalarRanges = {
      meta: { startDate: "2026-07-01", endDate: "2026-08-13" },
      google: { startDate: "2026-07-01", endDate: "2026-08-13" },
    };
    data.platformEfficiency = [
      { platform: "meta", spend: 90, revenue: 270, roas: 3, purchases: 5, cpa: 18 },
      { platform: "google", spend: 50, revenue: 240, roas: 4.8, purchases: 3, cpa: 16.67 },
    ];
    data.kpis.revenue = 1640;
    data.kpis.purchases = 12;
    data.providerTrends.meta = [
      { date: "2026-07-01", spend: 30, revenue: 90, purchases: 2 },
      { date: "2026-08-13", spend: 60, revenue: 180, purchases: 3 },
    ];
    data.providerTrends.google = [
      { date: "2026-07-01", spend: 10, revenue: 20, purchases: 1 },
      { date: "2026-08-13", spend: 40, revenue: 220, purchases: 2 },
    ];
    data.trends["30d"] = [{ date: "2026-08-13", spend: 100, revenue: 1200, purchases: 8 }];
    data.trends.custom = [
      { date: "2026-07-01", spend: 40, revenue: 440, purchases: 4 },
      { date: "2026-08-13", spend: 100, revenue: 1200, purchases: 8 },
    ];
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    expect(model.contract.metrics.find((metric) => metric.key === "revenue")?.sparkline).toEqual([
      { date: "2026-07-01", value: 440 },
      { date: "2026-08-13", value: 1200 },
    ]);
    expect(model.contract.metrics.find((metric) => metric.key === "orders")?.sparkline).toEqual([
      { date: "2026-07-01", value: 4 },
      { date: "2026-08-13", value: 8 },
    ]);
    expect(model.contract.metrics.find((metric) => metric.key === "mer")?.sparkline).toEqual([
      { date: "2026-07-01", value: 11 },
      { date: "2026-08-13", value: 12 },
    ]);
  });

  it("uses GA4 commerce revenue only as an explicit Shopify-disconnected MER fallback", async () => {
    const data = overview("ga4_fallback");
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const fallbackModel = await readHomePageModel({ businessId: "biz_1" });
    expect(fallbackModel.contract.metrics.find((metric) => metric.key === "mer")).toMatchObject({
      value: 12,
      availability: "available",
      source: {
        key: "ga4_fallback",
        label: "GA4 ecommerce revenue fallback / verified Meta Ads + Google Ads spend",
      },
    });

    data.shopifyConnectionState = "connected";
    vi.mocked(getOverviewData).mockResolvedValue(data as never);
    const connectedModel = await readHomePageModel({ businessId: "biz_1" });
    expect(connectedModel.contract.metrics.find((metric) => metric.key === "mer")).toMatchObject({
      value: null,
      availability: "unavailable",
    });
  });

  it("omits all paid daily series when a trend source does not match its scalar", async () => {
    const data = overview("shopify_warehouse");
    data.providerTrendSources.google = "projection_fallback" as never;
    vi.mocked(getOverviewData).mockResolvedValue(data as never);

    const model = await readHomePageModel({ businessId: "biz_1" });

    expect(model.contract.metrics.find((metric) => metric.key === "spend")?.sparkline).toEqual([]);
    expect(model.contract.metrics.find((metric) => metric.key === "blended_roas")).toMatchObject({
      value: 4,
      sparkline: [],
    });
    expect(model.contract.metrics.find((metric) => metric.key === "mer")).toMatchObject({
      value: 12,
      sparkline: [],
    });
    expect(model.trend).toBeNull();
  });
});
