import { createHash } from "node:crypto";
import type { IntegrationRow } from "@/lib/integrations";

/**
 * Nonsecret fingerprint of a provider connection generation.
 *
 * A discovery snapshot is evidence about the credential it was fetched with and
 * about nothing else. Without binding, a list captured under one user's token
 * stays "fresh" for its whole freshness window across a disconnect, a reconnect
 * by a different user, an account-owner change, or a credential rotation — and
 * would then authorise a selection under credentials that never saw those
 * accounts.
 *
 * The access token is HASHED, never stored or compared in the clear, so the
 * fingerprint is safe to persist beside the snapshot and safe to log. Rotating
 * the token changes it; so does disconnecting, reconnecting, or the provider
 * account behind the connection changing.
 *
 * Lives in its own module because both the snapshot writer and the selection
 * authorizer need it, and importing one from the other would be a cycle.
 */
export function computeProviderConnectionFingerprint(
  integration: Pick<
    IntegrationRow,
    | "id"
    | "provider"
    | "status"
    | "provider_account_id"
    | "access_token"
    | "connected_at"
    | "connection_generation"
  >,
): string {
  const token = integration.access_token ?? "";
  const tokenDigest = token
    ? createHash("sha256").update(token).digest("hex").slice(0, 32)
    : "none";
  return createHash("sha256")
    .update(
      [
        integration.provider,
        integration.id ?? "",
        integration.status ?? "",
        integration.provider_account_id ?? "",
        integration.connected_at ?? "",
        // The generation is what makes a RECONNECT visible. connected_at is
        // COALESCEd to the original value on reconnect, and an OAuth re-grant
        // often returns the same token bytes, so without this a
        // disconnect-reconnect cycle produced an identical fingerprint and a
        // snapshot captured under the old credential kept validating.
        String(integration.connection_generation ?? 1),
        tokenDigest,
      ].join(""),
    )
    .digest("hex");
}
