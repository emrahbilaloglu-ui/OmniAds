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

function overview(revenueSource: "shopify_warehouse" | "ad_platforms") {
  return {
    businessId: "biz_1",
    dateRange: { startDate: "2026-08-01", endDate: "2026-08-13" },
    kpis: { spend: 100, revenue: 1200, roas: 12, purchases: 8, cpa: 12.5, aov: 150 },
    kpiSources: {
      spend: { source: "ad_platforms", label: "Ad platforms" },
      revenue: { source: revenueSource, label: revenueSource === "shopify_warehouse" ? "Shopify Warehouse" : "Ad platforms" },
      roas: { source: "shopify_warehouse", label: "Shopify Warehouse" },
      purchases: { source: "shopify_warehouse", label: "Shopify Warehouse" },
    },
    totals: { impressions: 0, clicks: 0, purchases: 8, spend: 100, conversions: 8, revenue: 1200, ctr: 0, cpm: 0, cpc: 0, cpa: 12.5, roas: 12 },
    platformEfficiency: [],
    trends: {
      "7d": [],
      "14d": [],
      "30d": [{ date: "2026-08-13", spend: 100, revenue: 1200, purchases: 8 }],
      custom: [],
    },
  };
}

describe("Home Shopify revenue", () => {
  beforeEach(() => {
    vi.mocked(getIntegrationStatusByBusiness).mockResolvedValue({ shopify: true } as never);
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
});
