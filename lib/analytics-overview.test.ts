import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The design's KPI cards carry a "vs prev Nd" line and its new/returning cards
 * carry an engagement rate. Both facts come from GA4 reports this module
 * already runs; this file holds the handler to serving them rather than
 * discarding them.
 */
const mocks = vi.hoisted(() => ({
  isDemoBusiness: vi.fn(async () => false),
  runGA4Report: vi.fn(),
  newVsReturningHeaders: [
    "sessions",
    "ecommercePurchases",
    "purchaseRevenue",
    "engagementRate",
  ] as string[],
}));

vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness: mocks.isDemoBusiness }));
vi.mock("@/lib/demo-business", () => ({ getDemoAnalyticsOverview: () => ({}) }));
vi.mock("@/lib/google-analytics-reporting", () => ({
  GA4AuthError: class GA4AuthError extends Error {},
  generateInsights: () => [],
  getGA4TokenAndProperty: async () => ({
    accessToken: "token",
    propertyId: "properties/1",
    propertyName: "Test GA4",
  }),
  runGA4Report: mocks.runGA4Report,
}));

const { getAnalyticsOverviewData } = await import("@/lib/analytics-overview");

const CURRENT: Record<string, number> = {
  totalUsers: 3800,
  newUsers: 2600,
  sessions: 241_800,
  engagedSessions: 158_600,
  engagementRate: 0.656,
  ecommercePurchases: 4290,
  purchaseRevenue: 326_400,
  averageSessionDuration: 92.4,
  totalPurchasers: 110,
  firstTimePurchasers: 71,
  averagePurchaseRevenuePerPayingUser: 76.1,
};

const PREVIOUS: Record<string, number> = { ...CURRENT, sessions: 223_500, ecommercePurchases: 3850 };

interface ReportParams {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  metrics: Array<{ name: string }>;
  dimensions?: Array<{ name: string }>;
}

function summaryReport(params: ReportParams, values: Record<string, number>) {
  const metricHeaders = params.metrics.map((metric) => metric.name);
  return {
    dimensionHeaders: [],
    metricHeaders,
    rows: [
      {
        dimensions: [],
        metrics: metricHeaders.map((name) => String(values[name] ?? 0)),
      },
    ],
    rowCount: 1,
    totals: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDemoBusiness.mockResolvedValue(false);
  mocks.newVsReturningHeaders = [
    "sessions",
    "ecommercePurchases",
    "purchaseRevenue",
    "engagementRate",
  ];
  mocks.runGA4Report.mockImplementation(async (params: ReportParams) => {
    const dimensions = (params.dimensions ?? []).map((dimension) => dimension.name);
    if (dimensions.length === 0) {
      const isComparison = params.dateRanges[0]?.startDate === "2026-06-20";
      return summaryReport(params, isComparison ? PREVIOUS : CURRENT);
    }
    if (dimensions[0] === "newVsReturning") {
      const headers = mocks.newVsReturningHeaders;
      const cell = (
        sessions: number,
        purchases: number,
        revenue: number,
        engagement: number,
      ) =>
        headers.map((header) =>
          header === "sessions"
            ? String(sessions)
            : header === "ecommercePurchases"
              ? String(purchases)
              : header === "purchaseRevenue"
                ? String(revenue)
                : String(engagement),
        );
      return {
        dimensionHeaders: ["newVsReturning"],
        metricHeaders: headers,
        rows: [
          { dimensions: ["new"], metrics: cell(178_400, 2159, 120_000, 0.612) },
          { dimensions: ["returning"], metrics: cell(63_400, 2131, 206_400, 0.781) },
        ],
        rowCount: 2,
        totals: undefined,
      };
    }
    return {
      dimensionHeaders: dimensions,
      metricHeaders: params.metrics.map((metric) => metric.name),
      rows: [],
      rowCount: 0,
      totals: undefined,
    };
  });
});

describe("getAnalyticsOverviewData", () => {
  it("serves the new/returning engagement rate GA4 already returns", async () => {
    const payload = await getAnalyticsOverviewData({
      businessId: "biz_1",
      startDate: "2026-07-18",
      endDate: "2026-08-14",
    });
    expect(payload.newVsReturning?.new.engagementRate).toBeCloseTo(0.612);
    expect(payload.newVsReturning?.returning.engagementRate).toBeCloseTo(0.781);
  });

  it("leaves the engagement rate absent when the property refuses the metric", async () => {
    mocks.newVsReturningHeaders = ["sessions", "ecommercePurchases", "purchaseRevenue"];
    const payload = await getAnalyticsOverviewData({
      businessId: "biz_1",
      startDate: "2026-07-18",
      endDate: "2026-08-14",
    });
    expect(payload.newVsReturning?.new.engagementRate).toBeUndefined();
    // A missing metric is never a zero.
    expect(payload.newVsReturning?.new.sessions).toBe(178_400);
  });

  it("runs no comparison report unless the caller named a window", async () => {
    const payload = await getAnalyticsOverviewData({
      businessId: "biz_1",
      startDate: "2026-07-18",
      endDate: "2026-08-14",
    });
    expect(payload.previousKpis).toBeUndefined();
    expect(mocks.runGA4Report).toHaveBeenCalledTimes(3);
  });

  it("adds exactly one report when a comparison window is named", async () => {
    const payload = await getAnalyticsOverviewData({
      businessId: "biz_1",
      startDate: "2026-07-18",
      endDate: "2026-08-14",
      compareStartDate: "2026-06-20",
      compareEndDate: "2026-07-17",
    });
    expect(mocks.runGA4Report).toHaveBeenCalledTimes(4);
    expect(payload.kpis?.sessions).toBe(241_800);
    expect(payload.previousKpis?.sessions).toBe(223_500);
    expect(payload.previousKpis?.purchases).toBe(3850);
  });
});
