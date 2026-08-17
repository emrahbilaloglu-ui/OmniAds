import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Klaviyo authorization leg.
 *
 * This route used to answer 501 unconditionally, because fabricating a
 * connection would have been a lie. It now performs a real handshake — and
 * still answers 501 when the deployment holds no Klaviyo client credential,
 * which is the honest boundary rather than a placeholder.
 *
 * The order of the three checks is the property under test: businessId, then
 * authorization, THEN configuration. Reversing the last two would let a
 * stranger read this deployment's configuration state off the status code.
 */

const requireBusinessAccess = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));

const { GET } = await import("@/app/api/oauth/klaviyo/start/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function get(params: Record<string, string> = { businessId: BUSINESS_ID }) {
  const url = new URL("https://example.test/api/oauth/klaviyo/start");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const base = new Request(url.toString());
  return Object.assign(base, { nextUrl: url }) as never;
}

function configure() {
  vi.stubEnv("KLAVIYO_CLIENT_ID", "client-id");
  vi.stubEnv("KLAVIYO_CLIENT_SECRET", "client-secret");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
}

describe("GET /api/oauth/klaviyo/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
  });

  it("requires businessId", async () => {
    configure();
    const response = await GET(get({}));
    expect(response.status).toBe(400);
    expect(requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("requires collaborator on the named business, exactly like the Google start route", async () => {
    configure();
    await GET(get());
    expect(requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        minRole: "collaborator",
      }),
    );
  });

  it("returns the authorizer's denial before revealing whether Klaviyo is configured", async () => {
    // Unconfigured AND unauthorized: the caller must see the denial, not the 501.
    const denial = new Response(null, { status: 403 });
    requireBusinessAccess.mockResolvedValue({ error: denial });

    const response = await GET(get());
    expect(response).toBe(denial);
  });

  it("answers 501 naming the exact env vars when no client credential exists", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");

    const response = await GET(get());
    expect(response.status).toBe(501);
    const payload = await response.json();
    expect(payload.error).toBe("not_configured");
    expect(payload.requiredEnv).toEqual([
      "KLAVIYO_CLIENT_ID",
      "KLAVIYO_CLIENT_SECRET",
    ]);
    expect(payload.redirectUri).toBe(
      "https://app.example.test/api/oauth/klaviyo/callback",
    );
  });

  it("treats a client id without a secret as unconfigured", async () => {
    vi.stubEnv("KLAVIYO_CLIENT_ID", "client-id");

    const response = await GET(get());
    expect(response.status).toBe(501);
  });

  it("redirects to Klaviyo with PKCE and mirrors the state into an httpOnly cookie", async () => {
    configure();

    const response = await GET(get());
    expect(response.status).toBe(307);

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://www.klaviyo.com/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://app.example.test/api/oauth/klaviyo/callback",
    );

    const state = location.searchParams.get("state") ?? "";
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString());
    expect(decoded.businessId).toBe(BUSINESS_ID);
    expect(decoded.nonce).toMatch(/^[0-9a-f]{32}$/);

    const stateCookie = response.cookies.get("klaviyo_oauth_state");
    expect(stateCookie?.value).toBe(state);
    expect(stateCookie?.httpOnly).toBe(true);
    expect(stateCookie?.sameSite).toBe("lax");

    const verifier = response.cookies.get("klaviyo_oauth_verifier");
    expect(verifier?.value).toBeTruthy();
    expect(verifier?.httpOnly).toBe(true);
    // The verifier is the secret half of PKCE and must never reach the provider.
    expect(location.searchParams.get("code_verifier")).toBeNull();
    expect(location.search).not.toContain(verifier?.value ?? "__absent__");
  });

  it("requests read-only scopes only", async () => {
    configure();
    const response = await GET(get());
    const scope =
      new URL(response.headers.get("location") ?? "").searchParams.get(
        "scope",
      ) ?? "";
    expect(scope.split(" ").sort()).toEqual([
      "accounts:read",
      "flows:read",
      "metrics:read",
    ]);
    expect(scope).not.toContain(":write");
  });
});
