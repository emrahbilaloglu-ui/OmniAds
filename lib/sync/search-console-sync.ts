/**
 * Proactive Search Console sync service.
 *
 * Warms up the SEO overview and findings caches so users never wait on API calls.
 * Uses the exact same functions as the SEO route handlers and stores
 * results via the explicit seo_results_cache writer.
 */
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import {
  resolveSearchConsoleContext,
  SearchConsoleAuthError,
} from "@/lib/search-console";
import {
  fetchSearchConsoleAnalyticsRows,
  buildSeoOverviewPayload,
  SearchConsoleApiError,
} from "@/lib/seo/intelligence";
import { buildSeoTechnicalFindings } from "@/lib/seo/findings";
import { writeSeoResultsCacheEntry } from "@/lib/seo/results-cache-writer";
import { computePreviousPeriod } from "@/lib/geo-momentum";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { ProviderRequestCooldownError } from "@/lib/provider-request-governance";
import { runWithGoogleRequestAuditContext } from "@/lib/google-request-audit";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";
import { logRuntimeInfo } from "@/lib/runtime-logging";

const DATE_WINDOWS = [
  { days: 30 },
  { days: 7 },
];

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
        VALUES (${businessId}, ${businessRefId}, 'search_console', ${reportType}, ${dateRangeKey}, 'running', now(), now())
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
          AND provider       = 'search_console'
          AND report_type    = ${reportType}
          AND date_range_key = ${dateRangeKey}
      `;
    }
  } catch {
    // tracking hatası sync'i durdurmamalı
  }
}

export interface SearchConsoleSyncResult {
  businessId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
}

export async function syncSearchConsoleReports(businessId: string): Promise<SearchConsoleSyncResult> {
  // Admission before the connection is even resolved. This is an external
  // source writing into the warehouse, so it is inside the master switch and
  // inside the capacity budget like every other ingest path.
  assertSyncLaneEnabled("source_ingest");
  await assertSyncGrowthBoundary("search_console_reports_sync", { fresh: true });
  let context: Awaited<ReturnType<typeof resolveSearchConsoleContext>>;
  try {
    context = await resolveSearchConsoleContext({ businessId, requireSite: true });
  } catch (err) {
    if (err instanceof SearchConsoleAuthError) {
      return { businessId, attempted: 0, succeeded: 0, failed: 0, skipped: true };
    }
    throw err;
  }

  const siteUrl = context.siteUrl ?? "";
  let succeeded = 0;
  let failed = 0;
  // Counted, not assumed: the loop below can break early on an auth or
  // quota error, and reporting the full window count as `attempted` claimed
  // work that never happened.
  let attempted = 0;

  for (const window of DATE_WINDOWS) {
    attempted += 1;
    // Re-admitted per WINDOW. Each window is its own provider call group and
    // its own cache/job write; admitting once at the top says nothing about
    // whether the fourth window is still allowed to run.
    assertSyncLaneEnabled("source_ingest");
    await assertSyncGrowthBoundary("search_console_report_window", { fresh: true });

    const { startDate, endDate } = buildDateRange(window.days);
    const { prevStart, prevEnd } = computePreviousPeriod(startDate, endDate);
    const dateRangeKey = `${startDate}:${endDate}`;

    await upsertSyncJob(businessId, "seo_overview", dateRangeKey, "running");
    try {
      const [overviewPayload, findingsPayload] = await runWithGoogleRequestAuditContext(
        {
          provider: "search_console",
          businessId,
          requestSource: "cron_sync",
          requestPath: "sync/search-console-cache-warm",
          requestType: "seo_overview",
        },
        async () => {
          const [currentRows, previousRows] = await Promise.all([
            fetchSearchConsoleAnalyticsRows({
              accessToken: context.accessToken,
              siteUrl,
              startDate,
              endDate,
              rowLimit: 300,
            }),
            fetchSearchConsoleAnalyticsRows({
              accessToken: context.accessToken,
              siteUrl,
              startDate: prevStart,
              endDate: prevEnd,
              rowLimit: 300,
            }),
          ]);

          return Promise.all([
            buildSeoOverviewPayload({
              siteUrl,
              startDate,
              endDate,
              currentRows,
              previousRows,
              businessId,
            }),
            buildSeoTechnicalFindings({
              siteUrl,
              accessToken: context.accessToken,
              currentRows,
              previousRows,
            }),
          ]);
        },
      );

      await Promise.all([
        writeSeoResultsCacheEntry({
          businessId,
          cacheType: "overview",
          startDate,
          endDate,
          payload: overviewPayload,
        }),
        writeSeoResultsCacheEntry({
          businessId,
          cacheType: "findings",
          startDate,
          endDate,
          payload: findingsPayload,
        }),
      ]);
      await upsertSyncJob(businessId, "seo_overview", dateRangeKey, "done");
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await upsertSyncJob(businessId, "seo_overview", dateRangeKey, "failed", msg);
      failed++;
      console.warn("[search-console-sync] task_failed", { businessId, startDate, endDate, message: msg });
      if (
        err instanceof ProviderRequestCooldownError ||
        (err instanceof SearchConsoleApiError && [401, 403, 429].includes(err.status))
      ) {
        break;
      }
    }
  }

  logRuntimeInfo("search-console-sync", "completed", {
    businessId,
    attempted,
    succeeded,
    failed,
  });
  return { businessId, attempted, succeeded, failed, skipped: false };
}
