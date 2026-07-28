import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderConnectionDbHarness,
  seedConnectedGoogleStore,
  type ProviderConnectionDbHarness,
} from "@/lib/__tests__/provider-connection-db-harness";

/**
 * A Google access token lives about an hour, and `executeGaqlQuery` calls
 * `resolveGoogleAccessTokenWithGeneration` on EVERY invocation — before its own
 * cache check — across roughly three dozen GET routes. So this is the write that
 * one authenticated page view performs.
 *
 * It used to run through `upsertIntegration`, the connect/reconnect writer,
 * which cannot tell a refresh from a reconnect: supplying an access token sets
 * `replacesCredential` → `authorityChanged` → (with status "connected")
 * `isReconnect`. A GET therefore rewrote `provider_connections.status`,
 * `.provider_account_id`, `.updated_at` and `.connection_generation`, cleared
 * `.disconnected_at`, cleared `error_message`, and re-encrypted the UNCHANGED
 * refresh token under a fresh IV.
 *
 * Every assertion below therefore names the columns that must NOT move, not
 * just the one that must. An implementation that persists the token and keeps
 * widening the connection row passes a "did the token change" test.
 */

let harness: ProviderConnectionDbHarness;

vi.mock("@/lib/db", () => ({
  getDb: () => harness.sql,
  runDbTransaction: <T,>(fn: () => Promise<T>, options?: { timeoutMs?: number }) =>
    harness.runDbTransaction(fn, options),
}));

vi.mock("@/lib/google-ads-accounts", () => ({
  refreshGoogleAccessToken: vi.fn(),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) =>
    new Map(businessIds.map((id) => [id, `business-ref-${id}`] as const)),
  ),
}));

vi.mock("@/lib/business-timezone", () => ({
  recomputeBusinessDerivedTimezone: vi.fn().mockResolvedValue(undefined),
}));

const googleAdsAccounts = await import("@/lib/google-ads-accounts");
const secrets = await import("@/lib/integration-secrets");

const EXPIRED_AT = "2026-07-01T09:59:00.000Z";
const ORIGINAL_ACCESS_TOKEN = "ya29.original-access-token";
const ORIGINAL_REFRESH_TOKEN = "1//original-refresh-token";

function connectionRow() {
  return harness.store.provider_connections[0]!;
}
function credentialRow() {
  return harness.store.integration_credentials[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "test-master-key");
  vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
  harness = createProviderConnectionDbHarness(
    seedConnectedGoogleStore({
      encryptedAccessToken: secrets.encryptIntegrationSecret(ORIGINAL_ACCESS_TOKEN)!,
      encryptedRefreshToken: secrets.encryptIntegrationSecret(ORIGINAL_REFRESH_TOKEN)!,
      // Already expired at the mocked clock, so the read path refreshes.
      tokenExpiresAt: EXPIRED_AT,
    }),
  );
});

describe("a GET-path Google token refresh writes ONLY the credential", () => {
  it("persists the new access token and leaves the connection row byte-identical", async () => {
    vi.mocked(googleAdsAccounts.refreshGoogleAccessToken).mockResolvedValue({
      accessToken: "ya29.refreshed-access-token",
      expiresIn: 3600,
    });
    const connectionBefore = { ...connectionRow() };
    const credentialBefore = { ...credentialRow() };
    const selectionsBefore = JSON.stringify(harness.store.business_provider_accounts);
    const assignmentsBefore = JSON.stringify(harness.store.provider_account_assignments);

    const { resolveGoogleAccessTokenWithGeneration } = await import(
      "@/lib/google-token-refresh"
    );
    const result = await resolveGoogleAccessTokenWithGeneration({ businessId: "biz_1" });

    expect(result.refreshed).toBe(true);
    expect(result.accessToken).toBe("ya29.refreshed-access-token");

    // The one thing that must change.
    expect(secrets.decryptIntegrationSecret(credentialRow().access_token)).toBe(
      "ya29.refreshed-access-token",
    );
    expect(credentialRow().token_expires_at).toBe("2026-07-01T11:00:00.000Z");
    expect(credentialRow().updated_at).toBe("2026-07-01T10:00:00.000Z");

    // The connection row: every column, named. `toEqual` on the whole row is the
    // real assertion; the individual ones say out loud which regressions this is
    // for, so a failure reads as a diagnosis instead of a diff.
    expect(connectionRow()).toEqual(connectionBefore);
    expect(connectionRow().status).toBe("connected");
    expect(connectionRow().provider_account_id).toBe("1234567890");
    expect(connectionRow().provider_account_name).toBe("Grandmix");
    expect(connectionRow().updated_at).toBe("2026-07-01T09:00:00.000Z");
    expect(connectionRow().connection_generation).toBe(7);
    expect(connectionRow().disconnected_at).toBeNull();
    expect(connectionRow().connected_at).toBe("2026-01-01T00:00:00.000Z");

    // The credential columns that are NOT the refreshed token. The refresh token
    // ciphertext in particular: re-encrypting the same plaintext under a fresh
    // IV moved the at-rest value on every single refresh.
    expect(credentialRow().refresh_token).toBe(credentialBefore.refresh_token);
    expect(secrets.decryptIntegrationSecret(credentialRow().refresh_token)).toBe(
      ORIGINAL_REFRESH_TOKEN,
    );
    expect(credentialRow().scopes).toBe(credentialBefore.scopes);
    expect(credentialRow().error_message).toBeNull();
    expect(credentialRow().metadata).toEqual({ connectedVia: "oauth" });
    expect(credentialRow().created_at).toBe(credentialBefore.created_at);

    // Selections and assignments are a different subsystem entirely.
    expect(JSON.stringify(harness.store.business_provider_accounts)).toBe(selectionsBefore);
    expect(JSON.stringify(harness.store.provider_account_assignments)).toBe(assignmentsBefore);

    // Structural, not incidental: no statement in this path writes the
    // connection table at all. A future edit that reintroduces one fails here
    // even if it happens to write back identical values.
    const writes = harness.queries.filter((query) =>
      /^\s*(INSERT|UPDATE|DELETE)\b/.test(query),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("UPDATE integration_credentials SET");
    expect(harness.queries.join("\n")).not.toContain("INSERT INTO provider_connections");
    expect(harness.queries.join("\n")).not.toContain("UPDATE provider_connections");
  });

  it("keeps the token bound to the generation it was read under", async () => {
    vi.mocked(googleAdsAccounts.refreshGoogleAccessToken).mockResolvedValue({
      accessToken: "ya29.refreshed-access-token",
      expiresIn: 3600,
    });

    const { resolveGoogleAccessTokenWithGeneration } = await import(
      "@/lib/google-token-refresh"
    );
    const result = await resolveGoogleAccessTokenWithGeneration({ businessId: "biz_1" });

    // Unchanged, because the refresh no longer changes it. Callers such as
    // `lib/google-ads/advisor-mutate.ts` hand this straight to
    // `assertProviderWriteAuthorityUnchanged`, which re-reads the same
    // `generation:status` from the connection row — the two must agree.
    expect(result.connectionGeneration).toBe("7:connected");
    expect(`${connectionRow().connection_generation}:${connectionRow().status}`).toBe(
      "7:connected",
    );
  });

  it("does not write at all when the cached token is still valid", async () => {
    credentialRow().token_expires_at = "2026-07-01T11:30:00.000Z";
    const before = harness.snapshot();

    const { resolveGoogleAccessTokenWithGeneration } = await import(
      "@/lib/google-token-refresh"
    );
    const result = await resolveGoogleAccessTokenWithGeneration({ businessId: "biz_1" });

    expect(result.refreshed).toBe(false);
    expect(result.accessToken).toBe(ORIGINAL_ACCESS_TOKEN);
    expect(vi.mocked(googleAdsAccounts.refreshGoogleAccessToken)).not.toHaveBeenCalled();
    expect(harness.snapshot()).toBe(before);
  });
});

describe("a genuine reconnect still bumps the generation", () => {
  it("bumps and rewrites the connection when the provider account changes", async () => {
    const { upsertIntegration } = await import("@/lib/integrations");

    const updated = await upsertIntegration({
      businessId: "biz_1",
      provider: "google",
      status: "connected",
      providerAccountId: "9999999999",
      providerAccountName: "A different Google account",
      accessToken: "ya29.reconnected-access-token",
      refreshToken: "1//reconnected-refresh-token",
      tokenExpiresAt: new Date("2026-07-01T11:00:00.000Z"),
    });

    expect(connectionRow().connection_generation).toBe(8);
    expect(updated.connection_generation).toBe(8);
    expect(connectionRow().provider_account_id).toBe("9999999999");
    expect(connectionRow().provider_account_name).toBe("A different Google account");
    expect(connectionRow().updated_at).toBe("2026-07-01T10:00:00.000Z");
    expect(secrets.decryptIntegrationSecret(credentialRow().refresh_token)).toBe(
      "1//reconnected-refresh-token",
    );
  });

  it("bumps on a re-grant by the same principal, and clears a stale disconnect", async () => {
    connectionRow().status = "disconnected";
    connectionRow().disconnected_at = "2026-06-30T00:00:00.000Z";
    const { upsertIntegration } = await import("@/lib/integrations");

    await upsertIntegration({
      businessId: "biz_1",
      provider: "google",
      status: "connected",
      providerAccountId: "1234567890",
      accessToken: "ya29.regranted-access-token",
      refreshToken: "1//regranted-refresh-token",
      tokenExpiresAt: new Date("2026-07-01T11:00:00.000Z"),
    });

    expect(connectionRow().connection_generation).toBe(8);
    expect(connectionRow().status).toBe("connected");
    expect(connectionRow().disconnected_at).toBeNull();
  });

  it("bumps on a scope change", async () => {
    const { upsertIntegration } = await import("@/lib/integrations");

    await upsertIntegration({
      businessId: "biz_1",
      provider: "google",
      status: "connected",
      providerAccountId: "1234567890",
      scopes: "https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/webmasters.readonly",
    });

    expect(connectionRow().connection_generation).toBe(8);
  });

  it("refuses a refresh computed under a generation a reconnect has replaced", async () => {
    // The reconnect lands WHILE Google is minting the new access token — the
    // exact race the compare-and-set exists for. The refresh must lose: its
    // token descends from a grant the user has already replaced.
    const { upsertIntegration } = await import("@/lib/integrations");
    vi.mocked(googleAdsAccounts.refreshGoogleAccessToken).mockImplementation(async () => {
      await upsertIntegration({
        businessId: "biz_1",
        provider: "google",
        status: "connected",
        providerAccountId: "9999999999",
        accessToken: "ya29.reconnected-access-token",
        refreshToken: "1//reconnected-refresh-token",
        tokenExpiresAt: new Date("2026-07-01T11:00:00.000Z"),
      });
      return { accessToken: "ya29.stale-refresh-result", expiresIn: 3600 };
    });

    const { resolveGoogleAccessTokenWithGeneration } = await import(
      "@/lib/google-token-refresh"
    );
    const result = await resolveGoogleAccessTokenWithGeneration({ businessId: "biz_1" });

    expect(result.refreshed).toBe(false);
    expect(result.accessToken).toBe("ya29.reconnected-access-token");
    expect(result.connectionGeneration).toBe("8:connected");
    expect(secrets.decryptIntegrationSecret(credentialRow().access_token)).toBe(
      "ya29.reconnected-access-token",
    );
    expect(connectionRow().connection_generation).toBe(8);
  });
});

describe("a failed refresh writes nothing", () => {
  it("leaves both tables untouched when the provider call fails", async () => {
    const before = harness.snapshot();
    vi.mocked(googleAdsAccounts.refreshGoogleAccessToken).mockRejectedValue(
      new Error("invalid_grant"),
    );

    const { resolveGoogleAccessTokenWithGeneration } = await import(
      "@/lib/google-token-refresh"
    );
    await expect(
      resolveGoogleAccessTokenWithGeneration({ businessId: "biz_1" }),
    ).rejects.toThrow("invalid_grant");

    expect(harness.snapshot()).toBe(before);
  });

  it("rolls back rather than half-writing when the credential update fails", async () => {
    const before = harness.snapshot();
    vi.mocked(googleAdsAccounts.refreshGoogleAccessToken).mockResolvedValue({
      accessToken: "ya29.refreshed-access-token",
      expiresIn: 3600,
    });
    harness.failNextCredentialUpdate("deadlock detected");

    const { resolveGoogleAccessTokenWithGeneration } = await import(
      "@/lib/google-token-refresh"
    );
    await expect(
      resolveGoogleAccessTokenWithGeneration({ businessId: "biz_1" }),
    ).rejects.toThrow("deadlock detected");

    expect(harness.snapshot()).toBe(before);
    expect(secrets.decryptIntegrationSecret(credentialRow().access_token)).toBe(
      ORIGINAL_ACCESS_TOKEN,
    );
    expect(connectionRow().connection_generation).toBe(7);
    expect(connectionRow().updated_at).toBe("2026-07-01T09:00:00.000Z");
  });

  it("refuses to resurrect a credential row that disconnect removed", async () => {
    // An INSERT ... ON CONFLICT here would CREATE a credential for a connection
    // that has none, putting a live token behind a row the user was told is
    // disconnected. There is nothing to refresh, and that is an error.
    harness.store.integration_credentials.length = 0;
    const { refreshIntegrationCredentialTokens } = await import("@/lib/integrations");

    await expect(
      refreshIntegrationCredentialTokens({
        businessId: "biz_1",
        provider: "google",
        accessToken: "ya29.refreshed-access-token",
        tokenExpiresAt: new Date("2026-07-01T11:00:00.000Z"),
        expectedConnectionGeneration: "7:connected",
      }),
    ).rejects.toThrow(/No google credential row to refresh/);

    expect(harness.store.integration_credentials).toHaveLength(0);
  });

  it("refuses a write that names no generation, without calling it a conflict", async () => {
    // A conflict is caught by callers and treated as "someone reconnected", so
    // reporting a missing binding as one would silently tolerate a caller that
    // simply forgot to pass it.
    const { refreshIntegrationCredentialTokens, ProviderConnectionGenerationConflictError } =
      await import("@/lib/integrations");
    const before = harness.snapshot();

    const error = await refreshIntegrationCredentialTokens({
      businessId: "biz_1",
      provider: "google",
      accessToken: "ya29.refreshed-access-token",
      tokenExpiresAt: new Date("2026-07-01T11:00:00.000Z"),
      expectedConnectionGeneration: "   ",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderConnectionGenerationConflictError);
    expect(harness.snapshot()).toBe(before);
  });
});

describe("concurrent refreshes", () => {
  it("serialise on the connection lock without corrupting or double-bumping", async () => {
    // Both callers read generation 7 and call Google before either writes. Under
    // the old path the first write bumped to 8 and the second lost its
    // compare-and-set; here both are legitimate writes of the same credential
    // under the same unchanged authority.
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let inFlight = 0;
    const minted = ["ya29.refreshed-a", "ya29.refreshed-b"];
    vi.mocked(googleAdsAccounts.refreshGoogleAccessToken).mockImplementation(async () => {
      const accessToken = minted[inFlight++]!;
      if (inFlight === 2) releaseBarrier();
      await barrier;
      return { accessToken, expiresIn: 3600 };
    });

    const { resolveGoogleAccessTokenWithGeneration } = await import(
      "@/lib/google-token-refresh"
    );
    const results = await Promise.all([
      resolveGoogleAccessTokenWithGeneration({ businessId: "biz_1", forceRefresh: true }),
      resolveGoogleAccessTokenWithGeneration({ businessId: "biz_1", forceRefresh: true }),
    ]);

    expect(results.map((result) => result.refreshed)).toEqual([true, true]);
    expect(results.map((result) => result.connectionGeneration)).toEqual([
      "7:connected",
      "7:connected",
    ]);

    expect(connectionRow().connection_generation).toBe(7);
    expect(connectionRow().updated_at).toBe("2026-07-01T09:00:00.000Z");
    expect(connectionRow().status).toBe("connected");
    expect(connectionRow().provider_account_id).toBe("1234567890");

    // Exactly one of the two tokens, whole. Not a mix, not the pre-refresh one.
    expect(harness.store.integration_credentials).toHaveLength(1);
    expect(minted).toContain(
      secrets.decryptIntegrationSecret(credentialRow().access_token),
    );
    expect(secrets.decryptIntegrationSecret(credentialRow().refresh_token)).toBe(
      ORIGINAL_REFRESH_TOKEN,
    );
  });

  it("blocks a reconnect on the connection lock, and the reconnect wins after", async () => {
    // The harsher ordering: the refresh has already passed its compare-and-set
    // and is holding the connection lock when the user reconnects. The reconnect
    // must WAIT — a refresh that never took the lock would let the two interleave
    // and leave one grant's access token beside the other's refresh token.
    vi.mocked(googleAdsAccounts.refreshGoogleAccessToken).mockResolvedValue({
      accessToken: "ya29.stale-refresh-result",
      expiresIn: 3600,
    });
    const { upsertIntegration } = await import("@/lib/integrations");
    const { resolveGoogleAccessTokenWithGeneration } = await import(
      "@/lib/google-token-refresh"
    );

    let signalRefreshHoldsLock!: () => void;
    const refreshHoldsLock = new Promise<void>((resolve) => {
      signalRefreshHoldsLock = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshMayProceed = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    harness.setBeforeCredentialUpdateHook(async () => {
      signalRefreshHoldsLock();
      await refreshMayProceed;
    });

    const refreshPromise = resolveGoogleAccessTokenWithGeneration({ businessId: "biz_1" });
    await refreshHoldsLock;

    // Started from the test body, so it opens its OWN transaction rather than
    // joining the refresh's async context.
    let reconnectSettled = false;
    const reconnectPromise = upsertIntegration({
      businessId: "biz_1",
      provider: "google",
      status: "connected",
      providerAccountId: "9999999999",
      accessToken: "ya29.reconnected-access-token",
      refreshToken: "1//reconnected-refresh-token",
      tokenExpiresAt: new Date("2026-07-01T11:00:00.000Z"),
    });
    void reconnectPromise.then(() => {
      reconnectSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(reconnectSettled).toBe(false);
    expect(connectionRow().connection_generation).toBe(7);

    releaseRefresh();
    const refreshResult = await refreshPromise;
    await reconnectPromise;

    expect(refreshResult.refreshed).toBe(true);
    // The reconnect is the newer grant: it owns the connection afterwards, and
    // both halves of the credential come from it.
    expect(connectionRow().connection_generation).toBe(8);
    expect(connectionRow().provider_account_id).toBe("9999999999");
    expect(secrets.decryptIntegrationSecret(credentialRow().access_token)).toBe(
      "ya29.reconnected-access-token",
    );
    expect(secrets.decryptIntegrationSecret(credentialRow().refresh_token)).toBe(
      "1//reconnected-refresh-token",
    );
  });
});
