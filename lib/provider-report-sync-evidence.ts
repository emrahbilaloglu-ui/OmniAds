import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";

/**
 * Shared evidence reads for the two providers whose only importer is the
 * report warmer: GA4 (`lib/sync/ga4-sync.ts`) and Search Console
 * (`lib/sync/search-console-sync.ts`).
 *
 * Both write exactly one `provider_sync_jobs` row per window they attempt —
 * `running` when the window starts, `done`/`failed` when it ends — and nothing
 * else records their progress. Every fact this module exposes is read from
 * those rows; none of it is computed from a clock running ahead of them.
 */
export const PROVIDER_REPORT_SYNC_JOB_TABLES = ["provider_sync_jobs"] as const;

/**
 * How long a `provider_sync_jobs` row may sit in `running` before this codebase
 * stops calling it in flight.
 *
 * This is not a new threshold. `lib/admin-operations-health.ts` already
 * classifies a running `provider_sync_jobs` row older than fifteen minutes as a
 * STUCK job — and it does so for exactly these providers, since its own query
 * selects `provider IN ('google_ads', 'ga4', 'search_console')`. Reusing that
 * boundary keeps one definition of "still working" in the product: past it, the
 * operations surface calls the job stuck, so the integrations card must not
 * keep telling the user an import is running.
 */
export const PROVIDER_REPORT_SYNC_JOB_STUCK_MS = 15 * 60_000;

export interface ProviderReportSyncJob {
  status: string;
  triggeredAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The most recently triggered warm job for one provider/report pair.
 *
 * The warmer loops its windows in order and stamps `triggered_at = now()` as it
 * enters each one, so the newest `triggered_at` is the attempt currently in
 * progress — or, once the loop has ended, the last attempt it made.
 */
export async function readLatestProviderReportSyncJob(input: {
  businessId: string;
  provider: string;
  reportType: string;
}): Promise<ProviderReportSyncJob | null> {
  const readiness = await getDbSchemaReadiness({
    tables: [...PROVIDER_REPORT_SYNC_JOB_TABLES],
  }).catch(() => null);
  if (!readiness?.ready) return null;

  const sql = getDb();
  const rows = (await sql`
    SELECT status, triggered_at, started_at, completed_at, error_message
    FROM provider_sync_jobs
    WHERE business_id = ${input.businessId}
      AND provider = ${input.provider}
      AND report_type = ${input.reportType}
    ORDER BY triggered_at DESC
    LIMIT 1
  `) as unknown as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status ? String(row.status) : "",
    triggeredAt: toIso(row.triggered_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    errorMessage: row.error_message ? String(row.error_message) : null,
  };
}

/**
 * True only while the warmer is plausibly still inside this job.
 *
 * A row with no parseable `triggered_at` proves nothing about when the work
 * began, so it is not counted as in flight — the same conservative reading the
 * first-sync rule applies to an unknown `connectedAt`.
 */
export function isProviderReportSyncJobInFlight(
  job: ProviderReportSyncJob | null,
  now: number = Date.now(),
): boolean {
  if (!job || job.status !== "running") return false;
  if (!job.triggeredAt) return false;
  const triggered = Date.parse(job.triggeredAt);
  if (Number.isNaN(triggered)) return false;
  return now - triggered <= PROVIDER_REPORT_SYNC_JOB_STUCK_MS;
}
