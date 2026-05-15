import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/meta", () => ({
  resolveMetaCredentials: vi.fn(),
  fetchMetaCampaignConfigs: vi.fn(),
  fetchMetaAdSetConfigs: vi.fn(),
}));

vi.mock("@/lib/meta/config-snapshots", () => ({
  readLatestMetaConfigSnapshots: vi.fn(),
  readPreviousDifferentMetaConfigDiffs: vi.fn(),
}));

vi.mock("@/lib/meta/request-model-store", () => ({
  readLatestMetaCampaignConfigHistory: vi.fn(),
  readLatestMetaAdSetConfigHistory: vi.fn(),
  readMetaCampaignDimensions: vi.fn(),
  readMetaAdSetDimensions: vi.fn(),
  readPreviousDifferentMetaCampaignConfigHistoryDiffs: vi.fn(),
  readPreviousDifferentMetaAdSetConfigHistoryDiffs: vi.fn(),
}));

vi.mock("@/lib/meta/constraints", () => ({
  getMetaBreakdownSupportedStart: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", () => ({
  emptyMetaWarehouseMetrics: vi.fn(),
  getMetaAdSetDailyCoverage: vi.fn(),
  getMetaAccountDailyCoverage: vi.fn(),
  getMetaAccountDailyRange: vi.fn(),
  getMetaAdDailyRange: vi.fn(),
  getMetaAdSetDailyRange: vi.fn(),
  getMetaBreakdownDailyRange: vi.fn(),
  getMetaCampaignDailyCoverage: vi.fn(),
  getMetaCampaignDailyRange: vi.fn(),
  getMetaDirtyRecentDates: vi.fn(),
  getMetaPublishedVerificationSummary: vi.fn(),
  getMetaQueueHealth: vi.fn(),
  getMetaRawSnapshotCoverageByEndpoint: vi.fn(),
  upsertMetaAccountDailyRows: vi.fn(),
  upsertMetaAdSetDailyRows: vi.fn(),
  upsertMetaCampaignDailyRows: vi.fn(),
  replaceMetaAccountDailySlice: vi.fn(),
  replaceMetaAdSetDailySlice: vi.fn(),
  replaceMetaCampaignDailySlice: vi.fn(),
}));

const configSnapshots = await import("@/lib/meta/config-snapshots");
const requestModelStore = await import("@/lib/meta/request-model-store");
const constraints = await import("@/lib/meta/constraints");
const warehouse = await import("@/lib/meta/warehouse");
const apiMeta = await import("@/lib/api/meta");
const { repairMetaWarehouseTruthRange } = await import("@/lib/meta/repair");
const {
  getMetaWarehouseSummary,
  getMetaWarehouseTrends,
  getMetaWarehouseAdSets,
  getMetaWarehouseCampaignTable,
  getMetaWarehouseBreakdowns,
  getMetaWarehouseCountryBreakdowns,
} = await import("@/lib/meta/serving");

describe("meta historical serving", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "0";
    process.env.META_AUTHORITATIVE_FINALIZATION_CANARY_BUSINESSES = "";
    vi.mocked(configSnapshots.readLatestMetaConfigSnapshots).mockResolvedValue(new Map());
    vi.mocked(configSnapshots.readPreviousDifferentMetaConfigDiffs).mockResolvedValue(new Map());
    vi.mocked(requestModelStore.readLatestMetaCampaignConfigHistory).mockResolvedValue(new Map());
    vi.mocked(requestModelStore.readLatestMetaAdSetConfigHistory).mockResolvedValue(new Map());
    vi.mocked(requestModelStore.readMetaCampaignDimensions).mockResolvedValue(new Map());
    vi.mocked(requestModelStore.readMetaAdSetDimensions).mockResolvedValue(new Map());
    vi.mocked(requestModelStore.readPreviousDifferentMetaCampaignConfigHistoryDiffs).mockResolvedValue(new Map());
    vi.mocked(requestModelStore.readPreviousDifferentMetaAdSetConfigHistoryDiffs).mockResolvedValue(new Map());
    vi.mocked(constraints.getMetaBreakdownSupportedStart).mockReturnValue("2026-03-01");
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue(null as never);
    vi.mocked(apiMeta.fetchMetaCampaignConfigs).mockResolvedValue(new Map() as never);
    vi.mocked(apiMeta.fetchMetaAdSetConfigs).mockResolvedValue(new Map() as never);
    vi.mocked(warehouse.getMetaPublishedVerificationSummary).mockResolvedValue(null as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([]);
  });

  it("keeps campaign table rows when optional enrichment queries fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: "OUTCOME_SALES",
        buyingType: "AUCTION",
        optimizationGoal: null,
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 20,
        impressions: 100,
        clicks: 4,
        reach: 100,
        frequency: null,
        conversions: 2,
        revenue: 50,
        roas: 2.5,
        cpa: 10,
        ctr: 4,
        cpc: 5,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaCampaignDimensions).mockRejectedValue(
      new Error("dimensions timeout"),
    );
    vi.mocked(requestModelStore.readLatestMetaCampaignConfigHistory).mockRejectedValue(
      new Error("config timeout"),
    );
    vi.mocked(
      requestModelStore.readPreviousDifferentMetaCampaignConfigHistoryDiffs,
    ).mockRejectedValue(new Error("previous timeout"));

    const rows = await getMetaWarehouseCampaignTable({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      includePrev: true,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "cmp-1",
      name: "Campaign 1",
      objective: "OUTCOME_SALES",
      spend: 20,
      revenue: 50,
      previousDailyBudget: null,
    });
    warn.mockRestore();
  });

  it("keeps ad set table rows when optional enrichment queries fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: null,
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 80,
        clicks: 3,
        reach: 80,
        frequency: null,
        conversions: 1,
        revenue: 24,
        roas: 2,
        cpa: 12,
        ctr: 3.75,
        cpc: 4,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaAdSetDimensions).mockRejectedValue(
      new Error("dimensions timeout"),
    );
    vi.mocked(requestModelStore.readLatestMetaAdSetConfigHistory).mockRejectedValue(
      new Error("config timeout"),
    );
    vi.mocked(
      requestModelStore.readPreviousDifferentMetaAdSetConfigHistoryDiffs,
    ).mockRejectedValue(new Error("previous timeout"));

    const rows = await getMetaWarehouseAdSets({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      campaignId: "cmp-1",
      includePrev: true,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "adset-1",
      name: "Adset 1",
      campaignId: "cmp-1",
      spend: 12,
      revenue: 24,
      previousDailyBudget: null,
    });
    warn.mockRestore();
  });

  it("hydrates ad set funnel event totals from ad daily payload rows", async () => {
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: "OFFSITE_CONVERSIONS",
        customEventType: "ADD_TO_CART",
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 100,
        impressions: 1000,
        clicks: 80,
        reach: 900,
        frequency: 1.11,
        conversions: 2,
        revenue: 120,
        roas: 1.2,
        cpa: 50,
        ctr: 8,
        cpc: 1.25,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Ad 1",
        adNameHistorical: "Ad 1",
        adStatus: "ACTIVE",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 60,
        impressions: 600,
        clicks: 50,
        reach: 550,
        frequency: 1.09,
        conversions: 1,
        revenue: 80,
        roas: 1.33,
        cpa: 60,
        ctr: 8.33,
        cpc: 1.2,
        linkClicks: 40,
        landingPageViews: 18,
        addToCart: 9,
        initiateCheckout: 4,
        viewContent: 15,
        leads: 3,
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-2",
        adNameCurrent: "Ad 2",
        adNameHistorical: "Ad 2",
        adStatus: "ACTIVE",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 40,
        impressions: 400,
        clicks: 30,
        reach: 350,
        frequency: 1.14,
        conversions: 1,
        revenue: 40,
        roas: 1,
        cpa: 40,
        ctr: 7.5,
        cpc: 1.33,
        linkClicks: 25,
        landingPageViews: 12,
        addToCart: 6,
        initiateCheckout: 2,
        viewContent: 10,
        leads: 2,
      },
    ] as never);

    const rows = await getMetaWarehouseAdSets({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      campaignId: "cmp-1",
    });

    expect(rows[0]).toMatchObject({
      id: "adset-1",
      linkClicks: 65,
      landingPageViews: 30,
      addToCart: 15,
      initiateCheckout: 6,
      viewContent: 25,
      leads: 5,
    });
  });

  it("filters ad set funnel event totals to published ad-daily keys when finalization v2 is enabled", async () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    process.env.META_AUTHORITATIVE_FINALIZATION_CANARY_BUSINESSES = "";
    vi.mocked(warehouse.getMetaPublishedVerificationSummary).mockResolvedValue({
      verificationState: "complete",
      truthReady: true,
      totalDays: 1,
      completedCoreDays: 1,
      sourceFetchedAt: "2026-04-04T00:00:00Z",
      publishedAt: "2026-04-04T00:05:00Z",
      asOf: "2026-04-04T00:05:00Z",
      publishedSlices: 2,
      totalExpectedSlices: 2,
      reasonCounts: {},
      publishedKeysBySurface: {
        adset_daily: ["act_1:2026-04-03"],
        ad_daily: ["act_1:2026-04-03"],
      },
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: "OFFSITE_CONVERSIONS",
        customEventType: "ADD_TO_CART",
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 100,
        impressions: 1000,
        clicks: 80,
        reach: 900,
        frequency: 1.11,
        conversions: 2,
        revenue: 120,
        roas: 1.2,
        cpa: 50,
        ctr: 8,
        cpc: 1.25,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-published",
        linkClicks: 40,
        addToCart: 9,
        initiateCheckout: 4,
        viewContent: 15,
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-04",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-unpublished",
        linkClicks: 25,
        addToCart: 6,
        initiateCheckout: 2,
        viewContent: 10,
      },
    ] as never);

    const rows = await getMetaWarehouseAdSets({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      campaignId: "cmp-1",
      providerAccountIds: ["act_1"],
    });

    expect(warehouse.getMetaPublishedVerificationSummary).toHaveBeenCalledWith(
      expect.objectContaining({ surfaces: ["adset_daily", "ad_daily"] }),
    );
    expect(rows[0]).toMatchObject({
      id: "adset-1",
      linkClicks: 40,
      addToCart: 9,
      initiateCheckout: 4,
      viewContent: 15,
    });
  });

  it("returns campaign current config from typed history instead of warehouse fact config", async () => {
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: "OUTCOME_SALES",
        buyingType: null,
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 5,
        bidValue: 5,
        bidValueFormat: "currency",
        dailyBudget: 10,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 20,
        impressions: 100,
        clicks: 4,
        reach: 100,
        frequency: null,
        conversions: 2,
        revenue: 50,
        roas: 2.5,
        cpa: 10,
        ctr: 4,
        cpc: 5,
        sourceSnapshotId: null,
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "PAUSED",
        objective: "OUTCOME_SALES",
        buyingType: null,
        optimizationGoal: "Lead",
        bidStrategyType: "cost_cap",
        bidStrategyLabel: "Cost Cap",
        manualBidAmount: 7,
        bidValue: 7,
        bidValueFormat: "currency",
        dailyBudget: 15,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 30,
        impressions: 120,
        clicks: 5,
        reach: 120,
        frequency: null,
        conversions: 3,
        revenue: 80,
        roas: 2.67,
        cpa: 10,
        ctr: 4.16,
        cpc: 6,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaCampaignDimensions).mockResolvedValue(
      new Map([
        [
          "cmp-1",
          {
            businessId: "biz-1",
            businessRefId: "biz-ref-1",
            providerAccountId: "act_1",
            providerAccountRefId: "provider-ref-1",
            campaignId: "cmp-1",
            campaignNameCurrent: "Campaign 1",
            campaignNameHistorical: "Campaign 1",
            campaignStatus: "PAUSED",
            buyingType: "AUCTION",
            firstSeenAt: null,
            lastSeenAt: null,
            sourceUpdatedAt: null,
          },
        ],
      ]),
    );
    vi.mocked(requestModelStore.readLatestMetaCampaignConfigHistory).mockResolvedValue(
      new Map([
        [
          "cmp-1",
          {
            campaignId: "cmp-1",
            objective: "OUTCOME_SALES",
            optimizationGoal: "Lead",
            bidStrategyType: "cost_cap",
            bidStrategyLabel: "Cost Cap",
            manualBidAmount: 7,
            bidValue: 7,
            bidValueFormat: "currency",
            dailyBudget: 15,
            lifetimeBudget: null,
            isBudgetMixed: false,
            isConfigMixed: false,
            isOptimizationGoalMixed: false,
            isBidStrategyMixed: false,
            isBidValueMixed: false,
          },
        ],
      ]),
    );

    const rows = await getMetaWarehouseCampaignTable({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-03",
      includePrev: false,
    });

    expect(rows[0]).toMatchObject({
      id: "cmp-1",
      status: "PAUSED",
      optimizationGoal: "Lead",
      bidStrategyType: "cost_cap",
      bidStrategyLabel: "Cost Cap",
      manualBidAmount: 7,
      bidValue: 7,
      dailyBudget: 15,
    });
    expect(rows[0]?.objective).toBe("OUTCOME_SALES");
    expect(requestModelStore.readLatestMetaCampaignConfigHistory).toHaveBeenCalled();
    expect(requestModelStore.readPreviousDifferentMetaCampaignConfigHistoryDiffs).not.toHaveBeenCalled();
    expect(apiMeta.fetchMetaCampaignConfigs).not.toHaveBeenCalled();
  });

  it("derives campaign previous bid and budget fields from typed history", async () => {
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: null,
        buyingType: null,
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 5,
        bidValue: 5,
        bidValueFormat: "currency",
        dailyBudget: 10,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 10,
        impressions: 100,
        clicks: 4,
        reach: 100,
        frequency: null,
        conversions: 1,
        revenue: 20,
        roas: 2,
        cpa: 10,
        ctr: 4,
        cpc: 2.5,
        sourceSnapshotId: null,
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-02",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: null,
        buyingType: null,
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 6,
        bidValue: 6,
        bidValueFormat: "currency",
        dailyBudget: 12,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 15,
        impressions: 110,
        clicks: 5,
        reach: 110,
        frequency: null,
        conversions: 2,
        revenue: 30,
        roas: 2,
        cpa: 7.5,
        ctr: 4.5,
        cpc: 3,
        sourceSnapshotId: null,
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: null,
        buyingType: null,
        optimizationGoal: "Purchase",
        bidStrategyType: "cost_cap",
        bidStrategyLabel: "Cost Cap",
        manualBidAmount: 8,
        bidValue: 8,
        bidValueFormat: "currency",
        dailyBudget: 15,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 20,
        impressions: 120,
        clicks: 6,
        reach: 120,
        frequency: null,
        conversions: 3,
        revenue: 40,
        roas: 2,
        cpa: 6.67,
        ctr: 5,
        cpc: 3.33,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(requestModelStore.readPreviousDifferentMetaCampaignConfigHistoryDiffs).mockResolvedValue(
      new Map([
        [
          "cmp-1",
          {
            previousManualBidAmount: 6,
            previousBidValue: 6,
            previousBidValueFormat: "currency",
            previousBidCapturedAt: "2026-04-02T00:00:00.000Z",
            previousDailyBudget: 12,
            previousLifetimeBudget: null,
            previousBudgetCapturedAt: "2026-04-02T00:00:00.000Z",
          },
        ],
      ]),
    );

    const rows = await getMetaWarehouseCampaignTable({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-03",
      includePrev: true,
    });

    expect(rows[0]).toMatchObject({
      previousManualBidAmount: 6,
      previousBidValue: 6,
      previousBidValueFormat: "currency",
      previousBidValueCapturedAt: "2026-04-02T00:00:00.000Z",
      previousDailyBudget: 12,
      previousLifetimeBudget: null,
      previousBudgetCapturedAt: "2026-04-02T00:00:00.000Z",
    });
    expect(requestModelStore.readPreviousDifferentMetaCampaignConfigHistoryDiffs).toHaveBeenCalled();
    expect(apiMeta.fetchMetaCampaignConfigs).not.toHaveBeenCalled();
  });

  it("uses campaign daily truth for summary totals when account rows drift", async () => {
    vi.mocked(warehouse.getMetaAccountDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        accountName: "Account 1",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 10,
        clicks: 1,
        reach: 10,
        frequency: 1,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: 10,
        cpc: 1,
        sourceSnapshotId: null,
        updatedAt: "2026-04-02T00:00:00Z",
      },
    ] as never);
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: "OUTCOME_SALES",
        buyingType: null,
        optimizationGoal: null,
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: 100,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 25,
        impressions: 100,
        clicks: 4,
        reach: 90,
        frequency: 1.11,
        conversions: 2,
        revenue: 50,
        roas: 2,
        cpa: 12.5,
        ctr: 4,
        cpc: 6.25,
        sourceSnapshotId: null,
        updatedAt: "2026-04-02T00:00:00Z",
      },
    ] as never);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: "2026-04-01",
      latest_updated_at: "2026-04-02T00:00:00Z",
      total_rows: 1,
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: "2026-04-01",
      latest_updated_at: "2026-04-02T00:00:00Z",
      total_rows: 1,
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 1, ready_through_date: "2026-04-01" }],
        ["breakdown_country", { completed_days: 1, ready_through_date: "2026-04-01" }],
        ["breakdown_gender", { completed_days: 1, ready_through_date: "2026-04-01" }],
        ["breakdown_platform_position", { completed_days: 1, ready_through_date: "2026-04-01" }],
      ]) as never,
    );
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      leasedPartitions: 0,
      queueDepth: 0,
    } as never);

    const summary = await getMetaWarehouseSummary({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-01",
    });

    expect(summary.totals.spend).toBe(25);
    expect(summary.totals.revenue).toBe(50);
    expect(summary.totals.conversions).toBe(2);
    expect(summary.accounts[0]).toMatchObject({
      providerAccountId: "act_1",
      accountName: "Account 1",
      spend: 25,
      revenue: 50,
    });
  });

  it("keeps warehouse summary partial until published truth exists", async () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      accountIds: ["act_1"],
      accountProfiles: {
        act_1: { name: "Account 1", timezone: "UTC", currency: "USD" },
      },
    } as never);
    vi.mocked(warehouse.getMetaAccountDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-07",
        accountName: "Account 1",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        frequency: 0,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
        updatedAt: "2026-04-08T00:00:00Z",
      },
    ] as never);
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-07",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: null,
        buyingType: null,
        optimizationGoal: null,
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
        updatedAt: "2026-04-08T00:00:00Z",
      },
    ] as never);
    vi.mocked(warehouse.getMetaPublishedVerificationSummary).mockResolvedValue({
      verificationState: "processing",
      truthReady: false,
      totalDays: 1,
      completedCoreDays: 1,
      sourceFetchedAt: null,
      publishedAt: null,
      asOf: null,
      publishedSlices: 0,
      totalExpectedSlices: 2,
      reasonCounts: { non_finalized: 1, validation_failed: 1, missing_breakdown: 1 },
      publishedKeysBySurface: {
        account_daily: [],
        campaign_daily: [],
      },
    } as never);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: "2026-04-07",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: "2026-04-07",
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: "2026-04-07",
    } as never);
    vi.mocked(warehouse.getMetaDirtyRecentDates).mockResolvedValue([
      {
        providerAccountId: "act_1",
        date: "2026-04-07",
        severity: "critical",
        reasons: ["non_finalized", "validation_failed", "missing_breakdown"],
        nonFinalized: true,
        validationFailed: true,
      },
    ] as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 1, ready_through_date: "2026-04-07" }],
        ["breakdown_country", { completed_days: 1, ready_through_date: "2026-04-07" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 1, ready_through_date: "2026-04-07" },
        ],
      ]) as never,
    );
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      leasedPartitions: 0,
      queueDepth: 0,
    } as never);

    const summary = await getMetaWarehouseSummary({
      businessId: "biz-1",
      startDate: "2026-04-07",
      endDate: "2026-04-07",
      providerAccountIds: ["act_1"],
    });

    expect(summary.isPartial).toBe(true);
    expect(summary.totals.spend).toBe(0);
    expect(summary.accounts).toHaveLength(0);
  });

  it("filters historical breakdown rows to published verified account-days when v2 is enabled", async () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    process.env.META_AUTHORITATIVE_FINALIZATION_CANARY_BUSINESSES = "";

    vi.mocked(warehouse.getMetaBreakdownDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        breakdownType: "age",
        breakdownKey: "18-24",
        breakdownLabel: "18-24",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 10,
        impressions: 100,
        clicks: 5,
        reach: 90,
        frequency: 1.1,
        conversions: 1,
        revenue: 20,
        roas: 2,
        cpa: 10,
        ctr: 5,
        cpc: 2,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        finalizedAt: "2026-04-02T00:00:00Z",
        validationStatus: "passed",
        sourceRunId: "run-1",
        createdAt: "2026-04-02T00:00:00Z",
        updatedAt: "2026-04-02T00:00:00Z",
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        breakdownType: "country",
        breakdownKey: "US",
        breakdownLabel: "United States",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 11,
        impressions: 100,
        clicks: 5,
        reach: 90,
        frequency: 1.1,
        conversions: 1,
        revenue: 20,
        roas: 2,
        cpa: 10,
        ctr: 5,
        cpc: 2,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        finalizedAt: "2026-04-02T00:00:00Z",
        validationStatus: "passed",
        sourceRunId: "run-1",
        createdAt: "2026-04-02T00:00:00Z",
        updatedAt: "2026-04-02T00:00:00Z",
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        breakdownType: "placement",
        breakdownKey: "facebook|feed|mobile",
        breakdownLabel: "facebook • feed • mobile",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 100,
        clicks: 5,
        reach: 90,
        frequency: 1.1,
        conversions: 1,
        revenue: 20,
        roas: 2,
        cpa: 10,
        ctr: 5,
        cpc: 2,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        finalizedAt: "2026-04-02T00:00:00Z",
        validationStatus: "passed",
        sourceRunId: "run-1",
        createdAt: "2026-04-02T00:00:00Z",
        updatedAt: "2026-04-02T00:00:00Z",
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-02",
        breakdownType: "age",
        breakdownKey: "25-34",
        breakdownLabel: "25-34",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 99,
        impressions: 100,
        clicks: 5,
        reach: 90,
        frequency: 1.1,
        conversions: 1,
        revenue: 20,
        roas: 2,
        cpa: 10,
        ctr: 5,
        cpc: 2,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        finalizedAt: "2026-04-03T00:00:00Z",
        validationStatus: "passed",
        sourceRunId: "run-2",
        createdAt: "2026-04-03T00:00:00Z",
        updatedAt: "2026-04-03T00:00:00Z",
      },
    ] as never);
    vi.mocked(warehouse.getMetaPublishedVerificationSummary).mockResolvedValue({
      verificationState: "finalized_verified",
      truthReady: true,
      totalDays: 2,
      completedCoreDays: 2,
      sourceFetchedAt: "2026-04-03T00:00:00Z",
      publishedAt: "2026-04-03T00:05:00Z",
      asOf: "2026-04-03T00:05:00Z",
      publishedSlices: 2,
      totalExpectedSlices: 2,
      reasonCounts: {},
      publishedKeysBySurface: {
        account_daily: ["act_1:2026-04-01", "act_1:2026-04-02"],
      },
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([] as never);
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([] as never);

    const payload = await getMetaWarehouseBreakdowns({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-02",
      providerAccountIds: ["act_1"],
    });

    expect(payload.age).toEqual([
      expect.objectContaining({ key: "18-24", spend: 10 }),
    ]);
    expect(payload.location).toEqual([
      expect.objectContaining({ key: "US", spend: 11 }),
    ]);
    expect(payload.placement).toEqual([
      expect.objectContaining({ key: "facebook|feed|mobile", spend: 12 }),
    ]);
  });

  it("keeps breakdown rows available when optional budget reads fail", async () => {
    vi.mocked(warehouse.getMetaBreakdownDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        breakdownType: "age",
        breakdownKey: "35-44",
        breakdownLabel: "35-44",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 88,
        impressions: 1200,
        clicks: 32,
        reach: 900,
        frequency: 1.2,
        conversions: 4,
        revenue: 240,
        roas: 2.73,
        cpa: 22,
        ctr: 2.66,
        cpc: 2.75,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        finalizedAt: "2026-04-02T00:00:00Z",
        validationStatus: "passed",
        sourceRunId: "run-age-1",
        createdAt: "2026-04-02T00:00:00Z",
        updatedAt: "2026-04-02T00:00:00Z",
      },
    ] as never);
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockRejectedValue(
      new Error("campaign budget timeout"),
    );
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockRejectedValue(
      new Error("adset budget timeout"),
    );

    const payload = await getMetaWarehouseBreakdowns({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-01",
      providerAccountIds: ["act_1"],
    });

    expect(payload.age).toEqual([
      expect.objectContaining({ key: "35-44", spend: 88 }),
    ]);
    expect(payload.location).toEqual([]);
    expect(payload.placement).toEqual([]);
    expect(payload.budget).toEqual({
      campaign: [],
      adset: [],
    });
  });

  it("keeps published breakdown rows when warehouse dates arrive as Date objects", async () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    process.env.META_AUTHORITATIVE_FINALIZATION_CANARY_BUSINESSES = "";

    vi.mocked(warehouse.getMetaBreakdownDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: new Date("2026-04-01T00:00:00.000Z"),
        breakdownType: "age",
        breakdownKey: "25-34",
        breakdownLabel: "25-34",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 42,
        impressions: 900,
        clicks: 27,
        reach: 700,
        frequency: 1.2,
        conversions: 3,
        revenue: 126,
        roas: 3,
        cpa: 14,
        ctr: 3,
        cpc: 1.55,
        sourceSnapshotId: null,
        truthState: "finalized_verified",
        truthVersion: 2,
        finalizedAt: "2026-04-02T00:00:00Z",
        validationStatus: "passed",
        sourceRunId: "run-age-date-object",
        createdAt: "2026-04-02T00:00:00Z",
        updatedAt: "2026-04-02T00:00:00Z",
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: new Date("2026-04-01T00:00:00.000Z"),
        breakdownType: "country",
        breakdownKey: "US",
        breakdownLabel: "United States",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 38,
        impressions: 860,
        clicks: 22,
        reach: 680,
        frequency: 1.15,
        conversions: 2,
        revenue: 84,
        roas: 2.21,
        cpa: 19,
        ctr: 2.56,
        cpc: 1.73,
        sourceSnapshotId: null,
        truthState: "finalized_verified",
        truthVersion: 2,
        finalizedAt: "2026-04-02T00:00:00Z",
        validationStatus: "passed",
        sourceRunId: "run-country-date-object",
        createdAt: "2026-04-02T00:00:00Z",
        updatedAt: "2026-04-02T00:00:00Z",
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: new Date("2026-04-01T00:00:00.000Z"),
        breakdownType: "placement",
        breakdownKey: "facebook|feed|mobile",
        breakdownLabel: "facebook • feed • mobile",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 40,
        impressions: 880,
        clicks: 24,
        reach: 690,
        frequency: 1.18,
        conversions: 2,
        revenue: 92,
        roas: 2.3,
        cpa: 20,
        ctr: 2.72,
        cpc: 1.67,
        sourceSnapshotId: null,
        truthState: "finalized_verified",
        truthVersion: 2,
        finalizedAt: "2026-04-02T00:00:00Z",
        validationStatus: "passed",
        sourceRunId: "run-placement-date-object",
        createdAt: "2026-04-02T00:00:00Z",
        updatedAt: "2026-04-02T00:00:00Z",
      },
    ] as never);
    vi.mocked(warehouse.getMetaPublishedVerificationSummary).mockResolvedValue({
      verificationState: "finalized_verified",
      truthReady: true,
      totalDays: 1,
      completedCoreDays: 1,
      sourceFetchedAt: "2026-04-02T00:00:00Z",
      publishedAt: "2026-04-02T00:05:00Z",
      asOf: "2026-04-02T00:05:00Z",
      publishedSlices: 1,
      totalExpectedSlices: 1,
      reasonCounts: {},
      publishedKeysBySurface: {
        account_daily: ["act_1:2026-04-01"],
      },
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([] as never);
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([] as never);

    const payload = await getMetaWarehouseBreakdowns({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-01",
      providerAccountIds: ["act_1"],
    });

    expect(payload.age).toEqual([expect.objectContaining({ key: "25-34", spend: 42 })]);
    expect(payload.location).toEqual([expect.objectContaining({ key: "US", spend: 38 })]);
    expect(payload.placement).toEqual([
      expect.objectContaining({ key: "facebook|feed|mobile", spend: 40 }),
    ]);
  });

  it("serves country-only breakdown rows even when age and placement rows are absent", async () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    process.env.META_AUTHORITATIVE_FINALIZATION_CANARY_BUSINESSES = "";

    vi.mocked(warehouse.getMetaBreakdownDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        breakdownType: "country",
        breakdownKey: "DE",
        breakdownLabel: "Germany",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 185,
        impressions: 3200,
        clicks: 84,
        reach: 2800,
        frequency: 1.2,
        conversions: 4,
        revenue: 410,
        roas: 2.22,
        cpa: 46.25,
        ctr: 2.63,
        cpc: 2.2,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        finalizedAt: "2026-04-02T00:00:00Z",
        validationStatus: "passed",
        sourceRunId: "run-geo-1",
        createdAt: "2026-04-02T00:00:00Z",
        updatedAt: "2026-04-02T00:00:00Z",
      },
    ] as never);
    vi.mocked(warehouse.getMetaPublishedVerificationSummary).mockResolvedValue({
      verificationState: "finalized_verified",
      truthReady: true,
      totalDays: 1,
      completedCoreDays: 1,
      sourceFetchedAt: "2026-04-02T00:00:00Z",
      publishedAt: "2026-04-02T00:05:00Z",
      asOf: "2026-04-02T00:05:00Z",
      publishedSlices: 1,
      totalExpectedSlices: 1,
      reasonCounts: {},
      publishedKeysBySurface: {
        account_daily: ["act_1:2026-04-01"],
      },
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([] as never);
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([] as never);

    const payload = await getMetaWarehouseCountryBreakdowns({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-01",
      providerAccountIds: ["act_1"],
    });

    expect(payload.rows).toEqual([
      expect.objectContaining({
        key: "DE",
        label: "Germany",
        spend: 185,
        purchases: 4,
      }),
    ]);
    expect(payload.isPartial).toBe(false);
    expect(payload.freshness.dataState).toBe("ready");
  });

  it("normalizes non-ISO trend dates before grouping and sorting", async () => {
    vi.mocked(warehouse.getMetaAccountDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "Mon Mar 30 2026 00:00:00 GMT+0000 (Coordinated Universal Time)",
        accountName: "Account 1",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 25,
        impressions: 100,
        clicks: 4,
        reach: 90,
        frequency: 1.1,
        conversions: 2,
        revenue: 50,
        roas: 2,
        cpa: 12.5,
        ctr: 4,
        cpc: 6.25,
        sourceSnapshotId: null,
        updatedAt: "2026-04-02T00:00:00Z",
      },
    ] as never);

    const trends = await getMetaWarehouseTrends({
      businessId: "biz-1",
      startDate: "2026-03-30",
      endDate: "2026-03-30",
      providerAccountIds: ["act_1"],
    });

    expect(trends.points).toHaveLength(1);
    expect(trends.points[0]).toMatchObject({
      date: "2026-03-30",
      spend: 25,
      revenue: 50,
      conversions: 2,
    });
  });

  it("keeps range adset goal while using typed history for current bid config", async () => {
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 5,
        bidValue: 5,
        bidValueFormat: "currency",
        dailyBudget: 10,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 15,
        impressions: 100,
        clicks: 4,
        reach: 100,
        frequency: null,
        conversions: 2,
        revenue: 30,
        roas: 2,
        cpa: 7.5,
        ctr: 4,
        cpc: 3.75,
        sourceSnapshotId: null,
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1 latest",
        adsetNameHistorical: "Adset 1 latest",
        adsetStatus: "PAUSED",
        optimizationGoal: "Lead",
        bidStrategyType: "cost_cap",
        bidStrategyLabel: "Cost Cap",
        manualBidAmount: 8,
        bidValue: 8,
        bidValueFormat: "currency",
        dailyBudget: 14,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 20,
        impressions: 120,
        clicks: 6,
        reach: 120,
        frequency: null,
        conversions: 3,
        revenue: 40,
        roas: 2,
        cpa: 6.67,
        ctr: 5,
        cpc: 3.33,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaAdSetDimensions).mockResolvedValue(
      new Map([
        [
          "adset-1",
          {
            businessId: "biz-1",
            businessRefId: "biz-ref-1",
            providerAccountId: "act_1",
            providerAccountRefId: "provider-ref-1",
            campaignId: "cmp-1",
            adsetId: "adset-1",
            adsetNameCurrent: "Adset 1",
            adsetNameHistorical: "Adset 1",
            adsetStatus: "PAUSED",
            firstSeenAt: null,
            lastSeenAt: null,
            sourceUpdatedAt: null,
          },
        ],
      ]),
    );
    vi.mocked(requestModelStore.readLatestMetaAdSetConfigHistory).mockResolvedValue(
      new Map([
        [
          "adset-1",
          {
            campaignId: "cmp-1",
            optimizationGoal: "Purchase",
            bidStrategyType: "cost_cap",
            bidStrategyLabel: "Cost Cap",
            manualBidAmount: 8,
            bidValue: 8,
            bidValueFormat: "currency",
            dailyBudget: 14,
            lifetimeBudget: null,
            isBudgetMixed: false,
            isConfigMixed: false,
            isOptimizationGoalMixed: false,
            isBidStrategyMixed: false,
            isBidValueMixed: false,
          },
        ],
      ]),
    );

    const rows = await getMetaWarehouseAdSets({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-03",
      campaignId: "cmp-1",
      includePrev: false,
    });

    expect(rows[0]).toMatchObject({
      id: "adset-1",
      status: "PAUSED",
      optimizationGoal: "Lead",
      isOptimizationGoalMixed: true,
      bidStrategyType: "cost_cap",
      manualBidAmount: 8,
      dailyBudget: 14,
    });
    expect(requestModelStore.readLatestMetaAdSetConfigHistory).toHaveBeenCalled();
    expect(requestModelStore.readPreviousDifferentMetaAdSetConfigHistoryDiffs).not.toHaveBeenCalled();
    expect(apiMeta.fetchMetaAdSetConfigs).not.toHaveBeenCalled();
  });

  it("reads missing campaign bid values from typed history without persisting them from serving", async () => {
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: null,
        buyingType: null,
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: 15,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 30,
        impressions: 120,
        clicks: 5,
        reach: 120,
        frequency: null,
        conversions: 3,
        revenue: 80,
        roas: 2.67,
        cpa: 10,
        ctr: 4.16,
        cpc: 6,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(requestModelStore.readLatestMetaCampaignConfigHistory).mockResolvedValue(
      new Map([
        [
          "cmp-1",
          {
            campaignId: "cmp-1",
            objective: "OUTCOME_SALES",
            optimizationGoal: "Purchase",
            bidStrategyType: "bid_cap",
            bidStrategyLabel: "Bid Cap",
            manualBidAmount: 2200,
            bidValue: 2200,
            bidValueFormat: "currency",
            dailyBudget: 15,
            lifetimeBudget: null,
            isBudgetMixed: false,
            isConfigMixed: false,
            isOptimizationGoalMixed: false,
            isBidStrategyMixed: false,
            isBidValueMixed: false,
          },
        ],
      ])
    );

    const rows = await getMetaWarehouseCampaignTable({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      includePrev: false,
    });

    expect(rows[0]).toMatchObject({
      objective: "OUTCOME_SALES",
      manualBidAmount: 2200,
      bidValue: 2200,
      bidValueFormat: "currency",
    });
    expect(warehouse.upsertMetaCampaignDailyRows).not.toHaveBeenCalled();
    expect(apiMeta.fetchMetaCampaignConfigs).not.toHaveBeenCalled();
  });

  it("reads missing adset target roas values from typed history without persisting them from serving", async () => {
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: "Purchase",
        bidStrategyType: "target_roas",
        bidStrategyLabel: "Target ROAS",
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: 10,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 15,
        impressions: 100,
        clicks: 4,
        reach: 100,
        frequency: null,
        conversions: 2,
        revenue: 30,
        roas: 2,
        cpa: 7.5,
        ctr: 4,
        cpc: 3.75,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(requestModelStore.readLatestMetaAdSetConfigHistory).mockResolvedValue(
      new Map([
        [
          "adset-1",
          {
            campaignId: "cmp-1",
            optimizationGoal: "Purchase",
            bidStrategyType: "target_roas",
            bidStrategyLabel: "Target ROAS",
            manualBidAmount: null,
            bidValue: 2.5,
            bidValueFormat: "roas",
            dailyBudget: 10,
            lifetimeBudget: null,
            isBudgetMixed: false,
            isConfigMixed: false,
            isOptimizationGoalMixed: false,
            isBidStrategyMixed: false,
            isBidValueMixed: false,
          },
        ],
      ])
    );

    const rows = await getMetaWarehouseAdSets({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      campaignId: "cmp-1",
      includePrev: false,
    });

    expect(rows[0]).toMatchObject({
      optimizationGoal: "Purchase",
      bidStrategyType: "target_roas",
      bidValue: 2.5,
      bidValueFormat: "roas",
    });
    expect(warehouse.upsertMetaAdSetDailyRows).not.toHaveBeenCalled();
    expect(apiMeta.fetchMetaAdSetConfigs).not.toHaveBeenCalled();
  });

  it("derives adset previous bid and budget fields from typed history", async () => {
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 5,
        bidValue: 5,
        bidValueFormat: "currency",
        dailyBudget: 10,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 10,
        impressions: 100,
        clicks: 4,
        reach: 100,
        frequency: null,
        conversions: 1,
        revenue: 20,
        roas: 2,
        cpa: 10,
        ctr: 4,
        cpc: 2.5,
        sourceSnapshotId: null,
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-02",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 6,
        bidValue: 6,
        bidValueFormat: "currency",
        dailyBudget: 12,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 15,
        impressions: 110,
        clicks: 5,
        reach: 110,
        frequency: null,
        conversions: 2,
        revenue: 30,
        roas: 2,
        cpa: 7.5,
        ctr: 4.5,
        cpc: 3,
        sourceSnapshotId: null,
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: "Lead",
        bidStrategyType: "cost_cap",
        bidStrategyLabel: "Cost Cap",
        manualBidAmount: 8,
        bidValue: 8,
        bidValueFormat: "currency",
        dailyBudget: 14,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 20,
        impressions: 120,
        clicks: 6,
        reach: 120,
        frequency: null,
        conversions: 3,
        revenue: 40,
        roas: 2,
        cpa: 6.67,
        ctr: 5,
        cpc: 3.33,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(requestModelStore.readPreviousDifferentMetaAdSetConfigHistoryDiffs).mockResolvedValue(
      new Map([
        [
          "adset-1",
          {
            previousManualBidAmount: 6,
            previousBidValue: 6,
            previousBidValueFormat: "currency",
            previousBidCapturedAt: "2026-04-02T00:00:00.000Z",
            previousDailyBudget: 12,
            previousLifetimeBudget: null,
            previousBudgetCapturedAt: "2026-04-02T00:00:00.000Z",
          },
        ],
      ]),
    );

    const rows = await getMetaWarehouseAdSets({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-03",
      campaignId: "cmp-1",
      includePrev: true,
    });

    expect(rows[0]).toMatchObject({
      previousManualBidAmount: 6,
      previousBidValue: 6,
      previousBidValueFormat: "currency",
      previousBidValueCapturedAt: "2026-04-02T00:00:00.000Z",
      previousDailyBudget: 12,
      previousLifetimeBudget: null,
      previousBudgetCapturedAt: "2026-04-02T00:00:00.000Z",
    });
    expect(requestModelStore.readPreviousDifferentMetaAdSetConfigHistoryDiffs).toHaveBeenCalled();
    expect(apiMeta.fetchMetaAdSetConfigs).not.toHaveBeenCalled();
  });

  it("reads missing campaign and adset config from typed request model without calling live Meta fetches", async () => {
    vi.mocked(requestModelStore.readLatestMetaCampaignConfigHistory).mockResolvedValue(
      new Map([
        [
          "cmp-1",
          {
            campaignId: "cmp-1",
            objective: "OUTCOME_SALES",
            optimizationGoal: "Purchase",
            bidStrategyType: "LOWEST_COST_WITH_BID_CAP",
            bidStrategyLabel: "Bid Cap",
            manualBidAmount: 5,
            bidValue: 5,
            bidValueFormat: "currency",
            dailyBudget: 10,
            lifetimeBudget: null,
            isBudgetMixed: false,
            isConfigMixed: false,
            isOptimizationGoalMixed: false,
            isBidStrategyMixed: false,
            isBidValueMixed: false,
          },
        ],
      ]),
    );
    vi.mocked(requestModelStore.readLatestMetaAdSetConfigHistory).mockResolvedValue(
      new Map([
        [
          "adset-1",
          {
            campaignId: "cmp-1",
            optimizationGoal: "Purchase",
            bidStrategyType: "LOWEST_COST_WITH_BID_CAP",
            bidStrategyLabel: "Bid Cap",
            manualBidAmount: 4,
            bidValue: 4,
            bidValueFormat: "currency",
            dailyBudget: 8,
            lifetimeBudget: null,
            isBudgetMixed: false,
            isConfigMixed: false,
            isOptimizationGoalMixed: false,
            isBidStrategyMixed: false,
            isBidValueMixed: false,
          },
        ],
      ]),
    );
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: null,
        buyingType: null,
        optimizationGoal: null,
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 20,
        impressions: 100,
        clicks: 4,
        reach: 100,
        frequency: null,
        conversions: 2,
        revenue: 50,
        roas: 2.5,
        cpa: 10,
        ctr: 4,
        cpc: 5,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: null,
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 80,
        clicks: 3,
        reach: 80,
        frequency: null,
        conversions: 1,
        revenue: 24,
        roas: 2,
        cpa: 12,
        ctr: 3.75,
        cpc: 4,
        sourceSnapshotId: null,
      },
    ] as never);

    const [campaignRows, adsetRows] = await Promise.all([
      getMetaWarehouseCampaignTable({
        businessId: "biz-1",
        startDate: "2026-04-03",
        endDate: "2026-04-03",
        includePrev: false,
      }),
      getMetaWarehouseAdSets({
        businessId: "biz-1",
        startDate: "2026-04-03",
        endDate: "2026-04-03",
        campaignId: "cmp-1",
        includePrev: false,
      }),
    ]);

    expect(campaignRows[0]).toMatchObject({
      objective: "OUTCOME_SALES",
      bidStrategyLabel: "Bid Cap",
      bidValue: 5,
      dailyBudget: 10,
    });
    expect(adsetRows[0]).toMatchObject({
      optimizationGoal: "Purchase",
      bidStrategyLabel: "Bid Cap",
      bidValue: 4,
      dailyBudget: 8,
    });
    expect(warehouse.upsertMetaCampaignDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaAdSetDailyRows).not.toHaveBeenCalled();
    expect(apiMeta.fetchMetaCampaignConfigs).not.toHaveBeenCalled();
    expect(apiMeta.fetchMetaAdSetConfigs).not.toHaveBeenCalled();
  });

  it("repairs an entire warehouse date range and reports changed row counts", async () => {
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token-1",
      accountIds: ["act_1"],
      currency: "USD",
      accountProfiles: {
        act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
      },
    } as never);
    vi.mocked(apiMeta.fetchMetaCampaignConfigs).mockResolvedValue(
      new Map([
        [
          "cmp-1",
          {
            id: "cmp-1",
            name: "Campaign 1",
            objective: "OUTCOME_SALES",
            bid_strategy: "LOWEST_COST_WITH_BID_CAP",
            bid_amount: "5",
            daily_budget: "10",
          },
        ],
      ]) as never
    );
    vi.mocked(apiMeta.fetchMetaAdSetConfigs).mockResolvedValue(
      new Map([
        [
          "adset-1",
          {
            id: "adset-1",
            name: "Adset 1",
            campaign_id: "cmp-1",
            optimization_goal: "omni_purchase",
            bid_strategy: "LOWEST_COST_WITH_BID_CAP",
            bid_amount: "4",
            daily_budget: "8",
          },
        ],
      ]) as never
    );
    vi.mocked(warehouse.getMetaCampaignDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: null,
        buyingType: null,
        optimizationGoal: null,
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 20,
        impressions: 100,
        clicks: 4,
        reach: 100,
        frequency: null,
        conversions: 2,
        revenue: 50,
        roas: 2.5,
        cpa: 10,
        ctr: 4,
        cpc: 5,
        sourceSnapshotId: null,
      },
    ] as never);
    vi.mocked(warehouse.getMetaAdSetDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: null,
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 80,
        clicks: 3,
        reach: 80,
        frequency: null,
        conversions: 1,
        revenue: 24,
        roas: 2,
        cpa: 12,
        ctr: 3.75,
        cpc: 4,
        sourceSnapshotId: null,
      },
    ] as never);

    const result = await repairMetaWarehouseTruthRange({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
    });

    expect(result).toMatchObject({
      accountRowsScanned: 0,
      campaignRowsScanned: 1,
      adsetRowsScanned: 1,
      accountRowsChanged: 1,
      campaignRowsChanged: 1,
      adsetRowsChanged: 1,
    });
  });
});
