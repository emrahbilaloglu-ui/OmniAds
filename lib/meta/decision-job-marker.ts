import { getDb } from "@/lib/db";

export type NativeDecisionJobMarker = {
  asOfDate: string;
  cacheIdentity: string;
};

/**
 * A published native job changes the decision inventory even when its as-of
 * day does not change. Read its indexed, business-scoped marker before using
 * the heavier as-of and decision caches, so a warm process cannot keep serving
 * a prior engine epoch after the new generation has committed. This marker
 * chooses cache identity and an upper date bound only; the native read model
 * still verifies the account receipt and every snapshot before serving it.
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
    }>(
      `SELECT run.id::text AS job_run_id,
              run.as_of_date::text AS as_of_date,
              CASE
                WHEN run.finished_at IS NULL
                  OR run.finished_at > statement_timestamp() THEN 'failed'
                ELSE run.status
              END AS status,
              run.finished_at::text AS finished_at
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
        ORDER BY run.as_of_date DESC, run.started_at DESC, run.id DESC
        LIMIT 1`,
      [businessId],
    );
    const row = rows[0];
    if (
      !row?.job_run_id ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.as_of_date) ||
      !row.status
    ) {
      return null;
    }
    return {
      asOfDate: row.as_of_date,
      cacheIdentity: `${row.job_run_id}:${row.status}:${row.finished_at ?? "unfinished"}`,
    };
  } catch {
    // A failed marker read cannot share the "no native job" cache identity:
    // the last healthy generation may have changed since that key was filled.
    return "read_failed";
  }
}

