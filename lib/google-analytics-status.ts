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
 * The report type the GA4 warmer stamps on its own job rows.
 * `lib/sync/ga4-sync.ts` — `const REPORT_TYPE = "ga4_overview"`.
 */
export const GA4_WARM_JOB_REPORT_TYPE = "ga4_overview";

/**
 * The durable snapshot that makes GA4 servable without a live provider call.
 *
 * `lib/sync/ga4-sync.ts` warms it through `warmGa4UserFacingRouteReportCache`,
 * and `app/api/analytics/overview/route.ts` reads exactly this
 * `provider='ga4' / report_type='ga4_analytics_overview'` row before it will
 * consider calling Google. Its existence is therefore the honest answer to "has
 * this source's snapshot landed".
 */
export const GA4_SNAPSHOT_ANCHOR_REPORT_TYPE = "ga4_analytics_overview";

export type GoogleAnalyticsStatusState =
  /** No stored GA4 connection at all. */
  | "not_connected"
  /** A stored connection that cannot be used until someone re-authorizes it. */
  | "action_required"
  /** Connected, but nobody has chosen which property to read. */
  | "connected_no_property"
  /** Connected and assigned; nothing has landed and nothing is running. */
  | "awaiting_first_sync"
  /** Connected and assigned; a warm job is in flight and nothing has landed. */
  | "syncing"
  /** Connected and assigned; the last attempt failed or has stopped moving. */
  | "first_sync_stalled"
  /** A servable GA4 snapshot exists. */
  | "ready";

export interface GoogleAnalyticsStatusResponse {
  provider: "ga4";
  /** The stored connection is in `connected` status — the handshake landed. */
  connected: boolean;
  state: GoogleAnalyticsStatusState;
  connectedAt: string | null;
  property: {
    id: string | null;
    name: string | null;
  };
  /** A property is selected, so GA4 knows what it is importing. */
  propertyReady: boolean;
  /**
   * The share of the first import's historical window that has landed, 0-100.
   *
   * **Always null, deliberately.** GA4 has no backfill queue to observe: the
   * warmer makes one Data API call per window and either stores the whole
   * window or stores nothing, so the only two observable points are 0% and the
   * moment the snapshot exists — and at that moment `snapshotReady` is already
   * true and the progress block is gone. Counting landed *report types* instead
   * would put a number that is not a share of the window under the design's
   * "Backfill 28 days" caption, which is worse than showing no number at all.
   * The field is typed `number | null` so a real day-level source can fill it
   * later without a shape change.
   */
  backfillPercent: number | null;
  /** The anchor snapshot exists, so the app can serve GA4 from storage. */
  snapshotReady: boolean;
  snapshotAt: string | null;
  latestSync: ProviderReportSyncJob | null;
  errorMessage: string | null;
}

function readSelectedProperty(
  metadata: Record<string, unknown> | null | undefined,
  providerAccountId: string | null,
): string | null {
  const candidates = [
    metadata?.ga4PropertyId,
    metadata?.propertyResourceName,
    providerAccountId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function readSelectedPropertyName(
  metadata: Record<string, unknown> | null | undefined,
  providerAccountName: string | null,
): string | null {
  const candidates = [
    metadata?.ga4PropertyName,
    metadata?.propertyName,
    providerAccountName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/** When the anchor snapshot last landed, or null if it never has. */
export async function readGa4SnapshotAnchorAt(
  businessId: string,
): Promise<string | null> {
  const readiness = await getDbSchemaReadiness({
    tables: ["provider_reporting_snapshots"],
  }).catch(() => null);
  if (!readiness?.ready) return null;

  const sql = getDb();
  const rows = (await sql`
    SELECT updated_at
    FROM provider_reporting_snapshots
    WHERE business_id = ${businessId}
      AND provider = 'ga4'
      AND report_type = ${GA4_SNAPSHOT_ANCHOR_REPORT_TYPE}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as unknown as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row?.updated_at) return null;
  const parsed = new Date(String(row.updated_at));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function notConnected(
  connectedAt: string | null,
  errorMessage: string | null,
  state: GoogleAnalyticsStatusState,
): GoogleAnalyticsStatusResponse {
  return {
    provider: "ga4",
    connected: false,
    state,
    connectedAt,
    property: { id: null, name: null },
    propertyReady: false,
    backfillPercent: null,
    snapshotReady: false,
    snapshotAt: null,
    latestSync: null,
    errorMessage,
  };
}

/**
 * GA4 readiness, derived entirely from what the integration persists.
 *
 * No provider call is made: a status read that burned a Google quota unit every
 * time the integrations card polled would be its own defect, and every fact the
 * card needs is already in `provider_connections` / `provider_sync_jobs` /
 * `provider_reporting_snapshots`.
 */
export async function getGoogleAnalyticsStatus(
  businessId: string,
  now: number = Date.now(),
): Promise<GoogleAnalyticsStatusResponse> {
  if (await isDemoBusiness(businessId).catch(() => false)) {
    return getDemoGoogleAnalyticsStatus();
  }

  const integration = await getIntegrationMetadata(businessId, "ga4").catch(
    () => null,
  );
  if (!integration) {
    return notConnected(null, null, "not_connected");
  }

  const connectedAt = integration.connected_at ?? null;
  const errorMessage = integration.error_message ?? null;
  if (integration.status !== "connected") {
    // The row exists, so somebody did connect this source once; it is broken
    // rather than absent, and saying so is what lets the card name the fault.
    return notConnected(connectedAt, errorMessage, "action_required");
  }

  const metadata =
    integration.metadata && typeof integration.metadata === "object"
      ? (integration.metadata as Record<string, unknown>)
      : null;
  const propertyId = readSelectedProperty(
    metadata,
    integration.provider_account_id ?? null,
  );
  const propertyName = readSelectedPropertyName(
    metadata,
    integration.provider_account_name ?? null,
  );

  const [snapshotAt, latestSync] = await Promise.all([
    readGa4SnapshotAnchorAt(businessId).catch(() => null),
    readLatestProviderReportSyncJob({
      businessId,
      provider: "ga4",
      reportType: GA4_WARM_JOB_REPORT_TYPE,
    }).catch(() => null),
  ]);

  const snapshotReady = snapshotAt !== null;
  const inFlight = isProviderReportSyncJobInFlight(latestSync, now);

  // `error_message` deliberately does NOT decide the state of a row that says
  // `connected`. The only writer that records one is `markIntegrationError`,
  // and it sets `status = 'error'` in the same call — which the branch above
  // already catches. On a row that is back to `connected`, the message is
  // residue: `upsertIntegration` only clears it when the reconnect changed the
  // authority, so a healthy source can still carry the last failure it ever
  // had. Letting that residue read as a live fault would name a fault that is
  // not there. It stays in the payload as the last recorded provider error.
  const state: GoogleAnalyticsStatusState = snapshotReady
    ? "ready"
    : !propertyId
      ? "connected_no_property"
      : inFlight
        ? "syncing"
        : latestSync && latestSync.status !== "done"
          ? "first_sync_stalled"
          : "awaiting_first_sync";

  return {
    provider: "ga4",
    connected: true,
    state,
    connectedAt,
    property: { id: propertyId, name: propertyName },
    propertyReady: Boolean(propertyId),
    backfillPercent: null,
    snapshotReady,
    snapshotAt,
    latestSync,
    errorMessage,
  };
}

/**
 * The demo workspace serves GA4 from fixtures, with no import to run.
 *
 * Reporting it as `ready` is the truthful reading — its analytics surfaces
 * answer immediately — and it keeps the demo card out of a first-import claim
 * that could never complete.
 */
export function getDemoGoogleAnalyticsStatus(): GoogleAnalyticsStatusResponse {
  const integration = getDemoIntegration("ga4");
  const metadata =
    integration?.metadata && typeof integration.metadata === "object"
      ? (integration.metadata as Record<string, unknown>)
      : null;
  return {
    provider: "ga4",
    connected: integration?.status === "connected",
    state: integration?.status === "connected" ? "ready" : "not_connected",
    connectedAt: integration?.connected_at ?? null,
    property: {
      id: readSelectedProperty(metadata, integration?.provider_account_id ?? null),
      name: readSelectedPropertyName(
        metadata,
        integration?.provider_account_name ?? null,
      ),
    },
    propertyReady: Boolean(
      readSelectedProperty(metadata, integration?.provider_account_id ?? null),
    ),
    backfillPercent: null,
    snapshotReady: integration?.status === "connected",
    snapshotAt: integration?.connected_at ?? null,
    latestSync: null,
    errorMessage: null,
  };
}
