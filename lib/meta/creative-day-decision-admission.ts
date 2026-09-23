import { META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION } from "@/lib/meta/creatives-types";

/**
 * New creative decision epochs may consume only rows whose provider-creative
 * membership was rebuilt from source identity and whose campaign/adset parent
 * is unambiguous across every source Ad. Older or mixed-parent rows remain
 * available for historical display, but they cannot form a campaign-scoped
 * creative decision input.
 */
export function creativeDaySourceMembershipSql(alias?: string): string {
  if (alias && !/^[a-z_][a-z_0-9]*$/i.test(alias)) {
    throw new Error("Invalid creative-day SQL alias");
  }

  const column = alias ? `${alias}.payload_json` : "payload_json";
  const creativeId = alias ? `${alias}.creative_id` : "creative_id";
  const members = `(CASE WHEN jsonb_typeof(${column}->'source_ad_ids') = 'array' AND jsonb_typeof(${column}->'source_creative_ids') = 'array' THEN jsonb_array_length(${column}->'source_ad_ids') > 0 AND ${column}->>'associated_ads_count' = jsonb_array_length(${column}->'source_ad_ids')::text AND (SELECT COUNT(DISTINCT source_member.value) FROM jsonb_array_elements_text(${column}->'source_ad_ids') source_member(value)) = jsonb_array_length(${column}->'source_ad_ids') AND jsonb_array_length(${column}->'source_creative_ids') = 1 AND ${column}->'source_creative_ids'->>0 = ${creativeId} ELSE FALSE END)`;
  return `(${column}->>'source_identity_version' = '${META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION}' AND ${column}->>'source_ad_ids_complete' = 'true' AND ${members})`;
}

/** Campaign/adset parent certainty is required for a creative-level decision. */
export function creativeDayDecisionAdmissionSql(alias?: string): string {
  if (alias && !/^[a-z_][a-z_0-9]*$/i.test(alias)) {
    throw new Error("Invalid creative-day SQL alias");
  }
  const column = alias ? `${alias}.payload_json` : "payload_json";
  return `(${creativeDaySourceMembershipSql(alias)} AND ${column}->>'source_parent_grain_complete' = 'true')`;
}

/**
 * Creative membership does not certify historical configuration. A legacy
 * creative decision may use objective and optimization context only after a
 * separate receipt-backed process has verified every decision-bearing config
 * field for that provider-local day under the D098 config-source contract.
 * The normal sync and metric backfill stamp `unverified`; neither self-promotes.
 * Native Ad decisions resolve the receipts independently and do not use this.
 */
export function creativeDayConfigDecisionAdmissionSql(
  alias: string | undefined,
  evaluationDateSql: string,
): string {
  if (!/^\$[1-9][0-9]*$/.test(evaluationDateSql)) {
    throw new Error("Creative-day config admission requires an as-of date parameter");
  }
  const column = alias ? `${alias}.payload_json` : "payload_json";
  const field = (name: string) => `(${column}#>>'{historical_config_proof,${name}}')`;
  const stored = (name: string) => alias ? `${alias}.${name}` : name;
  // Legacy producers expose only an as-of date. Current-day reads stop at the
  // actual query clock; historical replay stops at that UTC day's exclusive
  // end, so a receipt observed later cannot be borrowed from the future.
  const cutoff = `LEAST(now(), ((${evaluationDateSql}::date + INTERVAL '1 day') AT TIME ZONE 'UTC'))`;
  const observedBeforeCutoff = (name: string) => {
    const value = field(name);
    // pg_input_is_valid keeps malformed JSON from aborting a whole decision
    // query. The strict UTC form also rejects relative timestamps like "now".
    return `(CASE WHEN ${value} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$' AND pg_input_is_valid(${value}, 'timestamptz') THEN ${value}::timestamptz < ${cutoff} ELSE FALSE END)`;
  };
  const equalToProof = (storedSql: string, proofName: string) =>
    `NULLIF(BTRIM(${storedSql}), '') IS NOT DISTINCT FROM NULLIF(BTRIM(${field(proofName)}), '')`;
  return `(${creativeDayDecisionAdmissionSql(alias)} AND ${stored("created_at")} <= ${cutoff} AND ${stored("updated_at")} <= ${cutoff} AND ${column}->>'historical_config_provenance' IN ('provider_receipt_day_bracketed', 'provider_receipt_legacy_bracketed') AND ${observedBeforeCutoff("knowledge_cutoff_at")} AND ${observedBeforeCutoff("last_receipt_observed_at")} AND NULLIF(BTRIM(${field("objective")}), '') IS NOT NULL AND ${equalToProof(stored("objective"), "objective")} AND ${equalToProof(stored("optimization_goal"), "optimization_goal")} AND ${equalToProof(`${column}->>'custom_event_type'`, "custom_event_type")} AND ${equalToProof(`${column}->>'custom_conversion_id'`, "custom_conversion_id")})`;
}

/**
 * Filtering individual days is insufficient: a single unverified delivered
 * day would disappear from the sum and make a partial window look complete.
 * This anti-join excludes that entire creative from an authority population.
 */
export function creativeDayCompleteWindowSql(
  alias: string | undefined,
  evaluationDateSql: string,
  days: number,
  providerAccountScopeSql?: string,
  businessIdSql?: string,
): string {
  if (alias && !/^[a-z_][a-z_0-9]*$/i.test(alias)) {
    throw new Error("Invalid creative-day SQL alias");
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("Invalid creative-day decision window");
  }
  if (providerAccountScopeSql && !/^\$[1-9][0-9]*$/.test(providerAccountScopeSql)) {
    throw new Error("Invalid creative-day provider account scope");
  }
  if (businessIdSql && !/^\$[1-9][0-9]*$/.test(businessIdSql)) {
    throw new Error("Invalid creative-day business scope");
  }
  const outer = alias ?? "meta_creative_daily";
  const candidate = "unverified_creative_day";
  const admission = creativeDayConfigDecisionAdmissionSql(candidate, evaluationDateSql);
  const accountScope = providerAccountScopeSql
    ? `AND (${providerAccountScopeSql}::text IS NULL OR ${candidate}.provider_account_id = ${outer}.provider_account_id)`
    : "";
  // The optional business binding lets D101 reconcile source account-days
  // once, then hash the small set of creative identities touching a bad day.
  const sourceCoverage = creativeDaySourceCoverageSql(
    alias, evaluationDateSql, days, providerAccountScopeSql, businessIdSql,
  );
  const unverifiedDays = businessIdSql
    ? `ROW(${outer}.business_ref_id, ${outer}.creative_id) NOT IN (
      WITH unverified_creatives AS MATERIALIZED (
        SELECT DISTINCT ${candidate}.business_ref_id, ${candidate}.creative_id
        FROM meta_creative_daily ${candidate}
        WHERE ${candidate}.business_ref_id = ${businessIdSql}::uuid
          AND ${candidate}.date BETWEEN (${evaluationDateSql}::date - INTERVAL '${days - 1} days') AND ${evaluationDateSql}::date
          ${providerAccountScopeSql ? `AND (${providerAccountScopeSql}::text IS NULL OR ${candidate}.provider_account_id = ${providerAccountScopeSql}::text)` : ""}
          AND (${candidate}.spend <> 0 OR ${candidate}.conversions <> 0 OR ${candidate}.revenue <> 0 OR ${candidate}.impressions <> 0 OR ${candidate}.clicks <> 0)
          AND NOT COALESCE(${admission}, FALSE)
      )
      SELECT business_ref_id, creative_id FROM unverified_creatives
    )`
    : `NOT EXISTS (
    SELECT 1 FROM meta_creative_daily ${candidate}
    WHERE ${candidate}.business_ref_id = ${outer}.business_ref_id
      AND ${candidate}.creative_id = ${outer}.creative_id
      ${accountScope}
      AND ${candidate}.date BETWEEN (${evaluationDateSql}::date - INTERVAL '${days - 1} days') AND ${evaluationDateSql}::date
      AND (${candidate}.spend <> 0 OR ${candidate}.conversions <> 0 OR ${candidate}.revenue <> 0 OR ${candidate}.impressions <> 0 OR ${candidate}.clicks <> 0)
      AND NOT COALESCE(${admission}, FALSE)
  )`;
  return `(${unverifiedDays} AND ${sourceCoverage})`;
}

/**
 * D101 account/day source coverage for the legacy creative lane. A verified
 * creative row proves only its own members: an entirely skipped day has no
 * creative row to fail the per-row admission above. The finalized Ad-day
 * source and its published same-run manifest must therefore be covered by
 * exactly one admitted creative member for each decision-bearing Ad. The
 * account/day totals must reconcile as well. This is deliberately separate
 * from native Ad hydration, which has its own D101 coverage contract.
 */
export function creativeDaySourceCoverageSql(
  alias: string | undefined,
  evaluationDateSql: string,
  days: number,
  providerAccountScopeSql?: string,
  businessIdSql?: string,
): string {
  return buildCreativeDaySourceCoverageSql(alias, evaluationDateSql, days, providerAccountScopeSql,
    undefined, undefined, businessIdSql);
}

/** The outcome job evaluates its own 7/14-day post-decision range. */
export function creativeDayOutcomeSourceCoverageSql(
  alias: string,
  evaluationDateSql: string,
): string {
  if (!/^[a-z_][a-z_0-9]*$/i.test(alias)) throw new Error("Invalid creative-day SQL alias");
  const activeDayCoverage = buildCreativeDaySourceCoverageSql(alias, evaluationDateSql, 14, undefined,
    `(${alias}.decision_as_of_date + INTERVAL '1 day')`,
    `(${alias}.decision_as_of_date + (${alias}.outcome_window_days * INTERVAL '1 day'))`);
  const cutoff = `LEAST(now(), ((${evaluationDateSql}::date + INTERVAL '1 day') AT TIME ZONE 'UTC'))`;
  const accountSource = `
    SELECT known_day.provider_account_id,
      MIN(NULLIF(BTRIM(known_day.account_timezone), '')) AS account_timezone,
      COUNT(DISTINCT NULLIF(BTRIM(known_day.account_timezone), '')) AS timezone_count,
      BOOL_AND(NULLIF(BTRIM(known_day.account_timezone), '') IS NOT NULL) AS timezone_present
    FROM meta_creative_daily known_day
    WHERE known_day.business_ref_id = ${alias}.business_ref_id
      AND known_day.creative_id = ${alias}.creative_id
      AND known_day.date BETWEEN (${alias}.decision_as_of_date - INTERVAL '89 days')
        AND (${alias}.decision_as_of_date + (${alias}.outcome_window_days * INTERVAL '1 day'))
    GROUP BY known_day.provider_account_id`;
  // An active Ad-day check cannot distinguish a measured zero on an otherwise
  // empty day from a day that was never finalized. Demand the D101 published
  // chain for every expected provider-local day in every known source account.
  // The published Ad slice row count must cover the dated Ad facts exactly.
  const closedDayCoverage = `(
    EXISTS (SELECT 1 FROM (${accountSource}) known_accounts)
    AND NOT EXISTS (
      SELECT 1
      FROM (${accountSource}) known_account
      CROSS JOIN LATERAL generate_series(
        (${alias}.decision_as_of_date + INTERVAL '1 day')::date,
        (${alias}.decision_as_of_date + (${alias}.outcome_window_days * INTERVAL '1 day'))::date,
        INTERVAL '1 day'
      ) expected(day)
      WHERE known_account.timezone_count <> 1
        OR NOT known_account.timezone_present
        OR NOT EXISTS (
          SELECT 1
          FROM meta_authoritative_publication_pointers pointer
          JOIN meta_authoritative_slice_versions slice ON slice.id = pointer.active_slice_version_id
          JOIN meta_authoritative_source_manifests manifest ON manifest.id = slice.manifest_id
          WHERE pointer.business_id = ${alias}.business_ref_id::text
            AND pointer.provider_account_id = known_account.provider_account_id
            AND pointer.day = expected.day::date AND pointer.surface = 'ad_daily'
            AND slice.business_id = pointer.business_id
            AND slice.provider_account_id = pointer.provider_account_id
            AND slice.day = pointer.day AND slice.surface = pointer.surface
            AND slice.source_run_id = pointer.published_by_run_id
            AND slice.state = 'finalized_verified' AND slice.truth_state = 'finalized'
            AND slice.validation_status = 'passed' AND slice.status = 'published'
            AND manifest.business_id = pointer.business_id
            AND manifest.provider_account_id = pointer.provider_account_id
            AND manifest.day = pointer.day AND manifest.run_id = slice.source_run_id
            AND manifest.fetch_status = 'completed'
            AND manifest.account_timezone = known_account.account_timezone
            AND manifest.completed_at >= CASE WHEN EXISTS (
              SELECT 1 FROM pg_timezone_names tz WHERE tz.name = known_account.account_timezone
            ) THEN ((pointer.day + 1)::timestamp AT TIME ZONE known_account.account_timezone) END
            AND manifest.created_at <= ${cutoff} AND manifest.updated_at <= ${cutoff}
            AND manifest.completed_at <= ${cutoff}
            AND slice.created_at <= ${cutoff} AND slice.updated_at <= ${cutoff}
            AND slice.published_at IS NOT NULL AND slice.published_at <= ${cutoff}
            AND pointer.created_at <= ${cutoff} AND pointer.updated_at <= ${cutoff}
            AND pointer.published_at <= ${cutoff}
            AND manifest.completed_at <= slice.published_at
            AND slice.published_at <= pointer.published_at
            AND slice.staged_row_count IS NOT NULL
            AND slice.staged_row_count = (
              SELECT COUNT(*) FROM meta_ad_daily source_ad
              WHERE source_ad.business_id = pointer.business_id
                AND source_ad.provider_account_id = pointer.provider_account_id
                AND source_ad.date = pointer.day
            )
            AND NOT EXISTS (
              SELECT 1 FROM meta_ad_daily invalid_ad
              WHERE invalid_ad.business_id = pointer.business_id
                AND invalid_ad.provider_account_id = pointer.provider_account_id
                AND invalid_ad.date = pointer.day
                AND NOT (invalid_ad.source_run_id = pointer.published_by_run_id
                  AND invalid_ad.truth_state = 'finalized'
                  AND invalid_ad.validation_status = 'passed'
                  AND invalid_ad.finalized_at IS NOT NULL
                  AND invalid_ad.finalized_at <= ${cutoff}
                  AND invalid_ad.created_at <= ${cutoff}
                  AND invalid_ad.updated_at <= ${cutoff})
            )
        )
    )
  )`;
  return `(${activeDayCoverage} AND ${closedDayCoverage})`;
}

function buildCreativeDaySourceCoverageSql(
  alias: string | undefined,
  evaluationDateSql: string,
  days: number,
  providerAccountScopeSql?: string,
  rangeStartSql?: string,
  rangeEndSql?: string,
  businessIdSql?: string,
): string {
  if (alias && !/^[a-z_][a-z_0-9]*$/i.test(alias)) throw new Error("Invalid creative-day SQL alias");
  if (!/^\$[1-9][0-9]*$/.test(evaluationDateSql)) throw new Error("Invalid creative-day as-of date parameter");
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Invalid creative-day decision window");
  if (providerAccountScopeSql && !/^\$[1-9][0-9]*$/.test(providerAccountScopeSql)) {
    throw new Error("Invalid creative-day provider account scope");
  }
  if (businessIdSql && !/^\$[1-9][0-9]*$/.test(businessIdSql)) {
    throw new Error("Invalid creative-day business scope");
  }
  const outer = alias ?? "meta_creative_daily";
  const rangeStart = rangeStartSql ?? `(${evaluationDateSql}::date - INTERVAL '${days - 1} days')`;
  const rangeEnd = rangeEndSql ?? `${evaluationDateSql}::date`;
  const cutoff = `LEAST(now(), ((${evaluationDateSql}::date + INTERVAL '1 day') AT TIME ZONE 'UTC'))`;
  const sourceBusiness = businessIdSql ? `${businessIdSql}::text` : `${outer}.business_ref_id::text`;
  const accountScope = providerAccountScopeSql
    ? `AND (${providerAccountScopeSql}::text IS NULL OR creative_source_account.provider_account_id = ${outer}.provider_account_id)`
    : "";
  // Account/day reconciliation must include valid mixed-parent creative
  // groups. They cannot make their own campaign-scoped decision, but dropping
  // their economics would falsely hold every unrelated creative in account.
  const admitted = creativeDaySourceMembershipSql("covered_creative_day");
  const activity = `(source_ad.spend <> 0 OR source_ad.conversions <> 0 OR source_ad.revenue <> 0 OR source_ad.impressions <> 0 OR source_ad.clicks <> 0)`;
  const sameDay = `covered_creative_day.business_ref_id = ${sourceBusiness}::uuid
      AND covered_creative_day.provider_account_id = source_day.provider_account_id
      AND covered_creative_day.date = source_day.date
      AND covered_creative_day.account_timezone = source_day.account_timezone
      AND covered_creative_day.account_currency = source_day.account_currency
      AND ${admitted}
      AND covered_creative_day.created_at <= ${cutoff}
      AND covered_creative_day.updated_at <= ${cutoff}`;
  const badSourceDays = `SELECT source_day.provider_account_id FROM (
      SELECT source_ad.provider_account_id, source_ad.date,
        MIN(source_ad.account_timezone) AS account_timezone,
        COUNT(DISTINCT source_ad.account_timezone) AS timezone_count,
        MIN(source_ad.account_currency) AS account_currency,
        COUNT(DISTINCT source_ad.account_currency) AS currency_count,
        MIN(source_ad.source_run_id) AS source_run_id,
        COUNT(DISTINCT source_ad.source_run_id) AS source_run_count,
        BOOL_AND(source_ad.truth_state = 'finalized'
          AND source_ad.validation_status = 'passed'
          AND NULLIF(BTRIM(source_ad.source_run_id), '') IS NOT NULL
          AND NULLIF(BTRIM(source_ad.account_timezone), '') IS NOT NULL
          AND NULLIF(BTRIM(source_ad.account_currency), '') IS NOT NULL
          AND source_ad.finalized_at IS NOT NULL
          AND source_ad.finalized_at <= ${cutoff}
          AND source_ad.created_at <= ${cutoff}
          AND source_ad.updated_at <= ${cutoff}) AS source_rows_valid,
        ARRAY_AGG(source_ad.ad_id ORDER BY source_ad.ad_id) AS source_ad_ids,
        SUM(source_ad.spend) AS spend,
        SUM(source_ad.conversions) AS conversions,
        SUM(source_ad.revenue) AS revenue,
        SUM(source_ad.impressions) AS impressions,
        SUM(source_ad.clicks) AS clicks
      FROM meta_ad_daily source_ad
      WHERE source_ad.business_id = ${sourceBusiness}
        AND source_ad.date BETWEEN ${rangeStart} AND ${rangeEnd}
        AND ${activity}
        ${businessIdSql ? "" : `AND EXISTS (
          SELECT 1 FROM meta_creative_daily creative_source_account
          WHERE creative_source_account.business_ref_id = ${outer}.business_ref_id
            AND creative_source_account.creative_id = ${outer}.creative_id
            AND creative_source_account.provider_account_id = source_ad.provider_account_id
            AND creative_source_account.date BETWEEN ${rangeStart} AND ${rangeEnd}
            ${accountScope}
        )`}
      GROUP BY source_ad.provider_account_id, source_ad.date
    ) source_day
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS creative_rows,
        SUM(covered_creative_day.spend) AS spend,
        SUM(covered_creative_day.conversions) AS conversions,
        SUM(covered_creative_day.revenue) AS revenue,
        SUM(covered_creative_day.impressions) AS impressions,
        SUM(covered_creative_day.clicks) AS clicks
      FROM meta_creative_daily covered_creative_day
      WHERE ${sameDay}
        AND (covered_creative_day.spend <> 0 OR covered_creative_day.conversions <> 0
          OR covered_creative_day.revenue <> 0 OR covered_creative_day.impressions <> 0
          OR covered_creative_day.clicks <> 0)
    ) creative_totals ON TRUE
    LEFT JOIN LATERAL (
      SELECT ARRAY_AGG(member.ad_id ORDER BY member.ad_id) AS member_ad_ids
      FROM meta_creative_daily covered_creative_day
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(covered_creative_day.payload_json->'source_ad_ids') = 'array'
          THEN covered_creative_day.payload_json->'source_ad_ids' ELSE '[]'::jsonb END
      ) member(ad_id)
      WHERE ${sameDay}
    ) creative_members ON TRUE
    WHERE source_day.timezone_count <> 1
      OR source_day.currency_count <> 1
      OR source_day.source_run_count <> 1
      OR NOT COALESCE(source_day.source_rows_valid, FALSE)
      OR NOT EXISTS (
        SELECT 1 FROM meta_authoritative_publication_pointers pointer
        JOIN meta_authoritative_slice_versions slice ON slice.id = pointer.active_slice_version_id
        JOIN meta_authoritative_source_manifests manifest ON manifest.id = slice.manifest_id
        WHERE pointer.business_id = ${sourceBusiness}
          AND pointer.provider_account_id = source_day.provider_account_id
          AND pointer.day = source_day.date AND pointer.surface = 'ad_daily'
          AND pointer.published_by_run_id = source_day.source_run_id
          AND slice.business_id = pointer.business_id
          AND slice.provider_account_id = pointer.provider_account_id
          AND slice.day = pointer.day AND slice.surface = pointer.surface
          AND slice.source_run_id = source_day.source_run_id
          AND slice.state = 'finalized_verified' AND slice.truth_state = 'finalized'
          AND slice.validation_status = 'passed' AND slice.status = 'published'
          AND manifest.business_id = pointer.business_id
          AND manifest.provider_account_id = pointer.provider_account_id
          AND manifest.day = pointer.day
          AND manifest.run_id = source_day.source_run_id
          AND manifest.fetch_status = 'completed'
          AND manifest.account_timezone = source_day.account_timezone
          AND manifest.completed_at >= ((pointer.day + 1)::timestamp AT TIME ZONE source_day.account_timezone)
          AND manifest.created_at <= ${cutoff} AND manifest.updated_at <= ${cutoff}
          AND manifest.completed_at <= ${cutoff}
          AND slice.created_at <= ${cutoff} AND slice.updated_at <= ${cutoff}
          AND slice.published_at IS NOT NULL AND slice.published_at <= ${cutoff}
          AND pointer.created_at <= ${cutoff} AND pointer.updated_at <= ${cutoff}
          AND pointer.published_at <= ${cutoff}
          AND manifest.completed_at <= slice.published_at
          AND slice.published_at <= pointer.published_at
      )
      OR COALESCE(creative_totals.creative_rows, 0) = 0
      OR EXISTS (
        SELECT 1 FROM unnest(source_day.source_ad_ids) source_member(ad_id)
        WHERE (SELECT COUNT(*) FROM unnest(creative_members.member_ad_ids) covered_member(ad_id)
               WHERE covered_member.ad_id = source_member.ad_id) <> 1
      )
      OR EXISTS (
        SELECT 1 FROM unnest(creative_members.member_ad_ids) covered_member(ad_id)
        WHERE NOT EXISTS (
          SELECT 1 FROM meta_ad_daily source_member
          WHERE source_member.business_id = ${sourceBusiness}
            AND source_member.provider_account_id = source_day.provider_account_id
            AND source_member.date = source_day.date
            AND source_member.ad_id = covered_member.ad_id
            AND source_member.truth_state = 'finalized'
            AND source_member.validation_status = 'passed'
            AND source_member.created_at <= ${cutoff}
            AND source_member.updated_at <= ${cutoff}
        )
      )
      OR ABS(COALESCE(creative_totals.spend, 0) - source_day.spend) > 0.000001
      OR ABS(COALESCE(creative_totals.conversions, 0) - source_day.conversions) > 0.000001
      OR ABS(COALESCE(creative_totals.revenue, 0) - source_day.revenue) > 0.000001
      OR COALESCE(creative_totals.impressions, 0) <> source_day.impressions
      OR COALESCE(creative_totals.clicks, 0) <> source_day.clicks
  `;
  // A source-day-only anti-join misses an entire skipped account day: there
  // is no Ad fact from which to build source_day. Require a published receipt
  // for every provider-local day of a candidate account
  // in the window, including measured zero days. First *observed* activity is
  // not proof the account was absent earlier. The staged count ties the
  // receipt to every Ad fact; a creative economic row with no source Ad fact
  // is rejected separately because an empty published day would otherwise
  // appear consistent.
  const missingPublishedDays = `SELECT active_account.provider_account_id FROM (
      SELECT creative_source_account.provider_account_id,
        MIN(creative_source_account.account_timezone) AS account_timezone,
        COUNT(DISTINCT creative_source_account.account_timezone) AS timezone_count,
        BOOL_AND(NULLIF(BTRIM(creative_source_account.account_timezone), '') IS NOT NULL) AS timezone_present
      FROM meta_creative_daily creative_source_account
      WHERE creative_source_account.business_ref_id = ${sourceBusiness}::uuid
        AND creative_source_account.date BETWEEN ${rangeStart} AND ${rangeEnd}
        ${businessIdSql ? "" : `AND creative_source_account.creative_id = ${outer}.creative_id ${accountScope}`}
        ${providerAccountScopeSql && businessIdSql ? `AND (${providerAccountScopeSql}::text IS NULL OR creative_source_account.provider_account_id = ${providerAccountScopeSql}::text)` : ""}
      GROUP BY creative_source_account.provider_account_id
    ) active_account
    CROSS JOIN LATERAL generate_series(${rangeStart}::date,
      ${rangeEnd}::date, INTERVAL '1 day') expected(day)
    WHERE active_account.timezone_count <> 1
      OR NOT active_account.timezone_present
      OR EXISTS (
        SELECT 1 FROM meta_creative_daily uncovered_creative
        WHERE uncovered_creative.business_ref_id = ${sourceBusiness}::uuid
          AND uncovered_creative.provider_account_id = active_account.provider_account_id
          AND uncovered_creative.date = expected.day::date
          AND (uncovered_creative.spend <> 0 OR uncovered_creative.conversions <> 0
            OR uncovered_creative.revenue <> 0 OR uncovered_creative.impressions <> 0
            OR uncovered_creative.clicks <> 0)
          AND NOT EXISTS (
            SELECT 1 FROM meta_ad_daily economic_ad
            WHERE economic_ad.business_id = ${sourceBusiness}
              AND economic_ad.provider_account_id = active_account.provider_account_id
              AND economic_ad.date = expected.day::date
              AND (economic_ad.spend <> 0 OR economic_ad.conversions <> 0
                OR economic_ad.revenue <> 0 OR economic_ad.impressions <> 0
                OR economic_ad.clicks <> 0)
          )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM meta_authoritative_publication_pointers pointer
        JOIN meta_authoritative_slice_versions slice ON slice.id = pointer.active_slice_version_id
        JOIN meta_authoritative_source_manifests manifest ON manifest.id = slice.manifest_id
        WHERE pointer.business_id = ${sourceBusiness}
          AND pointer.provider_account_id = active_account.provider_account_id
          AND pointer.day = expected.day::date AND pointer.surface = 'ad_daily'
          AND slice.business_id = pointer.business_id
          AND slice.provider_account_id = pointer.provider_account_id
          AND slice.day = pointer.day AND slice.surface = pointer.surface
          AND slice.source_run_id = pointer.published_by_run_id
          AND slice.state = 'finalized_verified' AND slice.truth_state = 'finalized'
          AND slice.validation_status = 'passed' AND slice.status = 'published'
          AND manifest.business_id = pointer.business_id
          AND manifest.provider_account_id = pointer.provider_account_id
          AND manifest.day = pointer.day AND manifest.run_id = slice.source_run_id
          AND manifest.fetch_status = 'completed'
          AND manifest.account_timezone = active_account.account_timezone
          AND manifest.completed_at >= CASE WHEN EXISTS (
            SELECT 1 FROM pg_timezone_names tz WHERE tz.name = active_account.account_timezone
          ) THEN ((pointer.day + 1)::timestamp AT TIME ZONE active_account.account_timezone) END
          AND manifest.created_at <= ${cutoff} AND manifest.updated_at <= ${cutoff}
          AND manifest.completed_at <= ${cutoff}
          AND slice.created_at <= ${cutoff} AND slice.updated_at <= ${cutoff}
          AND slice.published_at IS NOT NULL AND slice.published_at <= ${cutoff}
          AND pointer.created_at <= ${cutoff} AND pointer.updated_at <= ${cutoff}
          AND pointer.published_at <= ${cutoff}
          AND manifest.completed_at <= slice.published_at
          AND slice.published_at <= pointer.published_at
          AND slice.staged_row_count IS NOT NULL
          AND slice.staged_row_count = (
            SELECT COUNT(*) FROM meta_ad_daily all_ad
            WHERE all_ad.business_id = pointer.business_id
              AND all_ad.provider_account_id = pointer.provider_account_id
              AND all_ad.date = pointer.day
          )
          AND NOT EXISTS (
            SELECT 1 FROM meta_ad_daily invalid_ad
            WHERE invalid_ad.business_id = pointer.business_id
              AND invalid_ad.provider_account_id = pointer.provider_account_id
              AND invalid_ad.date = pointer.day
              AND NOT (invalid_ad.source_run_id = pointer.published_by_run_id
                AND invalid_ad.truth_state = 'finalized'
                AND invalid_ad.validation_status = 'passed'
                AND invalid_ad.finalized_at IS NOT NULL
                AND invalid_ad.finalized_at <= ${cutoff}
                AND invalid_ad.created_at <= ${cutoff}
                AND invalid_ad.updated_at <= ${cutoff})
          )
      )`;
  const badAccountDays = `${badSourceDays} UNION ${missingPublishedDays}`;
  if (!businessIdSql) return `NOT EXISTS (${badAccountDays})`;
  // The set of bad account-days is independent of the candidate creative.
  // Materialize it once, then map it to every creative that appeared in each
  // affected physical account during the decision window. A whole missing
  // creative day therefore blocks the candidate without rescanning D101 for
  // each of its daily rows.
  return `ROW(${outer}.business_ref_id, ${outer}.creative_id) NOT IN (
    WITH bad_accounts AS MATERIALIZED (${badAccountDays})
    SELECT DISTINCT creative_source_account.business_ref_id, creative_source_account.creative_id
    FROM meta_creative_daily creative_source_account
    JOIN bad_accounts ON bad_accounts.provider_account_id = creative_source_account.provider_account_id
    WHERE creative_source_account.business_ref_id = ${businessIdSql}::uuid
      AND creative_source_account.date BETWEEN ${rangeStart} AND ${rangeEnd}
      ${providerAccountScopeSql ? `AND (${providerAccountScopeSql}::text IS NULL OR creative_source_account.provider_account_id = ${providerAccountScopeSql}::text)` : ""}
  )`;
}
