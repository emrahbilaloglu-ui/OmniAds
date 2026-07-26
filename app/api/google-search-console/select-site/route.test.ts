import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SECOND Search Console selection writer.
 *
 * `app/api/search-console/sites` was hardened; this one was left as it was. It
 * ran the same accessibility check and then called `upsertIntegration` with no
 * expected generation at all, so a reconnect landing anywhere between the
 * listing and the write committed unconditionally — a selection validated
 * against one principal stored under another's credential, with every later sync
 * failing against a site the current token cannot see.
 *
 * It also never re-checked the assignment lane after the provider round trip, so
 * a cutover quiesce beginning during the listing did not stop it.
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
const { POST } = await import("@/app/api/google-search-console/select-site/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const LANE_ON = {
  ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
  ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED: "enabled",
};
const PROVIDER_SITE = "sc-domain:mine.example";

const searchConsole = { generation: 3, status: "connected" };
const google = { generation: 11, status: "connected" };
const writes: Array<Record<string, unknown>> = [];

function post(body: unknown) {
  return new Request("https://example.test/api/google-search-console/select-site", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function listingResponse(siteUrls: string[]) {
  return new Response(
    JSON.stringify({ siteEntry: siteUrls.map((siteUrl) => ({ siteUrl })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("google-search-console select-site selection authority", () => {
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
    upsertIntegration.mockImplementation(async (params: Record<string, unknown>) => {
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
    });
  });

  it("binds the write to BOTH generations captured before the listing", async () => {
    const response = await POST(post({ businessId: BUSINESS_ID, siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      providerAccountId: PROVIDER_SITE,
      expectedConnectionGeneration: "3:connected",
      expectedDerivedAuthority: { provider: "google", connectionGeneration: "11:connected" },
    });
  });

  it("refuses a Search Console reconnect that lands during the listing", async () => {
    providerFetch.mockImplementation(async () => {
      searchConsole.generation = 4;
      return listingResponse([PROVIDER_SITE]);
    });

    const response = await POST(post({ businessId: BUSINESS_ID, siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("connection_changed");
    expect(writes).toHaveLength(0);
  });

  it("refuses a GOOGLE reconnect that lands during the listing", async () => {
    // The Search Console generation is untouched by a plain Google reconnect, so
    // this is the case the Search Console compare-and-set alone cannot see.
    providerFetch.mockImplementation(async () => {
      google.generation = 12;
      return listingResponse([PROVIDER_SITE]);
    });

    const response = await POST(post({ businessId: BUSINESS_ID, siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("connection_changed");
    expect(writes).toHaveLength(0);
  });

  it("refuses when the assignment lane closes during the listing", async () => {
    providerFetch.mockImplementation(async () => {
      delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;
      return listingResponse([PROVIDER_SITE]);
    });

    const response = await POST(post({ businessId: BUSINESS_ID, siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("lane_disabled");
    expect(writes).toHaveLength(0);
  });

  it("refuses a site the connected token cannot see", async () => {
    const response = await POST(
      post({ businessId: BUSINESS_ID, siteUrl: "sc-domain:someone-else.example" }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("search_console_site_not_accessible");
    expect(writes).toHaveLength(0);
  });

  it("refuses when the Google generation cannot be established, rather than writing unbound", async () => {
    // No Google connection to bind to used to mean `expectedDerivedAuthority:
    // null`, which the optional parameter accepted as "no compare-and-set". The
    // selection writer requires the generation, so this is a refusal now.
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
      googleIntegration: undefined,
    }));

    const response = await POST(post({ businessId: BUSINESS_ID, siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(500);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("refuses when the connection cannot be read, rather than writing unbound", async () => {
    resolveSearchConsoleContext.mockRejectedValue(new Error("db down"));

    const response = await POST(post({ businessId: BUSINESS_ID, siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(500);
    expect(writes).toHaveLength(0);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("refuses with the assignment lane off, before any provider call", async () => {
    delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;

    const response = await POST(post({ businessId: BUSINESS_ID, siteUrl: PROVIDER_SITE }));

    expect(response.status).toBe(503);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});
