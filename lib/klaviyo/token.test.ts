import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Klaviyo credential handling.
 *
 * It reuses this repo's ONE provider credential store — `provider_connections`
 * + `integration_credentials` through `refreshIntegrationCredentialTokens` —
 * rather than introducing a second. Two Klaviyo-specific properties are pinned:
 *
 *   - Klaviyo ROTATES the refresh token on every grant, so the new one must be
 *     persisted. The Google path deliberately omits it because Google's does
 *     not change; copying that omission here would strand the connection an
 *     hour later with an untraceable invalid_grant.
 *   - The compare-and-set against `connection_generation` is preserved, so a
 *     refresh in flight during a reconnect loses to the reconnect.
 */

class MockGenerationConflictError extends Error {
  constructor() {
    super("connection generation conflict");
    this.name = "ProviderConnectionGenerationConflictError";
  }
}

const getIntegration = vi.fn();
const refreshIntegrationCredentialTokens = vi.fn();
const readProviderConnectionGenerationToken = vi.fn();
const refreshKlaviyoAccessToken = vi.fn();

vi.mock("@/lib/integrations", () => ({
  getIntegration,
  refreshIntegrationCredentialTokens,
  ProviderConnectionGenerationConflictError: MockGenerationConflictError,
}));
vi.mock("@/lib/provider-account-snapshots", () => ({
  readProviderConnectionGenerationToken,
}));
vi.mock("@/lib/klaviyo/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, refreshKlaviyoAccessToken };
});

const { resolveKlaviyoAccessToken } = await import("@/lib/klaviyo/token");
const { KlaviyoApiError } = await import("@/lib/klaviyo/api");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const HOUR = 60 * 60 * 1000;

function connection(overrides: Record<string, unknown> = {}) {
  return {
    status: "connected",
    access_token: "stored-access",
    refresh_token: "stored-refresh",
    token_expires_at: new Date(Date.now() + HOUR).toISOString(),
    connection_generation: 4,
    scopes: "accounts:read flows:read metrics:read",
    ...overrides,
  };
}

describe("resolveKlaviyoAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readProviderConnectionGenerationToken.mockResolvedValue("4:connected");
    getIntegration.mockResolvedValue(connection());
    refreshKlaviyoAccessToken.mockResolvedValue({
      accessToken: "fresh-access",
      refreshToken: "rotated-refresh",
      expiresIn: 3600,
      scope: "accounts:read flows:read metrics:read",
    });
    refreshIntegrationCredentialTokens.mockResolvedValue({
      connectionGeneration: "4:connected",
      scopes: "accounts:read flows:read metrics:read",
      tokenExpiresAt: new Date(Date.now() + HOUR).toISOString(),
      refreshTokenRotated: true,
    });
  });

  it("uses the stored token while it is still valid and calls the provider not at all", async () => {
    const result = await resolveKlaviyoAccessToken({ businessId: BUSINESS_ID });
    expect(result).toMatchObject({
      accessToken: "stored-access",
      refreshed: false,
      connectionGeneration: "4:connected",
    });
    expect(refreshKlaviyoAccessToken).not.toHaveBeenCalled();
  });

  it("persists the ROTATED refresh token when Klaviyo issues a new one", async () => {
    getIntegration.mockResolvedValue(
      connection({ token_expires_at: new Date(Date.now() - 1).toISOString() }),
    );

    const result = await resolveKlaviyoAccessToken({ businessId: BUSINESS_ID });

    expect(result.accessToken).toBe("fresh-access");
    expect(result.refreshed).toBe(true);
    expect(refreshIntegrationCredentialTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        provider: "klaviyo",
        accessToken: "fresh-access",
        rotatedRefreshToken: "rotated-refresh",
        expectedConnectionGeneration: "4:connected",
      }),
    );
  });

  it("writes through the shared credential store and never a Klaviyo-only one", async () => {
    getIntegration.mockResolvedValue(
      connection({ token_expires_at: new Date(Date.now() - 1).toISOString() }),
    );
    await resolveKlaviyoAccessToken({ businessId: BUSINESS_ID });
    expect(refreshIntegrationCredentialTokens).toHaveBeenCalledTimes(1);
  });

  it("loses to a reconnect that landed mid-refresh and returns the newer credential", async () => {
    getIntegration
      .mockResolvedValueOnce(
        connection({ token_expires_at: new Date(Date.now() - 1).toISOString() }),
      )
      .mockResolvedValueOnce(
        connection({ access_token: "newer-access", connection_generation: 5 }),
      );
    refreshIntegrationCredentialTokens.mockRejectedValue(
      new MockGenerationConflictError(),
    );

    const result = await resolveKlaviyoAccessToken({ businessId: BUSINESS_ID });
    expect(result).toMatchObject({
      accessToken: "newer-access",
      refreshed: false,
      connectionGeneration: "5:connected",
    });
  });

  it("refuses when the connection is not connected", async () => {
    getIntegration.mockResolvedValue(connection({ status: "disconnected" }));
    await expect(
      resolveKlaviyoAccessToken({ businessId: BUSINESS_ID }),
    ).rejects.toBeInstanceOf(KlaviyoApiError);
  });

  it("refuses an expired token with no refresh token instead of guessing", async () => {
    getIntegration.mockResolvedValue(
      connection({
        token_expires_at: new Date(Date.now() - 1).toISOString(),
        refresh_token: null,
      }),
    );
    await expect(
      resolveKlaviyoAccessToken({ businessId: BUSINESS_ID }),
    ).rejects.toThrow(/reconnect/i);
    expect(refreshKlaviyoAccessToken).not.toHaveBeenCalled();
  });

  it("re-reads once when the generation moved between the paired reads", async () => {
    readProviderConnectionGenerationToken
      .mockResolvedValueOnce("4:connected")
      .mockResolvedValueOnce("5:connected")
      .mockResolvedValue("5:connected");
    getIntegration
      .mockResolvedValueOnce(connection())
      .mockResolvedValue(connection({ connection_generation: 5 }));

    const result = await resolveKlaviyoAccessToken({ businessId: BUSINESS_ID });
    expect(result.connectionGeneration).toBe("5:connected");
  });
});
