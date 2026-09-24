import type { DbClient } from "@/lib/db";
import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";
import { META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION } from "@/lib/meta/creatives-types";
import type {
  MetaAdDailyRow,
  MetaCreativeDailyRow,
} from "@/lib/meta/warehouse-types";

type AuthoritativeAdDailyWriter = (
  rows: MetaAdDailyRow[],
  options: { writeMode: "authoritative_fact" },
) => Promise<void>;

/**
 * Mirror creative fixture metrics into the authoritative Ad-day fact store.
 *
 * The strict Meta AOV reader accepts only current-schema, finalized, validated
 * facts whose complete timestamp chain is inside the requested day cutoff.
 * The shipped writer supplies the canonical account bindings and schema; the
 * fixture-only update moves its wall-clock insert timestamps back to the same
 * T02 finalization instant so yesterday-based tests remain cutoff-safe.
 */
export async function seedCanonicalMetaAdDailyFacts(input: {
  sql: DbClient;
  rows: MetaCreativeDailyRow[];
  write: AuthoritativeAdDailyWriter;
  /** Scope tests may explicitly seed a complete synthetic creative source day. */
  certifyCreativeDecisionSource?: boolean;
}) {
  if (input.rows.length === 0) return;

  const fixtureKeys = new Set<string>();
  const facts = input.rows.map((row): MetaAdDailyRow => {
    if (!row.adId) {
      throw new Error("Canonical Meta Ad-day fixtures require an ad id.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      throw new Error(`Canonical Meta Ad-day fixture date is invalid: ${row.date}`);
    }
    const fixtureKey = [
      row.businessId,
      row.providerAccountId,
      row.date,
      row.adId,
    ].join("\u0000");
    if (fixtureKeys.has(fixtureKey)) {
      throw new Error(`Duplicate canonical Meta Ad-day fixture: ${fixtureKey}`);
    }
    fixtureKeys.add(fixtureKey);
    return {
      businessId: row.businessId,
      providerAccountId: row.providerAccountId,
      date: row.date,
      campaignId: row.campaignId,
      adsetId: row.adsetId,
      adId: row.adId,
      adNameCurrent: row.creativeName,
      adNameHistorical: row.creativeName,
      adStatus: row.effectiveStatus ?? null,
      accountTimezone: row.accountTimezone,
      accountCurrency: row.accountCurrency,
      sourceSnapshotId: row.sourceSnapshotId,
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      reach: row.reach,
      frequency: row.frequency,
      conversions: row.conversions,
      revenue: row.revenue,
      roas: row.roas,
      cpa: row.cpa,
      ctr: row.ctr,
      cpc: row.cpc,
      linkClicks: row.linkClicks ?? null,
      truthState: "finalized",
      validationStatus: "passed",
      finalizedAt: `${row.date}T02:00:00.000Z`,
      metricSchemaVersion: META_CANONICAL_METRIC_SCHEMA_VERSION,
    };
  });

  await input.write(facts, { writeMode: "authoritative_fact" });

  const partitions = new Map<string, MetaAdDailyRow[]>();
  const creativePartitions = new Map<string, MetaCreativeDailyRow[]>();
  for (const fact of facts) {
    const key = `${fact.businessId}\u0000${fact.providerAccountId}\u0000${fact.date}`;
    const partition = partitions.get(key) ?? [];
    partition.push(fact);
    partitions.set(key, partition);
  }
  for (const row of input.rows) {
    const key = `${row.businessId}\u0000${row.providerAccountId}\u0000${row.date}`;
    const partition = creativePartitions.get(key) ?? [];
    partition.push(row);
    creativePartitions.set(key, partition);
  }

  for (const partition of partitions.values()) {
    const first = partition[0]!;
    const cutoffSafeAt = `${first.date}T02:00:00.000Z`;
    const sourceRunId = `fixture-creative-${first.businessId}-${first.providerAccountId}-${first.date}`;
    const updated = await input.sql.query<{ ad_id: string }>(
      `UPDATE meta_ad_daily
          SET created_at = $4::timestamptz,
              updated_at = $4::timestamptz,
              finalized_at = $4::timestamptz,
              source_run_id = CASE WHEN $6::boolean THEN $7::text ELSE source_run_id END
        WHERE business_id = $1::text
          AND provider_account_id = $2
          AND date = $3::date
          AND ad_id = ANY($5::text[])
        RETURNING ad_id`,
      [
        first.businessId,
        first.providerAccountId,
        first.date,
        cutoffSafeAt,
        partition.map((row) => row.adId),
        input.certifyCreativeDecisionSource === true,
        sourceRunId,
      ],
    );
    if (updated.length !== partition.length) {
      throw new Error(
        `Canonical Meta Ad-day fixture write mismatch for ${first.businessId}`
        + `/${first.providerAccountId}/${first.date}: expected ${partition.length}, updated ${updated.length}`,
      );
    }

    if (!input.certifyCreativeDecisionSource) continue;

    // These four account-scope tests exercise the shipped calibration and
    // serving paths, not D098 receipt adjudication. Supply explicit fixture
    // proof for their controlled provider facts; production writers cannot
    // mint this marker from creative membership alone.
    const creativePartitionKey = `${first.businessId}\u0000${first.providerAccountId}\u0000${first.date}`;
    const certifiedRows = creativePartitions.get(creativePartitionKey)!.map((row) => {
      if (!row.creativeId || !row.objective || !row.optimizationGoal) {
        throw new Error("Certified creative fixture needs identity and config.");
      }
      return {
        creative_id: row.creativeId,
        payload_json: {
          source_identity_version: META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION,
          source_ad_ids_complete: true,
          source_ad_ids: [row.adId],
          source_creative_ids: [row.creativeId],
          associated_ads_count: 1,
          source_parent_grain_complete: true,
          source_membership_scope: "all_provider_ad_days",
          reach_aggregation: "single_ad_provider_reach",
          historical_config_provenance: "provider_receipt_day_bracketed",
          historical_config_proof: {
            knowledge_cutoff_at: `${row.date}T03:00:00.000Z`,
            last_receipt_observed_at: `${row.date}T02:00:00.000Z`,
            objective: row.objective,
            optimization_goal: row.optimizationGoal,
            custom_event_type: null,
            custom_conversion_id: null,
            receipt_refs: ["synthetic_account_scope_fixture"],
          },
        },
      };
    });
    const certified = await input.sql.query<{ creative_id: string }>(
      `UPDATE meta_creative_daily creative
          SET payload_json = COALESCE(creative.payload_json, '{}'::jsonb) || fixture.payload_json,
              created_at = $4::timestamptz,
              updated_at = $4::timestamptz
         FROM jsonb_to_recordset($5::jsonb) AS fixture(creative_id text, payload_json jsonb)
        WHERE creative.business_id = $1
          AND creative.provider_account_id = $2
          AND creative.date = $3::date
          AND creative.creative_id = fixture.creative_id
        RETURNING creative.creative_id`,
      [first.businessId, first.providerAccountId, first.date, cutoffSafeAt,
        JSON.stringify(certifiedRows)],
    );
    if (certified.length !== partition.length) {
      throw new Error(`Certified creative fixture mismatch for ${first.businessId}/${first.providerAccountId}/${first.date}`);
    }

    const priorPublication = await input.sql.query<{
      active_slice_version_id: string;
      manifest_id: string;
      publication_reason: string;
    }>(
      `SELECT p.active_slice_version_id, s.manifest_id, p.publication_reason
       FROM meta_authoritative_publication_pointers p
       JOIN meta_authoritative_slice_versions s ON s.id=p.active_slice_version_id
        WHERE p.business_id = $1 AND p.provider_account_id = $2 AND p.day = $3::date
          AND p.surface = 'ad_daily'`,
      [first.businessId, first.providerAccountId, first.date],
    );
    if (priorPublication.length > 0) {
      if (priorPublication[0]!.publication_reason !== "certified_zero_ad_fixture") continue;
      // A later fixture batch can deliver on a day previously certified zero.
      // Retire that synthetic receipt before publishing the real Ad-day batch.
      await input.sql.query(`DELETE FROM meta_authoritative_publication_pointers
        WHERE business_id=$1 AND provider_account_id=$2 AND day=$3::date AND surface='ad_daily'`,
      [first.businessId, first.providerAccountId, first.date]);
      await input.sql.query(`DELETE FROM meta_authoritative_slice_versions WHERE id=$1::uuid`,
      [priorPublication[0]!.active_slice_version_id]);
      await input.sql.query(`DELETE FROM meta_authoritative_source_manifests WHERE id=$1::uuid`,
      [priorPublication[0]!.manifest_id]);
    }

    const publishedAt = new Date(`${first.date}T00:00:00.000Z`);
    publishedAt.setUTCDate(publishedAt.getUTCDate() + 1);
    const publishedAtIso = publishedAt.toISOString();
    const [manifest] = await input.sql.query<{ id: string }>(
      `INSERT INTO meta_authoritative_source_manifests (
         business_id, provider_account_id, day, surface, account_timezone,
         source_kind, source_window_kind, run_id, fetch_status,
         started_at, completed_at, created_at, updated_at
       ) VALUES ($1, $2, $3::date, 'account_daily', $4, 'meta_insights',
         'complete_day', $5, 'completed', $6::timestamptz,
         $7::timestamptz, $7::timestamptz, $7::timestamptz) RETURNING id`,
      [first.businessId, first.providerAccountId, first.date, first.accountTimezone,
        sourceRunId, cutoffSafeAt, publishedAtIso],
    );
    const [slice] = await input.sql.query<{ id: string }>(
      `INSERT INTO meta_authoritative_slice_versions (
         business_id, provider_account_id, day, surface, manifest_id,
         candidate_version, state, truth_state, validation_status, status,
         source_run_id, staged_row_count, published_at, created_at, updated_at
       ) VALUES ($1, $2, $3::date, 'ad_daily', $4::uuid, 1,
         'finalized_verified', 'finalized', 'passed', 'published',
         $5, $7::integer, $6::timestamptz, $6::timestamptz, $6::timestamptz) RETURNING id`,
      [first.businessId, first.providerAccountId, first.date, manifest!.id,
        sourceRunId, publishedAtIso, partition.length],
    );
    await input.sql.query(
      `INSERT INTO meta_authoritative_publication_pointers (
         business_id, provider_account_id, day, surface, active_slice_version_id,
         published_by_run_id, publication_reason, published_at, created_at, updated_at
       ) VALUES ($1, $2, $3::date, 'ad_daily', $4::uuid, $5,
         'certified_account_scope_fixture', $6::timestamptz,
         $6::timestamptz, $6::timestamptz)`,
      [first.businessId, first.providerAccountId, first.date, slice!.id,
        sourceRunId, publishedAtIso],
    );

    // D101 requires a complete account-day window, including measured zero
    // days before this fixture's first delivered Ad. These are explicit
    // synthetic zero-Ad source receipts, never inferred from missing rows.
    // Refuse to stamp a zero receipt over any existing Ad fact.
    await input.sql.query(
      `WITH zero_days AS (
         SELECT generated.day::date AS day
         FROM generate_series($3::date - INTERVAL '89 days',
           $3::date - INTERVAL '1 day', INTERVAL '1 day') generated(day)
         WHERE NOT EXISTS (
           SELECT 1 FROM meta_ad_daily a
           WHERE a.business_id=$1 AND a.provider_account_id=$2
             AND a.date=generated.day::date
         )
           AND NOT EXISTS (
             SELECT 1 FROM meta_authoritative_publication_pointers p
             WHERE p.business_id=$1 AND p.provider_account_id=$2
               AND p.day=generated.day::date AND p.surface='ad_daily'
           )
       ), manifests AS (
         INSERT INTO meta_authoritative_source_manifests (
           business_id, provider_account_id, day, surface, account_timezone,
           source_kind, source_window_kind, run_id, fetch_status,
           started_at, completed_at, created_at, updated_at
         ) SELECT $1, $2, day, 'account_daily', $4, 'meta_insights',
           'complete_day', 'fixture-zero-' || $2 || '-' || day::text, 'completed',
           ((day + INTERVAL '1 day')::timestamp AT TIME ZONE $4::text) - INTERVAL '1 hour',
           ((day + INTERVAL '1 day')::timestamp AT TIME ZONE $4::text),
           ((day + INTERVAL '1 day')::timestamp AT TIME ZONE $4::text),
           ((day + INTERVAL '1 day')::timestamp AT TIME ZONE $4::text)
         FROM zero_days RETURNING id, day, run_id, completed_at
       ), slices AS (
         INSERT INTO meta_authoritative_slice_versions (
           business_id, provider_account_id, day, surface, manifest_id,
           candidate_version, state, truth_state, validation_status, status,
           source_run_id, staged_row_count, published_at, created_at, updated_at
         ) SELECT $1, $2, m.day, 'ad_daily', m.id, 1,
           'finalized_verified', 'finalized', 'passed', 'published',
           m.run_id, 0, m.completed_at, m.completed_at, m.completed_at
         FROM manifests m RETURNING id, day, source_run_id, published_at
       )
       INSERT INTO meta_authoritative_publication_pointers (
         business_id, provider_account_id, day, surface, active_slice_version_id,
         published_by_run_id, publication_reason, published_at, created_at, updated_at
       ) SELECT $1, $2, s.day, 'ad_daily', s.id, s.source_run_id,
         'certified_zero_ad_fixture', s.published_at, s.published_at, s.published_at
       FROM slices s`,
      [first.businessId, first.providerAccountId, first.date, first.accountTimezone],
    );
  }
}
