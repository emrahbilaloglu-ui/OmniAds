import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getIntegration } from "@/lib/integrations";
import {
  fetchKlaviyoConversionMetricId,
  fetchKlaviyoFlows,
  fetchKlaviyoFlowStatistics,
  KlaviyoApiError,
} from "@/lib/klaviyo/api";
import { resolveKlaviyoAccessToken } from "@/lib/klaviyo/token";
import {
  KLAVIYO_FLOW_WINDOW_DAYS,
  KLAVIYO_WAREHOUSE_TABLES,
  replaceKlaviyoFlowMetrics,
  type KlaviyoFlowMetricRow,
} from "@/lib/klaviyo/warehouse";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";

/**
 * Klaviyo lifecycle ingest.
 *
 * READ-ONLY against the provider. Nothing here writes to Klaviyo — see the
 * module docstring on `lib/klaviyo/api.ts` — so none of the guarded-write
 * machinery (confirmation ceremony, Tier-1 supervision, action log) applies and
 * none of it is bypassed. What DOES apply is the ingest admission every other
 * external source obeys, and this path obeys it identically to
 * `lib/sync/search-console-sync.ts`:
 *
 *   assertSyncLaneEnabled("source_ingest")  — the global + per-lane kill switch
 *   assertSyncGrowthBoundary(...)           — the database capacity fence
 *
 * Both are asserted BEFORE the connection is resolved and again before the
 * warehouse write, because the provider round-trip sits between them and
 * admission at the top says nothing about whether the write is still allowed.
 */

const KLAVIYO_SYNC_REPORT_TYPE = "flow_values";

export type KlaviyoSyncSkipReason =
  | "not_connected"
  | "schema_not_ready"
  | "no_provider_account";

export interface KlaviyoSyncResult {
  businessId: string;
  skipped: boolean;
  skipReason: KlaviyoSyncSkipReason | null;
  flowsSeen: number;
  rowsWritten: number;
  /** True when Klaviyo served no conversion metric, so revenue is unknowable. */
  revenueUnavailable: boolean;
  windowStart: string;
  windowEnd: string;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The 28-day window the design's column names, ending at the last complete day. */
export function buildKlaviyoWindow(now: Date = new Date()): {
  start: string;
  end: string;
} {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - KLAVIYO_FLOW_WINDOW_DAYS);
  return { start: isoDate(start), end: isoDate(end) };
}

async function recordSyncJob(
  businessId: string,
  status: "running" | "done" | "failed",
  errorMessage?: string,
): Promise<void> {
  try {
    const readiness = await getDbSchemaReadiness({
      tables: ["provider_sync_jobs"],
    });
    if (!readiness.ready) return;
    const sql = getDb();
    const businessRefIds = await resolveBusinessReferenceIds([businessId]);
    const businessRefId = businessRefIds.get(businessId) ?? null;
    const rangeKey = `last_${KLAVIYO_FLOW_WINDOW_DAYS}d`;
    if (status === "running") {
      await sql`
        INSERT INTO provider_sync_jobs (
          business_id, business_ref_id, provider, report_type, date_range_key,
          status, triggered_at, started_at
        )
        VALUES (${businessId}, ${businessRefId}, 'klaviyo', ${KLAVIYO_SYNC_REPORT_TYPE}, ${rangeKey}, 'running', now(), now())
        ON CONFLICT (business_id, provider, report_type, date_range_key) DO UPDATE SET
          business_ref_id = COALESCE(provider_sync_jobs.business_ref_id, EXCLUDED.business_ref_id),
          status        = 'running',
          started_at    = now(),
          triggered_at  = now(),
          error_message = NULL
      `;
    } else {
      await sql`
        UPDATE provider_sync_jobs SET
          business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
          status        = ${status},
          completed_at  = now(),
          error_message = ${errorMessage ?? null}
        WHERE business_id    = ${businessId}
          AND provider       = 'klaviyo'
          AND report_type    = ${KLAVIYO_SYNC_REPORT_TYPE}
          AND date_range_key = ${rangeKey}
      `;
    }
  } catch {
    // Job bookkeeping must never be the reason an otherwise good sync fails.
  }
}

/**
 * Pull this business's Klaviyo flows and their 28-day statistics into
 * `klaviyo_flow_metrics`.
 *
 * A flow Klaviyo reports no statistics for is still written, with NULL metrics:
 * the flow genuinely exists and its name and status are known facts, while its
 * revenue is not. That is the row the design draws for "Win-back 60d" — a real
 * name, a real Draft status, and an em-dash in all three numeric columns.
 */
export async function syncKlaviyoFlowMetrics(
  businessId: string,
  options?: { now?: Date },
): Promise<KlaviyoSyncResult> {
  assertSyncLaneEnabled("source_ingest");
  await assertSyncGrowthBoundary("klaviyo_flow_metrics_sync", { fresh: true });

  const window = buildKlaviyoWindow(options?.now ?? new Date());
  const base = {
    businessId,
    flowsSeen: 0,
    rowsWritten: 0,
    revenueUnavailable: false,
    windowStart: window.start,
    windowEnd: window.end,
  };

  const readiness = await getDbSchemaReadiness({
    tables: [...KLAVIYO_WAREHOUSE_TABLES],
  });
  if (!readiness.ready) {
    return { ...base, skipped: true, skipReason: "schema_not_ready" };
  }

  // The state machine's gate, on the write side: only a `connected` connection
  // authorises an ingest. A disconnected or errored row is not a licence to
  // keep pulling.
  const integration = await getIntegration(businessId, "klaviyo");
  if (!integration || integration.status !== "connected") {
    return { ...base, skipped: true, skipReason: "not_connected" };
  }
  const providerAccountId = integration.provider_account_id?.trim() ?? "";
  if (!providerAccountId) {
    // Without the account this snapshot belongs to there is no key to store it
    // under, and inventing one would let two Klaviyo accounts overwrite each
    // other silently.
    return { ...base, skipped: true, skipReason: "no_provider_account" };
  }

  await recordSyncJob(businessId, "running");
  try {
    const { accessToken } = await resolveKlaviyoAccessToken({ businessId });

    const flows = (await fetchKlaviyoFlows(accessToken)).filter(
      (flow) => !flow.archived,
    );
    const conversionMetricId =
      await fetchKlaviyoConversionMetricId(accessToken);
    const statistics = await fetchKlaviyoFlowStatistics({
      accessToken,
      conversionMetricId,
      start: window.start,
      end: window.end,
    });
    const statisticsByFlow = new Map(
      statistics.map((entry) => [entry.flowId, entry]),
    );

    const currency = (() => {
      const metadata = integration.metadata as Record<string, unknown> | null;
      const value = metadata?.klaviyoCurrency;
      return typeof value === "string" && value.trim() !== ""
        ? value.trim()
        : null;
    })();

    const rows: KlaviyoFlowMetricRow[] = flows.map((flow) => {
      const stats = statisticsByFlow.get(flow.id) ?? null;
      return {
        flowId: flow.id,
        flowName: flow.name,
        flowStatus: flow.status,
        currency,
        revenue: stats?.conversionValue ?? null,
        openRate: stats?.openRate ?? null,
        recipients: stats?.recipients ?? null,
      };
    });

    // Re-admitted before the write. The provider round-trip above can take long
    // enough for the operator to have turned the lane off, and the fence to have
    // tripped, since the assertion at the top.
    assertSyncLaneEnabled("source_ingest");
    await assertSyncGrowthBoundary("klaviyo_flow_metrics_write", {
      fresh: true,
    });

    const written = await replaceKlaviyoFlowMetrics({
      businessId,
      providerAccountId,
      windowDays: KLAVIYO_FLOW_WINDOW_DAYS,
      windowStart: window.start,
      windowEnd: window.end,
      fetchedAt: options?.now ?? new Date(),
      rows,
    });

    await recordSyncJob(businessId, "done");
    return {
      ...base,
      skipped: false,
      skipReason: null,
      flowsSeen: flows.length,
      rowsWritten: written.written,
      revenueUnavailable: conversionMetricId == null,
    };
  } catch (error) {
    const message =
      error instanceof KlaviyoApiError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Unknown Klaviyo sync error.";
    await recordSyncJob(businessId, "failed", message);
    throw error;
  }
}
