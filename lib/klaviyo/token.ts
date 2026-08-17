import {
  getIntegration,
  refreshIntegrationCredentialTokens,
  ProviderConnectionGenerationConflictError,
} from "@/lib/integrations";
import { KlaviyoApiError, refreshKlaviyoAccessToken } from "@/lib/klaviyo/api";
import { readProviderConnectionGenerationToken } from "@/lib/provider-account-snapshots";

/**
 * Read a usable Klaviyo access token, refreshing it if needed, bound to exactly
 * one connection generation.
 *
 * This is `lib/google-token-refresh.ts` with one Klaviyo-specific difference,
 * and the difference matters: Klaviyo ROTATES the refresh token on every grant.
 * The Google path deliberately omits `rotatedRefreshToken` because Google's
 * refresh token does not change and re-encrypting it would move the ciphertext
 * for nothing. Here the returned refresh token is genuinely new, so it MUST be
 * persisted — dropping it would strand the connection at the next refresh, an
 * hour later, with an invalid_grant nobody could trace.
 *
 * Everything else is the same shared credential store: no second table, no
 * second refresh path, and the compare-and-set against
 * `connection_generation` so a refresh that started before a reconnect cannot
 * overwrite the credential the reconnect just granted.
 */
export async function resolveKlaviyoAccessToken(input: {
  businessId: string;
  /** Refresh even if the recorded expiry has not passed yet. */
  forceRefresh?: boolean;
}): Promise<{
  accessToken: string;
  connectionGeneration: string | null;
  refreshed: boolean;
  scopes: string | null;
}> {
  const provider = "klaviyo" as const;

  // Generation, credential, generation — the same paired read the Google helper
  // uses, so "this token belongs to this generation" is observed rather than
  // assumed.
  const generationBefore = await readProviderConnectionGenerationToken(
    input.businessId,
    provider,
  );
  const integration = await getIntegration(input.businessId, provider);
  const generationAfter = await readProviderConnectionGenerationToken(
    input.businessId,
    provider,
  );
  if (generationBefore !== generationAfter) {
    return resolveKlaviyoAccessToken(input);
  }

  if (!integration || integration.status !== "connected") {
    throw new KlaviyoApiError(
      "klaviyo_not_connected",
      "Klaviyo is not connected for this business.",
      404,
    );
  }
  if (!integration.access_token) {
    throw new KlaviyoApiError(
      "klaviyo_reconnect_required",
      "The Klaviyo connection has no access token. Please reconnect.",
      401,
    );
  }

  const expiresAt = integration.token_expires_at
    ? new Date(integration.token_expires_at).getTime()
    : null;
  const expired =
    expiresAt != null && Number.isFinite(expiresAt) && Date.now() >= expiresAt;

  if (!input.forceRefresh && !expired) {
    return {
      accessToken: integration.access_token,
      connectionGeneration: `${integration.connection_generation ?? 1}:${integration.status}`,
      refreshed: false,
      scopes: integration.scopes ?? null,
    };
  }

  if (!integration.refresh_token) {
    throw new KlaviyoApiError(
      "klaviyo_reconnect_required",
      "The Klaviyo access token has expired and no refresh token is available. Please reconnect.",
      401,
    );
  }
  if (generationAfter == null) {
    throw new KlaviyoApiError(
      "klaviyo_reconnect_required",
      "The Klaviyo connection disappeared while its token was being refreshed. Please reconnect.",
      401,
    );
  }

  const refreshed = await refreshKlaviyoAccessToken(integration.refresh_token);
  try {
    const updated = await refreshIntegrationCredentialTokens({
      businessId: input.businessId,
      provider,
      accessToken: refreshed.accessToken,
      // Supplied, unlike the Google path: Klaviyo hands back a DIFFERENT
      // refresh token and invalidates the old one.
      rotatedRefreshToken: refreshed.refreshToken,
      tokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      expectedConnectionGeneration: generationAfter,
    });
    return {
      accessToken: refreshed.accessToken,
      connectionGeneration: updated.connectionGeneration,
      refreshed: true,
      scopes: updated.scopes ?? integration.scopes ?? null,
    };
  } catch (error: unknown) {
    if (!(error instanceof ProviderConnectionGenerationConflictError)) throw error;
    // Someone reconnected while this refresh was in flight. The newer grant is
    // the truth and this token describes a credential the user already replaced.
    const current = await getIntegration(input.businessId, provider);
    if (!current?.access_token) {
      throw new KlaviyoApiError(
        "klaviyo_reconnect_required",
        "The Klaviyo connection changed while its token was being refreshed and is no longer usable. Please reconnect.",
        401,
      );
    }
    return {
      accessToken: current.access_token,
      connectionGeneration: `${current.connection_generation ?? 1}:${current.status}`,
      refreshed: false,
      scopes: current.scopes ?? null,
    };
  }
}
