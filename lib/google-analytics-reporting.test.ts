import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where the GA4 property's currency enters the read path.
 *
 * The code is written once, at property selection, into the same integration
 * metadata that already holds the property id, name and time zone. Nothing on a
 * read path may write, so this resolver only reads it back — and a property
 * selected before the code existed resolves to `null`, which every money
 * surface renders as the missing value rather than as dollars.
 */
const getIntegration = vi.fn();

vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getIntegration };
});

const { getGA4TokenAndProperty, resolveGa4AnalyticsContext } = await import(
  "@/lib/google-analytics-reporting"
);

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function connectedWith(metadata: Record<string, unknown>) {
  getIntegration.mockResolvedValue({
    id: "int-ga4",
    status: "connected",
    metadata,
    access_token: "token",
    refresh_token: "refresh",
    token_expires_at: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GA4 property currency resolution", () => {
  it("serves the stored ISO 4217 code through both readers", async () => {
    connectedWith({
      ga4PropertyId: "properties/12345",
      ga4PropertyName: "Grandmix",
      ga4PropertyCurrency: "TRY",
    });

    await expect(resolveGa4AnalyticsContext(BUSINESS_ID)).resolves.toMatchObject({
      propertyId: "12345",
      propertyCurrency: "TRY",
    });
    await expect(getGA4TokenAndProperty(BUSINESS_ID)).resolves.toMatchObject({
      propertyId: "12345",
      currencyCode: "TRY",
    });
  });

  it("resolves null for a property selected before the code was persisted", async () => {
    // The pre-migration row: real property, no currency. It must stay null all
    // the way to the surface — a substituted "USD" would put a wrong unit under
    // a real revenue number.
    connectedWith({
      ga4PropertyId: "properties/12345",
      ga4PropertyName: "Grandmix",
      ga4PropertyTimeZone: "Europe/Istanbul",
    });

    const context = await resolveGa4AnalyticsContext(BUSINESS_ID);
    expect(context.propertyCurrency).toBeNull();
    expect((await getGA4TokenAndProperty(BUSINESS_ID)).currencyCode).toBeNull();
  });

  it("refuses a stored value that is not a three-letter code", async () => {
    connectedWith({
      ga4PropertyId: "properties/12345",
      ga4PropertyCurrency: "dollars",
    });

    expect((await resolveGa4AnalyticsContext(BUSINESS_ID)).propertyCurrency).toBeNull();
  });

  it("normalises a lowercase stored code rather than dropping it", async () => {
    connectedWith({
      ga4PropertyId: "properties/12345",
      ga4PropertyCurrency: "eur",
    });

    expect((await resolveGa4AnalyticsContext(BUSINESS_ID)).propertyCurrency).toBe("EUR");
  });
});
