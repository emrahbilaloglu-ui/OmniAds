import type { DbClient } from "@/lib/db";
import { JOB_NAME as DECISIONS_JOB_NAME } from "./decisions-job";

// Both certification and demotion invalidate a completed chain at the same
// 90-day scope. One scan retains either witness, including UUID-owned legacy
// rows whose display business_id differs; it does not narrow source identity.
export const READ_COMPLETED_CREATIVE_PRODUCER_SCOPES_SQL = `
    WITH requested AS (
      SELECT business_id, as_of_date
      FROM unnest($2::text[], $3::date[]) AS scope(business_id, as_of_date)
    ), completed AS (
      SELECT
        runs.business_ref_id, runs.as_of_date,
        bool_or(job_name = 'engine_v3_calibration_job' AND status = 'success') AS calibration_success,
        bool_or(job_name = 'engine_v3_lifecycle_job' AND status = 'success') AS lifecycle_success,
        bool_or(job_name = $1 AND status = 'success') AS decisions_success
      FROM engine_v3_job_runs runs
      JOIN requested ON requested.business_id::uuid = runs.business_ref_id
        AND requested.as_of_date = runs.as_of_date
      WHERE job_name IN (
          'engine_v3_calibration_job',
          'engine_v3_lifecycle_job',
          $1
        )
        AND engine_version = $4
      GROUP BY runs.business_ref_id, runs.as_of_date
    ), latest_decision AS (
      SELECT DISTINCT ON (runs.business_ref_id, runs.as_of_date)
        runs.business_ref_id, runs.as_of_date,
        CASE WHEN
          runs.error_json#>>'{metadata,evaluation_cutoff_at}' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$'
          AND pg_input_is_valid(runs.error_json#>>'{metadata,evaluation_cutoff_at}', 'timestamptz')
          THEN (runs.error_json#>>'{metadata,evaluation_cutoff_at}')::timestamptz
          ELSE NULL
        END AS evaluation_cutoff_at
      FROM engine_v3_job_runs runs
      JOIN requested ON requested.business_id::uuid = runs.business_ref_id
        AND requested.as_of_date = runs.as_of_date
      WHERE runs.job_name = $1 AND runs.status = 'success' AND runs.engine_version = $4
      ORDER BY runs.business_ref_id, runs.as_of_date, runs.finished_at DESC NULLS LAST, runs.id DESC
    )
    SELECT completed.business_ref_id, completed.as_of_date::text
    FROM completed
    JOIN latest_decision ON latest_decision.business_ref_id = completed.business_ref_id
      AND latest_decision.as_of_date = completed.as_of_date
    WHERE calibration_success = TRUE
      AND lifecycle_success = TRUE
      AND decisions_success = TRUE
      AND latest_decision.evaluation_cutoff_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM meta_creative_daily creative
        WHERE creative.business_ref_id = completed.business_ref_id
          AND creative.date BETWEEN (completed.as_of_date - INTERVAL '89 days')
            AND completed.as_of_date
          AND ((creative.payload_json->>'historical_config_provenance' IN
            ('provider_receipt_day_bracketed', 'provider_receipt_legacy_bracketed')
          AND CASE WHEN
            creative.payload_json#>>'{historical_config_proof,certified_at}' ~
              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$'
            AND pg_input_is_valid(creative.payload_json#>>'{historical_config_proof,certified_at}', 'timestamptz')
            THEN (creative.payload_json#>>'{historical_config_proof,certified_at}')::timestamptz
              > latest_decision.evaluation_cutoff_at
            ELSE FALSE END) OR (CASE WHEN
            creative.payload_json->>'historical_config_authority_changed_at' ~
              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$'
            AND pg_input_is_valid(
              creative.payload_json->>'historical_config_authority_changed_at',
              'timestamptz')
            THEN (creative.payload_json->>'historical_config_authority_changed_at')::timestamptz
              > latest_decision.evaluation_cutoff_at
            ELSE FALSE END))
      )
      AND NOT EXISTS (
        SELECT 1 FROM meta_authoritative_publication_pointers pointer
        WHERE pointer.business_id = completed.business_ref_id::text
          AND pointer.day BETWEEN (completed.as_of_date - INTERVAL '89 days')
            AND completed.as_of_date
          AND pointer.surface = 'ad_daily'
          AND pointer.updated_at > latest_decision.evaluation_cutoff_at
      )
    `;

/** Caller pins every read to one repeatable-read transaction. */
export async function readCompletedCreativeProducerScopes(
  db: DbClient,
  businesses: ReadonlyArray<{ id: string; asOf: string }>,
  engineVersion: string,
): Promise<Array<{ business_ref_id: unknown; as_of_date: unknown }>> {
  const unique = new Map(businesses.map((business) => [
    `${business.id}:${business.asOf}`, business,
  ]));
  const rows: Array<{ business_ref_id: unknown; as_of_date: unknown }> = [];
  for (const business of unique.values()) {
    rows.push(...await db.query<{ business_ref_id: unknown; as_of_date: unknown }>(
      READ_COMPLETED_CREATIVE_PRODUCER_SCOPES_SQL,
      [DECISIONS_JOB_NAME, [business.id], [business.asOf], engineVersion],
    ));
  }
  return rows;
}
