import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a Search Console site selection is allowed to persist, and what may
 * authorise persisting it.
 *
 * The stored site now comes from the live accessible-site listing rather than
 * from the request body, but the binding to the connection that produced that
 * listing was still wrong: the generation handed to the compare-and-set was read
 * by a query issued AFTER the listing, so a reconnect landing during the listing
 * produced the very token the compare-and-set then matched against. That query
 * also degraded its own failure to `null`, which disables the compare-and-set
 * entirely and lets a completely unbound write commit.
 *
 * Search Console makes this worse than it looks: the listing and every later sync
 * run on the GOOGLE credential while the selection is stored on the Search
 * Console connection, and a plain Google reconnect bumps neither the Search
 * Console status nor its account — so the write's own compare-and-set cannot see
 * a Google principal change at all.
 */

const requireBusinessAccess = vi.fn();
const isDemoBusiness = vi.fn();
const upsertIntegration = vi.fn();
const resolveSearchConsoleContext = vi.fn();
const providerFetch = vi.fn();

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
  return { ...actual, upsertIntegration };
});
vi.mock("@/lib/search-console", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveSearchConsoleContext };
});

const { ProviderConnectionGenerationConflictError } = await import(
  "@/lib/integrations"
);
const { POST } = await import("@/app/api/search-console/sites/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const LANE_ON = {
  ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
  ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED: "enabled",
};

/** The provider's own spelling of the one site this connection can see. */
const PROVIDER_SITE = "sc-domain:mine.example";

/**
 * The two live connections a Search Console selection depends on, so a test can
 * move either one underneath an in-flight request the way a reconnect does.
 */
const searchConsole = { generation: 3, status: "connected" };
const google = { generation: 11, status: "connected" };
const writes: Array<Record<string, unknown>> = [];

function post(body: unknown) {
  const url = `https://example.test/api/search-console/sites?businessId=${BUSINESS_ID}`;
  const base = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // The handler reads businessId from nextUrl, which only NextRequest exposes.
  return Object.assign(base, { nextUrl: new URL(url) }) as never;
}

function listingResponse(siteUrls: string[]) {
  return new Response(
    JSON.stringify({ siteEntry: siteUrls.map((siteUrl) => ({ siteUrl })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function lastWrite() {
  return writes[writes.length - 1];
}

describe("Search Console sites selection authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    Object.assign(process.env, LANE_ON);
    searchConsole.generation = 3;
    searchConsole.status = "connected";
    google.generation = 11;
    google.status = "connected";
    writes.length = 0;

    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    isDemoBusiness.mockResolvedValue(false);
    resolveSearchConsoleContext.mockImplementation(async () => ({
      businessId: BUSINESS_ID,
      accessToken: "token",
      siteUrl: null,
      integration: {
        id: "int-sc",
        provider: "search_console",
        status: searchConsole.status,
        connection_generation: searchConsole.generation,
        metadata: { unrelatedExistingKey: "kept" },
        connected_at: "2026-07-01T00:00:00.000Z",
      },
      googleIntegration: {
        id: "int-google",
        provider: "google",
        status: google.status,
        connection_generation: google.generation,
      },
    }));
    vi.stubGlobal("fetch", providerFetch);
    providerFetch.mockResolvedValue(listingResponse([PROVIDER_SITE]));
    upsertIntegration.mockImplementation(
      async (params: Record<string, unknown>) => {
        const observed = `${searchConsole.generation}:${searchConsole.status}`;
        if (
          params.expectedConnectionGeneration != null &&
          params.expectedConnectionGeneration !== observed
        ) {
          throw new ProviderConnectionGenerationConflictError({
            businessId: BUSINESS_ID,
            provider: "search_console",
            expected: params.expectedConnectionGeneration as string,
            observed,
          });
        }
        // The derived-authority compare-and-set the real implementation runs in
        // the same transaction, modelled so a Google reconnect is refused by the
        // WRITE and not only by the route's re-observation.
        const derived = params.expectedDerivedAuthority as
          | { provider: string; connectionGeneration: string }
          | null
          | undefined;
        if (derived) {
          const observedGoogle = `${google.generation}:${google.status}`;
          if (derived.connectionGeneration !== observedGoogle) {
            throw new ProviderConnectionGenerationConflictError({
              businessId: BUSINESS_ID,
              provider: "google",
              expected: derived.connectionGeneration,
              observed: observedGoogle,
            });
          }
        }
        writes.push(params);
        return {
          id: "int-sc",
          provider: "search_console",
          status: "connected",
          metadata: params.metadata,
        };
      },
    );
  });

  it("persists the provider's spelling of the site, never the caller's", async () => {
    const response = await POST(post({ siteUrl: "sc-domain:MINE.example" }));

    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    const write = lastWrite() as {
      providerAccountId: string;
      providerAccountName: string;
      metadata: Record<string, unknown>;
    };
    expect(write.providerAccountId).toBe(PROVIDER_SITE);
    expect(write.providerAccountName).toBe(PROVIDER_SITE);
    expect(write.metadata).toMatchObject({
      siteUrl: PROVIDER_SITE,
      propertyName: PROVIDER_SITE,
    });
    expect(JSON.stringify(write)).not.toContain("MINE.example");
  });

  it("persists exactly the provider-sourced fields on the happy path", async () => {
    const response = await POST(post({ siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(lastWrite()).toEqual({
      businessId: BUSINESS_ID,
      provider: "search_console",
      status: "connected",
      providerAccountId: PROVIDER_SITE,
      providerAccountName: PROVIDER_SITE,
      // The generation captured from the connection row read before the listing,
      // which is what makes the compare-and-set cover the round trip.
      expectedConnectionGeneration: "3:connected",
      // Search Console authority DERIVES from the Google connection, so the
      // write compare-and-sets both generations inside one transaction. A
      // separate pre-write read of Google is a check-then-act the reconnect can
      // land between.
      expectedDerivedAuthority: {
        provider: "google",
        connectionGeneration: "11:connected",
      },
      metadata: {
        unrelatedExistingKey: "kept",
        siteUrl: PROVIDER_SITE,
        siteType: "domain",
        propertyName: PROVIDER_SITE,
        connectedAt: "2026-07-01T00:00:00.000Z",
      },
    });
  });

  it("refuses when the assignment lane closes between the listing and the write", async () => {
    providerFetch.mockImplementation(async () => {
      delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;
      return listingResponse([PROVIDER_SITE]);
    });

    const response = await POST(post({ siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "lane_disabled" });
    expect(upsertIntegration).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("refuses a Search Console reconnect that lands between the listing and the write", async () => {
    providerFetch.mockImplementation(async () => {
      searchConsole.generation += 1;
      return listingResponse([PROVIDER_SITE]);
    });

    const response = await POST(post({ siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "connection_changed",
      retryable: true,
    });
    // The compare-and-set was offered the PRE-listing generation and refused, so
    // the attempt had no effect at all.
    expect(upsertIntegration).toHaveBeenCalledTimes(1);
    expect(upsertIntegration.mock.calls[0][0]).toMatchObject({
      expectedConnectionGeneration: "3:connected",
    });
    expect(writes).toHaveLength(0);
  });

  it("refuses a Google reconnect that lands between the listing and the write", async () => {
    // Nothing about the Search Console connection changes here, so its own
    // compare-and-set would have matched and stored a site chosen under the
    // previous Google principal.
    providerFetch.mockImplementation(async () => {
      google.generation += 1;
      return listingResponse([PROVIDER_SITE]);
    });

    const response = await POST(post({ siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "connection_changed",
      retryable: true,
    });
    expect(upsertIntegration).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("refuses when the Google generation cannot be established, rather than writing unbound", async () => {
    // The degradation the old optional parameter accepted silently: no Google
    // connection to bind to meant `expectedDerivedAuthority: null`, which is an
    // unbound write wearing the shape of a bound one. The selection writer now
    // requires the generation, so the route has to refuse before the listing.
    resolveSearchConsoleContext.mockImplementation(async () => ({
      businessId: BUSINESS_ID,
      accessToken: "token",
      siteUrl: null,
      integration: {
        id: "int-sc",
        provider: "search_console",
        status: searchConsole.status,
        connection_generation: searchConsole.generation,
        metadata: {},
        connected_at: "2026-07-01T00:00:00.000Z",
      },
      googleIntegration: null,
    }));

    const response = await POST(post({ siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(500);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(upsertIntegration).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("refuses a site the connected token cannot see", async () => {
    const response = await POST(
      post({ siteUrl: "sc-domain:someone-else.example" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "search_console_site_not_accessible",
    });
    expect(upsertIntegration).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("refuses when the accessible list cannot be read, rather than trusting the input", async () => {
    providerFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "quota" } }), {
        status: 429,
      }),
    );

    const response = await POST(post({ siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(503);
    expect(upsertIntegration).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("refuses with the assignment lane off, before any provider call", async () => {
    delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;

    const response = await POST(post({ siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "lane_disabled" });
    expect(resolveSearchConsoleContext).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(upsertIntegration).not.toHaveBeenCalled();
  });

  it("refuses a caller without business access before anything else", async () => {
    requireBusinessAccess.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "auth_error" }), {
        status: 403,
      }),
    });

    const response = await POST(post({ siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(403);
    expect(resolveSearchConsoleContext).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(upsertIntegration).not.toHaveBeenCalled();
  });
});
