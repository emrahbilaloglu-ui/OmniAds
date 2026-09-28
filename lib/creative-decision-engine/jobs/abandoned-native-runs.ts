import { getDb, runDbTransaction, type DbClient } from "@/lib/db";
import { NATIVE_AD_ENGINE_VERSION } from "../types";
import { hashAdvisoryLock } from "./advisory-lock";

export const NATIVE_DECISION_RUN_STALE_SECONDS = 30 * 60;
const JOB = "engine_v3_native_ad_decisions_shadow_job";

/** Close bookkeeping left behind by a killed producer, never an active job.
 * Both the job transaction and scheduler session use these exact lock keys.
 * A fresh row, either held lock, or a locked ledger row prevents closure.
 * This writes terminal metadata only; it creates no decision or provider work.
 */
export async function reapAbandonedNativeDecisionRuns(options: {
  db?: DbClient;
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
} = {}) {
  const transaction = options.transaction ?? (<T>(fn: () => Promise<T>) =>
    runDbTransaction(fn, { timeoutMs: 8_000 }));
  return transaction(async () => {
    const db = options.db ?? getDb();
    const rows = await db.query<{
      id: string; business_id: string; as_of_date: string;
    } & Record<string, unknown>>(`
      SELECT id::text, business_ref_id::text AS business_id, as_of_date::text
      FROM engine_v3_job_runs
      WHERE job_name = $1 AND engine_version = $2 AND status = 'running'
        AND started_at < clock_timestamp() - make_interval(secs => $3)
        AND updated_at < clock_timestamp() - make_interval(secs => $3)
      ORDER BY started_at, id
      LIMIT 20 FOR UPDATE SKIP LOCKED
    `, [JOB, NATIVE_AD_ENGINE_VERSION, NATIVE_DECISION_RUN_STALE_SECONDS]);
    const closed: string[] = [];
    let owned = 0;
    for (const row of rows) {
      const [lock] = await db.query<{ acquired: boolean } & Record<string, unknown>>(`
        SELECT pg_try_advisory_xact_lock($1::bigint)
          AND pg_try_advisory_xact_lock($2::bigint) AS acquired
      `, [
        hashAdvisoryLock(`${JOB}:${row.business_id}:${row.as_of_date}`).toString(),
        hashAdvisoryLock(`engine_v3_native_ad_shadow_business_chain:${row.business_id}:${row.as_of_date}`).toString(),
      ]);
      if (lock?.acquired !== true) { owned += 1; continue; }
      const updated = await db.query<{ id: string } & Record<string, unknown>>(`
        UPDATE engine_v3_job_runs
        SET status = 'failed', finished_at = clock_timestamp(),
          duration_ms = LEAST(2147483647, GREATEST(0,
            EXTRACT(epoch FROM clock_timestamp() - started_at) * 1000))::integer,
          error_code = 'native_execution_abandoned',
          error_message = 'Stale native decision execution has no job or scheduler lock owner.',
          error_json = COALESCE(error_json, '{}'::jsonb) ||
            jsonb_build_object('code', 'native_execution_abandoned',
            'metadata', COALESCE(error_json -> 'metadata', '{}'::jsonb) ||
              jsonb_build_object('contract', 'native-run-finalization.v1',
              'job_and_chain_locks_acquired', true, 'stale_seconds', $2::integer)),
          updated_at = clock_timestamp()
        WHERE id = $1::uuid AND status = 'running'
          AND job_name = $3 AND engine_version = $4
          AND updated_at < clock_timestamp() - make_interval(secs => $2)
        RETURNING id::text
      `, [row.id, NATIVE_DECISION_RUN_STALE_SECONDS, JOB, NATIVE_AD_ENGINE_VERSION]);
      closed.push(...updated.map((item) => item.id));
    }
    return { examined: rows.length, owned, closed };
  });
}
