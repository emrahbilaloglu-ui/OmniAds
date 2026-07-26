import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Search Console property selection accepted any syntactically valid URL.
 *
 * Both writers took the URL from the body and wrote it straight onto the
 * canonical connection as the selected property. Nothing proved the connected
 * token could see that site, so a typo, a stale bookmark, or a deliberately
 * supplied third-party domain became the business's selected property — and
 * every later sync then ran against a site the token has no permission for,
 * failing in a way that reads as a provider outage rather than as a bad
 * selection.
 *
 * Neither writer was under the assignment-mutation lane either, so "one switch
 * stops every selection change" was not true of them.
 */

const requireBusinessAccess = vi.fn();
const isDemoBusiness = vi.fn();
const resolveSearchConsoleContext = vi.fn();
const upsertIntegration = vi.fn();
const providerFetch = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness }));
vi.mock("@/lib/search-console", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveSearchConsoleContext };
});
vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, upsertIntegration };
});

const selectSite = await import(
  "@/app/api/google-search-console/select-site/route"
);
const sites = await import("@/app/api/search-console/sites/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const LANE_ON = {
  ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
  ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED: "enabled",
};

function request(siteUrl: string) {
  // Both handlers read businessId from nextUrl, which only NextRequest exposes.
  const url = `https://example.test/api/x?businessId=${BUSINESS_ID}`;
  const base = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // select-site reads businessId from the body; sites reads it from the query.
    body: JSON.stringify({ siteUrl, businessId: BUSINESS_ID }),
  });
  return Object.assign(base, { nextUrl: new URL(url) }) as never;
}

function listingResponse(siteUrls: string[]) {
  return new Response(
    JSON.stringify({ siteEntry: siteUrls.map((siteUrl) => ({ siteUrl })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe.each([
  ["select-site", () => selectSite.POST] as const,
  ["sites", () => sites.POST] as const,
])("Search Console selection guard (%s)", (_label, getPost) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    Object.assign(process.env, LANE_ON);
    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    isDemoBusiness.mockResolvedValue(false);
    resolveSearchConsoleContext.mockResolvedValue({
      accessToken: "token",
      integration: { metadata: {}, connected_at: "2026-07-01T00:00:00.000Z" },
    });
    upsertIntegration.mockResolvedValue({
      id: "int-1",
      provider: "search_console",
      status: "connected",
      provider_account_id: "sc-domain:mine.example",
      provider_account_name: "sc-domain:mine.example",
      connected_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
      metadata: {},
    });
    vi.stubGlobal("fetch", providerFetch);
    providerFetch.mockResolvedValue(listingResponse(["sc-domain:mine.example"]));
  });

  it("refuses a site the connected token cannot see", async () => {
    const response = await getPost()(request("sc-domain:someone-else.example"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("search_console_site_not_accessible");
    expect(upsertIntegration).not.toHaveBeenCalled();
  });

  it("refuses when the accessible list cannot be read, rather than trusting the input", async () => {
    providerFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 }),
    );
    const response = await getPost()(request("sc-domain:mine.example"));
    expect(response.status).toBe(503);
    expect(upsertIntegration).not.toHaveBeenCalled();
  });

  it("accepts a site the token can see and stores the provider's spelling", async () => {
    const response = await getPost()(request("sc-domain:MINE.example"));
    expect(response.status).toBe(200);
    expect(upsertIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "sc-domain:mine.example" }),
    );
  });

  it("keeps sc-domain: and https:// as different properties", async () => {
    // Search Console reports them as distinct properties with distinct
    // permissions, so normalising them together would select the wrong one.
    providerFetch.mockResolvedValue(listingResponse(["sc-domain:mine.example"]));
    const response = await getPost()(request("https://mine.example/"));
    expect(response.status).toBe(400);
    expect(upsertIntegration).not.toHaveBeenCalled();
  });

  it("refuses with the assignment lane off, before any provider call", async () => {
    delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;
    const response = await getPost()(request("sc-domain:mine.example"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("lane_disabled");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(upsertIntegration).not.toHaveBeenCalled();
  });

  it("refuses a caller without business access before anything else", async () => {
    requireBusinessAccess.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "auth_error" }), { status: 403 }),
    });
    const response = await getPost()(request("sc-domain:mine.example"));
    expect(response.status).toBe(403);
    expect(resolveSearchConsoleContext).not.toHaveBeenCalled();
    expect(upsertIntegration).not.toHaveBeenCalled();
  });
});
