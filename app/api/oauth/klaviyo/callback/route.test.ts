import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Klaviyo callback leg.
 *
 * Same three refusals as `app/api/oauth/google/callback/route.ts`, in the same
 * order, plus the PKCE verifier Klaviyo requires. The property that matters
 * most is the one a state cookie alone does NOT give you: the cookie proves the
 * flow started in this browser, not that whoever finished it may connect
 * integrations for that business — so authorization is re-checked server-side
 * before any token is exchanged or stored.
 */

const requireBusinessAccess = vi.fn();
const upsertIntegration = vi.fn();
const exchangeKlaviyoAuthorizationCode = vi.fn();
const fetchKlaviyoAccount = vi.fn();
const syncKlaviyoFlowMetrics = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/integrations", () => ({ upsertIntegration }));
vi.mock("@/lib/klaviyo/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, exchangeKlaviyoAuthorizationCode, fetchKlaviyoAccount };
});
vi.mock("@/lib/klaviyo/sync", () => ({ syncKlaviyoFlowMetrics }));
vi.mock("@/lib/request-language", () => ({
  resolveRequestLanguage: vi.fn(async () => "en"),
}));
vi.mock("@/lib/runtime-logging", () => ({ logRuntimeDebug: vi.fn() }));

const { GET } = await import("@/app/api/oauth/klaviyo/callback/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function stateFor(businessId = BUSINESS_ID, returnTo: string | null = null) {
  return Buffer.from(
    JSON.stringify({
      businessId,
      provider: "klaviyo",
      returnTo,
      nonce: "0".repeat(32),
    }),
  ).toString("base64url");
}

function get(options: {
  params?: Record<string, string>;
  cookies?: Record<string, string>;
}) {
  const url = new URL("https://example.test/api/oauth/klaviyo/callback");
  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, value);
  }
  const cookies = options.cookies ?? {};
  const base = new Request(url.toString());
  return Object.assign(base, {
    nextUrl: url,
    cookies: {
      get: (name: string) =>
        name in cookies ? { name, value: cookies[name] } : undefined,
    },
  }) as never;
}

function locationOf(response: Response) {
  return new URL(response.headers.get("location") ?? "");
}

describe("GET /api/oauth/klaviyo/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("KLAVIYO_CLIENT_ID", "client-id");
    vi.stubEnv("KLAVIYO_CLIENT_SECRET", "client-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
    vi.spyOn(console, "error").mockImplementation(() => {});

    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    exchangeKlaviyoAuthorizationCode.mockResolvedValue({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresIn: 3600,
      scope: "accounts:read flows:read metrics:read",
    });
    fetchKlaviyoAccount.mockResolvedValue({
      id: "acct_1",
      name: "Aurora Supply Co.",
      currency: "USD",
    });
    upsertIntegration.mockResolvedValue({ id: "int_klaviyo_1" });
    syncKlaviyoFlowMetrics.mockResolvedValue({
      skipped: false,
      skipReason: null,
    });
  });

  const goodCookies = {
    klaviyo_oauth_state: stateFor(),
    klaviyo_oauth_verifier: "verifier",
  };

  it("redirects with an error when Klaviyo reports one, exchanging nothing", async () => {
    const response = await GET(
      get({ params: { error: "access_denied" }, cookies: goodCookies }),
    );
    expect(locationOf(response).searchParams.get("status")).toBe("error");
    expect(exchangeKlaviyoAuthorizationCode).not.toHaveBeenCalled();
  });

  it("rejects a state that does not match the cookie", async () => {
    const response = await GET(
      get({
        params: { code: "auth-code", state: stateFor() },
        cookies: {
          klaviyo_oauth_state: stateFor("other-business"),
          klaviyo_oauth_verifier: "verifier",
        },
      }),
    );
    expect(locationOf(response).searchParams.get("status")).toBe("error");
    expect(requireBusinessAccess).not.toHaveBeenCalled();
    expect(exchangeKlaviyoAuthorizationCode).not.toHaveBeenCalled();
  });

  it("rejects a flow whose PKCE verifier cookie is gone", async () => {
    const response = await GET(
      get({
        params: { code: "auth-code", state: stateFor() },
        cookies: { klaviyo_oauth_state: stateFor() },
      }),
    );
    expect(locationOf(response).searchParams.get("status")).toBe("error");
    expect(exchangeKlaviyoAuthorizationCode).not.toHaveBeenCalled();
  });

  it("re-authorizes server-side at collaborator, and a valid state cookie does not substitute for it", async () => {
    const denial = { error: new Response(null, { status: 403 }) };
    requireBusinessAccess.mockResolvedValue(denial);

    const response = await GET(
      get({
        params: { code: "auth-code", state: stateFor() },
        cookies: goodCookies,
      }),
    );

    expect(requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        minRole: "collaborator",
      }),
    );
    expect(locationOf(response).searchParams.get("status")).toBe("error");
    expect(exchangeKlaviyoAuthorizationCode).not.toHaveBeenCalled();
    expect(upsertIntegration).not.toHaveBeenCalled();
  });

  it("refuses to store a grant it cannot attribute to a Klaviyo account", async () => {
    fetchKlaviyoAccount.mockResolvedValue(null);

    const response = await GET(
      get({
        params: { code: "auth-code", state: stateFor() },
        cookies: goodCookies,
      }),
    );
    expect(locationOf(response).searchParams.get("status")).toBe("error");
    expect(upsertIntegration).not.toHaveBeenCalled();
  });

  it("stores the grant through the shared integration writer and clears both cookies", async () => {
    const response = await GET(
      get({
        params: { code: "auth-code", state: stateFor() },
        cookies: goodCookies,
      }),
    );

    expect(exchangeKlaviyoAuthorizationCode).toHaveBeenCalledWith({
      code: "auth-code",
      codeVerifier: "verifier",
    });
    expect(upsertIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        provider: "klaviyo",
        status: "connected",
        providerAccountId: "acct_1",
        providerAccountName: "Aurora Supply Co.",
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
      }),
    );
    expect(upsertIntegration.mock.calls[0][0].metadata).toMatchObject({
      klaviyoCurrency: "USD",
    });

    const location = locationOf(response);
    expect(location.pathname).toBe("/integrations/callback/klaviyo");
    expect(location.searchParams.get("status")).toBe("success");
    expect(location.searchParams.get("syncScheduled")).toBe("1");

    expect(response.cookies.get("klaviyo_oauth_state")?.value).toBe("");
    expect(response.cookies.get("klaviyo_oauth_verifier")?.value).toBe("");
  });

  it("tells the truth when the connection saved but the first import did not run", async () => {
    syncKlaviyoFlowMetrics.mockResolvedValue({
      skipped: true,
      skipReason: "schema_not_ready",
    });

    const response = await GET(
      get({
        params: { code: "auth-code", state: stateFor() },
        cookies: goodCookies,
      }),
    );
    const location = locationOf(response);
    expect(location.searchParams.get("status")).toBe("success");
    expect(location.searchParams.get("syncScheduled")).toBe("0");
    expect(location.searchParams.get("scheduleReason")).toBe("schema_not_ready");
  });

  it("keeps the connection when the guarded first import refuses outright", async () => {
    // A disabled `source_ingest` lane throws. The grant is real and stays; the
    // redirect says the import did not happen.
    const laneError = new Error("Sync lane 'source_ingest' is disabled.");
    laneError.name = "SyncLaneDisabledError";
    syncKlaviyoFlowMetrics.mockRejectedValue(laneError);

    const response = await GET(
      get({
        params: { code: "auth-code", state: stateFor() },
        cookies: goodCookies,
      }),
    );
    const location = locationOf(response);
    expect(location.searchParams.get("status")).toBe("success");
    expect(location.searchParams.get("syncScheduled")).toBe("0");
    expect(location.searchParams.get("scheduleReason")).toBe(
      "SyncLaneDisabledError",
    );
    expect(upsertIntegration).toHaveBeenCalledTimes(1);
  });
});
