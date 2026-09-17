import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/meta/live", () => ({
  getMetaLiveSummaryTotals: vi.fn(),
}));

vi.mock("@/lib/meta/readiness", () => ({
  getMetaPartialReason: vi.fn(),
  getMetaRangePreparationContext: vi.fn(),
}));

vi.mock("@/lib/meta/serving", () => ({
  getMetaWarehouseSummary: vi.fn(),
  getMetaWarehouseTrends: vi.fn(),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/sync/meta-sync", () => ({
  getMetaSelectedRangeTruthReadiness: vi.fn(),
}));

const integrations = await import("@/lib/integrations");
const live = await import("@/lib/meta/live");
const readiness = await import("@/lib/meta/readiness");
const serving = await import("@/lib/meta/serving");
const assignments = await import("@/lib/provider-account-assignments");
const metaSync = await import("@/lib/sync/meta-sync");
const canonical = await import("@/lib/meta/canonical-overview");

describe("meta canonical overview summary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
    } as never);
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: false,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-04-07",
      selectedRangeTruthEndDate: "2026-04-07",
      currentDateInTimezone: "2026-04-08",
      primaryAccountTimezone: "America/Los_Angeles",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "historical_authoritative",
      breakdownReadMode: "historical_authoritative",
    } as never);
    vi.mocked(readiness.getMetaPartialReason).mockReturnValue(
      "Warehouse data is still being prepared for the requested range.",
    );
    vi.mocked(live.getMetaLiveSummaryTotals).mockResolvedValue({
      spend: 0,
      revenue: 0,
      conversions: 0,
      roas: 0,
      cpa: null,
      ctr: null,
      cpc: null,
      impressions: 0,
      clicks: 0,
      reach: 0,
    } as never);
    vi.mocked(serving.getMetaWarehouseTrends).mockResolvedValue({
      freshness: {
        dataState: "ready",
        lastSyncedAt: "2026-04-19T00:00:00Z",
        liveRefreshedAt: null,
        isPartial: false,
        missingWindows: [],
        warnings: [],
      },
      isPartial: false,
      verification: null,
      warehouseScope: "account_daily",
      points: [],
    } as never);
  });

  it("keeps historical non-finalized-only ranges partial until published truth exists", async () => {
    vi.mocked(serving.getMetaWarehouseSummary).mockResolvedValue({
      freshness: {
        dataState: "ready",
        lastSyncedAt: "2026-04-08T00:00:00Z",
        liveRefreshedAt: null,
        isPartial: false,
        missingWindows: [],
        warnings: [],
      },
      historicalSync: {
        progressPercent: 100,
        completedDays: 394,
        totalDays: 394,
        readyThroughDate: "2026-04-06",
        state: "ready",
      },
      isPartial: true,
      verification: null,
      totals: {
        spend: 0,
        revenue: 0,
        conversions: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        impressions: 0,
        clicks: 0,
        reach: 0,
      },
      accounts: [],
    } as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      totalDays: 1,
      completedCoreDays: 1,
      blockingReasons: ["non_finalized"],
      reasonCounts: { non_finalized: 1 },
    } as never);

    const result = await canonical.getMetaCanonicalOverviewSummary({
      businessId: "biz-1",
      startDate: "2026-04-07",
      endDate: "2026-04-07",
    });

    expect(result.isPartial).toBe(true);
    expect(result.notReadyReason).toContain("being prepared");
    expect(result.readSource).toBe("warehouse_published");
  });

  it("uses the historical truth end date when a selected range includes today", async () => {
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: false,
      selectedRangeIncludesCurrentDay: true,
      selectedRangeHistoricalEndDate: "2026-04-18",
      selectedRangeTruthEndDate: "2026-04-18",
      currentDateInTimezone: "2026-04-19",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "historical_authoritative",
      breakdownReadMode: "historical_authoritative",
    } as never);
    vi.mocked(serving.getMetaWarehouseSummary).mockResolvedValue({
      freshness: {
        dataState: "ready",
        lastSyncedAt: "2026-04-19T00:00:00Z",
        liveRefreshedAt: null,
        isPartial: false,
        missingWindows: [],
        warnings: [],
      },
      historicalSync: {
        progressPercent: 100,
        completedDays: 6,
        totalDays: 6,
        readyThroughDate: "2026-04-18",
        state: "ready",
      },
      isPartial: false,
      verification: {
        verificationState: "finalized_verified",
        sourceFetchedAt: "2026-04-19T00:00:00Z",
        publishedAt: "2026-04-19T00:05:00Z",
        asOf: "2026-04-19T00:05:00Z",
      },
      totals: {
        spend: 100,
        revenue: 250,
        conversions: 4,
        roas: 2.5,
        cpa: 25,
        ctr: 1.2,
        cpc: 2.4,
        impressions: 1000,
        clicks: 42,
        reach: 900,
      },
      accounts: [],
    } as never);

    const result = await canonical.getMetaCanonicalOverviewSummary({
      businessId: "biz-1",
      startDate: "2026-04-13",
      endDate: "2026-04-19",
    });

    expect(serving.getMetaWarehouseSummary).toHaveBeenCalledWith({
      businessId: "biz-1",
      startDate: "2026-04-13",
      endDate: "2026-04-18",
      providerAccountIds: ["act_1"],
    });
    expect(result.isPartial).toBe(false);
    expect(result.notReadyReason).toBeNull();
    expect(result.readSource).toBe("warehouse_published");
    expect(result.effectiveEndDate).toBe("2026-04-18");

    const trends = await canonical.getMetaCanonicalOverviewTrends({
      businessId: "biz-1",
      startDate: "2026-04-13",
      endDate: "2026-04-19",
    });
    expect(serving.getMetaWarehouseTrends).toHaveBeenCalledWith({
      businessId: "biz-1",
      startDate: "2026-04-13",
      endDate: "2026-04-18",
      providerAccountIds: ["act_1"],
    });
    expect(trends.effectiveEndDate).toBe("2026-04-18");
  });
});
