import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encryptIntegrationSecret,
  isEncryptedIntegrationSecret,
} from "@/lib/integration-secrets";
import type { ShopifyInstallContextRow } from "@/lib/shopify/install-context";

/**
 * A Shopify install context carries a shop's access token.
 *
 * It was consumed with a SELECT followed by a DELETE, so two finalizers racing
 * on the same token both read the row and both connected the shop. It was
 * consumed by TOKEN ALONE, so anyone who obtained the token could finalize it
 * into a business they had access to — binding someone else's store to their own
 * account. And once actor binding was added, the claim still ignored the
 * business the install was STARTED for, so a user who belongs to two businesses
 * could land the shop on the wrong one.
 *
 * The cross-process half of these claims is proven against real PostgreSQL by
 * `scripts/ephemeral-postgres-shopify-install-seam.ts`; what is mocked here is
 * the decision logic on top of it.
 */

const getDb = vi.fn();
const getDbSchemaReadiness = vi.fn(async () => ({ ready: true }));
const getIntegration = vi.fn();
const upsertIntegration = vi.fn();

vi.mock("@/lib/db", () => ({ getDb }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness,
  assertDbSchemaReady: vi.fn(async () => null),
}));
vi.mock("@/lib/integrations", () => ({ getIntegration, upsertIntegration }));
vi.mock("@/lib/shopify/pixels", () => ({
  registerShopifyCustomerEventsPixel: vi.fn(async () => ({ pixelId: "px" })),
}));
vi.mock("@/lib/shopify/webhooks", () => ({
  registerShopifySyncWebhooks: vi.fn(async () => ({ created: [] })),
}));

const {
  consumeShopifyInstallContext,
  createShopifyInstallContext,
  finalizeShopifyInstall,
  getShopifyInstallContext,
  restoreShopifyInstallContext,
} = await import("@/lib/shopify/install-context");

const ENCRYPTION_KEY = "install-context-suite-key";

// Every case runs with a key, because the writer refuses without one — the
// no-key behaviour is itself asserted, by removing it explicitly.
beforeEach(() => {
  vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", ENCRYPTION_KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const BUSINESS = "33333333-3333-4333-8333-333333333333";
const OTHER_BUSINESS = "44444444-4444-4444-8444-444444444444";

type StoredContext = ShopifyInstallContextRow;

function installContext(overrides: Partial<StoredContext> = {}): StoredContext {
  return {
    id: "ctx-1",
    token: "tok",
    shop_domain: "s.myshopify.com",
    shop_name: "S",
    access_token: "shpat_live",
    scopes: "read_orders",
    metadata: {},
    return_to: null,
    session_id: SESSION,
    user_id: null,
    preferred_business_id: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

/**
 * A fake that models the properties that matter: `DELETE ... RETURNING` can only
 * succeed ONCE for a given token no matter how many callers race, a refused
 * claim leaves the row untouched, and a restore can neither extend an expiry nor
 * overwrite a token that is already present.
 */
function installStore(rows: StoredContext[]) {
  const statements: string[] = [];
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ? ");
    statements.push(text);
    if (text.includes("DELETE FROM shopify_install_contexts WHERE expires_at")) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (new Date(rows[index]!.expires_at).getTime() <= Date.now()) {
          rows.splice(index, 1);
        }
      }
      return [];
    }
    if (text.includes("SELECT *") && text.includes("FROM shopify_install_contexts")) {
      const [token] = values as Array<string>;
      return rows
        .filter(
          (row) =>
            row.token === token &&
            new Date(row.expires_at).getTime() > Date.now(),
        )
        .slice(0, 1);
    }
    if (text.includes("DELETE FROM shopify_install_contexts")) {
      const [token, sessionId, userId, businessId] = values as Array<string | null>;
      const index = rows.findIndex(
        (row) =>
          row.token === token &&
          new Date(row.expires_at).getTime() > Date.now() &&
          (row.session_id == null || row.session_id === sessionId) &&
          (row.user_id == null || row.user_id === userId) &&
          (row.preferred_business_id == null ||
            row.preferred_business_id === businessId),
      );
      if (index < 0) return [];
      return rows.splice(index, 1);
    }
    // The CREATE insert and the RESTORE insert are both
    // `INSERT INTO shopify_install_contexts`; only the restore clamps with
    // LEAST, and their value positions differ, so they must not share a branch.
    if (
      text.includes("INSERT INTO shopify_install_contexts") &&
      !text.includes("LEAST(")
    ) {
      const [
        token,
        shopDomain,
        shopName,
        accessToken,
        scopes,
        ,
        returnTo,
        sessionId,
        userId,
        preferredBusinessId,
        expiresAt,
      ] = values as Array<string | null>;
      const created = installContext({
        id: `ctx-${rows.length + 1}`,
        token: token as string,
        shop_domain: shopDomain as string,
        shop_name: shopName,
        access_token: accessToken as string,
        scopes,
        return_to: returnTo,
        session_id: sessionId,
        user_id: userId,
        preferred_business_id: preferredBusinessId,
        created_at: new Date().toISOString(),
        expires_at: expiresAt as string,
      });
      rows.push(created);
      return [created];
    }
    if (text.includes("INSERT INTO shopify_install_contexts")) {
      const expiresAt = values[11] as string;
      if (new Date(expiresAt).getTime() <= Date.now()) return [];
      const token = values[0] as string;
      if (rows.some((row) => row.token === token)) return [];
      const clamped = new Date(
        Math.min(new Date(expiresAt).getTime(), Date.now() + 5 * 60 * 1000),
      ).toISOString();
      rows.push(
        installContext({
          token,
          access_token: values[3] as string,
          session_id: values[7] as string | null,
          user_id: values[8] as string | null,
          preferred_business_id: values[9] as string | null,
          created_at: values[10] as string,
          expires_at: clamped,
        }),
      );
      return [{ expires_at: clamped }];
    }
    if (text.includes("SELECT session_id::text")) {
      const [token] = values as Array<string>;
      return rows
        .filter(
          (row) =>
            row.token === token &&
            new Date(row.expires_at).getTime() > Date.now(),
        )
        .map((row) => ({
          session_id: row.session_id,
          user_id: row.user_id,
          preferred_business_id: row.preferred_business_id,
        }));
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

describe("install context tokens at rest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbSchemaReadiness.mockResolvedValue({ ready: true });
  });

  it("stores ciphertext and hands the caller back the real token", async () => {
    const rows: StoredContext[] = [];
    installStore(rows);

    const created = await createShopifyInstallContext({
      shopDomain: "enc.myshopify.com",
      accessToken: "shpat_at_rest",
      sessionId: SESSION,
    });

    expect(isEncryptedIntegrationSecret(rows[0]!.access_token)).toBe(true);
    expect(rows[0]!.access_token).not.toContain("shpat_at_rest");
    // ...and the caller still gets a usable credential, not a base64 blob it
    // would go on to send to Shopify as a bearer token.
    expect(created.access_token).toBe("shpat_at_rest");
  });

  it("refuses to create the context at all when there is no encryption key", async () => {
    const rows: StoredContext[] = [];
    const statements = installStore(rows);
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "");

    await expect(
      createShopifyInstallContext({
        shopDomain: "nokey.myshopify.com",
        accessToken: "shpat_no_key",
        sessionId: SESSION,
      }),
    ).rejects.toThrow(/INTEGRATION_TOKEN_ENCRYPTION_KEY/);

    // The refusal has to be BEFORE the insert. A row written and then rejected
    // is a plaintext credential nobody is looking for.
    expect(rows).toHaveLength(0);
    expect(statements.some((text) => text.includes("INSERT INTO"))).toBe(false);
  });

  it("decrypts on read and still passes a legacy plaintext row through", async () => {
    installStore([
      installContext({
        token: "encrypted",
        access_token: encryptIntegrationSecret("shpat_encrypted")!,
      }),
      installContext({ token: "legacy", access_token: "shpat_legacy" }),
    ]);

    await expect(getShopifyInstallContext("encrypted")).resolves.toMatchObject({
      access_token: "shpat_encrypted",
    });
    // Rows written before the change hold plaintext; refusing them would break
    // every install already in flight at deploy time.
    await expect(getShopifyInstallContext("legacy")).resolves.toMatchObject({
      access_token: "shpat_legacy",
    });
  });

  it("raises rather than returning ciphertext when it cannot be decrypted", async () => {
    const encrypted = encryptIntegrationSecret("shpat_other_key")!;
    installStore([installContext({ access_token: encrypted })]);
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "a-completely-different-key");

    await expect(getShopifyInstallContext("tok")).rejects.toThrow(
      /could not be decrypted/,
    );
  });

  it("re-encrypts on restore instead of writing the claimed plaintext back", async () => {
    const rows: StoredContext[] = [];
    installStore(rows);

    await expect(
      restoreShopifyInstallContext(installContext({ access_token: "shpat_restored" })),
    ).resolves.toBe("restored");

    expect(isEncryptedIntegrationSecret(rows[0]!.access_token)).toBe(true);
    expect(rows[0]!.access_token).not.toContain("shpat_restored");
  });

  it("claims a legacy plaintext grant and re-encrypts it if it is put back", async () => {
    const rows = [installContext({ access_token: "shpat_legacy_claim" })];
    installStore(rows);

    const claim = await consumeShopifyInstallContext({
      token: "tok",
      sessionId: SESSION,
      targetBusinessId: BUSINESS,
    });
    expect(claim).toMatchObject({ ok: true });
    if (!claim.ok) return;
    expect(claim.context.access_token).toBe("shpat_legacy_claim");

    await expect(restoreShopifyInstallContext(claim.context)).resolves.toBe(
      "restored",
    );
    expect(isEncryptedIntegrationSecret(rows[0]!.access_token)).toBe(true);
  });
});

describe("consumeShopifyInstallContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbSchemaReadiness.mockResolvedValue({ ready: true });
  });

  it("claims and deletes in ONE statement", async () => {
    const statements = installStore([installContext()]);
    const claim = await consumeShopifyInstallContext({
      token: "tok",
      sessionId: SESSION,
      targetBusinessId: BUSINESS,
    });
    expect(claim).toMatchObject({ ok: true });
    // The claim IS the mutation: no separate SELECT-then-DELETE window.
    expect(statements.filter((text) => text.includes("DELETE"))).toHaveLength(1);
    expect(statements.some((text) => text.includes("RETURNING *"))).toBe(true);
  });

  it("gives exactly one winner when two finalizers race", async () => {
    installStore([installContext()]);
    const [first, second] = await Promise.all([
      consumeShopifyInstallContext({
        token: "tok",
        sessionId: SESSION,
        targetBusinessId: BUSINESS,
      }),
      consumeShopifyInstallContext({
        token: "tok",
        sessionId: SESSION,
        targetBusinessId: BUSINESS,
      }),
    ]);
    const winners = [first, second].filter((claim) => claim.ok);
    expect(winners).toHaveLength(1);
  });

  it("refuses a context created for a different session", async () => {
    installStore([installContext()]);
    const claim = await consumeShopifyInstallContext({
      token: "tok",
      sessionId: OTHER_SESSION,
      targetBusinessId: BUSINESS,
    });
    expect(claim).toEqual({ ok: false, reason: "not_your_context" });
  });

  it("refuses a finalize into a business the install was not started for", async () => {
    const rows = [installContext({ preferred_business_id: BUSINESS })];
    installStore(rows);
    const claim = await consumeShopifyInstallContext({
      token: "tok",
      sessionId: SESSION,
      targetBusinessId: OTHER_BUSINESS,
    });
    expect(claim).toEqual({ ok: false, reason: "wrong_business" });
    // A refused claim must leave the grant intact for the business it belongs to.
    expect(rows).toHaveLength(1);
    await expect(
      consumeShopifyInstallContext({
        token: "tok",
        sessionId: SESSION,
        targetBusinessId: BUSINESS,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("reports a stranger as not_your_context, never revealing the target business", async () => {
    installStore([installContext({ preferred_business_id: BUSINESS })]);
    await expect(
      consumeShopifyInstallContext({
        token: "tok",
        sessionId: OTHER_SESSION,
        targetBusinessId: OTHER_BUSINESS,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_your_context" });
  });

  it("still claims a context that recorded no target business", async () => {
    installStore([installContext({ preferred_business_id: null })]);
    await expect(
      consumeShopifyInstallContext({
        token: "tok",
        sessionId: SESSION,
        targetBusinessId: OTHER_BUSINESS,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("refuses a target business that is not a well-formed id", async () => {
    installStore([installContext({ preferred_business_id: BUSINESS })]);
    await expect(
      consumeShopifyInstallContext({
        token: "tok",
        sessionId: SESSION,
        targetBusinessId: "not-a-business",
      }),
    ).resolves.toEqual({ ok: false, reason: "wrong_business" });
  });

  it("reports an unknown token as not_found, not as someone else's", async () => {
    installStore([]);
    await expect(
      consumeShopifyInstallContext({
        token: "nope",
        sessionId: SESSION,
        targetBusinessId: BUSINESS,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses an expired context", async () => {
    installStore([
      installContext({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
    ]);
    await expect(
      consumeShopifyInstallContext({
        token: "tok",
        sessionId: SESSION,
        targetBusinessId: BUSINESS,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });
});

describe("restoreShopifyInstallContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbSchemaReadiness.mockResolvedValue({ ready: true });
  });

  it("never extends the grant past the expiry the user consented to", async () => {
    const rows: StoredContext[] = [];
    const original = new Date(Date.now() + 20_000).toISOString();
    const statements = installStore(rows);
    await expect(
      restoreShopifyInstallContext(installContext({ expires_at: original })),
    ).resolves.toBe("restored");
    expect(new Date(rows[0]!.expires_at).getTime()).toBeLessThanOrEqual(
      new Date(original).getTime(),
    );
    // The clamp is the database's, computed against the database's clock.
    expect(statements.some((text) => text.includes("LEAST"))).toBe(true);
  });

  it("refuses to resurrect a grant that has already expired", async () => {
    const rows: StoredContext[] = [];
    installStore(rows);
    await expect(
      restoreShopifyInstallContext(
        installContext({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
      ),
    ).resolves.toBe("expired");
    expect(rows).toHaveLength(0);
  });

  it("reports a token another process already holds instead of claiming success", async () => {
    installStore([installContext()]);
    await expect(restoreShopifyInstallContext(installContext())).resolves.toBe(
      "already_present",
    );
  });
});

describe("finalizeShopifyInstall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbSchemaReadiness.mockResolvedValue({ ready: true });
  });

  const connected = {
    id: "int-1",
    provider: "shopify",
    status: "connected",
    provider_account_id: "s.myshopify.com",
    access_token: "shpat_live",
    connection_generation: 3,
    metadata: {},
  };

  function sideEffectSpies() {
    return {
      registerWebhooks: vi.fn(async () => ({ created: [] })),
      registerPixel: vi.fn(async () => ({ pixelId: "px-1" })),
    };
  }

  it("does NOT put the credential back when the failure is terminal", async () => {
    const rows = [installContext()];
    installStore(rows);
    // A missing encryption key fails identically on every retry; restoring would
    // leave a live shop token claimable until it expired, for no benefit.
    upsertIntegration.mockRejectedValueOnce(
      new Error("INTEGRATION_TOKEN_ENCRYPTION_KEY is required"),
    );
    getIntegration.mockResolvedValue(null);
    const sideEffects = sideEffectSpies();

    const result = await finalizeShopifyInstall({
      token: "tok",
      businessId: BUSINESS,
      sessionId: SESSION,
      sideEffects,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "integration_save_failed_terminal",
        retryable: false,
        grant: "discarded",
      },
    });
    expect(rows).toHaveLength(0);
    expect(sideEffects.registerWebhooks).not.toHaveBeenCalled();
    expect(sideEffects.registerPixel).not.toHaveBeenCalled();
  });

  it("restores the credential when the failure is transient and the write provably did not land", async () => {
    const rows = [installContext()];
    installStore(rows);
    upsertIntegration.mockRejectedValueOnce(
      Object.assign(new Error("connection closed"), { code: "08006" }),
    );
    getIntegration.mockResolvedValue(null);

    const result = await finalizeShopifyInstall({
      token: "tok",
      businessId: BUSINESS,
      sessionId: SESSION,
      sideEffects: sideEffectSpies(),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "integration_save_failed",
        retryable: true,
        grant: "restored",
      },
    });
    expect(rows).toHaveLength(1);
  });

  it("converges instead of publishing a second copy when the write actually landed", async () => {
    const rows = [installContext()];
    installStore(rows);
    // The commit succeeded and the response was lost. Restoring here would put a
    // second claimable copy of a credential that is already connected.
    upsertIntegration.mockRejectedValueOnce(
      Object.assign(new Error("Connection terminated unexpectedly"), {
        code: "08006",
      }),
    );
    getIntegration.mockResolvedValue(connected);
    const sideEffects = sideEffectSpies();

    const result = await finalizeShopifyInstall({
      token: "tok",
      businessId: BUSINESS,
      sessionId: SESSION,
      sideEffects,
    });

    expect(result).toMatchObject({ ok: true, credentialAlreadyPersisted: true });
    expect(rows).toHaveLength(0);
    expect(sideEffects.registerPixel).toHaveBeenCalledTimes(1);
  });

  it("discards rather than resurrects when the grant's state cannot be verified", async () => {
    const rows = [installContext()];
    installStore(rows);
    upsertIntegration.mockRejectedValueOnce(
      Object.assign(new Error("connection closed"), { code: "08006" }),
    );
    getIntegration.mockRejectedValue(new Error("database unreachable"));

    const result = await finalizeShopifyInstall({
      token: "tok",
      businessId: BUSINESS,
      sessionId: SESSION,
      sideEffects: sideEffectSpies(),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "integration_save_unverified", retryable: false },
    });
    expect(rows).toHaveLength(0);
  });

  it("refuses provider mutations once the connection has moved underneath them", async () => {
    installStore([installContext()]);
    upsertIntegration.mockResolvedValueOnce(connected);
    // A reconnect to a different shop lands between the credential write and the
    // registrations; the token in hand is no longer the stored one.
    getIntegration.mockResolvedValue({
      ...connected,
      connection_generation: 4,
      provider_account_id: "other.myshopify.com",
      access_token: "shpat_other",
    });
    const sideEffects = sideEffectSpies();

    const result = await finalizeShopifyInstall({
      token: "tok",
      businessId: BUSINESS,
      sessionId: SESSION,
      sideEffects,
    });

    expect(result).toMatchObject({
      ok: true,
      webhooks: { status: "refused", code: "shopify_connection_changed" },
      pixel: { status: "refused", code: "shopify_connection_changed" },
    });
    expect(sideEffects.registerWebhooks).not.toHaveBeenCalled();
    expect(sideEffects.registerPixel).not.toHaveBeenCalled();
  });

  it("does not create a second customer-events pixel for an already registered shop", async () => {
    installStore([installContext()]);
    upsertIntegration.mockResolvedValueOnce({
      ...connected,
      metadata: {
        shopifyCustomerEventsPixel: {
          shopDomain: "s.myshopify.com",
          pixelId: "px-1",
          registeredAt: new Date().toISOString(),
        },
      },
    });
    getIntegration.mockResolvedValue(connected);
    const sideEffects = sideEffectSpies();

    const result = await finalizeShopifyInstall({
      token: "tok",
      businessId: BUSINESS,
      sessionId: SESSION,
      sideEffects,
    });

    expect(result).toMatchObject({ ok: true, pixel: { status: "already_registered" } });
    expect(sideEffects.registerPixel).not.toHaveBeenCalled();
  });

  it("ignores a pixel marker carried in by the install context", async () => {
    installStore([
      installContext({
        metadata: {
          shopifyCustomerEventsPixel: { shopDomain: "s.myshopify.com", pixelId: "forged" },
        },
      }),
    ]);
    upsertIntegration.mockResolvedValueOnce(connected);
    getIntegration.mockResolvedValue(connected);
    const sideEffects = sideEffectSpies();

    await finalizeShopifyInstall({
      token: "tok",
      businessId: BUSINESS,
      sessionId: SESSION,
      sideEffects,
    });

    expect(sideEffects.registerPixel).toHaveBeenCalledTimes(1);
    const written = upsertIntegration.mock.calls[0]![0] as {
      metadata: Record<string, unknown>;
    };
    expect(written.metadata.shopifyCustomerEventsPixel).toBeUndefined();
  });
});
