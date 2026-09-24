import { getDb } from "@/lib/db";
import { NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS } from "@/lib/meta/decisions-workspace-contract";

export type NativeDecisionJobMarker = {
  asOfDate: string;
  cacheIdentity: string;
};

/**
 * A terminal native job can change the current or retained fallback decision
 * even when its report day is older than the latest run. Keep the maximum
 * report day as an upper bound, but identify the cache by BOTH that run and
 * the last terminal publication within the reader's seven-day fallback age
 * ceiling. Older publications cannot become current fallback authority. The
 * native reader still verifies the account receipt and every snapshot.
 */
export async function readLatestNativeDecisionJobMarker(
  businessId: string,
): Promise<NativeDecisionJobMarker | "read_failed" | null> {
  try {
    const rows = await getDb().query<{
      job_run_id: string;
      as_of_date: string;
      status: string;
      finished_at: string | null;
      published_job_run_id: string;
      published_status: string;
      published_updated_at: string;
    }>(
      `WITH effective_runs AS NOT MATERIALIZED (
         SELECT run.id, run.as_of_date, run.status, run.started_at,
                run.finished_at, run.updated_at
           FROM engine_v3_job_runs run
          WHERE run.job_name = 'engine_v3_native_ad_decisions_shadow_job'
            AND run.business_ref_id = $1::uuid
            AND run.business_id = $1::text
            AND run.status <> 'running'
            AND run.as_of_date <= (statement_timestamp() AT TIME ZONE 'UTC')::date
            AND run.started_at <= statement_timestamp()
            AND NOT (
              run.status = 'skipped'
              AND COALESCE(run.error_message, '') ILIKE 'Advisory lock not acquired%'
              AND EXISTS (
                SELECT 1
                  FROM engine_v3_job_runs holder
                 WHERE holder.business_ref_id = run.business_ref_id
                   AND holder.business_id = run.business_id
                   AND holder.job_name = run.job_name
                   AND holder.as_of_date = run.as_of_date
                   AND holder.id <> run.id
                   AND holder.status IN ('success', 'failed')
                   AND holder.started_at <= statement_timestamp()
                   AND holder.started_at <= COALESCE(run.finished_at, run.started_at)
                   AND holder.finished_at >= run.started_at
                   AND holder.finished_at <= statement_timestamp()
              )
            )
       ), latest_as_of AS (
         SELECT * FROM effective_runs
          ORDER BY as_of_date DESC, started_at DESC, id DESC LIMIT 1
       ), latest_publication AS (
         SELECT * FROM effective_runs
          WHERE as_of_date >=
            (statement_timestamp() AT TIME ZONE 'UTC')::date - $2::integer
          ORDER BY updated_at DESC, id DESC LIMIT 1
       )
       SELECT latest_as_of.id::text AS job_run_id,
              latest_as_of.as_of_date::text AS as_of_date,
              CASE
                WHEN latest_as_of.finished_at IS NULL
                  OR latest_as_of.finished_at > statement_timestamp() THEN 'failed'
                ELSE latest_as_of.status
              END AS status,
              latest_as_of.finished_at::text AS finished_at,
              COALESCE(latest_publication.id, latest_as_of.id)::text
                AS published_job_run_id,
              COALESCE(latest_publication.status, latest_as_of.status)
                AS published_status,
              COALESCE(latest_publication.updated_at, latest_as_of.updated_at)::text
                AS published_updated_at
         FROM latest_as_of LEFT JOIN latest_publication ON true`,
      [businessId, NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS],
    );
    const row = rows[0];
    if (
      !row?.job_run_id ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.as_of_date) ||
      !row.status ||
      !row.published_job_run_id ||
      !row.published_status ||
      !row.published_updated_at
    ) {
      return null;
    }
    return {
      asOfDate: row.as_of_date,
      cacheIdentity: `${row.job_run_id}:${row.status}:${row.finished_at ?? "unfinished"}:${row.published_job_run_id}:${row.published_status}:${row.published_updated_at}`,
    };
  } catch {
    // A failed marker read cannot share the "no native job" cache identity:
    // the last healthy generation may have changed since that key was filled.
    return "read_failed";
  }
}
