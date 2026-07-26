import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may READ a pending Shopify install context.
 *
 * The route this backs used to require nothing: a token in a query string
 * returned another tenant's shop domain, shop name, currency, the business the
 * install was started for and its timestamps, to anyone, repeatedly, for the
 * life of the token.
 *
 * What is proven here is the decision logic — actor binding, the trust-on-first
 * -use claim, the install proof, the projection, and the fact that every refusal
 * is the same refusal. The half that only a real database can settle — that the
 * first-view claim is genuinely exclusive under concurrent readers, and that a
 * refused read writes nothing — is proven by
 * `scripts/ephemeral-postgres-shopify-context-access-seam.ts`.
 *
 * The fake below derives its behaviour from the STATEMENT TEXT rather than
 * reimplementing the intended rules, so deleting a predicate from the shipped
 * SQL changes what these tests observe instead of being invisible to them.
 */

const getDb = vi.fn();
const getDbSchemaReadiness = vi.fn(async () => ({ ready: true }));

vi.mock("@/lib/db", () => ({ getDb }));
vi.mock("@/lib/db-schema-readiness", () => ({ getDbSchemaReadiness }));

const {
  SHOPIFY_INSTALL_CONTEXT_BOUND_READ_SQL,
  SHOPIFY_INSTALL_CONTEXT_CLAIM_SQL,
  buildShopifyInstallProof,
  constantTimeSecretsMatch,
  readShopifyInstallContextForViewer,
} = await import("@/lib/shopify/install-context-access");

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";
const BUSINESS_A = "55555555-5555-4555-8555-555555555555";
const BUSINESS_B = "66666666-6666-4666-8666-666666666666";
/** `DEMO_BUSINESS_ID`, the only business the Shopify reviewer may ever see. */
const DEMO_BUSINESS = "11111111-1111-4111-8111-111111111111";
const TOKEN = "a".repeat(64);
const SECRET = "shopify-app-secret";

interface StoredContext {
  token: string;
  shop_domain: string;
  shop_name: string | null;
  access_token: string;
  scopes: string | null;
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
    scopes: "read_orders",
    metadata: { currency: "USD", iana_timezone: "Europe/Istanbul" },
    session_id: null,
    user_id: null,
    preferred_business_id: null,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

/**
 * A store whose predicates come from the SQL it is handed.
 *
 * Every guard is applied only if the statement text still contains it, which is
 * what makes these assertions sensitive to the guard being removed: drop
 * `c.session_id = $2::uuid` from the read and the foreign-session test starts
 * SUCCEEDING here, not passing vacuously.
 */
function installStore(rows: StoredContext[], memberships: StoredMembership[] = []) {
  const statements: string[] = [];
  const query = vi.fn(async (text: string, params: unknown[]) => {
    statements.push(text);
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

    if (text.includes("UPDATE shopify_install_contexts")) {
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
  return { statements, query };
}

function read(overrides: Partial<Parameters<typeof readShopifyInstallContextForViewer>[0]> = {}) {
  return readShopifyInstallContextForViewer({
    token: TOKEN,
    sessionId: SESSION,
    userId: USER,
    userEmail: "merchant@example.invalid",
    installProof: buildShopifyInstallProof(TOKEN),
    ...overrides,
  });
}

describe("readShopifyInstallContextForViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbSchemaReadiness.mockResolvedValue({ ready: true });
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
  });

  it("never names the shop credential in any statement it can issue", () => {
    // The column is being encrypted at rest by a different change; this path has
    // no reason to hold the plaintext, and the guarantee is structural rather
    // than a habit of whoever edits the projection next.
    expect(SHOPIFY_INSTALL_CONTEXT_CLAIM_SQL).not.toContain("access_token");
    expect(SHOPIFY_INSTALL_CONTEXT_BOUND_READ_SQL).not.toContain("access_token");
    expect(SHOPIFY_INSTALL_CONTEXT_CLAIM_SQL).not.toContain("scopes");
    expect(SHOPIFY_INSTALL_CONTEXT_BOUND_READ_SQL).not.toContain("scopes");
    // And the whole metadata blob is never handed over either.
    expect(SHOPIFY_INSTALL_CONTEXT_BOUND_READ_SQL).toContain("c.metadata->>'currency'");
  });

  it("returns only the fields the connect page renders", async () => {
    installStore([storedContext({ session_id: SESSION, user_id: USER })]);

    const result = await read();

    expect(result).toEqual({
      ok: true,
      binding: "already_bound",
      context: {
        shopDomain: "merchant.myshopify.com",
        shopName: "Merchant",
        preferredBusinessId: null,
        currency: "USD",
      },
    });
  });

  it("refuses a caller with no session before it touches the database", async () => {
    const { query } = installStore([storedContext({ session_id: SESSION })]);

    await expect(read({ sessionId: null })).resolves.toEqual({
      ok: false,
      reason: "no_actor",
    });
    await expect(read({ userId: "not-a-uuid" })).resolves.toEqual({
      ok: false,
      reason: "no_actor",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a different session holding the token, and writes nothing", async () => {
    const rows = [storedContext({ session_id: SESSION, user_id: USER })];
    installStore(rows);

    // Even handed a VALID install proof — the strongest position a second
    // account in the same browser could be in — a context that already has an
    // actor cannot be re-bound. The claim's `session_id IS NULL` is what makes
    // that true; the statement is issued and matches nothing.
    const result = await read({ sessionId: OTHER_SESSION, userId: OTHER_USER });

    expect(result).toEqual({ ok: false, reason: "not_visible" });
    expect(rows[0]!.session_id).toBe(SESSION);
    expect(rows[0]!.user_id).toBe(USER);
  });

  it("refuses a foreign session on the session binding alone", async () => {
    // The recorded user is what refuses most foreign readers, so this case
    // removes it: a context bound to a session and to no user. Only
    // `c.session_id = $2::uuid` can refuse this, which is the point.
    const rows = [storedContext({ session_id: SESSION, user_id: null })];
    installStore(rows);

    await expect(
      read({ sessionId: OTHER_SESSION, userId: OTHER_USER }),
    ).resolves.toEqual({ ok: false, reason: "not_visible" });
    expect(rows[0]!.session_id).toBe(SESSION);
    expect(rows[0]!.user_id).toBeNull();
  });

  it("refuses the same session when the context recorded a different user", async () => {
    installStore([storedContext({ session_id: SESSION, user_id: OTHER_USER })]);

    await expect(read()).resolves.toEqual({ ok: false, reason: "not_visible" });
  });

  it("refuses an expired context", async () => {
    installStore([
      storedContext({
        session_id: SESSION,
        user_id: USER,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);

    await expect(read()).resolves.toEqual({ ok: false, reason: "not_visible" });
  });

  it("binds an actorless context to the first authenticated viewer that can prove the redirect", async () => {
    const rows = [storedContext()];
    installStore(rows);

    const result = await read();

    expect(result.ok).toBe(true);
    expect(result.ok && result.binding).toBe("claimed");
    expect(rows[0]!.session_id).toBe(SESSION);
    expect(rows[0]!.user_id).toBe(USER);
  });

  it("refuses to bind an actorless context without the install proof", async () => {
    const rows = [storedContext()];
    const { statements } = installStore(rows);

    await expect(read({ installProof: null })).resolves.toEqual({
      ok: false,
      reason: "not_visible",
    });
    // The proof is checked BEFORE the claim: a refused read must not have been
    // one UPDATE away from binding someone else's install.
    expect(statements.some((text) => text.includes("UPDATE"))).toBe(false);
    expect(rows[0]!.session_id).toBeNull();
  });

  it("refuses a forged proof, including the token replayed as its own proof", async () => {
    installStore([storedContext()]);
    await expect(read({ installProof: "0".repeat(64) })).resolves.toEqual({
      ok: false,
      reason: "not_visible",
    });

    installStore([storedContext()]);
    // The naive design — put the context token in a cookie as well — would have
    // accepted this, and an attacker holding the token can always send it.
    await expect(read({ installProof: TOKEN })).resolves.toEqual({
      ok: false,
      reason: "not_visible",
    });
  });

  it("refuses to bind when the proof cannot be computed at all", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "");
    installStore([storedContext()]);

    // Fail closed: an unavailable secret is "cannot prove", never "no proof
    // needed".
    await expect(read({ installProof: "anything" })).resolves.toEqual({
      ok: false,
      reason: "not_visible",
    });
  });

  it("refuses a second, different session once the binding is claimed", async () => {
    const rows = [storedContext()];
    installStore(rows);

    await expect(read()).resolves.toMatchObject({ ok: true, binding: "claimed" });
    // Replay of the very same token, with the very same valid proof, from
    // another session.
    await expect(
      read({ sessionId: OTHER_SESSION, userId: OTHER_USER }),
    ).resolves.toEqual({ ok: false, reason: "not_visible" });
    // ...and the original viewer keeps their install.
    await expect(read()).resolves.toMatchObject({
      ok: true,
      binding: "already_bound",
    });
  });

  it("refuses a context started for a business the caller cannot finish it into", async () => {
    const rows = [
      storedContext({
        session_id: SESSION,
        user_id: USER,
        preferred_business_id: BUSINESS_A,
      }),
    ];
    // The caller is a full member of a DIFFERENT business.
    installStore(rows, [
      { user_id: USER, business_id: BUSINESS_B, status: "active", role: "admin" },
    ]);

    await expect(read()).resolves.toEqual({ ok: false, reason: "not_visible" });
  });

  it("refuses a guest of the target business, who could never finalize it", async () => {
    installStore(
      [
        storedContext({
          session_id: SESSION,
          user_id: USER,
          preferred_business_id: BUSINESS_A,
        }),
      ],
      [{ user_id: USER, business_id: BUSINESS_A, status: "active", role: "guest" }],
    );

    await expect(read()).resolves.toEqual({ ok: false, reason: "not_visible" });
  });

  it("refuses an invited-but-not-active membership", async () => {
    installStore(
      [
        storedContext({
          session_id: SESSION,
          user_id: USER,
          preferred_business_id: BUSINESS_A,
        }),
      ],
      [
        {
          user_id: USER,
          business_id: BUSINESS_A,
          status: "invited",
          role: "admin",
        },
      ],
    );

    await expect(read()).resolves.toEqual({ ok: false, reason: "not_visible" });
  });

  it("allows a collaborator of the business the install was started for", async () => {
    installStore(
      [
        storedContext({
          session_id: SESSION,
          user_id: USER,
          preferred_business_id: BUSINESS_A,
        }),
      ],
      [
        {
          user_id: USER,
          business_id: BUSINESS_A,
          status: "active",
          role: "collaborator",
        },
      ],
    );

    await expect(read()).resolves.toMatchObject({
      ok: true,
      context: { preferredBusinessId: BUSINESS_A },
    });
  });

  it("confines the Shopify reviewer to the demo business", async () => {
    const reviewerEmail =
      process.env.SHOPIFY_REVIEWER_EMAIL?.trim() ?? "shopify-review@adsecute.com";
    const memberships = [
      { user_id: USER, business_id: BUSINESS_A, status: "active", role: "admin" },
      { user_id: USER, business_id: DEMO_BUSINESS, status: "active", role: "admin" },
    ];

    installStore(
      [
        storedContext({
          session_id: SESSION,
          user_id: USER,
          preferred_business_id: BUSINESS_A,
        }),
      ],
      memberships,
    );
    // A membership is not enough: `canReviewerAccessBusiness` confines this
    // account, and a parallel authorization path that dropped that rule would be
    // a hole of its own.
    await expect(read({ userEmail: reviewerEmail })).resolves.toEqual({
      ok: false,
      reason: "not_visible",
    });

    installStore(
      [
        storedContext({
          session_id: SESSION,
          user_id: USER,
          preferred_business_id: DEMO_BUSINESS,
        }),
      ],
      memberships,
    );
    await expect(read({ userEmail: reviewerEmail })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("refuses when the schema is unavailable instead of reading anything", async () => {
    getDbSchemaReadiness.mockResolvedValue({ ready: false });
    const { query } = installStore([storedContext({ session_id: SESSION })]);

    await expect(read()).resolves.toEqual({
      ok: false,
      reason: "schema_unavailable",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses an absent token without a query", async () => {
    const { query } = installStore([storedContext({ session_id: SESSION })]);

    await expect(read({ token: "" })).resolves.toEqual({
      ok: false,
      reason: "no_token",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a wrong-length and a wrong-but-same-length token identically", async () => {
    installStore([storedContext({ session_id: SESSION, user_id: USER })]);

    const sameLength = await read({ token: "b".repeat(64) });
    const wrongLength = await read({ token: "b".repeat(7) });

    expect(sameLength).toEqual({ ok: false, reason: "not_visible" });
    expect(wrongLength).toEqual(sameLength);
  });
});

describe("constantTimeSecretsMatch", () => {
  it("matches equal secrets", () => {
    expect(constantTimeSecretsMatch(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects a different secret of the same length", () => {
    expect(constantTimeSecretsMatch(TOKEN, "b".repeat(64))).toBe(false);
  });

  it("rejects a different length without throwing and without a length branch", () => {
    // `timingSafeEqual` throws on unequal lengths, and the usual guard —
    // comparing lengths first — is itself the leak. Digesting both sides makes
    // every comparison a fixed 32 bytes, so this is a plain false.
    expect(constantTimeSecretsMatch("", TOKEN)).toBe(false);
    expect(constantTimeSecretsMatch("b", TOKEN)).toBe(false);
    expect(constantTimeSecretsMatch(`${TOKEN}c`, TOKEN)).toBe(false);
  });
});

describe("buildShopifyInstallProof", () => {
  beforeEach(() => {
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
  });

  it("is not derivable from the context token", () => {
    const proof = buildShopifyInstallProof(TOKEN);
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(proof).not.toBe(TOKEN);
  });

  it("is bound to the specific token", () => {
    expect(buildShopifyInstallProof(TOKEN)).not.toBe(
      buildShopifyInstallProof("b".repeat(64)),
    );
  });

  it("is null rather than a guessable constant when the secret is missing", () => {
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "");
    expect(buildShopifyInstallProof(TOKEN)).toBeNull();
  });
});
