import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoIntegration } from "@/lib/demo-business";
import { getIntegrationMetadata } from "@/lib/integrations";
import {
  isProviderReportSyncJobInFlight,
  readLatestProviderReportSyncJob,
  type ProviderReportSyncJob,
} from "@/lib/provider-report-sync-evidence";

/**
 * The report type the Search Console warmer stamps on its own job rows.
 * `lib/sync/search-console-sync.ts` — `upsertSyncJob(..., "seo_overview", ...)`.
 */
export const SEARCH_CONSOLE_WARM_JOB_REPORT_TYPE = "seo_overview";

/**
 * The scope a Google connection must carry before Search Console can read.
 * Mirrors `SEARCH_CONSOLE_SCOPE` in `lib/search-console.ts`.
 */
export const SEARCH_CONSOLE_REQUIRED_GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";

export type SearchConsoleStatusState =
  /** No stored Search Console connection at all. */
  | "not_connected"
  /**
   * A stored connection that cannot be used: either the row itself is not
   * `connected`, or the `google` connection it borrows its credential from is
   * missing, disconnected or lacks the webmasters scope.
   */
  | "action_required"
  /** Connected, but nobody has chosen which site to read. */
  | "connected_no_site"
  /** Connected and assigned; nothing has landed and nothing is running. */
  | "awaiting_first_sync"
  /** Connected and assigned; a warm job is in flight and nothing has landed. */
  | "syncing"
  /** Connected and assigned; the last attempt failed or has stopped moving. */
  | "first_sync_stalled"
  /** A servable SEO overview snapshot exists. */
  | "ready";

export interface SearchConsoleStatusResponse {
  provider: "search_console";
  /** The stored connection is in `connected` status — the handshake landed. */
  connected: boolean;
  state: SearchConsoleStatusState;
  connectedAt: string | null;
  site: {
    url: string | null;
    type: "domain" | "url-prefix" | null;
  };
  /** A site is selected, so Search Console knows what it is importing. */
  siteReady: boolean;
  /**
   * Search Console runs on the `google` connection's credential, not its own.
   *
   * `resolveSearchConsoleContext` refuses unless a connected `google` row
   * carries the webmasters scope, so a Search Console card can be "connected"
   * and still unable to read a single row. Reporting the authority separately
   * is what lets the card say "Action required" instead of painting a bar for
   * an import that cannot start.
   */
  googleAuthority: {
    connected: boolean;
    hasSearchConsoleScope: boolean;
  };
  /**
   * The share of the first import's historical window that has landed, 0-100.
   *
   * **Always null, deliberately.** Search Console has no backfill queue to
   * observe: the warmer issues one Search Analytics query per window and either
   * stores that window's whole payload or stores nothing. The only observable
   * points are 0% and the moment the cache row exists — by which time
   * `snapshotReady` is true and the progress block is gone. Substituting a
   * count of landed cache types would put a number that is not a share of the
   * window under the design's "Backfill 28 days" caption. Typed `number | null`
   * so a real day-level source can fill it later without a shape change.
   */
  backfillPercent: number | null;
  /** An SEO overview cache row exists, so the app can serve SEO from storage. */
  snapshotReady: boolean;
  snapshotAt: string | null;
  latestSync: ProviderReportSyncJob | null;
  errorMessage: string | null;
}

function hasSearchConsoleScope(scopes: string | null | undefined): boolean {
  if (!scopes) return false;
  return scopes.split(/\s+/).includes(SEARCH_CONSOLE_REQUIRED_GOOGLE_SCOPE);
}

function readSelectedSite(
  metadata: Record<string, unknown> | null | undefined,
  providerAccountId: string | null,
): string | null {
  const candidates = [metadata?.siteUrl, providerAccountId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function siteTypeOf(siteUrl: string | null): "domain" | "url-prefix" | null {
  if (!siteUrl) return null;
  return siteUrl.startsWith("sc-domain:") ? "domain" : "url-prefix";
}

/**
 * When the SEO overview cache last landed, or null if it never has.
 *
 * `app/api/seo/overview/route.ts` reads exactly this row before it will call
 * Google, and `lib/sync/search-console-sync.ts` writes it, so its existence is
 * the honest answer to "has this source's snapshot landed".
 */
export async function readSearchConsoleSnapshotAnchorAt(
  businessId: string,
): Promise<string | null> {
  const readiness = await getDbSchemaReadiness({
    tables: ["seo_results_cache"],
  }).catch(() => null);
  if (!readiness?.ready) return null;

  const sql = getDb();
  const rows = (await sql`
    SELECT generated_at
    FROM seo_results_cache
    WHERE business_id = ${businessId}
      AND cache_type = 'overview'
    ORDER BY generated_at DESC
    LIMIT 1
  `) as unknown as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row?.generated_at) return null;
  const parsed = new Date(String(row.generated_at));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function disconnected(
  connectedAt: string | null,
  errorMessage: string | null,
  state: SearchConsoleStatusState,
  googleAuthority: SearchConsoleStatusResponse["googleAuthority"],
): SearchConsoleStatusResponse {
  return {
    provider: "search_console",
    connected: false,
    state,
    connectedAt,
    site: { url: null, type: null },
    siteReady: false,
    googleAuthority,
    backfillPercent: null,
    snapshotReady: false,
    snapshotAt: null,
    latestSync: null,
    errorMessage,
  };
}

/**
 * Search Console readiness, derived entirely from what the integration
 * persists. No provider call is made; see `getGoogleAnalyticsStatus` for why.
 */
export async function getSearchConsoleStatus(
  businessId: string,
  now: number = Date.now(),
): Promise<SearchConsoleStatusResponse> {
  if (await isDemoBusiness(businessId).catch(() => false)) {
    return getDemoSearchConsoleStatus();
  }

  const [integration, googleIntegration] = await Promise.all([
    getIntegrationMetadata(businessId, "search_console").catch(() => null),
    getIntegrationMetadata(businessId, "google").catch(() => null),
  ]);

  const googleAuthority = {
    connected: googleIntegration?.status === "connected",
    hasSearchConsoleScope: hasSearchConsoleScope(googleIntegration?.scopes),
  };

  if (!integration) {
    return disconnected(null, null, "not_connected", googleAuthority);
  }

  const connectedAt = integration.connected_at ?? null;
  const errorMessage = integration.error_message ?? null;
  if (integration.status !== "connected") {
    return disconnected(
      connectedAt,
      errorMessage,
      "action_required",
      googleAuthority,
    );
  }

  const metadata =
    integration.metadata && typeof integration.metadata === "object"
      ? (integration.metadata as Record<string, unknown>)
      : null;
  const siteUrl = readSelectedSite(
    metadata,
    integration.provider_account_id ?? null,
  );

  const [snapshotAt, latestSync] = await Promise.all([
    readSearchConsoleSnapshotAnchorAt(businessId).catch(() => null),
    readLatestProviderReportSyncJob({
      businessId,
      provider: "search_console",
      reportType: SEARCH_CONSOLE_WARM_JOB_REPORT_TYPE,
    }).catch(() => null),
  ]);

  const snapshotReady = snapshotAt !== null;
  const inFlight = isProviderReportSyncJobInFlight(latestSync, now);
  const authorityBroken =
    !googleAuthority.connected || !googleAuthority.hasSearchConsoleScope;

  // A broken Google authority IS live evidence — `resolveSearchConsoleContext`
  // refuses on exactly this — so it decides the state. `error_message` does
  // not: see the note in `lib/google-analytics-status.ts` for why a message on
  // a `connected` row is residue rather than a verdict.
  const state: SearchConsoleStatusState = authorityBroken
    ? "action_required"
    : snapshotReady
      ? "ready"
      : !siteUrl
        ? "connected_no_site"
        : inFlight
          ? "syncing"
          : latestSync && latestSync.status !== "done"
            ? "first_sync_stalled"
            : "awaiting_first_sync";

  return {
    provider: "search_console",
    connected: true,
    state,
    connectedAt,
    site: { url: siteUrl, type: siteTypeOf(siteUrl) },
    siteReady: Boolean(siteUrl),
    googleAuthority,
    backfillPercent: null,
    snapshotReady,
    snapshotAt,
    latestSync,
    errorMessage,
  };
}

/** The demo workspace serves SEO from fixtures; see the GA4 note. */
export function getDemoSearchConsoleStatus(): SearchConsoleStatusResponse {
  const integration = getDemoIntegration("search_console");
  const google = getDemoIntegration("google");
  const metadata =
    integration?.metadata && typeof integration.metadata === "object"
      ? (integration.metadata as Record<string, unknown>)
      : null;
  const siteUrl = readSelectedSite(
    metadata,
    integration?.provider_account_id ?? null,
  );
  const connected = integration?.status === "connected";
  return {
    provider: "search_console",
    connected,
    state: connected ? "ready" : "not_connected",
    connectedAt: integration?.connected_at ?? null,
    site: { url: siteUrl, type: siteTypeOf(siteUrl) },
    siteReady: Boolean(siteUrl),
    googleAuthority: {
      // The demo workspace answers from fixtures and never calls Google, so it
      // holds no OAuth principal and no scope string. Reporting the scope as
      // present would assert a credential that does not exist; the demo's
      // readiness comes from the fixtures serving, not from an authority.
      connected: google?.status === "connected",
      hasSearchConsoleScope: hasSearchConsoleScope(google?.scopes),
    },
    backfillPercent: null,
    snapshotReady: connected,
    snapshotAt: integration?.connected_at ?? null,
    latestSync: null,
    errorMessage: null,
  };
}
