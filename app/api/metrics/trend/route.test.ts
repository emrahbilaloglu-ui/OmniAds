import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/overview-service", () => ({
  getOverviewData: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegrationsByBusiness: vi.fn(),
}));

import { getDemoSparklines } from "@/lib/demo-business";
import {
  getDemoOverviewMetricTrendData,
  getOverviewMetricTrendCommerceScope,
  getOverviewMetricTrendProviderScope,
  getOverviewMetricTrendValue,
} from "@/lib/overview-metric-trend";

const access = await import("@/lib/access");
const businessMode = await import("@/lib/business-mode.server");
const integrations = await import("@/lib/integrations");
const overviewService = await import("@/lib/overview-service");
const { GET } = await import("@/app/api/metrics/trend/route");

function providerOverview(input?: {
  meta?: boolean;
  google?: boolean;
  metaSource?: string | null;
  googleSource?: string | null;
  date?: string;
  startDate?: string;
  endDate?: string;
  shopifyConnectionState?: "connected" | "disconnected" | "unknown";
  commerceSource?:
    | "shopify_ledger"
    | "shopify_warehouse"
    | "shopify_live_fallback"
    | "ga4_fallback"
    | "unavailable";
}) {
  const meta = input?.meta ?? true;
  const google = input?.google ?? true;
  const date = input?.date ?? "2026-02-10";
  const startDate = input?.startDate ?? date;
  const endDate = input?.endDate ?? date;
  const shopifyConnectionState = input?.shopifyConnectionState ?? "connected";
  const commerceSource = input?.commerceSource ?? "shopify_warehouse";
  const rows = [
    ...(meta
      ? [{ platform: "meta", spend: 100, revenue: 300, roas: 3, purchases: 3, cpa: 33.33 }]
      : []),
    ...(google
      ? [{ platform: "google", spend: 50, revenue: 100, roas: 2, purchases: 1, cpa: 50 }]
      : []),
  ];
  return {
    businessId: "biz_1",
    dateRange: { startDate, endDate },
    shopifyConnectionState,
    kpis: { spend: 150, revenue: 1_000, purchases: 10, roas: 6.67, cpa: 15, aov: 100 },
    kpiSources: {
      spend: { source: "ad_platforms", label: "Ad platforms" },
      revenue: { source: commerceSource, label: "Commerce" },
      purchases: { source: commerceSource, label: "Commerce" },
    },
    providerSources: {
      meta: meta ? (input?.metaSource ?? "warehouse_published_account_daily") : null,
      google: google ? (input?.googleSource ?? "warehouse_account_aggregate") : null,
    },
    providerScalarRanges: {
      meta: meta ? { startDate, endDate } : null,
      google: google ? { startDate, endDate } : null,
    },
    platformEfficiency: rows,
    totals: {
      impressions: 0,
      clicks: 0,
      purchases: 4,
      spend: 150,
      conversions: 4,
      revenue: 400,
      ctr: 0,
      cpm: 0,
      cpc: 0,
      cpa: 37.5,
      roas: 2.67,
    },
    trends: { "7d": [], "14d": [], "30d": [], custom: [] },
  };
}

describe("overview metric trend formulas", () => {
  it("keeps store MER separate from weighted platform Blended ROAS", () => {
    const input = {
      overview: {
        shopifyConnectionState: "connected" as const,
        kpis: { spend: 150, revenue: 1_000, purchases: 10 },
        kpiSources: { revenue: { source: "shopify_warehouse" } },
        providerSources: { meta: "warehouse_published_account_daily", google: "warehouse_account_aggregate" },
        platformEfficiency: [
          { platform: "meta", spend: 100, revenue: 300 },
          { platform: "google", spend: 50, revenue: 100 },
          // Non-paid rows never enter the platform-attributed numerator.
          { platform: "organic", spend: 0, revenue: 600 },
        ],
      },
      google: null,
      analytics: null,
    };

    expect(getOverviewMetricTrendValue("mer", input)).toBeCloseTo(6.6667, 4);
    expect(getOverviewMetricTrendValue("blended_roas", input)).toBeCloseTo(2.6667, 4);
  });

  it("fails closed instead of relabeling platform revenue as MER", () => {
    const unavailableCommerce = {
      overview: {
        shopifyConnectionState: "connected" as const,
        kpis: { spend: 100, revenue: 300, purchases: 3 },
        kpiSources: { revenue: { source: "unavailable" } },
        providerSources: { meta: "warehouse_published_account_daily", google: null },
        platformEfficiency: [{ platform: "meta", spend: 100, revenue: 300 }],
      },
      google: null,
      analytics: null,
    };

    expect(getOverviewMetricTrendValue("mer", unavailableCommerce)).toBeNull();
    expect(getOverviewMetricTrendValue("blended_roas", unavailableCommerce)).toBe(3);
  });

  it("withholds a blended ratio when a paid row has an unknown scalar source", () => {
    const input = {
      overview: {
        shopifyConnectionState: "connected" as const,
        kpis: { spend: 150, revenue: 1_000, purchases: 10 },
        kpiSources: { revenue: { source: "shopify_warehouse" } },
        providerSources: { meta: null, google: "warehouse_account_aggregate" },
        platformEfficiency: [
          { platform: "meta", spend: 100, revenue: 300 },
          { platform: "google", spend: 50, revenue: 100 },
        ],
      },
      google: null,
      analytics: null,
    };

    expect(getOverviewMetricTrendValue("blended_roas", input)).toBeNull();
    expect(getOverviewMetricTrendValue("mer", input)).toBeNull();
  });

  it("keeps failed reads and absent provider rows as gaps", () => {
    const failed = { overview: null, google: null, analytics: null };

    for (const metric of [
      "revenue",
      "spend",
      "orders",
      "aov",
      "cpa",
      "meta-spend",
      "google-spend",
      "clicks",
      "conversion_rate",
    ]) {
      expect(getOverviewMetricTrendValue(metric, failed), metric).toBeNull();
    }

    expect(
      getOverviewMetricTrendValue("google-clicks", {
        overview: providerOverview({ google: false }),
        google: { kpis: { clicks: 0 } },
        analytics: null,
      }),
    ).toBeNull();
  });

  it("preserves reported additive zeroes and omits ratios with zero denominators", () => {
    const input = {
      overview: {
        shopifyConnectionState: "connected" as const,
        kpis: { spend: 0, revenue: 0, purchases: 0 },
        kpiSources: {
          revenue: { source: "shopify_warehouse" },
          purchases: { source: "shopify_warehouse" },
        },
        providerSources: { meta: "warehouse_published_account_daily", google: null },
        platformEfficiency: [
          {
            platform: "meta",
            spend: 0,
            revenue: 0,
            purchases: 0,
            impressions: 0,
            clicks: 0,
          },
        ],
      },
      google: { kpis: { clicks: 0, impressions: 0, ctr: 0 } },
      analytics: { kpis: { sessions: 10, purchaseCvr: 0 } },
    };

    expect(getOverviewMetricTrendValue("revenue", input)).toBe(0);
    expect(getOverviewMetricTrendValue("orders", input)).toBe(0);
    expect(getOverviewMetricTrendValue("spend", input)).toBe(0);
    expect(getOverviewMetricTrendValue("meta-spend", input)).toBe(0);
    expect(getOverviewMetricTrendValue("conversion_rate", input)).toBe(0);
    expect(getOverviewMetricTrendValue("aov", input)).toBeNull();
    expect(getOverviewMetricTrendValue("cpa", input)).toBeNull();
    expect(getOverviewMetricTrendValue("meta-roas", input)).toBeNull();
  });

  it("omits ready-made rates when their reported denominator is zero", () => {
    const input = {
      overview: providerOverview(),
      google: { kpis: { impressions: 0, ctr: 0 } },
      analytics: { kpis: { sessions: 0, purchaseCvr: 0 } },
    };

    expect(getOverviewMetricTrendValue("conversion_rate", input)).toBeNull();
    expect(getOverviewMetricTrendValue("ctr", input)).toBeNull();
    expect(getOverviewMetricTrendValue("google-ctr", input)).toBeNull();

    const measuredZeroRate = {
      ...input,
      google: { kpis: { impressions: 100, ctr: 0 } },
      analytics: { kpis: { sessions: 100, purchaseCvr: 0 } },
    };
    expect(getOverviewMetricTrendValue("conversion_rate", measuredZeroRate)).toBe(0);
    expect(getOverviewMetricTrendValue("ctr", measuredZeroRate)).toBe(0);
    expect(getOverviewMetricTrendValue("google-ctr", measuredZeroRate)).toBe(0);
  });

  it("treats an intentionally empty disconnected paid scope as measured zero spend", () => {
    const overview = {
      dateRange: { startDate: "2026-02-10", endDate: "2026-02-11" },
      providerSources: { meta: null, google: null },
      providerScalarRanges: { meta: null, google: null },
      platformEfficiency: [],
    };
    const providerScope = getOverviewMetricTrendProviderScope(overview, {
      connections: { meta: "disconnected", google: "disconnected" },
      requestedRange: overview.dateRange,
    });

    expect(providerScope?.activeProviders).toEqual([]);
    expect(
      getOverviewMetricTrendValue("spend", {
        overview,
        google: null,
        analytics: null,
        providerScope,
      }),
    ).toBe(0);
    expect(
      getOverviewMetricTrendValue("blended_roas", {
        overview,
        google: null,
        analytics: null,
        providerScope,
      }),
    ).toBeNull();
  });

  it("requires every full-window provider on each MER and Blended ROAS day", () => {
    const fullWindow = providerOverview();
    const providerScope = getOverviewMetricTrendProviderScope(fullWindow);
    const missingMetaDay = providerOverview({ meta: false });
    const sourceSwitchedDay = providerOverview({
      googleSource: "warehouse_campaign_aggregate_fallback",
    });

    expect(providerScope?.activeProviders).toEqual(["meta", "google"]);
    for (const metric of ["spend", "cpa", "mer", "blended_roas"]) {
      expect(
        getOverviewMetricTrendValue(metric, {
          overview: missingMetaDay,
          google: null,
          analytics: null,
          providerScope,
        }),
      ).toBeNull();
      expect(
        getOverviewMetricTrendValue(metric, {
          overview: sourceSwitchedDay,
          google: null,
          analytics: null,
          providerScope,
        }),
      ).toBeNull();
    }
  });

  it("builds provider membership from a complete requested-window read and one connection snapshot", () => {
    const requestedRange = { startDate: "2026-02-10", endDate: "2026-02-11" };
    const historicalMeta = providerOverview({
      google: false,
      ...requestedRange,
    });
    const disconnected = {
      meta: "disconnected" as const,
      google: "disconnected" as const,
    };

    expect(
      getOverviewMetricTrendProviderScope(historicalMeta, {
        connections: disconnected,
        requestedRange,
      }),
    ).toEqual({
      activeProviders: ["meta"],
      sources: {
        meta: "warehouse_published_account_daily",
        google: null,
      },
    });

    expect(
      getOverviewMetricTrendProviderScope(historicalMeta, {
        connections: { ...disconnected, google: "connected" },
        requestedRange,
      }),
    ).toBeNull();
    expect(
      getOverviewMetricTrendProviderScope(historicalMeta, {
        connections: { ...disconnected, google: "unknown" },
        requestedRange,
      }),
    ).toBeNull();

    const partialRange = providerOverview({ ...requestedRange });
    partialRange.providerScalarRanges.meta = {
      startDate: requestedRange.startDate,
      endDate: requestedRange.startDate,
    };
    expect(
      getOverviewMetricTrendProviderScope(partialRange, {
        connections: disconnected,
        requestedRange,
      }),
    ).toBeNull();

    const mismatched = providerOverview({ google: false, ...requestedRange });
    mismatched.providerSources.google = "warehouse_account_aggregate";
    expect(
      getOverviewMetricTrendProviderScope(mismatched, {
        connections: disconnected,
        requestedRange,
      }),
    ).toBeNull();
  });

  it("freezes Shopify versus GA4 commerce authority while allowing Shopify source variants", () => {
    const fullWindow = providerOverview();
    const commerceScope = getOverviewMetricTrendCommerceScope(fullWindow, {
      shopify: "connected",
      ga4: "disconnected",
    });
    const providerScope = getOverviewMetricTrendProviderScope(fullWindow);
    const shopifyVariantDay = providerOverview({
      commerceSource: "shopify_live_fallback",
    });
    const ga4Day = providerOverview({
      shopifyConnectionState: "disconnected",
      commerceSource: "ga4_fallback",
    });

    expect(commerceScope).toEqual({ revenue: "shopify", purchases: "shopify" });
    expect(
      getOverviewMetricTrendValue("aov", {
        overview: shopifyVariantDay,
        google: null,
        analytics: null,
        commerceScope,
      }),
    ).toBe(100);
    for (const metric of ["revenue", "orders", "aov", "mer", "cpa"]) {
      expect(
        getOverviewMetricTrendValue(metric, {
          overview: ga4Day,
          google: null,
          analytics: null,
          providerScope,
          commerceScope,
        }),
        metric,
      ).toBeNull();
    }

    const ga4Window = providerOverview({
      shopifyConnectionState: "disconnected",
      commerceSource: "ga4_fallback",
    });
    expect(
      getOverviewMetricTrendCommerceScope(ga4Window, {
        shopify: "connected",
        ga4: "connected",
      }),
    ).toBeNull();
  });

  it("derives demo MER and Blended ROAS from each day's own source rows", () => {
    const dates = ["2026-02-10", "2026-02-11"];
    const demo = getDemoSparklines();
    const combined = new Map(demo.combined.map((point) => [point.date, point]));
    const meta = new Map(demo.providerTrends.meta.map((point) => [point.date, point]));
    const google = new Map(demo.providerTrends.google.map((point) => [point.date, point]));

    const mer = getDemoOverviewMetricTrendData("mer", dates);
    const blended = getDemoOverviewMetricTrendData("blended_roas", dates);

    expect(mer).toEqual(
      dates.map((date) => ({
        date,
        value: combined.get(date)!.revenue / combined.get(date)!.spend,
      })),
    );
    expect(blended).toEqual(
      dates.map((date) => ({
        date,
        value:
          (meta.get(date)!.revenue + google.get(date)!.revenue) /
          (meta.get(date)!.spend + google.get(date)!.spend),
      })),
    );
    expect(mer[0]!.value).not.toBe(mer[1]!.value);
    expect(blended[0]!.value).not.toBe(blended[1]!.value);
  });
});

describe("GET /api/metrics/trend", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({ businessId: "biz_1" } as never);
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(integrations.getIntegrationsByBusiness).mockResolvedValue([
      { provider: "meta", status: "connected" },
      { provider: "google", status: "connected" },
      { provider: "shopify", status: "connected" },
    ] as never);
  });

  it("uses no-trend overview reads and drops a day missing a full-window provider", async () => {
    vi.mocked(overviewService.getOverviewData).mockImplementation(async (params) => {
      if (params.startDate === "2026-02-10" && params.endDate === "2026-02-11") {
        return providerOverview({
          startDate: "2026-02-10",
          endDate: "2026-02-11",
        }) as never;
      }
      if (params.startDate === "2026-02-10") {
        return providerOverview({ date: "2026-02-10" }) as never;
      }
      return providerOverview({ meta: false, date: "2026-02-11" }) as never;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/metrics/trend?businessId=biz_1&metric=blended_roas&startDate=2026-02-10&endDate=2026-02-11",
      ),
    );
    const payload = await response.json();
    const internalFetchCalls = fetchSpy.mock.calls.length;
    fetchSpy.mockRestore();

    expect(payload).toEqual({
      metric: "blended_roas",
      data: [{ date: "2026-02-10", value: 400 / 150 }],
    });
    expect(overviewService.getOverviewData).toHaveBeenCalledTimes(3);
    expect(vi.mocked(overviewService.getOverviewData).mock.calls).toSatisfy(
      (calls: Array<[Record<string, unknown>]>) =>
        calls.every(([params]) => params.includeTrends === false),
    );
    expect(integrations.getIntegrationsByBusiness).toHaveBeenCalledTimes(1);
    expect(internalFetchCalls).toBe(0);
  });

  it("freezes the full-window provider set for generic spend", async () => {
    vi.mocked(overviewService.getOverviewData).mockImplementation(async (params) => {
      if (params.startDate === "2026-02-10" && params.endDate === "2026-02-11") {
        return providerOverview({
          startDate: "2026-02-10",
          endDate: "2026-02-11",
        }) as never;
      }
      return params.startDate === "2026-02-10"
        ? providerOverview({ date: "2026-02-10" }) as never
        : providerOverview({ google: false, date: "2026-02-11" }) as never;
    });

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/metrics/trend?businessId=biz_1&metric=spend&startDate=2026-02-10&endDate=2026-02-11",
      ),
    );

    expect(await response.json()).toEqual({
      metric: "spend",
      data: [{ date: "2026-02-10", value: 150 }],
    });
    expect(overviewService.getOverviewData).toHaveBeenCalledTimes(3);
    expect(integrations.getIntegrationsByBusiness).toHaveBeenCalledTimes(1);
  });

  it("skips an absent provider only when the frozen status confirms it is disconnected", async () => {
    vi.mocked(integrations.getIntegrationsByBusiness).mockResolvedValue([
      { provider: "meta", status: "connected" },
      { provider: "google", status: "disconnected" },
      { provider: "shopify", status: "connected" },
    ] as never);
    vi.mocked(overviewService.getOverviewData).mockImplementation(async (params) =>
      providerOverview({
        google: false,
        startDate: params.startDate ?? "2026-02-10",
        endDate: params.endDate ?? "2026-02-10",
      }) as never,
    );

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/metrics/trend?businessId=biz_1&metric=spend&startDate=2026-02-10&endDate=2026-02-11",
      ),
    );

    expect(await response.json()).toEqual({
      metric: "spend",
      data: [
        { date: "2026-02-10", value: 100 },
        { date: "2026-02-11", value: 100 },
      ],
    });
  });

  it("fails closed before daily reads when provider status is unknown or full-window coverage is partial", async () => {
    vi.mocked(integrations.getIntegrationsByBusiness).mockRejectedValue(
      new Error("integration status unavailable"),
    );
    vi.mocked(overviewService.getOverviewData).mockResolvedValue(
      providerOverview({
        google: false,
        startDate: "2026-02-10",
        endDate: "2026-02-11",
      }) as never,
    );

    const unknownStatusResponse = await GET(
      new NextRequest(
        "http://localhost:3000/api/metrics/trend?businessId=biz_1&metric=spend&startDate=2026-02-10&endDate=2026-02-11",
      ),
    );
    expect(await unknownStatusResponse.json()).toEqual({ metric: "spend", data: [] });
    expect(overviewService.getOverviewData).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({ businessId: "biz_1" } as never);
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(integrations.getIntegrationsByBusiness).mockResolvedValue([
      { provider: "meta", status: "connected" },
      { provider: "google", status: "disconnected" },
      { provider: "shopify", status: "connected" },
    ] as never);
    const partial = providerOverview({
      google: false,
      startDate: "2026-02-10",
      endDate: "2026-02-11",
    });
    partial.providerScalarRanges.meta = {
      startDate: "2026-02-10",
      endDate: "2026-02-10",
    };
    vi.mocked(overviewService.getOverviewData).mockResolvedValue(partial as never);

    const partialRangeResponse = await GET(
      new NextRequest(
        "http://localhost:3000/api/metrics/trend?businessId=biz_1&metric=spend&startDate=2026-02-10&endDate=2026-02-11",
      ),
    );
    expect(await partialRangeResponse.json()).toEqual({ metric: "spend", data: [] });
    expect(overviewService.getOverviewData).toHaveBeenCalledTimes(1);
  });

  it("freezes paid spend and commerce authority for CPA", async () => {
    vi.mocked(overviewService.getOverviewData).mockImplementation(async (params) => {
      if (params.startDate === "2026-02-10" && params.endDate === "2026-02-11") {
        return providerOverview({
          startDate: "2026-02-10",
          endDate: "2026-02-11",
        }) as never;
      }
      if (params.startDate === "2026-02-10") {
        return providerOverview({ date: "2026-02-10" }) as never;
      }
      return providerOverview({
        date: "2026-02-11",
        shopifyConnectionState: "disconnected",
        commerceSource: "ga4_fallback",
      }) as never;
    });

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/metrics/trend?businessId=biz_1&metric=cpa&startDate=2026-02-10&endDate=2026-02-11",
      ),
    );

    expect(await response.json()).toEqual({
      metric: "cpa",
      data: [{ date: "2026-02-10", value: 15 }],
    });
    expect(integrations.getIntegrationsByBusiness).toHaveBeenCalledTimes(1);
  });

  it("keeps a Shopify revenue trend from switching to GA4 after a reconnect race", async () => {
    vi.mocked(overviewService.getOverviewData).mockImplementation(async (params) => {
      if (params.startDate === "2026-02-10" && params.endDate === "2026-02-11") {
        return providerOverview({
          startDate: "2026-02-10",
          endDate: "2026-02-11",
        }) as never;
      }
      return params.startDate === "2026-02-10"
        ? providerOverview({ date: "2026-02-10", commerceSource: "shopify_live_fallback" }) as never
        : providerOverview({
            date: "2026-02-11",
            shopifyConnectionState: "disconnected",
            commerceSource: "ga4_fallback",
          }) as never;
    });

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/metrics/trend?businessId=biz_1&metric=revenue&startDate=2026-02-10&endDate=2026-02-11",
      ),
    );

    expect(await response.json()).toEqual({
      metric: "revenue",
      data: [{ date: "2026-02-10", value: 1_000 }],
    });
    expect(overviewService.getOverviewData).toHaveBeenCalledTimes(3);
    expect(integrations.getIntegrationsByBusiness).toHaveBeenCalledTimes(1);
  });

  it("returns gaps instead of zeroes when daily overview reads fail", async () => {
    vi.mocked(overviewService.getOverviewData).mockRejectedValue(new Error("overview unavailable"));

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/metrics/trend?businessId=biz_1&metric=spend&startDate=2026-02-10&endDate=2026-02-11",
      ),
    );

    expect(await response.json()).toEqual({ metric: "spend", data: [] });
  });

  it("turns a rejected auxiliary internal read into a gap", async () => {
    vi.mocked(overviewService.getOverviewData).mockResolvedValue(providerOverview() as never);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("analytics endpoint unavailable"));

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/metrics/trend?businessId=biz_1&metric=conversion_rate&startDate=2026-02-10&endDate=2026-02-10",
      ),
    );
    fetchSpy.mockRestore();

    expect(await response.json()).toEqual({ metric: "conversion_rate", data: [] });
  });
});
