/**
 * An absent `actions` key is Meta Insights' zero-action encoding only when the
 * stored row can be tied to the successful, complete, published ad Insights
 * request that explicitly asked for `actions`. A detached payload is unknown.
 *
 * The historical bulk writer did not put its requested field list in each
 * snapshot. `ad_insights_bulk` + `bulk_core_sync` is its fixed request shape;
 * `buildMetaBulkCoreInsightsUrl` requests `actions`. New snapshots record the
 * field list and must explicitly include actions. Keep the fixed historical
 * request invariant tested whenever the bulk request changes.
 */
const SQL_QUALIFIER = /^[a-z_][a-z0-9_]*$/;
const SQL_CUTOFF = /^(\$[1-9][0-9]*::timestamptz|transaction_timestamp\(\))$/;

export const META_AD_DAY_PROVIDER_ZERO_RECEIPT_CONTRACT_VERSION =
  "meta-ad-day-provider-zero-receipt.v1";

export function buildMetaAdDayProviderZeroReceiptSql(options: {
  qualifier: string;
  cutoffSql: string;
}): string {
  const { qualifier, cutoffSql } = options;
  if (!SQL_QUALIFIER.test(qualifier) || !SQL_CUTOFF.test(cutoffSql)) {
    throw new Error("meta_ad_day_provider_zero_receipt_sql_invalid");
  }
  const d = `${qualifier}.`;
  return `(CASE
    WHEN jsonb_typeof(${d}payload_json) IS DISTINCT FROM 'object'
      OR ${d}payload_json ? 'actions' THEN FALSE
    WHEN ${d}source_snapshot_id IS NULL
      OR NULLIF(BTRIM(${d}source_run_id), '') IS NULL THEN FALSE
    WHEN ${d}created_at > ${cutoffSql}
      OR ${d}updated_at > ${cutoffSql} THEN FALSE
    ELSE
      EXISTS (
        SELECT 1
        FROM meta_raw_snapshots source
        JOIN meta_authoritative_publication_pointers pointer
          ON pointer.business_id = ${d}business_id
          AND pointer.provider_account_id = ${d}provider_account_id
          AND pointer.day = ${d}date
          AND pointer.surface = 'account_daily'
          AND pointer.published_by_run_id = ${d}source_run_id
          AND pointer.published_at <= ${cutoffSql}
          AND pointer.created_at <= ${cutoffSql}
          AND pointer.updated_at <= ${cutoffSql}
        JOIN meta_authoritative_slice_versions slice
          ON slice.id = pointer.active_slice_version_id
          AND slice.business_id = pointer.business_id
          AND slice.provider_account_id = pointer.provider_account_id
          AND slice.day = pointer.day
          AND slice.surface = pointer.surface
          AND slice.source_run_id = pointer.published_by_run_id
          AND slice.state = 'finalized_verified'
          AND slice.truth_state = 'finalized'
          AND slice.validation_status = 'passed'
          AND slice.status = 'published'
          AND slice.published_at <= pointer.published_at
          AND slice.created_at <= ${cutoffSql}
          AND slice.updated_at <= ${cutoffSql}
        JOIN meta_authoritative_source_manifests manifest
          ON manifest.id = slice.manifest_id
          AND manifest.business_id = slice.business_id
          AND manifest.provider_account_id = slice.provider_account_id
          AND manifest.day = slice.day
          AND manifest.surface = slice.surface
          AND manifest.run_id = slice.source_run_id
          AND manifest.fetch_status = 'completed'
          AND manifest.fresh_start_applied
          AND manifest.checkpoint_reset_applied
          AND manifest.completed_at <= slice.published_at
          AND manifest.created_at <= ${cutoffSql}
          AND manifest.updated_at <= ${cutoffSql}
        JOIN meta_raw_snapshot_observations observation
          ON observation.snapshot_id = source.id
          AND observation.business_id = source.business_id
          AND observation.provider_account_id = source.provider_account_id
          AND observation.run_id = manifest.run_id
          AND observation.endpoint_name = 'ad_insights_bulk'
          AND observation.entity_scope = 'ad'
          AND observation.status = 'fetched'
          AND observation.provider_http_status = 200
          AND observation.observed_at <= manifest.completed_at
          AND observation.created_at <= ${cutoffSql}
        WHERE source.id = ${d}source_snapshot_id
          AND source.business_id = ${d}business_id
          AND source.provider_account_id = ${d}provider_account_id
          AND source.start_date = ${d}date
          AND source.end_date = ${d}date
          AND source.endpoint_name = 'ad_insights_bulk'
          AND source.entity_scope = 'ad'
          AND source.status = 'fetched'
          AND source.provider_http_status = 200
          AND source.fetched_at <= ${cutoffSql}
          AND source.created_at <= ${cutoffSql}
          AND source.fetched_at <= observation.observed_at
          AND source.fetched_at <= manifest.completed_at
          AND manifest.completed_at <= ${cutoffSql}
          AND source.request_context->>'source' = 'bulk_core_sync'
          AND source.request_context->>'level' = 'ad'
          AND (NOT (source.request_context ? 'fields')
            OR 'actions' = ANY(string_to_array(source.request_context->>'fields', ',')))
          AND observation.request_context->>'source' = 'bulk_core_sync'
          AND observation.request_context->>'level' = 'ad'
          AND (NOT (observation.request_context ? 'fields')
            OR 'actions' = ANY(string_to_array(observation.request_context->>'fields', ',')))
          AND source.payload_json @> jsonb_build_array(${d}payload_json)
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(source.payload_json) = 'array'
                THEN source.payload_json ELSE '[]'::jsonb END
            ) AS source_row(payload)
            WHERE source_row.payload = ${d}payload_json
          )
      )
  END)`;
}
