import { refreshGoogleAccessToken } from "@/lib/google-ads-accounts";
import {
  getIntegration,
  refreshIntegrationCredentialTokens,
  ProviderConnectionGenerationConflictError,
  type IntegrationProviderType,
} from "@/lib/integrations";
import { readProviderConnectionGenerationToken } from "@/lib/provider-account-snapshots";

/**
 * Read a usable Google access token, refreshing it if needed, bound to exactly
 * one connection generation.
 *
 * Four call sites did this by hand and each got it wrong in the same two ways.
 *
 * First, the write-back. `upsertIntegration` was called with no expected
 * generation, so a refresh that started before an OAuth reconnect and finished
 * after it overwrote the freshly granted credential with a token minted from the
 * OLD refresh token. The user reconnects, the page still works for a minute,
 * and then everything fails with an invalid_grant nobody can trace.
 *
 * Second, the transaction. In the discovery path the write-back happened inside
 * the snapshot refresh's transaction, so a later failure in that transaction
 * rolled back a token update that had genuinely succeeded — the provider had
 * already invalidated the previous access token, and the database no longer knew
 * the new one.
 *
 * This resolves both: the generation is captured with the credential, the
 * write-back is CAS'd against it, and a conflict is not an error — it means
 * someone reconnected, so the newer credential wins and is returned.
 */
export async function resolveGoogleAccessTokenWithGeneration(input: {
  businessId: string;
  provider?: IntegrationProviderType;
  /** Refresh even if the recorded expiry has not passed yet. */
  forceRefresh?: boolean;
}): Promise<{
  accessToken: string;
  /** The `generation:status` token this access token belongs to. */
  connectionGeneration: string | null;
  refreshed: boolean;
  scopes: string | null;
}> {
  const provider = input.provider ?? "google";

  // Generation, credential, generation. Requiring the two generation reads to
  // agree is what makes "this token belongs to this generation" a fact rather
  // than an assumption: a reconnect landing between them is visible here.
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
    // Re-read once under the settled generation rather than guessing which half
    // of the pair the credential came from.
    return resolveGoogleAccessTokenWithGeneration({ ...input, provider });
  }

  if (!integration?.access_token) {
    throw new Error(`${provider} integration not found or not connected.`);
  }

  const expiresAt = integration.token_expires_at
    ? new Date(integration.token_expires_at).getTime()
    : null;
  const expired = expiresAt != null && Number.isFinite(expiresAt) && Date.now() >= expiresAt;
  if (!input.forceRefresh && !expired) {
    return {
      accessToken: integration.access_token,
      // Derived from the integration row the token came from, which the paired
      // generation reads above have already proven settled.
      connectionGeneration: `${integration.connection_generation ?? 1}:${integration.status}`,
      refreshed: false,
      scopes: integration.scopes ?? null,
    };
  }
  if (!integration.refresh_token) {
    throw new Error(
      `The ${provider} access token has expired and no refresh token is available. Please reconnect.`,
    );
  }
  // Only reachable if the connection vanished between the paired reads above and
  // now. There is no generation to bind a write-back to, so there is no safe
  // write to make — refuse rather than persist a token under no authority.
  if (generationAfter == null) {
    throw new Error(
      `The ${provider} connection disappeared while its token was being refreshed. Please reconnect.`,
    );
  }

  const refreshed = await refreshGoogleAccessToken(integration.refresh_token);
  try {
    // The NARROW credential write path, not `upsertIntegration`.
    //
    // `upsertIntegration` is the connect/reconnect writer, and it has no way to
    // tell a refresh apart from a reconnect: supplying an access token makes it
    // `authorityChanged`, and `authorityChanged` with status "connected" makes
    // it `isReconnect`. Every hourly refresh therefore rewrote the CONNECTION —
    // status, provider_account_id, updated_at, connection_generation,
    // disconnected_at — from an ordinary authenticated GET, because
    // `executeGaqlQuery` and `resolveSearchConsoleContext` call this on the read
    // path. The credential is the only thing a refresh actually changes, so it
    // is the only thing written here.
    //
    // The generation CAS survives unchanged: it is still checked under the
    // connection row lock, so a refresh that started before an OAuth reconnect
    // and finished after it is still refused rather than overwriting the
    // freshly granted credential.
    const updated = await refreshIntegrationCredentialTokens({
      businessId: input.businessId,
      provider,
      accessToken: refreshed.accessToken,
      // Deliberately not re-supplying the refresh token. It did not change, and
      // `encryptIntegrationSecret` uses a fresh IV per call, so writing it back
      // moved the stored ciphertext on every refresh for no reason at all.
      tokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      expectedConnectionGeneration: generationAfter,
    });
    return {
      accessToken: refreshed.accessToken,
      // The generation this write COMMITTED under, observed under the same row
      // lock. A separate read after the write reopens the exact window this
      // helper exists to close: a reconnect landing in between would pair the
      // token we just minted with the generation that replaced it. A refresh no
      // longer CHANGES this value — that is the point — so it is the same
      // generation the credential was read under.
      connectionGeneration: updated.connectionGeneration,
      refreshed: true,
      scopes: updated.scopes ?? integration.scopes ?? null,
    };
  } catch (error: unknown) {
    if (!(error instanceof ProviderConnectionGenerationConflictError)) throw error;
    // Someone reconnected while this refresh was in flight. The newer grant is
    // the truth; the token this refresh just minted describes a credential the
    // user has already replaced, and writing it would undo their reconnect.
    const current = await getIntegration(input.businessId, provider);
    if (!current?.access_token) {
      throw new Error(
        `The ${provider} connection changed while its token was being refreshed and is no longer usable. Please reconnect.`,
      );
    }
    return {
      accessToken: current.access_token,
      // Same rule on the conflict path: the generation comes from the row the
      // token was read out of, not from a later read.
      connectionGeneration: `${current.connection_generation ?? 1}:${current.status}`,
      refreshed: false,
      scopes: current.scopes ?? null,
    };
  }
}
