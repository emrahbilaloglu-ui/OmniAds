/**
 * Whether a provider can actually serve a read — the *effective* capability,
 * not the connection row.
 *
 * A stored `connected` row is not a capability, and on two providers the gap is
 * routinely visible in production:
 *
 *  - **Search Console** borrows the `google` connection's credential.
 *    `resolveSearchConsoleContext` (lib/search-console.ts) refuses unless the
 *    `search_console` row is connected *and* a connected `google` row carries
 *    the webmasters scope *and* a site has been chosen. A workspace can — and
 *    one does — hold `search_console: connected` beside `google: disconnected`,
 *    where every Search Console read fails 401.
 *  - **GA4** refuses without a selected property.
 *    `resolveGa4AnalyticsContext` (lib/google-analytics-reporting.ts) throws
 *    `no_property_selected` when `metadata.ga4PropertyId` is absent, and the
 *    GA4 OAuth callback stores the Google *user* id in `provider_account_id`
 *    at handshake time — so "an account id exists" is not "a property was
 *    chosen".
 *
 * Both facts live outside the row a status chip naturally reads, which is how
 * a header came to say "connected" over a body that says "reconnect".
 *
 * Pure and dependency-free on purpose: the client store, the Insights header
 * and the Integrations cards all resolve the same predicate here rather than
 * each re-deriving it from whatever it happens to hold.
 */

/**
 * The scope a `google` connection must carry before Search Console can read.
 * The single definition; `lib/search-console.ts` (the gate) and
 * `lib/search-console-status.ts` (the server-side status view) both import it.
 */
export const SEARCH_CONSOLE_REQUIRED_GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";

/**
 * The facts a capability decision needs, as the client store holds them.
 *
 * `status` is the stored connection status, already narrowed by the store to
 * `connected` / `expired` / `error` / `disconnected`.
 */
export interface ProviderConnectionFacts {
  status: string;
  /** The granted OAuth scope string, space-separated, as the provider returned it. */
  scopes?: string | null;
  /** The provider entity the read gate requires: GA4 property, Search Console site. */
  selectedEntityId?: string | null;
}

/** Why a provider cannot serve a read. Each names the operator's next action. */
export type ProviderReadBlock =
  /** No usable stored connection for the provider itself. */
  | "not_connected"
  /** A stored connection that expired or errored: re-authorize this provider. */
  | "connection_fault"
  /** Search Console only: the `google` credential it borrows is missing or unscoped. */
  | "google_reconnect_required"
  /** GA4 only: connected, but nobody has chosen a property. */
  | "property_not_selected"
  /** Search Console only: connected, but nobody has chosen a site. */
  | "site_not_selected";

export interface ProviderReadCapability {
  /** True only when every gate the read itself applies would pass. */
  canRead: boolean;
  block: ProviderReadBlock | null;
}

const CAN_READ: ProviderReadCapability = { canRead: true, block: null };

function blocked(block: ProviderReadBlock): ProviderReadCapability {
  return { canRead: false, block };
}

export function hasSearchConsoleScope(scopes: string | null | undefined): boolean {
  if (!scopes) return false;
  return scopes.split(/\s+/).includes(SEARCH_CONSOLE_REQUIRED_GOOGLE_SCOPE);
}

/**
 * The row's own health, before any provider-specific requirement.
 * Returns `null` when the row itself is fine.
 */
function connectionBlock(
  facts: ProviderConnectionFacts | undefined,
): ProviderReadBlock | null {
  if (!facts) return "not_connected";
  if (facts.status === "expired" || facts.status === "error") {
    return "connection_fault";
  }
  return facts.status === "connected" ? null : "not_connected";
}

/**
 * The entity id the read gate would find, given a manifest row.
 *
 * GA4 deliberately does **not** fall back to `provider_account_id`: the OAuth
 * callback writes the Google user id there before a property exists, and
 * `resolveGa4AnalyticsContext` reads `metadata.ga4PropertyId` and nothing else.
 * Search Console does fall back, because its gate does
 * (`parseMetadataSite(metadata) ?? integration.provider_account_id`).
 */
export function readSelectedEntityId(
  provider: string,
  row: {
    metadata?: Record<string, unknown> | null;
    provider_account_id?: string | null;
  },
): string | null {
  const metadata = row.metadata ?? undefined;
  if (provider === "ga4") {
    const propertyId = metadata?.ga4PropertyId;
    return typeof propertyId === "string" && propertyId.trim()
      ? propertyId.trim()
      : null;
  }
  if (provider === "search_console") {
    const siteUrl = metadata?.siteUrl;
    if (typeof siteUrl === "string" && siteUrl.trim()) return siteUrl.trim();
    const accountId = row.provider_account_id;
    return typeof accountId === "string" && accountId.trim()
      ? accountId.trim()
      : null;
  }
  return null;
}

/** Mirrors `resolveGa4AnalyticsContext`'s refusals, in its own order. */
export function resolveGa4ReadCapability(
  ga4: ProviderConnectionFacts | undefined,
): ProviderReadCapability {
  const rowBlock = connectionBlock(ga4);
  if (rowBlock) return blocked(rowBlock);
  if (!ga4?.selectedEntityId) return blocked("property_not_selected");
  return CAN_READ;
}

/** Mirrors `resolveSearchConsoleContext`'s refusals, in its own order. */
export function resolveSearchConsoleReadCapability(
  searchConsole: ProviderConnectionFacts | undefined,
  google: ProviderConnectionFacts | undefined,
): ProviderReadCapability {
  const rowBlock = connectionBlock(searchConsole);
  if (rowBlock) return blocked(rowBlock);
  // The gate checks the borrowed credential before it checks the site, and a
  // site selection cannot be made without it, so the order is load-bearing.
  if (connectionBlock(google) || !hasSearchConsoleScope(google?.scopes)) {
    return blocked("google_reconnect_required");
  }
  if (!searchConsole?.selectedEntityId) return blocked("site_not_selected");
  return CAN_READ;
}
