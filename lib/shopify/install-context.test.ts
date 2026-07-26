import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A Shopify install context carries a shop's access token.
 *
 * It was consumed with a SELECT followed by a DELETE, so two finalizers racing
 * on the same token both read the row and both connected the shop. And it was
 * consumed by TOKEN ALONE, so anyone who obtained the token could finalize it
 * into a business they had access to — binding someone else's store to their
 * own account.
 */

const getDb = vi.fn();
const getDbSchemaReadiness = vi.fn(async () => ({ ready: true }));

vi.mock("@/lib/db", () => ({ getDb }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness,
  assertDbSchemaReady: vi.fn(async () => null),
}));

const { consumeShopifyInstallContext } = await import(
  "@/lib/shopify/install-context"
);

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";

/**
 * A fake that models the one property that matters: `DELETE ... RETURNING` can
 * only succeed ONCE for a given token, no matter how many callers race.
 */
function installStore(rows: Array<Record<string, unknown>>) {
  const statements: string[] = [];
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ? ");
    statements.push(text);
    if (text.includes("DELETE FROM shopify_install_contexts")) {
      const [token, sessionId, userId] = values as Array<string | null>;
      const index = rows.findIndex(
        (row) =>
          row.token === token &&
          (row.session_id == null || row.session_id === sessionId) &&
          (row.user_id == null || row.user_id === userId),
      );
      if (index < 0) return [];
      return rows.splice(index, 1);
    }
    if (text.includes("SELECT 1 FROM shopify_install_contexts")) {
      const [token] = values as Array<string>;
      return rows.filter((row) => row.token === token).map(() => ({ "?column?": 1 }));
    }
    return [];
  }) as never;
  getDb.mockReturnValue(tag);
  return statements;
}

describe("consumeShopifyInstallContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbSchemaReadiness.mockResolvedValue({ ready: true });
  });

  it("claims and deletes in ONE statement", async () => {
    const statements = installStore([
      { token: "tok", session_id: SESSION, user_id: null, shop_domain: "s.myshopify.com" },
    ]);
    const claim = await consumeShopifyInstallContext({
      token: "tok",
      sessionId: SESSION,
    });
    expect(claim).toMatchObject({ ok: true });
    // The claim IS the mutation: no separate SELECT-then-DELETE window.
    expect(statements.filter((text) => text.includes("DELETE"))).toHaveLength(1);
    expect(statements.some((text) => text.includes("RETURNING *"))).toBe(true);
  });

  it("gives exactly one winner when two finalizers race", async () => {
    installStore([
      { token: "tok", session_id: SESSION, user_id: null, shop_domain: "s.myshopify.com" },
    ]);
    const [first, second] = await Promise.all([
      consumeShopifyInstallContext({ token: "tok", sessionId: SESSION }),
      consumeShopifyInstallContext({ token: "tok", sessionId: SESSION }),
    ]);
    const winners = [first, second].filter((claim) => claim.ok);
    expect(winners).toHaveLength(1);
  });

  it("refuses a context created for a different session", async () => {
    installStore([
      { token: "tok", session_id: SESSION, user_id: null, shop_domain: "s.myshopify.com" },
    ]);
    const claim = await consumeShopifyInstallContext({
      token: "tok",
      sessionId: OTHER_SESSION,
    });
    expect(claim).toEqual({ ok: false, reason: "not_your_context" });
  });

  it("reports an unknown token as not_found, not as someone else's", async () => {
    installStore([]);
    await expect(
      consumeShopifyInstallContext({ token: "nope", sessionId: SESSION }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });
});
