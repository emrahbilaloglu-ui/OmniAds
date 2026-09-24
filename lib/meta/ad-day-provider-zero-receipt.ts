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
    ELSE
      EXISTS (
        SELECT 1 FROM meta_raw_snapshots source
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
          AND source.request_context->>'source' = 'bulk_core_sync'
          AND source.request_context->>'level' = 'ad'
          AND (NOT (source.request_context ? 'fields')
            OR 'actions' = ANY(string_to_array(source.request_context->>'fields', ',')))
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
      AND EXISTS (
        SELECT 1 FROM meta_authoritative_source_manifests manifest
        WHERE manifest.business_id = ${d}business_id
          AND manifest.provider_account_id = ${d}provider_account_id
          AND manifest.day = ${d}date
          AND manifest.surface = 'account_daily'
          AND manifest.run_id = ${d}source_run_id
          AND manifest.fetch_status = 'completed'
          AND manifest.fresh_start_applied
          AND manifest.checkpoint_reset_applied
          AND manifest.completed_at <= ${cutoffSql}
      )
      AND EXISTS (
        SELECT 1 FROM meta_authoritative_publication_pointers pointer
        WHERE pointer.business_id = ${d}business_id
          AND pointer.provider_account_id = ${d}provider_account_id
          AND pointer.day = ${d}date
          AND pointer.surface = 'account_daily'
          AND pointer.published_by_run_id = ${d}source_run_id
          AND pointer.published_at <= ${cutoffSql}
      )
  END)`;
}
