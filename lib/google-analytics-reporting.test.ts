import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where the GA4 property's currency enters the read path.
 *
 * The code is written at property selection, into the same integration metadata
 * that already holds the property id, name and time zone. A property selected
 * before that write existed has none — which is every workspace that had already
 * chosen one — so the resolver fills it from the same Admin read, ONCE, and
 * persists it. `null` survives to the surface only when the Admin API itself
 * cannot establish a code, and every money surface renders that as the missing
 * value rather than as dollars.
 */
const getIntegration = vi.fn();
const fetchGA4PropertyMetadata = vi.fn();
const runDbTransaction = vi.fn(async (fn: () => Promise<unknown>) => fn());
const dbQuery = vi.fn();

vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getIntegration };
});

vi.mock("@/lib/google-analytics-accounts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, fetchGA4PropertyMetadata };
});

vi.mock("@/lib/db", () => ({
  getDb: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    dbQuery(strings.join("?"), values),
  runDbTransaction,
}));

const { getGA4TokenAndProperty, resolveGa4AnalyticsContext } = await import(
  "@/lib/google-analytics-reporting"
);
const { resetGa4PropertyCurrencyResolutionState } = await import(
  "@/lib/google-analytics-property-currency"
);

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function connectedWith(metadata: Record<string, unknown>) {
  getIntegration.mockResolvedValue({
    id: "int-ga4",
    status: "connected",
    connection_generation: 3,
    metadata,
    access_token: "token",
    refresh_token: "refresh",
    token_expires_at: null,
  });
}

/**
 * A database in which the GA4 connection is exactly the row `connectedWith`
 * described, so the persist's compare-and-set has something true to compare to.
 */
function databaseHolding(metadata: Record<string, unknown>) {
  dbQuery.mockImplementation((sql: string) => {
    if (sql.includes("SELECT")) {
      return Promise.resolve([
        {
          id: "conn-ga4",
          status: "connected",
          connection_generation: "3",
          metadata,
        },
      ]);
    }
    return Promise.resolve([]);
  });
}

function persistedWrites() {
  return dbQuery.mock.calls.filter(([sql]) =>
    String(sql).includes("UPDATE integration_credentials"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetGa4PropertyCurrencyResolutionState();
  runDbTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  dbQuery.mockResolvedValue([]);
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

  it("does not touch the Admin API when the code is already stored", async () => {
    connectedWith({
      ga4PropertyId: "properties/12345",
      ga4PropertyCurrency: "TRY",
    });

    await resolveGa4AnalyticsContext(BUSINESS_ID);

    expect(fetchGA4PropertyMetadata).not.toHaveBeenCalled();
    expect(persistedWrites()).toHaveLength(0);
  });

  it("refuses a stored value that is not a three-letter code", async () => {
    // Unusable is not the same as absent for the READER — it must not be served
    // — but it is the same for the backfill, which refills it.
    connectedWith({
      ga4PropertyId: "properties/12345",
      ga4PropertyCurrency: "dollars",
    });
    databaseHolding({ ga4PropertyId: "properties/12345", ga4PropertyCurrency: "dollars" });
    fetchGA4PropertyMetadata.mockRejectedValue(new Error("admin unavailable"));

    expect((await resolveGa4AnalyticsContext(BUSINESS_ID)).propertyCurrency).toBeNull();
  });

  it("normalises a lowercase stored code rather than dropping it", async () => {
    connectedWith({
      ga4PropertyId: "properties/12345",
      ga4PropertyCurrency: "eur",
    });

    expect((await resolveGa4AnalyticsContext(BUSINESS_ID)).propertyCurrency).toBe("EUR");
    expect(fetchGA4PropertyMetadata).not.toHaveBeenCalled();
  });
});

describe("GA4 property currency backfill", () => {
  it("fetches the missing code once, persists it, and serves it", async () => {
    // The pre-migration row: real property, no currency. This is BskTR,
    // Halıcızade and Tiles Workshop in production.
    connectedWith({
      ga4PropertyId: "properties/12345",
      ga4PropertyName: "Grandmix",
      ga4PropertyTimeZone: "Europe/Istanbul",
    });
    databaseHolding({
      ga4PropertyId: "properties/12345",
      ga4PropertyTimeZone: "Europe/Istanbul",
    });
    fetchGA4PropertyMetadata.mockResolvedValue({
      propertyId: "properties/12345",
      timeZone: "Europe/Istanbul",
      currencyCode: "TRY",
    });

    const context = await resolveGa4AnalyticsContext(BUSINESS_ID);

    expect(context.propertyCurrency).toBe("TRY");
    expect(fetchGA4PropertyMetadata).toHaveBeenCalledTimes(1);
    expect(fetchGA4PropertyMetadata).toHaveBeenCalledWith("token", "properties/12345");

    const writes = persistedWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]![1]).toContain(JSON.stringify({ ga4PropertyCurrency: "TRY" }));
  });

  it("makes one Admin call for concurrent reads of the same property", async () => {
    // A single Analytics page render fans out to five endpoints. Without the
    // in-flight join that is five Admin calls for one fact.
    connectedWith({ ga4PropertyId: "properties/12345" });
    databaseHolding({ ga4PropertyId: "properties/12345" });
    fetchGA4PropertyMetadata.mockResolvedValue({
      propertyId: "properties/12345",
      timeZone: null,
      currencyCode: "TRY",
    });

    const contexts = await Promise.all([
      resolveGa4AnalyticsContext(BUSINESS_ID),
      resolveGa4AnalyticsContext(BUSINESS_ID),
      resolveGa4AnalyticsContext(BUSINESS_ID),
    ]);

    expect(contexts.map((context) => context.propertyCurrency)).toEqual([
      "TRY",
      "TRY",
      "TRY",
    ]);
    expect(fetchGA4PropertyMetadata).toHaveBeenCalledTimes(1);
    expect(persistedWrites()).toHaveLength(1);
  });

  it("renders the missing value and does not throw when the Admin call fails", async () => {
    connectedWith({ ga4PropertyId: "properties/12345" });
    databaseHolding({ ga4PropertyId: "properties/12345" });
    fetchGA4PropertyMetadata.mockRejectedValue(new Error("403 PERMISSION_DENIED"));

    const context = await resolveGa4AnalyticsContext(BUSINESS_ID);

    expect(context.propertyCurrency).toBeNull();
    expect(context.propertyId).toBe("12345");
    expect(persistedWrites()).toHaveLength(0);
    await expect(getGA4TokenAndProperty(BUSINESS_ID)).resolves.toMatchObject({
      currencyCode: null,
    });
  });

  it("stops retrying a property whose Admin read failed", async () => {
    connectedWith({ ga4PropertyId: "properties/12345" });
    databaseHolding({ ga4PropertyId: "properties/12345" });
    fetchGA4PropertyMetadata.mockRejectedValue(new Error("403 PERMISSION_DENIED"));

    await resolveGa4AnalyticsContext(BUSINESS_ID);
    await resolveGa4AnalyticsContext(BUSINESS_ID);
    await resolveGa4AnalyticsContext(BUSINESS_ID);

    expect(fetchGA4PropertyMetadata).toHaveBeenCalledTimes(1);
  });

  it("answers the read even when the persist itself fails", async () => {
    connectedWith({ ga4PropertyId: "properties/12345" });
    fetchGA4PropertyMetadata.mockResolvedValue({
      propertyId: "properties/12345",
      timeZone: null,
      currencyCode: "TRY",
    });
    runDbTransaction.mockRejectedValue(new Error("database is read-only"));

    await expect(resolveGa4AnalyticsContext(BUSINESS_ID)).resolves.toMatchObject({
      propertyCurrency: "TRY",
    });
  });

  it("refuses the write when the connection moved during the Admin call", async () => {
    connectedWith({ ga4PropertyId: "properties/12345" });
    // A reconnect committed while Google was being asked: the locked row now
    // reads generation 4, not the 3 this request captured.
    dbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        return Promise.resolve([
          {
            id: "conn-ga4",
            status: "connected",
            connection_generation: "4",
            metadata: { ga4PropertyId: "properties/12345" },
          },
        ]);
      }
      return Promise.resolve([]);
    });
    fetchGA4PropertyMetadata.mockResolvedValue({
      propertyId: "properties/12345",
      timeZone: null,
      currencyCode: "TRY",
    });

    const context = await resolveGa4AnalyticsContext(BUSINESS_ID);

    expect(context.propertyCurrency).toBe("TRY");
    expect(persistedWrites()).toHaveLength(0);
  });

  it("refuses the write when the selected property moved during the Admin call", async () => {
    connectedWith({ ga4PropertyId: "properties/12345" });
    databaseHolding({ ga4PropertyId: "properties/99999" });
    fetchGA4PropertyMetadata.mockResolvedValue({
      propertyId: "properties/12345",
      timeZone: null,
      currencyCode: "TRY",
    });

    await resolveGa4AnalyticsContext(BUSINESS_ID);

    expect(persistedWrites()).toHaveLength(0);
  });

  it("does not backfill while a property is still being chosen", async () => {
    // `requireProperty: false` is the selection route resolving a credential in
    // order to pick a property; it does its own Admin read straight afterwards.
    connectedWith({ ga4PropertyId: "properties/12345" });

    await resolveGa4AnalyticsContext(BUSINESS_ID, { requireProperty: false });

    expect(fetchGA4PropertyMetadata).not.toHaveBeenCalled();
  });
});
