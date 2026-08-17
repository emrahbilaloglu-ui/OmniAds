import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every payload that carries GA4 money must also carry the unit that money is
 * in. GA4 reports `purchaseRevenue` / `itemRevenue` in the property's own
 * currency, so a payload with revenue and no currency is a number with no unit
 * — which is exactly how a EUR property came to be rendered in dollars.
 */
const mocks = vi.hoisted(() => ({
  currencyCode: null as string | null,
  runGA4Report: vi.fn(),
}));

vi.mock("@/lib/google-analytics-reporting", () => ({
  GA4AuthError: class GA4AuthError extends Error {},
  isGa4InvalidArgumentError: () => false,
  getGA4TokenAndProperty: async () => ({
    accessToken: "token",
    propertyId: "properties/12345",
    propertyName: "Grandmix",
    currencyCode: mocks.currencyCode,
  }),
  runGA4Report: mocks.runGA4Report,
}));

const {
  getGa4DetailedAudienceData,
  getGa4DetailedCohortsData,
  getGa4DetailedDemographicsData,
  getGa4DetailedProductsData,
} = await import("@/lib/ga4-user-facing-reports");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const WINDOW = { businessId: BUSINESS_ID, startDate: "30daysAgo", endDate: "yesterday" };

interface ReportParams {
  metrics?: Array<{ name: string }>;
  dimensions?: Array<{ name: string }>;
}

/** One row of ones, whatever metrics and dimensions were asked for. */
function onesReport(params: ReportParams) {
  const metricHeaders = (params.metrics ?? []).map((metric) => metric.name);
  const dimensionHeaders = (params.dimensions ?? []).map((dimension) => dimension.name);
  return {
    dimensionHeaders,
    metricHeaders,
    rows: [
      {
        dimensions: dimensionHeaders.map((name) => `${name}-value`),
        metrics: metricHeaders.map(() => "1"),
      },
    ],
    rowCount: 1,
    totals: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runGA4Report.mockImplementation(async (params: ReportParams) => onesReport(params));
});

describe("GA4 detailed reports carry the property's currency", () => {
  it("serves the code on all four payloads when the property has one", async () => {
    mocks.currencyCode = "TRY";

    const [audience, cohorts, demographics, products] = await Promise.all([
      getGa4DetailedAudienceData(WINDOW),
      getGa4DetailedCohortsData(WINDOW),
      getGa4DetailedDemographicsData({ ...WINDOW, dimension: "country" }),
      getGa4DetailedProductsData(WINDOW),
    ]);

    expect(audience.currency).toBe("TRY");
    expect(cohorts.currency).toBe("TRY");
    expect(demographics.currency).toBe("TRY");
    expect(products.currency).toBe("TRY");
  });

  it("serves null — never a default — when the property has none", async () => {
    mocks.currencyCode = null;

    const [audience, cohorts, demographics, products] = await Promise.all([
      getGa4DetailedAudienceData(WINDOW),
      getGa4DetailedCohortsData(WINDOW),
      getGa4DetailedDemographicsData({ ...WINDOW, dimension: "country" }),
      getGa4DetailedProductsData(WINDOW),
    ]);

    expect(audience.currency).toBeNull();
    expect(cohorts.currency).toBeNull();
    expect(demographics.currency).toBeNull();
    expect(products.currency).toBeNull();
    // The rows themselves are unaffected; only the label is withheld.
    expect(audience.channels.length).toBeGreaterThan(0);
    expect(products.products.length).toBeGreaterThan(0);
  });
});
