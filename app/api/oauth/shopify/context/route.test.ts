import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * `GET /api/oauth/shopify/context` was an unauthenticated cross-tenant read.
 *
 * A token in a query string — the kind that lands in browser history, in a
 * `?next=` parameter on the login page, in a pasted link — returned another
 * tenant's shop domain, shop name, currency, install timestamps and the business
 * the install was started for. No session, no membership, no single use, for the
 * whole 30-minute life of the token.
 *
 * These tests drive the real handler over the real access module, with only the
 * session and the database faked, and they are adversarial on purpose: the
 * legitimate merchant must still get through, and everyone else must be told the
 * same thing.
 */

const getSessionFromRequest = vi.fn();
const getDb = vi.fn();
const getDbSchemaReadiness = vi.fn(async () => ({ ready: true }));

vi.mock("@/lib/auth", () => ({ getSessionFromRequest }));
vi.mock("@/lib/db", () => ({ getDb }));
vi.mock("@/lib/db-schema-readiness", () => ({ getDbSchemaReadiness }));

const { buildShopifyInstallProof } = await import(
  "@/lib/shopify/install-context-access"
);
const { GET } = await import("@/app/api/oauth/shopify/context/route");

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";
const BUSINESS_A = "55555555-5555-4555-8555-555555555555";
const BUSINESS_B = "66666666-6666-4666-8666-666666666666";
const TOKEN = "a".repeat(64);
const SECRET = "shopify-app-secret";

interface StoredContext {
  token: string;
  shop_domain: string;
  shop_name: string | null;
  access_token: string;
  metadata: Record<string, unknown>;
  session_id: string | null;
  user_id: string | null;
  preferred_business_id: string | null;
  expires_at: string;
}

interface StoredMembership {
  user_id: string;
  business_id: string;
  status: string;
  role: string;
}

function storedContext(overrides: Partial<StoredContext> = {}): StoredContext {
  return {
    token: TOKEN,
    shop_domain: "merchant.myshopify.com",
    shop_name: "Merchant",
    access_token: "shpat_live_credential",
    metadata: { currency: "USD", iana_timezone: "Europe/Istanbul" },
    session_id: null,
    user_id: null,
    preferred_business_id: null,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

/** Predicates derived from the statement text, so a dropped guard is visible. */
function installStore(rows: StoredContext[], memberships: StoredMembership[] = []) {
  const query = vi.fn(async (text: string, params: unknown[]) => {
    const [token, sessionId, userId, reviewerOnly] = params as Array<string | null>;
    const has = (fragment: string) => text.includes(fragment);
    const businessVisible = (row: StoredContext) => {
      if (!has("FROM memberships m")) return true;
      if (row.preferred_business_id == null) return true;
      if (
        has("$4::uuid IS NULL OR c.preferred_business_id = $4::uuid") &&
        reviewerOnly != null &&
        row.preferred_business_id !== reviewerOnly
      ) {
        return false;
      }
      return memberships.some(
        (m) =>
          m.user_id === userId &&
          m.business_id === row.preferred_business_id &&
          (!has("m.status = 'active'") || m.status === "active") &&
          (!has("m.role IN ('admin', 'collaborator')") ||
            m.role === "admin" ||
            m.role === "collaborator"),
      );
    };
    const project = (row: StoredContext) => ({
      shop_domain: row.shop_domain,
      shop_name: row.shop_name,
      preferred_business_id: row.preferred_business_id,
      currency:
        typeof row.metadata.currency === "string" ? row.metadata.currency : null,
      token: row.token,
    });

    if (has("UPDATE shopify_install_contexts")) {
      if (has("$2::uuid IS NOT NULL") && sessionId == null) return [];
      if (has("$3::uuid IS NOT NULL") && userId == null) return [];
      const row = rows.find(
        (candidate) =>
          candidate.token === token &&
          (!has("c.expires_at > now()") ||
            new Date(candidate.expires_at).getTime() > Date.now()) &&
          (!has("c.session_id IS NULL") || candidate.session_id == null) &&
          (!has("c.user_id IS NULL OR c.user_id = $3::uuid") ||
            candidate.user_id == null ||
            candidate.user_id === userId) &&
          businessVisible(candidate),
      );
      if (!row) return [];
      if (has("SET session_id = $2::uuid")) row.session_id = sessionId;
      if (has("user_id    = $3::uuid")) row.user_id = userId;
      return [project(row)];
    }

    const row = rows.find(
      (candidate) =>
        candidate.token === token &&
        (!has("c.expires_at > now()") ||
          new Date(candidate.expires_at).getTime() > Date.now()) &&
        (!has("c.session_id = $2::uuid") || candidate.session_id === sessionId) &&
        (!has("c.user_id IS NULL OR c.user_id = $3::uuid") ||
          candidate.user_id == null ||
          candidate.user_id === userId) &&
        businessVisible(candidate),
    );
    return row ? [project(row)] : [];
  });
  getDb.mockReturnValue({ query });
  return query;
}

function signedIn(
  input: { sessionId?: string; userId?: string; email?: string } = {},
) {
  getSessionFromRequest.mockResolvedValue({
    sessionId: input.sessionId ?? SESSION,
    user: {
      id: input.userId ?? USER,
      email: input.email ?? "merchant@example.invalid",
      name: "Merchant",
      avatar: null,
      language: "en",
    },
    activeBusinessId: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

function request(
  input: { token?: string; proof?: string | null } = {},
): NextRequest {
  const token = input.token ?? TOKEN;
  const proof =
    input.proof === undefined ? buildShopifyInstallProof(token) : input.proof;
  return new NextRequest(
    `https://adsecute.com/api/oauth/shopify/context?token=${encodeURIComponent(token)}`,
    proof ? { headers: { cookie: `shopify_install_proof=${proof}` } } : undefined,
  );
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/oauth/shopify/context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbSchemaReadiness.mockResolvedValue({ ready: true });
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
  });

  it("refuses an unauthenticated request and never looks at the token", async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const query = installStore([storedContext({ session_id: SESSION, user_id: USER })]);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({
      error: "auth_error",
      message: "Authentication required.",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("serves the first-party merchant exactly the fields the page renders", async () => {
    signedIn();
    const rows = [storedContext()];
    installStore(rows);

    const response = await GET(request());

    expect(response.status).toBe(200);
    // Exactly this, and nothing else: no token echo, no returnTo, no createdAt,
    // no expiresAt, no timezone, and above all no access token.
    expect(await body(response)).toEqual({
      context: {
        shopDomain: "merchant.myshopify.com",
        shopName: "Merchant",
        preferredBusinessId: null,
        currency: "USD",
      },
    });
    // ...and the view bound the install to the merchant who opened it.
    expect(rows[0]!.session_id).toBe(SESSION);
    expect(rows[0]!.user_id).toBe(USER);
  });

  it("never lets the response be cached by anything in front of it", async () => {
    signedIn();
    installStore([storedContext()]);

    const response = await GET(request());

    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
  });

  it("refuses a different logged-in user holding the token", async () => {
    signedIn({ sessionId: OTHER_SESSION, userId: OTHER_USER });
    const rows = [storedContext({ session_id: SESSION, user_id: USER })];
    installStore(rows);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      error: "context_not_found",
      message: "Shopify install context not found or expired.",
    });
    expect(rows[0]!.session_id).toBe(SESSION);
  });

  it("refuses an expired context", async () => {
    signedIn();
    installStore([
      storedContext({
        session_id: SESSION,
        user_id: USER,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);

    const response = await GET(request());

    expect(response.status).toBe(404);
  });

  it("refuses an expired context to the bearer even with a valid proof", async () => {
    signedIn();
    const rows = [
      storedContext({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    ];
    installStore(rows);

    expect((await GET(request())).status).toBe(404);
    // An expired grant must not be revivable by binding it.
    expect(rows[0]!.session_id).toBeNull();
  });

  it("refuses a token for business A to a member of business B", async () => {
    signedIn();
    installStore(
      [
        storedContext({
          session_id: SESSION,
          user_id: USER,
          preferred_business_id: BUSINESS_A,
        }),
      ],
      [{ user_id: USER, business_id: BUSINESS_B, status: "active", role: "admin" }],
    );

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      error: "context_not_found",
      message: "Shopify install context not found or expired.",
    });
  });

  it("refuses a replay after the binding has been claimed", async () => {
    signedIn();
    const rows = [storedContext()];
    installStore(rows);

    expect((await GET(request())).status).toBe(200);

    // Same token, same valid proof, different session.
    signedIn({ sessionId: OTHER_SESSION, userId: OTHER_USER });
    const replay = await GET(request());
    expect(replay.status).toBe(404);
    expect(await body(replay)).toEqual({
      error: "context_not_found",
      message: "Shopify install context not found or expired.",
    });

    // The merchant who claimed it can still refresh the page.
    signedIn();
    expect((await GET(request())).status).toBe(200);
  });

  it("refuses a bearer with no install proof, and does not burn the merchant's install", async () => {
    signedIn({ sessionId: OTHER_SESSION, userId: OTHER_USER });
    const rows = [storedContext()];
    installStore(rows);

    const stolen = await GET(request({ proof: null }));

    expect(stolen.status).toBe(404);
    expect(rows[0]!.session_id).toBeNull();

    // ...and the real merchant, arriving afterwards, still completes the install.
    signedIn();
    const merchant = await GET(request());
    expect(merchant.status).toBe(200);
    expect(rows[0]!.session_id).toBe(SESSION);
  });

  it("refuses the context token replayed as its own proof", async () => {
    signedIn({ sessionId: OTHER_SESSION, userId: OTHER_USER });
    const rows = [storedContext()];
    installStore(rows);

    expect((await GET(request({ proof: TOKEN }))).status).toBe(404);
    expect(rows[0]!.session_id).toBeNull();
  });

  it("refuses a wrong-but-same-length token and a wrong-length token identically", async () => {
    signedIn();
    installStore([storedContext({ session_id: SESSION, user_id: USER })]);

    const sameLength = await GET(request({ token: "b".repeat(64) }));
    const wrongLength = await GET(request({ token: "b".repeat(9) }));
    const empty = await GET(request({ token: "" }));

    expect(sameLength.status).toBe(404);
    expect(wrongLength.status).toBe(404);
    expect(empty.status).toBe(404);
    const [a, b, c] = await Promise.all([
      body(sameLength),
      body(wrongLength),
      body(empty),
    ]);
    // Byte-identical: the response must not be an oracle for which tokens exist.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
  });

  it("refuses a live token and an unknown token with the same body and status", async () => {
    signedIn({ sessionId: OTHER_SESSION, userId: OTHER_USER });
    installStore([storedContext({ session_id: SESSION, user_id: USER })]);
    const live = await GET(request({ proof: null }));

    installStore([]);
    const unknown = await GET(request({ proof: null }));

    expect(live.status).toBe(unknown.status);
    expect(JSON.stringify(await body(live))).toBe(
      JSON.stringify(await body(unknown)),
    );
  });

  it("refuses rather than failing open when the schema is unavailable", async () => {
    signedIn();
    getDbSchemaReadiness.mockResolvedValue({ ready: false });
    installStore([storedContext({ session_id: SESSION, user_id: USER })]);

    expect((await GET(request())).status).toBe(404);
  });
});
