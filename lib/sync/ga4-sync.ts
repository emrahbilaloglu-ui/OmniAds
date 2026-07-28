/**
 * Proactive GA4 sync service.
 *
 * Warms user-facing GA4 dashboard/reporting caches through explicit writer lanes.
 * Shared read helpers stay read-only; route/report snapshots are persisted only
 * via `lib/reporting-cache-writer.ts`.
 */
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import {
  resolveGa4AnalyticsContext,
  GA4AuthError,
} from "@/lib/google-analytics-reporting";
import { ProviderRequestCooldownError } from "@/lib/provider-request-governance";
import { getNormalizedSearchParamsKey } from "@/lib/route-report-cache";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";
import {
  GA4_AUTO_WARM_DATE_WINDOWS,
  GA4_AUTO_WARM_DETAIL_REQUESTS,
} from "@/lib/sync/report-warmer-boundaries";
import {
  warmGa4EcommerceFallbackCache,
  warmGa4UserFacingRouteReportCache,
} from "@/lib/user-facing-report-cache-owners";
import { logRuntimeInfo } from "@/lib/runtime-logging";

const REPORT_TYPE = "ga4_overview";

function buildDateRange(days: number): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - days);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function upsertSyncJob(
  businessId: string,
  reportType: string,
  dateRangeKey: string,
  status: "running" | "done" | "failed",
  errorMessage?: string,
): Promise<void> {
  try {
    const readiness = await getDbSchemaReadiness({
      tables: ["provider_sync_jobs"],
    });
    if (!readiness.ready) {
      return;
    }
    const sql = getDb();
    const businessRefIds = await resolveBusinessReferenceIds([businessId]);
    const businessRefId = businessRefIds.get(businessId) ?? null;
    if (status === "running") {
      await sql`
        INSERT INTO provider_sync_jobs (
          business_id,
          business_ref_id,
          provider,
          report_type,
          date_range_key,
          status,
          triggered_at,
          started_at
        )
        VALUES (${businessId}, ${businessRefId}, 'ga4', ${reportType}, ${dateRangeKey}, 'running', now(), now())
        ON CONFLICT (business_id, provider, report_type, date_range_key) DO UPDATE SET
          business_ref_id = COALESCE(provider_sync_jobs.business_ref_id, EXCLUDED.business_ref_id),
          status       = 'running',
          started_at   = now(),
          triggered_at = now(),
          error_message = NULL
      `;
    } else {
      await sql`
        UPDATE provider_sync_jobs SET
          business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
          status       = ${status},
          completed_at = now(),
          error_message = ${errorMessage ?? null}
        WHERE business_id    = ${businessId}
          AND provider       = 'ga4'
          AND report_type    = ${reportType}
          AND date_range_key = ${dateRangeKey}
      `;
    }
  } catch {
    // tracking hatası sync'i durdurmamalı
  }
}

export interface GA4SyncResult {
  businessId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
}

export async function syncGA4Reports(businessId: string): Promise<GA4SyncResult> {
  // Admission before the connection is even resolved. This is an external
  // source writing into the warehouse, so it is inside the master switch and
  // inside the capacity budget like every other ingest path.
  assertSyncLaneEnabled("source_ingest");
  await assertSyncGrowthBoundary("ga4_reports_sync", { fresh: true });
  // GA4 bağlantısını doğrula
  try {
    await resolveGa4AnalyticsContext(businessId, { requireProperty: true });
  } catch (err) {
    if (err instanceof GA4AuthError) {
      return { businessId, attempted: 0, succeeded: 0, failed: 0, skipped: true };
    }
    throw err;
  }

  let succeeded = 0;
  let failed = 0;
  // Counted, not assumed: the loop below can break early on an auth or
  // quota error, and reporting the full window count as `attempted` claimed
  // work that never happened.
  let attempted = 0;

  for (const window of GA4_AUTO_WARM_DATE_WINDOWS) {
    attempted += 1;
    // Re-admitted per WINDOW, before the job row that starts it.
    //
    // Admission once at the top covers a run that may take many minutes across
    // several windows, each of which calls the provider and writes a cache and a
    // job row. A lane disabled or a disk filled after the first window would
    // otherwise be discovered only when the whole run finished.
    assertSyncLaneEnabled("source_ingest");
    await assertSyncGrowthBoundary("ga4_report_window", { fresh: true });

    const { startDate, endDate } = buildDateRange(window.days);
    const searchParams = new URLSearchParams({ businessId, startDate, endDate });
    const dateRangeKey = getNormalizedSearchParamsKey(searchParams);

    await upsertSyncJob(businessId, REPORT_TYPE, dateRangeKey, "running");
    try {
      await warmGa4UserFacingRouteReportCache({
        businessId,
        reportType: "ga4_analytics_overview",
        startDate,
        endDate,
      });
      await warmGa4EcommerceFallbackCache({
        businessId,
        startDate,
        endDate,
      });
      for (const report of GA4_AUTO_WARM_DETAIL_REQUESTS) {
        try {
          await warmGa4UserFacingRouteReportCache({
            businessId,
            startDate,
            endDate,
            ...report,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[ga4-sync] detail_cache_warm_failed", {
            businessId,
            reportType: report.reportType,
            dimension: "dimension" in report ? report.dimension : null,
            startDate,
            endDate,
            message,
          });
          if (error instanceof ProviderRequestCooldownError) {
            break;
          }
        }
      }
      await upsertSyncJob(businessId, REPORT_TYPE, dateRangeKey, "done");
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await upsertSyncJob(businessId, REPORT_TYPE, dateRangeKey, "failed", msg);
      failed++;
      console.warn("[ga4-sync] task_failed", { businessId, window: window.label, message: msg });
      // quota hatası gelirse diğer window'ları da deneme
      if (
        err instanceof ProviderRequestCooldownError ||
        (err instanceof GA4AuthError && [401, 403, 429].includes(err.status))
      ) {
        break;
      }
    }
  }

  logRuntimeInfo("ga4-sync", "completed", {
    businessId,
    attempted,
    succeeded,
    failed,
  });
  return {
    businessId,
    attempted,
    succeeded,
    failed,
    skipped: false,
  };
}
