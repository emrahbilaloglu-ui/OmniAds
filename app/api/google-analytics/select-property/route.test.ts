import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a GA4 property selection is allowed to persist, and what may authorise
 * persisting it.
 *
 * Two defects lived on this path. The property name, account id and account name
 * were taken from the request body, so a caller could bind a property under any
 * label and any account relationship it liked and every surface downstream read
 * that back as provider truth. And the connection generation handed to the
 * compare-and-set was read by a query issued AFTER the property listing, so a
 * reconnect landing during the listing produced the very token the compare-and-set
 * then matched against — a selection validated under the previous Google
 * principal committed onto the new connection with no refusal at all.
 */

const requireBusinessAccess = vi.fn();
const isDemoBusiness = vi.fn();
const getIntegration = vi.fn();
const upsertIntegration = vi.fn();
const resolveGa4AnalyticsContext = vi.fn();
const fetchGA4Properties = vi.fn();
const fetchGA4PropertyMetadata = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const unusable = () => {
    throw new Error("The route must not reach the database in this test.");
  };
  return {
    ...actual,
    getDb: vi.fn(unusable),
    getDbWithTimeout: vi.fn(unusable),
    runDbTransaction: vi.fn(unusable),
  };
});
vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getIntegration, upsertIntegration };
});
vi.mock("@/lib/google-analytics-accounts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, fetchGA4Properties, fetchGA4PropertyMetadata };
});
vi.mock("@/lib/google-analytics-reporting", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveGa4AnalyticsContext };
});

const { ProviderConnectionGenerationConflictError } = await import(
  "@/lib/integrations"
);
const { POST } = await import("@/app/api/google-analytics/select-property/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const LANE_ON = {
  ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
  ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED: "enabled",
};

/** The provider's own spelling of the one property this connection can see. */
const PROVIDER_PROPERTY = {
  propertyId: "properties/900900900",
  propertyName: "Grandmix Storefront",
  accountId: "accounts/4242",
  accountName: "Grandmix Holding",
};

/**
 * The live connection, so a test can move it underneath an in-flight request the
 * way a reconnect does and the fake write can compare-and-set against it exactly
 * as `upsertIntegration` does inside its transaction.
 */
const connection = {
  generation: 7,
  status: "connected",
  writes: [] as Array<Record<string, unknown>>,
};

function post(body: unknown) {
  return new Request("https://example.test/api/google-analytics/select-property", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function selectionBody(overrides: Record<string, unknown> = {}) {
  return {
    businessId: BUSINESS_ID,
    propertyId: "900900900",
    propertyName: "Grandmix Storefront",
    ...overrides,
  };
}

function lastWrite() {
  return connection.writes[connection.writes.length - 1];
}

describe("GA4 select-property selection authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    Object.assign(process.env, LANE_ON);
    connection.generation = 7;
    connection.status = "connected";
    connection.writes = [];

    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    isDemoBusiness.mockResolvedValue(false);
    getIntegration.mockImplementation(async () => ({
      id: "int-ga4",
      business_id: BUSINESS_ID,
      provider: "ga4",
      status: connection.status,
      connection_generation: connection.generation,
      metadata: { unrelatedExistingKey: "kept" },
      access_token: "token",
      refresh_token: "refresh",
      token_expires_at: null,
    }));
    resolveGa4AnalyticsContext.mockResolvedValue({
      businessId: BUSINESS_ID,
      integrationId: "int-ga4",
      accessToken: "token",
      refreshToken: "refresh",
      propertyId: null,
      propertyName: null,
    });
    fetchGA4Properties.mockResolvedValue({
      ok: true,
      properties: [PROVIDER_PROPERTY],
    });
    fetchGA4PropertyMetadata.mockResolvedValue({
      propertyId: PROVIDER_PROPERTY.propertyId,
      timeZone: "Europe/Istanbul",
      currencyCode: "TRY",
    });
    upsertIntegration.mockImplementation(
      async (params: Record<string, unknown>) => {
        const observed = `${connection.generation}:${connection.status}`;
        if (
          params.expectedConnectionGeneration != null &&
          params.expectedConnectionGeneration !== observed
        ) {
          throw new ProviderConnectionGenerationConflictError({
            businessId: BUSINESS_ID,
            provider: "ga4",
            expected: params.expectedConnectionGeneration as string,
            observed,
          });
        }
        connection.writes.push(params);
        return {
          id: "int-ga4",
          provider: "ga4",
          status: "connected",
          metadata: params.metadata,
        };
      },
    );
  });

  it("persists the provider's property and account, never the caller's", async () => {
    const response = await POST(
      post(
        selectionBody({
          propertyName: "Totally Different Label",
          accountId: "accounts/attacker",
          accountName: "Attacker Holding",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(connection.writes).toHaveLength(1);
    const write = lastWrite() as {
      providerAccountId: string;
      providerAccountName: string;
      metadata: Record<string, unknown>;
    };
    expect(write.providerAccountId).toBe(PROVIDER_PROPERTY.propertyId);
    expect(write.providerAccountName).toBe(PROVIDER_PROPERTY.propertyName);
    expect(write.metadata).toMatchObject({
      ga4PropertyId: PROVIDER_PROPERTY.propertyId,
      ga4PropertyName: PROVIDER_PROPERTY.propertyName,
      ga4AccountId: PROVIDER_PROPERTY.accountId,
      ga4AccountName: PROVIDER_PROPERTY.accountName,
      ga4PropertyTimeZone: "Europe/Istanbul",
      ga4PropertyCurrency: "TRY",
      unrelatedExistingKey: "kept",
    });
    expect(JSON.stringify(write.metadata)).not.toContain("Attacker");
    expect(JSON.stringify(write.metadata)).not.toContain("Totally Different");
  });

  it("persists exactly the provider-sourced fields on the happy path", async () => {
    const response = await POST(post(selectionBody()));

    expect(response.status).toBe(200);
    expect(connection.writes).toHaveLength(1);
    expect(lastWrite()).toEqual({
      businessId: BUSINESS_ID,
      provider: "ga4",
      status: "connected",
      providerAccountId: PROVIDER_PROPERTY.propertyId,
      providerAccountName: PROVIDER_PROPERTY.propertyName,
      // The generation captured from the integration row read before the
      // listing, which is what makes the compare-and-set cover the round trip.
      expectedConnectionGeneration: "7:connected",
      metadata: {
        unrelatedExistingKey: "kept",
        ga4PropertyId: PROVIDER_PROPERTY.propertyId,
        ga4PropertyName: PROVIDER_PROPERTY.propertyName,
        ga4AccountId: PROVIDER_PROPERTY.accountId,
        ga4AccountName: PROVIDER_PROPERTY.accountName,
        ga4PropertyTimeZone: "Europe/Istanbul",
        ga4PropertyCurrency: "TRY",
      },
    });
  });

  it("persists the property's currency from the same Admin read as its time zone", async () => {
    // GA4 reports every revenue metric in the property's own currency, and the
    // Admin `properties/{id}` record carries the code beside the time zone. It
    // is stored here, at selection, because no read path may write.
    await POST(post(selectionBody()));

    const write = lastWrite() as { metadata: Record<string, unknown> };
    expect(write.metadata.ga4PropertyCurrency).toBe("TRY");
    expect(fetchGA4PropertyMetadata).toHaveBeenCalledWith(
      "token",
      PROVIDER_PROPERTY.propertyId,
    );
  });

  it("stores no currency when the Admin read gave none, and never a default", async () => {
    // A property whose record carries no `currencyCode`, or whose Admin call
    // failed, is stored as absent. Downstream that renders the missing value —
    // a guessed "USD" would put a wrong unit under a real number.
    fetchGA4PropertyMetadata.mockResolvedValue({
      propertyId: PROVIDER_PROPERTY.propertyId,
      timeZone: null,
      currencyCode: null,
    });

    await POST(post(selectionBody()));

    const write = lastWrite() as { metadata: Record<string, unknown> };
    expect(write.metadata.ga4PropertyCurrency).toBeNull();
    expect(JSON.stringify(write.metadata)).not.toContain("USD");
  });

  it("stores no currency when the Admin call itself fails", async () => {
    fetchGA4PropertyMetadata.mockRejectedValue(new Error("admin_unavailable"));

    const response = await POST(post(selectionBody()));

    expect(response.status).toBe(200);
    const write = lastWrite() as { metadata: Record<string, unknown> };
    expect(write.metadata.ga4PropertyCurrency).toBeNull();
    expect(write.metadata.ga4PropertyTimeZone).toBeNull();
  });

  it("refuses when the assignment lane closes between the listing and the write", async () => {
    fetchGA4Properties.mockImplementation(async () => {
      delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;
      return { ok: true, properties: [PROVIDER_PROPERTY] };
    });

    const response = await POST(post(selectionBody()));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "lane_disabled" });
    expect(upsertIntegration).not.toHaveBeenCalled();
    expect(connection.writes).toHaveLength(0);
  });

  it("refuses a reconnect that lands between the listing and the write", async () => {
    // The reconnect happens while the properties are being listed, which is
    // exactly when a generation read taken afterwards would return the NEW value
    // and let the stale selection through.
    fetchGA4Properties.mockImplementation(async () => {
      connection.generation += 1;
      return { ok: true, properties: [PROVIDER_PROPERTY] };
    });

    const response = await POST(post(selectionBody()));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "connection_changed",
      retryable: true,
    });
    expect(upsertIntegration).toHaveBeenCalledTimes(1);
    expect(upsertIntegration.mock.calls[0][0]).toMatchObject({
      expectedConnectionGeneration: "7:connected",
    });
    expect(connection.writes).toHaveLength(0);
  });

  it("refuses a disconnect that lands between the listing and the write", async () => {
    fetchGA4Properties.mockImplementation(async () => {
      connection.status = "disconnected";
      return { ok: true, properties: [PROVIDER_PROPERTY] };
    });

    const response = await POST(post(selectionBody()));

    expect(response.status).toBe(409);
    expect(connection.writes).toHaveLength(0);
  });

  it("refuses a property the connected Google account cannot see", async () => {
    const response = await POST(
      post(selectionBody({ propertyId: "properties/111000111" })),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "property_not_accessible",
    });
    expect(upsertIntegration).not.toHaveBeenCalled();
    expect(connection.writes).toHaveLength(0);
  });

  it("refuses when the property list cannot be read, rather than trusting the body", async () => {
    fetchGA4Properties.mockResolvedValue({
      ok: false,
      error: "quota",
      properties: [],
    });

    const response = await POST(post(selectionBody()));

    expect(response.status).toBe(502);
    expect(upsertIntegration).not.toHaveBeenCalled();
    expect(connection.writes).toHaveLength(0);
  });

  it("refuses with the assignment lane off, before any provider call", async () => {
    delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;

    const response = await POST(post(selectionBody()));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "lane_disabled" });
    expect(fetchGA4Properties).not.toHaveBeenCalled();
    expect(upsertIntegration).not.toHaveBeenCalled();
  });

  it("refuses a caller without business access before anything else", async () => {
    requireBusinessAccess.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "auth_error" }), {
        status: 403,
      }),
    });

    const response = await POST(post(selectionBody()));

    expect(response.status).toBe(403);
    expect(getIntegration).not.toHaveBeenCalled();
    expect(fetchGA4Properties).not.toHaveBeenCalled();
    expect(upsertIntegration).not.toHaveBeenCalled();
  });
});
