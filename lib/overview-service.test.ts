import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopifyStatusResponse } from "@/lib/shopify/status";

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/account-store", () => ({
  getBusinessTimezone: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  getDemoOverview: vi.fn(),
  getDemoSparklines: vi.fn(),
  isDemoBusinessId: vi.fn(),
}));

vi.mock("@/lib/google-ads/serving", () => ({
  getGoogleCanonicalOverviewSummary: vi.fn(),
  getGoogleCanonicalOverviewTrends: vi.fn(),
}));

vi.mock("@/lib/google-analytics-reporting", () => ({
  resolveGa4AnalyticsContext: vi.fn(),
  runGA4Report: vi.fn(),
}));

vi.mock("@/lib/ga4-ecommerce-fallback", () => ({
  getGa4EcommerceFallbackData: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
  getIntegrationMetadata: vi.fn(),
}));

vi.mock("@/lib/meta/canonical-overview", () => ({
  getMetaCanonicalOverviewSummary: vi.fn(),
  getMetaCanonicalOverviewTrends: vi.fn(),
}));

vi.mock("@/lib/reporting-cache", () => ({
  getCachedReport: vi.fn(),
  getReportingDateRangeKey: vi.fn(() => "cache-key"),
  setCachedReport: vi.fn(),
}));

vi.mock("@/lib/shopify/read-adapter", () => ({
  getShopifyOverviewReadCandidate: vi.fn(),
  getShopifyOverviewSummaryReadCandidate: vi.fn(),
}));

vi.mock("@/lib/shopify/customer-events-analytics", () => ({
  getShopifyCustomerEventsAggregate: vi.fn(),
}));

const accountStore = await import("@/lib/account-store");
const businessMode = await import("@/lib/business-mode.server");
const demo = await import("@/lib/demo-business");
const ga4Fallback = await import("@/lib/ga4-ecommerce-fallback");
const googleServing = await import("@/lib/google-ads/serving");
const integrations = await import("@/lib/integrations");
const metaCanonical = await import("@/lib/meta/canonical-overview");
const reportingCache = await import("@/lib/reporting-cache");
const shopifyCustomerEvents = await import("@/lib/shopify/customer-events-analytics");
const shopifyReadAdapter = await import("@/lib/shopify/read-adapter");
const { buildPlatformSections } = await import("@/lib/overview-summary-support");
const {
  getOverviewData,
  getOverviewTrendBundle,
  getShopifyOverviewServingData,
} = await import("@/lib/overview-service");

function buildShopifyStatus(
  overrides: Partial<ShopifyStatusResponse> = {},
): ShopifyStatusResponse {
  return {
    state: "not_connected",
    connected: false,
    shopId: null,
    warehouse: null,
    sync: null,
    serving: null,
    reconciliation: null,
    issues: [],
    ...overrides,
  };
}

function buildReadCandidate(
  overrides: Partial<
    Awaited<ReturnType<typeof shopifyReadAdapter.getShopifyOverviewReadCandidate>>
  > = {},
): Awaited<ReturnType<typeof shopifyReadAdapter.getShopifyOverviewReadCandidate>> {
  return {
    status: buildShopifyStatus(),
    live: null,
    warehouse: null,
    ledger: null,
    override: null,
    divergence: null,
    ledgerConsistency: null,
    decisionReasons: [],
    canaryEnabled: false,
    preferredSource: "none",
    canServeWarehouse: false,
    servingMetadata: {
      source: "none",
      provider: "shopify",
      trustState: "no_data",
      fallbackReason: null,
      lastSyncedAt: null,
      coverageStatus: "unknown",
      productionMode: "disabled",
      pendingRepair: false,
      pendingRepairStartedAt: null,
      pendingRepairLastTopic: null,
      pendingRepairLastReceivedAt: null,
      selectedRevenueTruthBasis: null,
      basisSelectionReason: null,
      transactionCoverageOrderRate: null,
      transactionCoverageAmountRate: null,
      explainedAdjustmentRevenue: 0,
      unexplainedAdjustmentRevenue: 0,
    },
    ...overrides,
  };
}

describe("overview-service canonical orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(accountStore.getBusinessTimezone).mockResolvedValue("UTC" as never);
    vi.mocked(demo.isDemoBusinessId).mockReturnValue(false);
    vi.mocked(ga4Fallback.getGa4EcommerceFallbackData).mockResolvedValue(null);
    vi.mocked(reportingCache.getCachedReport).mockResolvedValue(null);
    vi.mocked(integrations.getIntegration).mockResolvedValue(null);
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue(null);
    vi.mocked(metaCanonical.getMetaCanonicalOverviewSummary).mockResolvedValue({
      totals: { spend: 120, revenue: 480, conversions: 6 },
      accounts: [
        {
          providerAccountId: "act_1",
          spend: 120,
          revenue: 480,
          conversions: 6,
          roas: 4,
        },
      ],
      isPartial: false,
      notReadyReason: null,
      readSource: "warehouse_published",
      warehouseScope: "account_daily",
    } as never);
    vi.mocked(metaCanonical.getMetaCanonicalOverviewTrends).mockResolvedValue({
      points: [],
      isPartial: false,
      notReadyReason: null,
      readSource: "warehouse_published",
      warehouseScope: "account_daily",
      meta: { readSource: "warehouse_published" },
    } as never);
    vi.mocked(googleServing.getGoogleCanonicalOverviewSummary).mockResolvedValue({
      kpis: {
        spend: 30,
        revenue: 90,
        conversions: 3,
        roas: 3,
        cpa: 10,
        cpc: 1,
        ctr: 2,
        impressions: 1000,
        clicks: 30,
        convRate: 10,
      },
      kpiDeltas: undefined,
      summary: {
        totalAccounts: 1,
        readSource: "warehouse_account_aggregate",
      },
      meta: {
        readSource: "warehouse_account_aggregate",
      },
    } as never);
    vi.mocked(googleServing.getGoogleCanonicalOverviewTrends).mockResolvedValue({
      points: [],
      meta: {
        readSource: "warehouse_account_daily",
        fallbackReason: null,
        degraded: false,
      },
    } as never);
    vi.mocked(shopifyReadAdapter.getShopifyOverviewReadCandidate).mockResolvedValue(
      buildReadCandidate() as never,
    );
    vi.mocked(shopifyReadAdapter.getShopifyOverviewSummaryReadCandidate).mockResolvedValue(
      buildReadCandidate() as never,
    );
    vi.mocked(shopifyCustomerEvents.getShopifyCustomerEventsAggregate).mockResolvedValue({
      sessions: 0,
      sessionlessEvents: 0,
      pageViews: 0,
      productViews: 0,
      addToCart: 0,
      beginCheckout: 0,
      purchases: 0,
      productViewSessions: 0,
      addToCartSessions: 0,
      beginCheckoutSessions: 0,
      purchaseSessions: 0,
      productViewRate: null,
      addToCartRate: null,
      checkoutRate: null,
      checkoutCompletionRate: null,
      conversionRate: null,
      daily: [],
    });
  });

  it("composes Meta and Google overview fragments from canonical provider helpers", async () => {
    const overview = await getOverviewData({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-15",
      includeTrends: false,
    });

    expect(metaCanonical.getMetaCanonicalOverviewSummary).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-15",
    });
    expect(googleServing.getGoogleCanonicalOverviewSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        dateRange: "custom",
        customStart: "2026-03-01",
        customEnd: "2026-03-15",
        compareMode: "none",
        source: "overview_aggregation_route",
      }),
    );
    expect(overview.kpis.spend).toBe(150);
    expect(overview.kpis.revenue).toBe(570);
    expect(overview.kpis.purchases).toBe(9);
  });

  it("keeps Meta visible in overview when current-day live totals have no account rows yet", async () => {
    vi.mocked(metaCanonical.getMetaCanonicalOverviewSummary).mockResolvedValue({
      totals: { spend: 23.22, revenue: 0, conversions: 0, roas: 0 },
      accounts: [],
      isPartial: false,
      notReadyReason: null,
      readSource: "current_day_live",
    } as never);
    vi.mocked(googleServing.getGoogleCanonicalOverviewSummary).mockResolvedValue({
      kpis: {
        spend: 14.31,
        revenue: 0,
        conversions: 0,
        roas: 0,
        cpa: 0,
        cpc: 0,
        ctr: 0,
        impressions: 0,
        clicks: 0,
        convRate: 0,
      },
      kpiDeltas: undefined,
      summary: {
        totalAccounts: 1,
        readSource: "live_overlay_current_day",
      },
      meta: {
        readSource: "live_overlay_current_day",
      },
    } as never);

    const overview = await getOverviewData({
      businessId: "biz",
      startDate: "2026-04-08",
      endDate: "2026-04-08",
      includeTrends: false,
    });

    expect(overview.platformEfficiency).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "meta",
          spend: 23.22,
        }),
      ]),
    );
    expect(overview.kpis.spend).toBe(37.53);
  });

  it("blocks GA4 commerce fallback whenever Shopify is connected", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      provider_account_id: "grandmix.myshopify.com",
    } as never);
    vi.mocked(ga4Fallback.getGa4EcommerceFallbackData).mockResolvedValue({
      revenue: 999,
      purchases: 9,
      averageOrderValue: 111,
    });
    vi.mocked(shopifyReadAdapter.getShopifyOverviewSummaryReadCandidate).mockResolvedValue(
      buildReadCandidate({
        status: buildShopifyStatus({
          state: "partial",
          connected: true,
          shopId: "grandmix.myshopify.com",
        }),
      }) as never,
    );

    const overview = await getOverviewData({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-15",
      includeTrends: false,
    });

    expect(ga4Fallback.getGa4EcommerceFallbackData).not.toHaveBeenCalled();
    expect(overview.shopifyConnectionState).toBe("connected");
    expect(overview.kpiSources.revenue).toEqual({
      source: "unavailable",
      label: "Unavailable",
    });
    expect(overview.kpiSources.purchases?.source).toBe("unavailable");
    expect(overview.kpiSources.aov?.source).toBe("unavailable");
  });

  it("uses GA4 commerce fallback when Shopify is confirmed disconnected", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue(null);
    vi.mocked(ga4Fallback.getGa4EcommerceFallbackData).mockResolvedValue({
      revenue: 900,
      purchases: 6,
      averageOrderValue: 150,
    });

    const overview = await getOverviewData({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-15",
      includeTrends: false,
    });

    expect(ga4Fallback.getGa4EcommerceFallbackData).toHaveBeenCalledWith(
      "biz",
      "2026-03-01",
      "2026-03-15",
    );
    expect(overview.kpis).toEqual(
      expect.objectContaining({ revenue: 900, purchases: 6, aov: 150, roas: 6 }),
    );
    expect(overview.totals).toEqual(
      expect.objectContaining({ revenue: 570, spend: 150, purchases: 9, conversions: 9, roas: 3.8 }),
    );
    expect(overview.kpiSources.revenue).toEqual({ source: "ga4_fallback", label: "GA4" });
    expect(overview.kpiSources.purchases?.source).toBe("ga4_fallback");
    expect(overview.kpiSources.aov?.source).toBe("ga4_fallback");
    expect(overview.shopifyConnectionState).toBe("disconnected");
  });

  it("fails closed instead of using GA4 commerce when Shopify connection state cannot be read", async () => {
    vi.mocked(integrations.getIntegration).mockRejectedValue(new Error("integration store unavailable"));
    vi.mocked(ga4Fallback.getGa4EcommerceFallbackData).mockResolvedValue({
      revenue: 900,
      purchases: 6,
      averageOrderValue: 150,
    });

    const overview = await getOverviewData({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-15",
      includeTrends: false,
    });

    expect(ga4Fallback.getGa4EcommerceFallbackData).not.toHaveBeenCalled();
    expect(overview.kpiSources.revenue?.source).toBe("unavailable");
    expect(overview.shopifyConnectionState).toBe("unknown");
  });

  it.each(["error", "expired"])(
    "fails closed for a fulfilled Shopify connection row with status %s",
    async (status) => {
      vi.mocked(integrations.getIntegration).mockResolvedValue({ status } as never);
      vi.mocked(ga4Fallback.getGa4EcommerceFallbackData).mockResolvedValue({
        revenue: 900,
        purchases: 6,
        averageOrderValue: 150,
      });

      const overview = await getOverviewData({
        businessId: "biz",
        startDate: "2026-03-01",
        endDate: "2026-03-15",
        includeTrends: false,
      });

      expect(ga4Fallback.getGa4EcommerceFallbackData).not.toHaveBeenCalled();
      expect(overview.shopifyConnectionState).toBe("unknown");
      expect(overview.kpiSources.revenue?.source).toBe("unavailable");
    },
  );

  it("uses the summary Shopify read path for sparkline bundles", async () => {
    vi.mocked(metaCanonical.getMetaCanonicalOverviewTrends).mockResolvedValue({
      points: [{ date: "2026-03-01", spend: 10, revenue: 20, conversions: 1 }],
      isPartial: false,
      notReadyReason: null,
      readSource: "warehouse_published",
      warehouseScope: "account_daily",
      meta: { readSource: "warehouse_published" },
    } as never);
    vi.mocked(googleServing.getGoogleCanonicalOverviewTrends).mockResolvedValue({
      points: [{ date: "2026-03-01", spend: 5, revenue: 15, conversions: 2 }],
      meta: {
        readSource: "warehouse_account_daily",
        fallbackReason: null,
        degraded: false,
      },
    } as never);

    const bundle = await getOverviewTrendBundle({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-01",
    });

    expect(shopifyReadAdapter.getShopifyOverviewSummaryReadCandidate).toHaveBeenCalled();
    expect(shopifyReadAdapter.getShopifyOverviewReadCandidate).not.toHaveBeenCalled();
    // These provider rows did not report impressions or clicks, so the
    // primitives are unknown (null) rather than a measured zero.
    expect(bundle.providerTrends.meta).toEqual([
      { date: "2026-03-01", spend: 10, revenue: 20, purchases: 1, impressions: null, clicks: null },
    ]);
    expect(bundle.providerTrends.google).toEqual([
      { date: "2026-03-01", spend: 5, revenue: 15, purchases: 2, impressions: null, clicks: null },
    ]);
    expect(bundle.combined).toEqual([
      { date: "2026-03-01", spend: 15, revenue: 0, purchases: 0 },
    ]);
    expect(bundle.shopifyCommerceAvailable).toBe(false);
    expect(bundle.shopifyConnectionState).toBe("disconnected");
  });

  it("carries provider impressions and clicks through fragments, trends and blended totals", async () => {
    vi.mocked(metaCanonical.getMetaCanonicalOverviewSummary).mockResolvedValue({
      totals: { spend: 120, revenue: 480, conversions: 6, impressions: 12_000, clicks: 300 },
      accounts: [
        { providerAccountId: "act_1", spend: 80, revenue: 320, conversions: 4, impressions: 8_000, clicks: 240, roas: 4 },
        { providerAccountId: "act_2", spend: 40, revenue: 160, conversions: 2, impressions: 4_000, clicks: 60, roas: 4 },
      ],
      isPartial: false,
      notReadyReason: null,
      readSource: "warehouse_published",
      warehouseScope: "account_daily",
    } as never);
    vi.mocked(googleServing.getGoogleCanonicalOverviewSummary).mockResolvedValue({
      kpis: {
        spend: 30,
        revenue: 90,
        conversions: 3.25,
        roas: 3,
        cpa: 9.23,
        cpc: 1,
        ctr: 2,
        impressions: 1_000,
        clicks: 30,
        convRate: 10.83,
      },
      summary: { totalAccounts: 1, readSource: "warehouse_account_aggregate" },
      meta: { readSource: "warehouse_account_aggregate" },
    } as never);
    vi.mocked(metaCanonical.getMetaCanonicalOverviewTrends).mockResolvedValue({
      points: [
        { date: "2026-03-01", spend: 6, revenue: 12, conversions: 1, impressions: 600, clicks: 12 },
        { date: "2026-03-01", spend: 4, revenue: 8, conversions: 0, impressions: 400, clicks: 8 },
        { date: "2026-03-02", spend: 5, revenue: 0, conversions: 0 },
      ],
      isPartial: false,
      notReadyReason: null,
      readSource: "warehouse_published",
      warehouseScope: "account_daily",
      meta: { readSource: "warehouse_published" },
    } as never);
    vi.mocked(googleServing.getGoogleCanonicalOverviewTrends).mockResolvedValue({
      points: [{ date: "2026-03-01", spend: 5, revenue: 15, conversions: 1.25, impressions: 250, clicks: 10 }],
      meta: { readSource: "warehouse_account_daily", fallbackReason: null, degraded: false },
    } as never);

    const overview = await getOverviewData({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-03",
      includeTrends: false,
    });

    expect(overview.platformEfficiency).toEqual([
      expect.objectContaining({ platform: "meta", spend: 80, impressions: 8_000, clicks: 240 }),
      expect.objectContaining({ platform: "meta", spend: 40, impressions: 4_000, clicks: 60 }),
      // Fractional Google conversions survive the response rounding.
      expect.objectContaining({ platform: "google", purchases: 3.25, impressions: 1_000, clicks: 30 }),
    ]);
    expect(overview.providerSources).toEqual({
      meta: "warehouse_published_account_daily",
      google: "warehouse_account_aggregate",
    });
    // Meta delivery counts now reach the blended totals alongside Meta spend.
    expect(overview.totals.impressions).toBe(13_000);
    expect(overview.totals.clicks).toBe(330);
    expect(overview.totals.ctr).toBe(2.54);

    const bundle = await getOverviewTrendBundle({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-03",
    });

    expect(bundle.providerTrends.meta).toEqual([
      { date: "2026-03-01", spend: 10, revenue: 20, purchases: 1, impressions: 1_000, clicks: 20 },
      // A row that omitted the primitives leaves them unknown for that day.
      { date: "2026-03-02", spend: 5, revenue: 0, purchases: 0, impressions: null, clicks: null },
      // 2026-03-03 had no provider row at all, so it is absent rather than a zero point.
    ]);
    // Blended spend may still read the absent provider date as no spend.
    expect(bundle.combined.map((point) => [point.date, point.spend])).toEqual([
      ["2026-03-01", 15],
      ["2026-03-02", 5],
      ["2026-03-03", 0],
    ]);
    expect(bundle.providerTrends.google?.[0]).toEqual({
      date: "2026-03-01",
      spend: 5,
      revenue: 15,
      purchases: 1.25,
      impressions: 250,
      clicks: 10,
    });
    // The Meta trend names the same published grain as the Meta summary.
    expect(bundle.providerTrendSources).toEqual({
      meta: "warehouse_published_account_daily",
      google: "warehouse_account_daily",
    });
  });

  describe("Meta scalar source contract", () => {
    const liveTotals = {
      spend: 500,
      revenue: 1_500,
      conversions: 25,
      roas: 3,
      cpa: 20,
      ctr: 2,
      cpc: 0.5,
      impressions: 50_000,
      clicks: 1_000,
      reach: 0,
    };
    const partialWarehouseAccounts = [
      { providerAccountId: "act_1", spend: 120, revenue: 480, conversions: 6, impressions: 9_000, clicks: 200, roas: 4 },
    ];

    it.each([
      ["a non-empty partial warehouse account slice", partialWarehouseAccounts],
      ["an empty warehouse account slice", []],
    ])("builds one provider row from live historical totals with %s", async (_case, accounts) => {
      vi.mocked(metaCanonical.getMetaCanonicalOverviewSummary).mockResolvedValue({
        totals: liveTotals,
        accounts,
        isPartial: false,
        notReadyReason: null,
        readSource: "live_historical_fallback",
      } as never);

      const overview = await getOverviewData({
        businessId: "biz",
        startDate: "2023-01-01",
        endDate: "2023-01-31",
        includeTrends: false,
      });

      const metaRows = overview.platformEfficiency.filter((row) => row.platform === "meta");
      expect(metaRows).toEqual([
        {
          platform: "meta",
          spend: 500,
          revenue: 1_500,
          purchases: 25,
          roas: 3,
          cpa: 20,
          impressions: 50_000,
          clicks: 1_000,
        },
      ]);
      expect(overview.providerSources?.meta).toBe("live_historical_fallback");
      // Card rows and the blended totals now describe the same live range.
      expect(overview.kpis.spend).toBe(530);
      expect(overview.totals.impressions).toBe(51_000);
    });

    it("keeps an unready current-day live read unknown instead of a zero row", async () => {
      vi.mocked(metaCanonical.getMetaCanonicalOverviewSummary).mockResolvedValue({
        totals: { ...liveTotals, spend: 0, revenue: 0, conversions: 0, impressions: 0, clicks: 0 },
        accounts: [],
        isPartial: true,
        notReadyReason: "Current-day live Meta totals are still being prepared.",
        readSource: "current_day_live",
      } as never);

      const overview = await getOverviewData({
        businessId: "biz",
        startDate: "2026-04-08",
        endDate: "2026-04-08",
        includeTrends: false,
      });

      expect(overview.platformEfficiency.filter((row) => row.platform === "meta")).toEqual([]);
      expect(overview.providerSources?.meta).toBeNull();
    });

    it("keeps a ready current-day live read with delivery but no spend as a measured row", async () => {
      vi.mocked(metaCanonical.getMetaCanonicalOverviewSummary).mockResolvedValue({
        totals: { ...liveTotals, spend: 0, revenue: 0, conversions: 0, impressions: 1_200, clicks: 0 },
        accounts: [],
        isPartial: false,
        notReadyReason: null,
        readSource: "current_day_live",
      } as never);

      const overview = await getOverviewData({
        businessId: "biz",
        startDate: "2026-04-08",
        endDate: "2026-04-08",
        includeTrends: false,
      });

      expect(overview.platformEfficiency.filter((row) => row.platform === "meta")).toEqual([
        expect.objectContaining({ spend: 0, impressions: 1_200, clicks: 0 }),
      ]);
      expect(overview.providerSources?.meta).toBe("current_day_live");
    });

    it("uses no Meta row for a published warehouse read with no account rows", async () => {
      vi.mocked(metaCanonical.getMetaCanonicalOverviewSummary).mockResolvedValue({
        totals: liveTotals,
        accounts: [],
        isPartial: false,
        notReadyReason: null,
        readSource: "warehouse_published",
        warehouseScope: "account_daily",
      } as never);

      const overview = await getOverviewData({
        businessId: "biz",
        startDate: "2026-03-01",
        endDate: "2026-03-15",
        includeTrends: false,
      });

      expect(overview.platformEfficiency.filter((row) => row.platform === "meta")).toEqual([]);
      expect(overview.providerSources?.meta).toBeNull();
    });
  });

  it("records Google's scalar source and clears it when Google produced no row", async () => {
    vi.mocked(googleServing.getGoogleCanonicalOverviewSummary).mockResolvedValue({
      kpis: {
        spend: 9,
        revenue: 18,
        conversions: 1,
        roas: 2,
        cpa: 9,
        cpc: 0.9,
        ctr: 5,
        impressions: 200,
        clicks: 10,
        convRate: 10,
      },
      summary: { totalAccounts: 1, readSource: "live_overlay_current_day" },
      meta: {
        readSource: "live_overlay_current_day",
        query_names: ["customer_summary", "campaign_core_basic"],
        failed_queries: [],
      },
    } as never);
    const live = await getOverviewData({
      businessId: "biz",
      startDate: "2026-04-08",
      endDate: "2026-04-08",
      includeTrends: false,
    });
    expect(live.providerSources?.google).toBe("live_overlay_current_day");

    vi.mocked(googleServing.getGoogleCanonicalOverviewSummary).mockRejectedValue(new Error("google unavailable"));
    const failed = await getOverviewData({
      businessId: "biz",
      startDate: "2026-04-08",
      endDate: "2026-04-08",
      includeTrends: false,
    });
    expect(failed.providerSources?.google).toBeNull();
    expect(failed.platformEfficiency.some((row) => row.platform === "google")).toBe(false);
  });

  describe("Google row coverage", () => {
    const zeroKpis = {
      spend: 0,
      revenue: 0,
      conversions: 0,
      roas: 0,
      cpa: 0,
      cpc: 0,
      ctr: 0,
      impressions: 0,
      clicks: 0,
      convRate: 0,
    };
    const request = { businessId: "biz", startDate: "2026-03-01", endDate: "2026-03-07", includeTrends: false };

    it("keeps a covered all-zero warehouse window as a measured zero row", async () => {
      vi.mocked(googleServing.getGoogleCanonicalOverviewSummary).mockResolvedValue({
        kpis: zeroKpis,
        summary: { totalAccounts: 1, readSource: "warehouse_account_aggregate" },
        meta: { readSource: "warehouse_account_aggregate" },
      } as never);

      const overview = await getOverviewData(request);

      expect(overview.platformEfficiency.filter((row) => row.platform === "google")).toEqual([
        expect.objectContaining({ spend: 0, revenue: 0, purchases: 0, impressions: 0, clicks: 0 }),
      ]);
      expect(overview.providerSources?.google).toBe("warehouse_account_aggregate");
    });

    it("has no row when the warehouse read covered no rows", async () => {
      vi.mocked(googleServing.getGoogleCanonicalOverviewSummary).mockResolvedValue({
        kpis: zeroKpis,
        summary: { totalAccounts: 0, readSource: "warehouse_account_aggregate" },
        meta: { readSource: "warehouse_account_aggregate" },
      } as never);

      const overview = await getOverviewData(request);

      expect(overview.platformEfficiency.some((row) => row.platform === "google")).toBe(false);
      expect(overview.providerSources?.google).toBeNull();
    });

    it("keeps a successful all-zero current-day live read as a measured row", async () => {
      vi.mocked(googleServing.getGoogleCanonicalOverviewSummary).mockResolvedValue({
        kpis: zeroKpis,
        summary: { totalAccounts: 0, readSource: "live_overlay_current_day" },
        meta: {
          readSource: "live_overlay_current_day",
          query_names: ["customer_summary", "campaign_core_basic", "campaign_share"],
          failed_queries: [],
        },
      } as never);

      const overview = await getOverviewData(request);

      expect(overview.platformEfficiency.filter((row) => row.platform === "google")).toEqual([
        expect.objectContaining({ spend: 0, impressions: 0, clicks: 0 }),
      ]);
      expect(overview.providerSources?.google).toBe("live_overlay_current_day");
    });

    it.each([
      ["its customer summary query failed", ["customer_summary"], [{ query: "customer_summary" }]],
      ["its customer summary query never ran", [], []],
    ])("has no live row when %s", async (_case, queryNames, failedQueries) => {
      vi.mocked(googleServing.getGoogleCanonicalOverviewSummary).mockResolvedValue({
        kpis: zeroKpis,
        summary: { totalAccounts: 0, readSource: "live_overlay_current_day" },
        meta: {
          readSource: "live_overlay_current_day",
          query_names: queryNames,
          failed_queries: failedQueries,
        },
      } as never);

      const overview = await getOverviewData(request);

      expect(overview.platformEfficiency.some((row) => row.platform === "google")).toBe(false);
      expect(overview.providerSources?.google).toBeNull();
    });

    it("renders an all-zero current window against a positive previous window with the same source", async () => {
      vi.mocked(googleServing.getGoogleCanonicalOverviewSummary)
        .mockResolvedValueOnce({
          kpis: zeroKpis,
          summary: { totalAccounts: 1, readSource: "warehouse_account_aggregate" },
          meta: { readSource: "warehouse_account_aggregate" },
        } as never)
        .mockResolvedValueOnce({
          kpis: {
            spend: 40,
            revenue: 100,
            conversions: 4,
            roas: 2.5,
            cpa: 10,
            cpc: 0.8,
            ctr: 5,
            impressions: 1_000,
            clicks: 50,
            convRate: 8,
          },
          summary: { totalAccounts: 1, readSource: "warehouse_account_aggregate" },
          meta: { readSource: "warehouse_account_aggregate" },
        } as never);

      const current = await getOverviewData(request);
      const previous = await getOverviewData({ ...request, startDate: "2026-02-22", endDate: "2026-02-28" });
      const google = buildPlatformSections(current, previous, "previous_period").find(
        (section) => section.provider === "google",
      )!;
      const byTitle = Object.fromEntries(google.metrics.map((metric) => [metric.title, metric]));

      for (const title of ["Spend", "Conversion value", "Conversions"]) {
        expect(byTitle[title], title).toEqual(
          expect.objectContaining({ value: 0, status: "available", changePct: -100 }),
        );
      }
      expect(byTitle.Spend?.previousValue).toBe(40);
      expect(byTitle["Conversion value"]?.previousValue).toBe(100);
      expect(byTitle.Conversions?.previousValue).toBe(4);

      const unavailable: Array<[string, string]> = [
        ["ROAS", "No spend in this window"],
        ["Cost / conv.", "No conversions in this window"],
        ["CTR", "No impressions in this window"],
        ["CPC", "No clicks in this window"],
        ["Conversion rate", "No clicks in this window"],
      ];
      for (const [title, reason] of unavailable) {
        expect(byTitle[title], title).toEqual(
          expect.objectContaining({ value: null, status: "unavailable", changePct: null, helperText: reason }),
        );
      }
    });
  });

  it("reports each provider trend's read source and null when that read fails", async () => {
    vi.mocked(googleServing.getGoogleCanonicalOverviewTrends).mockResolvedValue({
      points: [{ date: "2026-03-02", spend: 4, revenue: 8, conversions: 0.5, impressions: 100, clicks: 4 }],
      meta: { readSource: "warehouse_campaign_daily_fallback", fallbackReason: null, degraded: false },
    } as never);
    vi.mocked(metaCanonical.getMetaCanonicalOverviewTrends).mockRejectedValue(new Error("meta trends unavailable"));

    const bundle = await getOverviewTrendBundle({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-03",
    });

    expect(bundle.providerTrendSources).toEqual({ meta: null, google: "warehouse_campaign_daily_fallback" });
    expect(bundle.providerTrends.meta).toEqual([]);
    // Only the reported Google date is present; the other two dates are absent, not zero.
    expect(bundle.providerTrends.google).toEqual([
      { date: "2026-03-02", spend: 4, revenue: 8, purchases: 0.5, impressions: 100, clicks: 4 },
    ]);
    expect(bundle.combined.map((point) => point.spend)).toEqual([0, 4, 0]);
  });

  it("lets Shopify canonical revenue override ad-platform revenue in combined trends without altering provider trends", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({ status: "connected" } as never);
    vi.mocked(metaCanonical.getMetaCanonicalOverviewTrends).mockResolvedValue({
      points: [{ date: "2026-03-01", spend: 10, revenue: 20, conversions: 1 }],
      isPartial: false,
      notReadyReason: null,
      readSource: "warehouse_published",
      warehouseScope: "account_daily",
      meta: { readSource: "warehouse_published" },
    } as never);
    vi.mocked(googleServing.getGoogleCanonicalOverviewTrends).mockResolvedValue({
      points: [{ date: "2026-03-01", spend: 5, revenue: 15, conversions: 2 }],
      meta: {
        readSource: "warehouse_account_daily",
        fallbackReason: null,
        degraded: false,
      },
    } as never);
    vi.mocked(shopifyReadAdapter.getShopifyOverviewSummaryReadCandidate).mockResolvedValue(
      buildReadCandidate({
        live: {
          revenue: 50,
          purchases: 4,
          averageOrderValue: 12.5,
          sessions: null,
          conversionRate: null,
          newCustomers: null,
          returningCustomers: null,
          dailyTrends: [
            {
              date: "2026-03-01",
              revenue: 50,
              purchases: 4,
              sessions: null,
              conversionRate: null,
              newCustomers: null,
              returningCustomers: null,
            },
          ],
        },
        preferredSource: "live",
      }) as never,
    );

    const bundle = await getOverviewTrendBundle({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-01",
    });

    // These provider rows did not report impressions or clicks, so the
    // primitives are unknown (null) rather than a measured zero.
    expect(bundle.providerTrends.meta).toEqual([
      { date: "2026-03-01", spend: 10, revenue: 20, purchases: 1, impressions: null, clicks: null },
    ]);
    expect(bundle.providerTrends.google).toEqual([
      { date: "2026-03-01", spend: 5, revenue: 15, purchases: 2, impressions: null, clicks: null },
    ]);
    expect(bundle.combined).toEqual([
      { date: "2026-03-01", spend: 15, revenue: 50, purchases: 4 },
    ]);
    expect(bundle.shopifyCommerceAvailable).toBe(true);
    expect(bundle.shopifyConnectionState).toBe("connected");
  });

  it("keeps a connected but unsynced Shopify trend bundle distinct from a disconnect", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({ status: "connected" } as never);

    const bundle = await getOverviewTrendBundle({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-01",
    });

    expect(bundle.shopifyConnectionState).toBe("connected");
    expect(bundle.shopifyCommerceAvailable).toBe(false);
    expect(bundle.shopifyDaily).toEqual([]);
  });

  it("fails trend commerce closed when the Shopify connection state cannot be read", async () => {
    vi.mocked(integrations.getIntegration).mockRejectedValue(new Error("integration store unavailable"));
    vi.mocked(shopifyReadAdapter.getShopifyOverviewSummaryReadCandidate).mockResolvedValue(
      buildReadCandidate({
        live: {
          revenue: 50,
          purchases: 4,
          averageOrderValue: 12.5,
          sessions: null,
          conversionRate: null,
          newCustomers: null,
          returningCustomers: null,
          dailyTrends: [
            {
              date: "2026-03-01",
              revenue: 50,
              purchases: 4,
              sessions: null,
              conversionRate: null,
              newCustomers: null,
              returningCustomers: null,
            },
          ],
        },
        preferredSource: "live",
      }) as never,
    );

    const bundle = await getOverviewTrendBundle({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-01",
    });

    expect(bundle.shopifyConnectionState).toBe("unknown");
    expect(bundle.shopifyCommerceAvailable).toBe(false);
    expect(bundle.shopifyDaily).toEqual([]);
    expect(bundle.combined).toEqual([
      { date: "2026-03-01", spend: 0, revenue: 0, purchases: 0 },
    ]);
  });

  it("uses the summary Shopify read candidate via getShopifyOverviewServingData", async () => {
    vi.mocked(shopifyReadAdapter.getShopifyOverviewSummaryReadCandidate).mockResolvedValue(
      buildReadCandidate({
        live: {
          revenue: 75,
          purchases: 5,
          averageOrderValue: 15,
          sessions: null,
          conversionRate: null,
          newCustomers: null,
          returningCustomers: null,
          dailyTrends: [],
        },
        preferredSource: "live",
      }) as never,
    );

    const result = await getShopifyOverviewServingData({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-02",
    });

    expect(shopifyReadAdapter.getShopifyOverviewSummaryReadCandidate).toHaveBeenCalled();
    expect(shopifyReadAdapter.getShopifyOverviewReadCandidate).not.toHaveBeenCalled();
    expect(result.aggregate?.revenue).toBe(75);
    expect(result.aggregate?.purchases).toBe(5);
  });

  it("merges fully covered Shopify customer events using the active shop and business timezone", async () => {
    vi.mocked(accountStore.getBusinessTimezone).mockResolvedValue("Europe/Istanbul" as never);
    vi.mocked(shopifyReadAdapter.getShopifyOverviewSummaryReadCandidate).mockResolvedValue(
      buildReadCandidate({
        status: buildShopifyStatus({
          state: "ready",
          connected: true,
          shopId: "grandmix.myshopify.com",
        }),
        customerEventsRegisteredAt: "2026-02-20T10:00:00.000Z",
        live: {
          revenue: 75,
          purchases: 5,
          averageOrderValue: 15,
          sessions: null,
          conversionRate: null,
          newCustomers: 4,
          returningCustomers: 1,
          dailyTrends: [
            {
              date: "2026-03-02",
              revenue: 75,
              purchases: 5,
              sessions: null,
              conversionRate: null,
              newCustomers: 4,
              returningCustomers: 1,
            },
          ],
        },
        preferredSource: "live",
      }) as never,
    );
    vi.mocked(shopifyCustomerEvents.getShopifyCustomerEventsAggregate).mockResolvedValue({
      sessions: 200,
      sessionlessEvents: 0,
      pageViews: 250,
      productViews: 100,
      addToCart: 20,
      beginCheckout: 15,
      purchases: 5,
      productViewSessions: 90,
      addToCartSessions: 20,
      beginCheckoutSessions: 15,
      purchaseSessions: 5,
      productViewRate: 45,
      addToCartRate: 10,
      checkoutRate: 7.5,
      checkoutCompletionRate: 33.33,
      conversionRate: 2.5,
      daily: [
        {
          date: "2026-03-01",
          sessions: 80,
          sessionlessEvents: 0,
          pageViews: 100,
          productViews: 40,
          addToCart: 8,
          beginCheckout: 6,
          purchases: 0,
          productViewSessions: 35,
          addToCartSessions: 8,
          beginCheckoutSessions: 6,
          purchaseSessions: 0,
          productViewRate: 43.75,
          addToCartRate: 10,
          checkoutRate: 7.5,
          checkoutCompletionRate: 0,
          conversionRate: 0,
        },
        {
          date: "2026-03-02",
          sessions: 120,
          sessionlessEvents: 0,
          pageViews: 150,
          productViews: 60,
          addToCart: 12,
          beginCheckout: 9,
          purchases: 5,
          productViewSessions: 55,
          addToCartSessions: 12,
          beginCheckoutSessions: 9,
          purchaseSessions: 5,
          productViewRate: 45.83,
          addToCartRate: 10,
          checkoutRate: 7.5,
          checkoutCompletionRate: 55.56,
          conversionRate: 4.17,
        },
      ],
    });

    const result = await getShopifyOverviewServingData({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-02",
    });

    expect(shopifyCustomerEvents.getShopifyCustomerEventsAggregate).toHaveBeenCalledWith({
      businessId: "biz",
      providerAccountId: "grandmix.myshopify.com",
      timeZone: "Europe/Istanbul",
      startDate: "2026-03-01",
      endDate: "2026-03-02",
    });
    expect(result.aggregate?.sessions).toBe(200);
    expect(result.aggregate?.conversionRate).toBe(2.5);
    expect(result.aggregate?.dailyTrends).toEqual([
      expect.objectContaining({
        date: "2026-03-01",
        revenue: 0,
        purchases: 0,
        sessions: 80,
        conversionRate: 0,
      }),
      expect.objectContaining({
        date: "2026-03-02",
        revenue: 75,
        purchases: 5,
        sessions: 120,
        conversionRate: 4.17,
      }),
    ]);
  });

  it("does not merge Shopify customer events when registration does not cover the full range", async () => {
    vi.mocked(shopifyReadAdapter.getShopifyOverviewSummaryReadCandidate).mockResolvedValue(
      buildReadCandidate({
        status: buildShopifyStatus({
          state: "ready",
          connected: true,
          shopId: "grandmix.myshopify.com",
        }),
        customerEventsRegisteredAt: "2026-03-01T00:00:00.000Z",
        live: {
          revenue: 75,
          purchases: 5,
          averageOrderValue: 15,
          sessions: null,
          conversionRate: null,
          newCustomers: 4,
          returningCustomers: 1,
          dailyTrends: [],
        },
        preferredSource: "live",
      }) as never,
    );

    const result = await getShopifyOverviewServingData({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-02",
      timeZone: "Europe/Istanbul",
    });

    expect(shopifyCustomerEvents.getShopifyCustomerEventsAggregate).not.toHaveBeenCalled();
    expect(result.aggregate?.conversionRate).toBeNull();
  });

  it("serves Shopify warehouse shadow data when exact serving trust is unavailable", async () => {
    vi.mocked(shopifyReadAdapter.getShopifyOverviewSummaryReadCandidate).mockResolvedValue(
      buildReadCandidate({
        preferredSource: "warehouse_shadow",
        warehouse: {
          revenue: 36445.99,
          grossRevenue: 37827.13,
          refundedRevenue: 1381.14,
          purchases: 158,
          returnEvents: 0,
          averageOrderValue: 239.41,
          daily: [
            {
              date: "2026-04-01",
              orderRevenue: 2487.4,
              refundedRevenue: 0,
              netRevenue: 2487.4,
              orders: 11,
              returnEvents: 0,
            },
          ],
        },
        servingMetadata: {
          source: "warehouse",
          provider: "shopify",
          trustState: "live_fallback",
          fallbackReason: "range_serving_state_unavailable",
          lastSyncedAt: null,
          coverageStatus: "unknown",
          productionMode: "auto",
          pendingRepair: false,
          pendingRepairStartedAt: null,
          pendingRepairLastTopic: null,
          pendingRepairLastReceivedAt: null,
          selectedRevenueTruthBasis: null,
          basisSelectionReason: null,
          transactionCoverageOrderRate: null,
          transactionCoverageAmountRate: null,
          explainedAdjustmentRevenue: null,
          unexplainedAdjustmentRevenue: null,
        },
      }) as never,
    );

    const result = await getShopifyOverviewServingData({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-18",
    });

    expect(result.aggregate?.revenue).toBe(36445.99);
    expect(result.aggregate?.purchases).toBe(158);
    expect(result.serving.source).toBe("warehouse");
    expect(result.serving.trustState).toBe("live_fallback");
  });
});
