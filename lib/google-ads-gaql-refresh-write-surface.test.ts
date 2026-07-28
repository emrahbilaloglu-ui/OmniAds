import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderConnectionDbHarness,
  seedConnectedGoogleStore,
  type ProviderConnectionDbHarness,
} from "@/lib/__tests__/provider-connection-db-harness";

/**
 * The claim under test, end to end: ONE authenticated GET must not rewrite the
 * provider connection.
 *
 * `executeGaqlQuery` is the read path behind roughly three dozen GET routes, and
 * it calls `resolveGoogleAccessTokenWithGeneration` on every invocation, BEFORE
 * its own cache check. With an hour-long access token that meant a page view
 * regularly performed a write that `upsertIntegration` classified as a reconnect
 * — moving `status`, `provider_account_id`, `updated_at`,
 * `connection_generation` and `disconnected_at`.
 *
 * The sibling suite in `lib/google-token-refresh.test.ts` exercises the write
 * path directly. This one drives it through the real GAQL entry point, with only
 * the peripheral services stubbed, so nothing between the route and the database
 * is taken on trust.
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

vi.mock("@/lib/provider-account-snapshots", async (importOriginal) => {
  // `readProviderConnectionGenerationToken` stays REAL — it is the read that
  // binds the token to a generation, and stubbing it would hollow out the CAS.
  const actual = await importOriginal<typeof import("@/lib/provider-account-snapshots")>();
  return { ...actual, readProviderAccountSnapshot: vi.fn(async () => null) };
});

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(async () => []),
}));

vi.mock("@/lib/provider-request-governance", () => ({
  runProviderRequestWithGovernance: vi.fn(
    async (input: { execute: () => Promise<unknown> }) => input.execute(),
  ),
}));

vi.mock("@/lib/google-request-audit", () => ({
  classifyGoogleRequestAuditSource: vi.fn(() => "ui"),
}));

vi.mock("@/lib/runtime-logging", () => ({ logRuntimeDebug: vi.fn() }));

// Only `upsertIntegration` needs these. Stubbed so that an implementation which
// reintroduces the reconnect write fails on the ASSERTIONS below — "the
// connection row moved" — instead of crashing inside an unmocked dependency.
vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) =>
    new Map(businessIds.map((id) => [id, `business-ref-${id}`] as const)),
  ),
}));

vi.mock("@/lib/business-timezone", () => ({
  recomputeBusinessDerivedTimezone: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/oauth/google-config", () => ({
  GOOGLE_CONFIG: {
    adsApiBase: "https://googleads.googleapis.com/v18",
    developerToken: "test-developer-token",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: "test-client",
    clientSecret: "test-secret",
  },
}));

const googleAdsAccounts = await import("@/lib/google-ads-accounts");
const secrets = await import("@/lib/integration-secrets");

const ORIGINAL_ACCESS_TOKEN = "ya29.original-access-token";
const ORIGINAL_REFRESH_TOKEN = "1//original-refresh-token";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "test-master-key");
  vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
  harness = createProviderConnectionDbHarness(
    seedConnectedGoogleStore({
      encryptedAccessToken: secrets.encryptIntegrationSecret(ORIGINAL_ACCESS_TOKEN)!,
      encryptedRefreshToken: secrets.encryptIntegrationSecret(ORIGINAL_REFRESH_TOKEN)!,
      tokenExpiresAt: "2026-07-01T09:59:00.000Z",
    }),
  );
});

describe("executeGaqlQuery on an expired token", () => {
  it("refreshes and queries without rewriting the provider connection", async () => {
    vi.mocked(googleAdsAccounts.refreshGoogleAccessToken).mockResolvedValue({
      accessToken: "ya29.refreshed-access-token",
      expiresIn: 3600,
    });
    const connectionBefore = { ...harness.store.provider_connections[0]! };
    const selectionsBefore = JSON.stringify(harness.store.business_provider_accounts);

    const authorizationHeaders: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        authorizationHeaders.push(
          (init.headers as Record<string, string> | undefined)?.Authorization,
        );
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ results: [{ campaign: { id: "1" } }] }),
        } as unknown as Response;
      }),
    );

    const { executeGaqlQuery } = await import("@/lib/google-ads-gaql");
    const result = await executeGaqlQuery({
      businessId: "biz_1",
      customerId: "1234567890",
      query: "SELECT campaign.id FROM campaign",
      queryName: "campaign_ids",
      source: "insights_page",
    });

    expect(result.results).toHaveLength(1);
    // The GET really did carry the refreshed token.
    expect(authorizationHeaders).toContain("Bearer ya29.refreshed-access-token");

    const connectionAfter = harness.store.provider_connections[0]!;
    const credentialAfter = harness.store.integration_credentials[0]!;

    expect(secrets.decryptIntegrationSecret(credentialAfter.access_token)).toBe(
      "ya29.refreshed-access-token",
    );
    expect(connectionAfter).toEqual(connectionBefore);
    expect(connectionAfter.status).toBe("connected");
    expect(connectionAfter.provider_account_id).toBe("1234567890");
    expect(connectionAfter.updated_at).toBe("2026-07-01T09:00:00.000Z");
    expect(connectionAfter.connection_generation).toBe(7);
    expect(connectionAfter.disconnected_at).toBeNull();
    expect(credentialAfter.refresh_token).toBe(
      harness.store.integration_credentials[0]!.refresh_token,
    );
    expect(secrets.decryptIntegrationSecret(credentialAfter.refresh_token)).toBe(
      ORIGINAL_REFRESH_TOKEN,
    );
    expect(JSON.stringify(harness.store.business_provider_accounts)).toBe(selectionsBefore);

    const writes = harness.queries.filter((query) =>
      /^\s*(INSERT|UPDATE|DELETE)\b/.test(query),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("UPDATE integration_credentials SET");
  });
});
