import type { IntegrationRow } from "@/lib/integrations";

/**
 * Shared authority for the two provider property-selection writers: GA4
 * property selection and Search Console site selection. Both validate a caller's
 * choice against a live provider listing and then write the result onto the
 * canonical connection, so both have the same window to defend.
 */

/**
 * The `connection_generation:status` token for a connection, taken from an
 * integration row the caller already read rather than from a query of its own.
 *
 * `readProviderConnectionGenerationToken` issues a fresh query, and a selection
 * route that called it AFTER its provider round trip captured the generation the
 * reconnect had just produced rather than the one its evidence was gathered
 * under. The compare-and-set inside `upsertIntegration` then matched and the
 * stale selection committed — the precise failure the compare-and-set exists to
 * stop. Deriving the token from the row that produced the credential closes that
 * window, and removes a second query whose failure previously degraded to `null`
 * and left the write with no compare-and-set at all.
 *
 * The format must stay byte-identical to the token `upsertIntegration` compares
 * against, which joins `connection_generation::text` to the connection status.
 * `?? 1` is the recorded meaning of a connection that has never been
 * re-established, which is how rows predating the column read.
 */
export function connectionGenerationTokenFromIntegration(
  integration:
    | Pick<IntegrationRow, "status" | "connection_generation">
    | null
    | undefined,
): string | null {
  if (!integration) return null;
  return `${integration.connection_generation ?? 1}:${integration.status}`;
}
