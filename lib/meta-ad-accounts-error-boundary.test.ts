import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One rule, checked at every place it can be broken: a message or a body Meta
 * wrote never reaches a caller, a browser, an OAuth redirect, a log or a
 * diagnostic payload.
 *
 * The reason it matters is not hypothetical. Graph quotes the failing request
 * back inside `error.message`, and for the calls in this repository that
 * request carries the access token. Every fixture below therefore embeds a
 * token-shaped secret in the provider's message, and every assertion is the
 * same one: the secret is nowhere in what crossed the boundary.
 *
 * The real `lib/meta-ad-accounts.ts` runs in all of these. Only `fetch` and the
 * database-backed collaborators are stubbed, because the defect lived in how
 * the module and the routes handled a real Graph response.
 */
const LEAKED_TOKEN =
  "EAAG9ZC1LeAkEDBOThisTokenMustNeverAppearAnywhere0123456789";

const PROVIDER_SENTENCE = `Error validating access token: the session was invalidated for the request GET /me/adaccounts?access_token=${LEAKED_TOKEN}`;

function graphErrorEchoingTheToken() {
  return {
    error: {
      message: PROVIDER_SENTENCE,
      type: "OAuthException",
      code: 190,
      error_subcode: 463,
      is_transient: false,
      fbtrace_id: "LeAkEdTr4ce0001",
    },
  };
}

/** A non-JSON provider body: the `rawBody` path the debug route returned. */
const NON_JSON_PROVIDER_BODY = `<html><body>upstream rejected token ${LEAKED_TOKEN}</body></html>`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(body: string, status = 400) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

/** Everything the handlers wrote to a log while a test ran. */
const consoleCalls: unknown[][] = [];

function loggedText() {
  return consoleCalls
    .map((call) => call.map((part) => safeStringify(part)).join(" "))
    .join("\n");
}

function safeStringify(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The single assertion this file exists for. */
function expectNoProviderLeak(subject: string) {
  expect(subject).not.toContain(LEAKED_TOKEN);
  expect(subject).not.toContain("Error validating access token");
  expect(subject).not.toContain("upstream rejected token");
}

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(async () => false),
}));

vi.mock("@/lib/demo-business", () => ({
  getDemoProviderDiscoveryPayload: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
  upsertIntegration: vi.fn(),
  /*
    ROUND 23, ITEM 1: the route now binds its refresh to the generation of the
    record the token came from. The real derivation, so this double cannot
    disagree with the module it stands in for.
  */
  providerConnectionGenerationTokenFromIntegration: (
    integration: { connection_generation?: unknown; status?: unknown } | null,
  ) => {
    if (!integration) return null;
    const generation = integration.connection_generation;
    if (generation == null || String(generation).trim().length === 0) return null;
    return `${String(generation)}:${String(integration.status)}`;
  },
}));

vi.mock("@/lib/provider-account-discovery", () => ({
  resolveProviderDiscoveryPayload: vi.fn(),
}));

vi.mock("@/lib/provider-account-discovery-refresh", () => ({
  refreshProviderDiscoveryPayload: vi.fn(),
}));

vi.mock("@/lib/provider-account-snapshots", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/provider-account-snapshots")>();
  return {
    ...actual,
    readProviderAccountSnapshot: vi.fn(async () => null),
  };
});

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES: ["provider_account_assignments"],
  getProviderAccountAssignments: vi.fn(async () => ({
    account_ids: ["act_1054905059780305"],
  })),
}));

vi.mock("@/lib/sync/meta-sync", () => ({
  syncMetaInitial: vi.fn(async () => undefined),
}));

vi.mock("@/lib/oauth/post-connect-schedule", () => ({
  scheduleAfterProviderConnect: vi.fn(async () => ({
    scheduled: true,
    reason: "scheduled",
    retainedAccountIds: [],
    droppedAccountIds: [],
    scheduledPartitionCount: 1,
    preexistingAccountIds: [],
    detail: null,
    recoverable: true,
  })),
}));

const access = await import("@/lib/access");
const integrations = await import("@/lib/integrations");
const discovery = await import("@/lib/provider-account-discovery");
const refresh = await import("@/lib/provider-account-discovery-refresh");
const snapshots = await import("@/lib/provider-account-snapshots");

const { fetchMetaAdAccounts, getMetaApiErrorMessage } = await import(
  "@/lib/meta-ad-accounts"
);
const adAccountsRoute = await import(
  "@/app/integrations/meta/ad-accounts/route"
);
const debugRoute = await import(
  "@/app/integrations/meta/ad-accounts/debug/route"
);
const oauthCallbackRoute = await import("@/app/api/oauth/meta/callback/route");
const topCreativesRoute = await import("@/app/api/meta/top-creatives/route");

beforeEach(() => {
  consoleCalls.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: {} as never,
    membership: {} as never,
  });
  vi.mocked(integrations.getIntegration).mockResolvedValue({
    id: "integration_1",
    status: "connected",
    scopes: "ads_read",
    access_token: "stored-meta-token",
    token_expires_at: null,
  } as never);
  vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue(
    null as never,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("lib/meta-ad-accounts: the provider's message never leaves the module", () => {
  it("replaces a token-echoing Graph message with the named identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(graphErrorEchoingTheToken(), 400)),
    );

    const result = await fetchMetaAdAccounts("stored-meta-token");

    expectNoProviderLeak(JSON.stringify(result));
    expectNoProviderLeak(getMetaApiErrorMessage(result));
    expectNoProviderLeak(loggedText());

    // ...and the guard against over-correcting into silence: the four named
    // identifiers Meta support asks for are still carried, and still say
    // exactly which failure this was.
    expect(result.body?.error?.authored_by).toBe("adsecute");
    expect(result.body?.error).toMatchObject({
      code: 190,
      error_subcode: 463,
      is_transient: false,
      fbtrace_id: "LeAkEdTr4ce0001",
    });
    expect(getMetaApiErrorMessage(result)).toBe(
      "Meta API request failed (status 400, code 190, subcode 463, is_transient false, fbtrace_id LeAkEdTr4ce0001)",
    );
    expect(result.graphError).toEqual({
      errorCode: 190,
      errorSubcode: 463,
      isTransient: false,
      fbtraceId: "LeAkEdTr4ce0001",
    });
  });

  it("carries no raw provider body out at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(NON_JSON_PROVIDER_BODY, 400)),
    );

    const result = await fetchMetaAdAccounts("stored-meta-token");

    // The field is gone, not redacted: nothing downstream can reach for it.
    expect("rawBody" in result).toBe(false);
    expectNoProviderLeak(JSON.stringify(result));
    expectNoProviderLeak(getMetaApiErrorMessage(result));
    expectNoProviderLeak(loggedText());
    expect(getMetaApiErrorMessage(result)).toContain("status 400");
  });

  it("keeps the provider's message out of business-discovery failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v25.0/me/adaccounts") {
          return jsonResponse({
            data: [{ id: "act_direct", name: "Direct Account" }],
          });
        }
        if (url.pathname === "/v25.0/me/businesses") {
          return jsonResponse(graphErrorEchoingTheToken(), 403);
        }
        return jsonResponse({ data: [] });
      }),
    );

    const result = await fetchMetaAdAccounts("stored-meta-token");

    expect(result.ok).toBe(false);
    expectNoProviderLeak(JSON.stringify(result));
    expectNoProviderLeak(getMetaApiErrorMessage(result));
    expectNoProviderLeak(loggedText());

    // The aggregate the ad-accounts route serves is built out of these, so the
    // per-edge sentence has to be authored here rather than quoted.
    expect(result.businessDiscovery?.errors[0]?.message).toBe(
      "Meta me/businesses discovery failed (status 403, code 190, subcode 463, is_transient false, fbtrace_id LeAkEdTr4ce0001)",
    );
    expect(result.body?.error?.message).toContain(
      "Meta business account discovery failed:",
    );
  });
});

describe("app/integrations/meta/ad-accounts/debug/route.ts", () => {
  function debugRequest() {
    return new NextRequest(
      "http://localhost/integrations/meta/ad-accounts/debug?businessId=biz_1",
    );
  }

  it("returns the named identity instead of the Graph body", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(graphErrorEchoingTheToken(), 400)),
    );

    const response = await debugRoute.GET(debugRequest());
    const payload = await response.json();

    expectNoProviderLeak(JSON.stringify(payload));
    expectNoProviderLeak(loggedText());
    expect(payload.meta.raw).toBeUndefined();
    expect(payload.meta.error.authored_by).toBe("adsecute");
    expect(payload.meta.error.code).toBe(190);
    expect(payload.meta.graph_error).toEqual({
      errorCode: 190,
      errorSubcode: 463,
      isTransient: false,
      fbtraceId: "LeAkEdTr4ce0001",
    });
  });

  it("never returns the raw provider body, JSON or not", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(NON_JSON_PROVIDER_BODY, 400)),
    );

    const response = await debugRoute.GET(debugRequest());
    const payload = await response.json();

    expectNoProviderLeak(JSON.stringify(payload));
    expectNoProviderLeak(loggedText());
    expect(payload.meta).not.toHaveProperty("raw");
    expect(payload.meta.status).toBe(400);
  });
});

describe("app/integrations/meta/ad-accounts/route.ts", () => {
  function getRequest() {
    return new NextRequest(
      "http://localhost/integrations/meta/ad-accounts?businessId=biz_1",
    );
  }

  function postRequest() {
    return new NextRequest(
      "http://localhost/integrations/meta/ad-accounts?businessId=biz_1",
      { method: "POST" },
    );
  }

  it("does not put the provider's message in the meta_api_error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(graphErrorEchoingTheToken(), 400)),
    );
    // The route's own liveLoader, run for real. Whatever it throws is the
    // string every downstream channel carries.
    vi.mocked(discovery.resolveProviderDiscoveryPayload).mockImplementation(
      async (input) => {
        await input.liveLoader();
        throw new Error("liveLoader was expected to fail");
      },
    );

    const response = await adAccountsRoute.GET(getRequest());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toBe("meta_api_error");
    expectNoProviderLeak(JSON.stringify(payload));
    expectNoProviderLeak(loggedText());
    // Guard against over-correcting into a message that says nothing: the
    // operator still gets the identifiers they can quote to Meta.
    expect(payload.message).toContain("status 400");
    expect(payload.message).toContain("code 190");
    expect(payload.message).toContain("fbtrace_id LeAkEdTr4ce0001");
  });

  it("does not put the provider's message in the snapshot lastError the browser reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(graphErrorEchoingTheToken(), 400)),
    );
    let persistedLastError: string | null = null;
    vi.mocked(refresh.refreshProviderDiscoveryPayload).mockImplementation(
      async (input) => {
        // Exactly what lib/provider-account-snapshots.ts does when the
        // liveLoader throws: the message is written to the snapshot run's
        // `last_error` column and re-served as `meta.lastError`.
        try {
          await input.liveLoader();
        } catch (error) {
          persistedLastError =
            error instanceof Error ? error.message : String(error);
          throw new snapshots.ProviderAccountSnapshotRefreshError({
            provider: "meta",
            businessId: "biz_1",
            message: persistedLastError,
            dueToRecentFailure: false,
          });
        }
        throw new Error("liveLoader was expected to fail");
      },
    );
    vi.mocked(discovery.resolveProviderDiscoveryPayload).mockResolvedValue({
      data: [],
      meta: {
        source: "snapshot",
        lastError: persistedLastError,
        lastKnownGoodAvailable: false,
      },
      notice: null,
    } as never);

    const response = await adAccountsRoute.POST(postRequest());
    const payload = await response.json();

    expect(persistedLastError).not.toBeNull();
    expectNoProviderLeak(String(persistedLastError));
    expectNoProviderLeak(JSON.stringify(payload));
    expectNoProviderLeak(loggedText());
    expect(String(persistedLastError)).toContain("status 400");
  });

  it("quotes only errors it authored, not whatever it caught", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [] })));
    vi.mocked(discovery.resolveProviderDiscoveryPayload).mockRejectedValue(
      new Error(
        "connection to server at \"10.0.0.4\", port 5432 failed: password authentication failed",
      ),
    );

    const response = await adAccountsRoute.GET(getRequest());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toBe("meta_api_error");
    expect(payload.message).not.toContain("password authentication failed");
    expect(payload.message).not.toContain("10.0.0.4");
    expect(payload.message).toBe(
      "We couldn't load your Meta accounts right now. A background sync has been scheduled.",
    );
  });
});

describe("app/api/meta/top-creatives/route.ts", () => {
  it("logs the named identity rather than the raw Graph body", async () => {
    // Both Graph calls in this route put the access token in the request URL,
    // and Graph quotes the failing request back inside `error.message`. The
    // handler used to log `raw.slice(0, 300)` of the response body, so the
    // credential landed in the server log.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(graphErrorEchoingTheToken(), 400)),
    );

    const response = await topCreativesRoute.GET(
      new NextRequest(
        "http://localhost/api/meta/top-creatives?businessId=biz_1",
      ),
    );
    const payload = await response.json();

    expectNoProviderLeak(loggedText());
    expectNoProviderLeak(JSON.stringify(payload));
    // ...and the rejection is still described, not swallowed.
    expect(loggedText()).toContain("code 190");
    expect(loggedText()).toContain("fbtrace_id LeAkEdTr4ce0001");
  });
});

describe("app/api/oauth/meta/callback/route.ts", () => {
  const STATE = Buffer.from(
    JSON.stringify({ businessId: "biz_1", returnTo: "/c/biz_1/manage" }),
  ).toString("base64url");

  function callbackRequest(query: string) {
    return new NextRequest(
      `http://localhost/api/oauth/meta/callback?${query}`,
      { headers: { cookie: `meta_oauth_state=${STATE}` } },
    );
  }

  function redirectLocation(response: Response) {
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    // The browser reads the decoded value: legacy-page.tsx renders `?error=`
    // verbatim, so decode before asserting.
    return decodeURIComponent(location as string);
  }

  beforeEach(() => {
    vi.stubEnv("META_APP_ID", "app-id");
    vi.stubEnv("META_APP_SECRET", "app-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    vi.mocked(integrations.upsertIntegration).mockResolvedValue({
      id: "integration_1",
      connection_generation: 1,
      status: "connected",
    } as never);
  });

  it("keeps a token-echoing token-exchange failure out of the redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(graphErrorEchoingTheToken(), 400)),
    );

    const response = await oauthCallbackRoute.GET(
      callbackRequest(`code=auth-code&state=${STATE}`),
    );
    const location = redirectLocation(response);

    expectNoProviderLeak(location);
    expectNoProviderLeak(loggedText());
    expect(location).toContain("status=error");
    expect(location).toContain(
      "Failed to exchange the Meta authorization code (status 400, code 190",
    );
  });

  it("keeps a token-echoing identity failure out of the redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/oauth/access_token")) {
          return jsonResponse({
            access_token: "short-lived-token",
            expires_in: 3600,
          });
        }
        if (url.pathname.endsWith("/me")) {
          return jsonResponse(graphErrorEchoingTheToken(), 400);
        }
        return jsonResponse({ data: [] });
      }),
    );

    const response = await oauthCallbackRoute.GET(
      callbackRequest(`code=auth-code&state=${STATE}`),
    );
    const location = redirectLocation(response);

    expectNoProviderLeak(location);
    expectNoProviderLeak(loggedText());
    expect(location).toContain(
      "Failed to fetch the Meta user profile (status 400, code 190",
    );
  });

  it("does not echo the provider's error_description back to the browser", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [] })));

    const response = await oauthCallbackRoute.GET(
      callbackRequest(
        `error=access_denied&error_description=${encodeURIComponent(
          `Owner revoked ${LEAKED_TOKEN}`,
        )}`,
      ),
    );
    const location = redirectLocation(response);

    expectNoProviderLeak(location);
    expectNoProviderLeak(loggedText());
    expect(location).toContain("Meta declined the connection (access_denied).");
  });
});
