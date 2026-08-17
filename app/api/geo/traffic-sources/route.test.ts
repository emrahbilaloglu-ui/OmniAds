import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sixth endpoint that serves GA4 money.
 *
 * The AI Sources tab's Revenue column reads `purchaseRevenue` from this route
 * and used to render it with a hardcoded `$`. GA4 reports that metric in the
 * property's own currency, so the code has to travel with the number; this file
 * holds it there, including the case where the property has no stored code and
 * the column must say nothing rather than claim dollars.
 */
const requireBusinessAccess = vi.fn();
const isDemoBusiness = vi.fn();
const getGA4TokenAndProperty = vi.fn();
const runGA4Report = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness }));
vi.mock("@/lib/request-language", () => ({
  resolveRequestLanguage: async () => "en",
}));
vi.mock("@/lib/google-analytics-reporting", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getGA4TokenAndProperty, runGA4Report };
});

const { GET } = await import("@/app/api/geo/traffic-sources/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function get() {
  return new NextRequest(
    `http://localhost/api/geo/traffic-sources?businessId=${BUSINESS_ID}` +
      "&startDate=2026-07-18&endDate=2026-08-14",
  );
}

interface ReportParams {
  metrics?: Array<{ name: string }>;
  dimensions?: Array<{ name: string }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireBusinessAccess.mockResolvedValue({ businessId: BUSINESS_ID });
  isDemoBusiness.mockResolvedValue(false);
  runGA4Report.mockImplementation(async (params: ReportParams) => {
    const metricHeaders = (params.metrics ?? []).map((metric) => metric.name);
    const dimensionHeaders = (params.dimensions ?? []).map((dimension) => dimension.name);
    return {
      dimensionHeaders,
      metricHeaders,
      rows: dimensionHeaders.length
        ? [
            {
              dimensions: ["chatgpt.com"],
              metrics: metricHeaders.map((name) =>
                name === "purchaseRevenue" ? "1900" : "10",
              ),
            },
          ]
        : [],
      rowCount: dimensionHeaders.length ? 1 : 0,
      totals: [{ dimensions: [], metrics: metricHeaders.map(() => "100") }],
    };
  });
});

describe("GET /api/geo/traffic-sources", () => {
  it("serves the property's currency beside the revenue column it labels", async () => {
    getGA4TokenAndProperty.mockResolvedValue({
      accessToken: "token",
      propertyId: "properties/12345",
      propertyName: "Grandmix",
      currencyCode: "TRY",
    });

    const payload = (await (await GET(get())).json()) as {
      currency: string | null;
      sources: Array<{ revenue: number }>;
    };

    expect(payload.currency).toBe("TRY");
    expect(payload.sources[0]?.revenue).toBe(1900);
  });

  it("serves null — never a default — when the property has no stored code", async () => {
    getGA4TokenAndProperty.mockResolvedValue({
      accessToken: "token",
      propertyId: "properties/12345",
      propertyName: "Grandmix",
      currencyCode: null,
    });

    const payload = (await (await GET(get())).json()) as {
      currency: string | null;
      sources: Array<{ revenue: number }>;
    };

    expect(payload.currency).toBeNull();
    // The rows are unchanged; only the unit is withheld.
    expect(payload.sources[0]?.revenue).toBe(1900);
  });

  it("keeps the access check the sibling GA4 reads use", async () => {
    getGA4TokenAndProperty.mockResolvedValue({
      accessToken: "token",
      propertyId: "properties/12345",
      propertyName: "Grandmix",
      currencyCode: "USD",
    });

    await GET(get());

    expect(requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, minRole: "collaborator" }),
    );
  });
});
