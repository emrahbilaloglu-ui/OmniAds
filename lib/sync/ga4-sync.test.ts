import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  GA4_AUTO_WARM_DATE_WINDOWS,
  GA4_AUTO_WARM_DETAIL_REQUESTS,
  isGa4AutoWarmDemographicsDimension,
  isGa4AutoWarmDetailRequest,
  isGa4AutoWarmWindowDays,
} from "@/lib/sync/report-warmer-boundaries";

class MockGA4AuthError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = "GA4AuthError";
    this.code = code;
    this.status = status;
  }
}

const sql = vi.fn();

vi.mock("@/lib/sync/global-kill-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/global-kill-switch")>();
  return {
    ...actual,
    // Lanes default to OFF. Admission has its own suite
    // (source-ingest-admission.test.ts); this one is about what runs behind it.
    assertSyncLaneEnabled: vi.fn(() => ({
      lane: "source_ingest" as const,
      enabled: true,
      reason: "enabled" as const,
    })),
  };
});

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/db-growth-fence")>();
  return {
    ...actual,
    assertSyncGrowthBoundary: vi.fn(async () => ({
      allowed: true as const,
      reason: "ready" as const,
      warning: false,
      databaseBytes: 1,
      databaseBudgetBytes: 2,
      tableBytes: {},
      offender: null,
      evaluatedAt: "2026-07-26T00:00:00.000Z",
      errorMessage: null,
      overridden: false,
    })),
  };
});
vi.mock("@/lib/google-analytics-reporting", () => ({
  resolveGa4AnalyticsContext: vi.fn(),
  GA4AuthError: MockGA4AuthError,
}));

vi.mock("@/lib/route-report-cache", () => ({
  getNormalizedSearchParamsKey: vi.fn((searchParams: URLSearchParams) =>
    `${searchParams.get("startDate")}:${searchParams.get("endDate")}`,
  ),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `${businessId}-ref`] as const),
    );
  }),
}));

vi.mock("@/lib/user-facing-report-cache-owners", () => ({
  warmGa4EcommerceFallbackCache: vi.fn(),
  warmGa4UserFacingRouteReportCache: vi.fn(),
}));

const ga4 = await import("@/lib/google-analytics-reporting");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const cacheOwners = await import("@/lib/user-facing-report-cache-owners");
const { syncGA4Reports } = await import("@/lib/sync/ga4-sync");

function buildDateRange(days: number) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - days);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

describe("syncGA4Reports", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));
    vi.resetAllMocks();
    sql.mockResolvedValue([]);
    vi.mocked(ga4.resolveGa4AnalyticsContext).mockResolvedValue({
      propertyId: "properties/123",
    } as never);
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
    vi.mocked(cacheOwners.warmGa4UserFacingRouteReportCache).mockImplementation(
      async (input) =>
        ({
          reportType: input.reportType,
        }) as never,
    );
    vi.mocked(cacheOwners.warmGa4EcommerceFallbackCache).mockResolvedValue({
      reportType: "ecommerce_fallback",
      wrote: true,
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warms overview and ecommerce fallback caches through the sync owner", async () => {
    const result = await syncGA4Reports("biz_1");

    const expectedDateRanges = GA4_AUTO_WARM_DATE_WINDOWS.map((window) =>
      buildDateRange(window.days),
    );
    expect(vi.mocked(cacheOwners.warmGa4UserFacingRouteReportCache).mock.calls).toEqual(
      expectedDateRanges.flatMap(({ startDate, endDate }) => [
        [
          {
            businessId: "biz_1",
            reportType: "ga4_analytics_overview",
            startDate,
            endDate,
          },
        ],
        ...GA4_AUTO_WARM_DETAIL_REQUESTS.map((report) => [
          {
            businessId: "biz_1",
            startDate,
            endDate,
            ...report,
          },
        ]),
      ]),
    );
    expect(vi.mocked(cacheOwners.warmGa4EcommerceFallbackCache).mock.calls).toEqual(
      expectedDateRanges.map(({ startDate, endDate }) => [
        {
          businessId: "biz_1",
          startDate,
          endDate,
        },
      ]),
    );
    expect(result).toEqual({
      businessId: "biz_1",
      attempted: GA4_AUTO_WARM_DATE_WINDOWS.length,
      succeeded: GA4_AUTO_WARM_DATE_WINDOWS.length,
      failed: 0,
      skipped: false,
    });
    expect(
      sql.mock.calls.some(([strings]) =>
        String((strings as TemplateStringsArray).join(" ")).includes("business_ref_id"),
      ),
    ).toBe(true);
  });

  it("skips warming when GA4 auth is unavailable", async () => {
    vi.mocked(ga4.resolveGa4AnalyticsContext).mockRejectedValue(
      new ga4.GA4AuthError("ga4_not_connected", "Not connected", 404),
    );

    const result = await syncGA4Reports("biz_1");

    expect(result).toEqual({
      businessId: "biz_1",
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
    });
    expect(cacheOwners.warmGa4UserFacingRouteReportCache).not.toHaveBeenCalled();
    expect(cacheOwners.warmGa4EcommerceFallbackCache).not.toHaveBeenCalled();
  });

  it("keeps non-default windows and non-country demographics manual", async () => {
    await syncGA4Reports("biz_1");

    expect(isGa4AutoWarmWindowDays(30)).toBe(true);
    expect(isGa4AutoWarmWindowDays(7)).toBe(true);
    expect(isGa4AutoWarmWindowDays(14)).toBe(false);
    expect(isGa4AutoWarmDemographicsDimension("country")).toBe(true);
    expect(isGa4AutoWarmDemographicsDimension("city")).toBe(false);
    expect(
      isGa4AutoWarmDetailRequest({
        reportType: "ga4_detailed_demographics",
        dimension: "country",
      }),
    ).toBe(true);
    expect(
      isGa4AutoWarmDetailRequest({
        reportType: "ga4_detailed_demographics",
        dimension: "city",
      }),
    ).toBe(false);
    expect(
      isGa4AutoWarmDetailRequest({
        reportType: "ga4_detailed_audience",
        dimension: "country",
      }),
    ).toBe(false);

    const routeWarmCalls = vi
      .mocked(cacheOwners.warmGa4UserFacingRouteReportCache)
      .mock.calls.map(([input]) => input);
    const detailWarmCalls = routeWarmCalls.filter(
      (input) => input.reportType !== "ga4_analytics_overview",
    );

    expect(detailWarmCalls).toHaveLength(12);
    expect(
      new Set(detailWarmCalls.map((input) => `${input.startDate}:${input.endDate}`)),
    ).toEqual(new Set(["2026-03-10:2026-04-09", "2026-04-02:2026-04-09"]));
    expect(
      detailWarmCalls
        .filter((input) => input.reportType === "ga4_detailed_demographics")
        .map((input) => input.dimension ?? null),
    ).toEqual(
      GA4_AUTO_WARM_DATE_WINDOWS.map(() => "country"),
    );
    expect(
      detailWarmCalls
        .filter((input) => input.reportType !== "ga4_detailed_demographics")
        .every((input) => input.dimension == null),
    ).toBe(true);
  });

  it("logs and continues when a detailed warmer fails after the core GA4 warmers succeed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(cacheOwners.warmGa4UserFacingRouteReportCache).mockImplementation(
      async (input) => {
        if (input.reportType === "ga4_detailed_products") {
          throw new Error("detail warmer failed");
        }
        return {
          reportType: input.reportType,
        } as never;
      },
    );

    const result = await syncGA4Reports("biz_1");

    expect(result).toEqual({
      businessId: "biz_1",
      attempted: GA4_AUTO_WARM_DATE_WINDOWS.length,
      succeeded: GA4_AUTO_WARM_DATE_WINDOWS.length,
      failed: 0,
      skipped: false,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[ga4-sync] detail_cache_warm_failed",
      expect.objectContaining({
        businessId: "biz_1",
        reportType: "ga4_detailed_products",
        dimension: null,
      }),
    );
    warnSpy.mockRestore();
  });
});
