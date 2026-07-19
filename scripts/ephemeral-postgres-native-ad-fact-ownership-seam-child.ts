/**
 * Native-Ad decision-fact ownership proof against the migrations-from-zero DB.
 *
 * This file is intentionally a child of ephemeral-postgres-migrations-check:
 * it refuses every database except that parent's isolated, freshly migrated
 * PostgreSQL database.
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  buildAdRecommendationEpisode,
  type AdRecommendationEpisode,
} from "@/lib/creative-decision-engine/ad-operator-response-detection";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  createDecisionOriginAdActionIdempotencyKey,
  type DecisionOriginAdExecutionRequest,
} from "@/lib/creative-decision-engine/execution-safety";
import { AD_DECISION_EVALUATION_CONTRACT_VERSION } from "@/lib/creative-decision-engine/evaluation-store";
import {
  READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
  READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import { persistAdRecommendationEpisodes } from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  getDb,
  resetDbClientCache,
  runDbTransaction,
} from "@/lib/db";
import { pruneMetaCreativeMediaOutsideRetention } from "@/lib/meta/cleanup";
import {
  getMetaAdDailyRange,
  upsertMetaAdDailyRows,
  upsertMetaCreativeDailyRows,
  upsertMetaCreativeMediaRows,
} from "@/lib/meta/warehouse";
import {
  DECISION_ORIGIN_PENDING_RECONCILIATION_CODE,
  DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
  INSERT_MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_QUERY,
  MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
  MANUAL_META_AD_STATUS_WRITE_VERIFICATION_CONTRACT_VERSION,
  appendManualMetaAdStatusReconciliationEvent,
  appendManualMetaAdStatusMutationAttemptCompleted,
  appendManualMetaAdStatusMutationAttemptStarted,
  completeDecisionOriginMetaAdsActionLog,
  completeMetaAdsActionLog,
  createDecisionOriginMetaAdsActionLog,
  createMetaAdsActionLog,
  markDecisionOriginActionReconciliationRequired,
  readManualMetaAdStatusReconciliationCandidate,
  reconcileManualMetaAdStatusAndCreateClaim,
  type ManualMetaAdStatusMutationAttemptEvent,
  type ManualMetaProviderMutationAttemptReceipt,
  type MetaAdsActionLogRow,
} from "@/lib/meta/ads-action-log";
import type { MetaAdDailyRow } from "@/lib/meta/warehouse-types";

const EPHEMERAL_DB_NAME = "adsecute_migrations_from_zero";
const AS_OF_DATE = "2026-07-18";
const SAFE_DATE = "2026-07-17";
const LEGACY_MEDIA_DATE = "2025-01-01";
const CUTOFF = "2026-07-18T03:15:00.000Z";
const AFTER_CUTOFF = "2026-07-18T03:15:00.001Z";
const PROVIDER_ACCOUNT_ID = "act_native_fact_ownership_migrated_seam";
const SAFE_AD_ID = "990000000000001";
const UNSAFE_AD_ID = "990000000000002";
const LEGACY_MEDIA_AD_ID = "990000000000003";
const SAFE_CAMPAIGN_ID = "770000000000001";
const SAFE_ADSET_ID = "660000000000001";
const SAFE_CREATIVE_ID = "880000000000001";
const MANUAL_NO_START_AD_ID = "990000000000010";
const MANUAL_STARTED_ONLY_AD_ID = "990000000000011";
const MANUAL_VERIFIED_COMPLETION_AD_ID = "990000000000012";
const MANUAL_FAILURE_COMPLETION_AD_ID = "990000000000013";
const MANUAL_MULTIPLE_SOURCE_AD_ID = "990000000000014";
const MANUAL_LEGACY_QUARANTINE_AD_ID = "990000000000015";
const MANUAL_SAME_MILLISECOND_AD_ID = "990000000000016";
const MANUAL_STORE_DRIFT_AD_ID = "990000000000017";
const MANUAL_DATABASE_DRIFT_AD_ID = "990000000000018";
const MANUAL_UNAUTHORIZED_TERMINAL_AD_ID = "990000000000019";
const MANUAL_PRE_PROVIDER_FAILURE_AD_ID = "990000000000020";
const MANUAL_VERIFIED_TERMINAL_AD_ID = "990000000000021";
const MANUAL_AMBIGUOUS_TERMINAL_AD_ID = "990000000000022";
const MANUAL_TERMINAL_DRIFT_AD_ID = "990000000000023";
const MANUAL_START_WINS_RACE_AD_ID = "990000000000024";
const MANUAL_TERMINAL_WINS_RACE_AD_ID = "990000000000025";
const MANUAL_COMPLETION_WINS_RACE_AD_ID = "990000000000026";
const MANUAL_BACKDATED_CREATED_AT_AD_ID = "990000000000027";
const MANUAL_RECONCILIATION_WINS_RACE_AD_ID = "990000000000028";
const MANUAL_RECONCILED_RAW_ATTEMPT_ID =
  "11111111-1111-4111-8111-111111111117";

interface IdRow {
  id: string;
}

interface FullRowHash {
  date: string;
  ad_id: string;
  row_bytes: string;
  row_hash: string;
}

interface DecisionLineageRow {
  scope_type: "account" | "campaign";
  scope_id: string;
  snapshot_id: string;
  evaluation_id: string;
  input_hash: string;
  decision_hash: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function capturedError(operation: () => Promise<unknown>) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error;
  }
}

async function assertPromisePending(
  promise: Promise<unknown>,
  label: string,
) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert(!settled, `${label} did not serialize on the source row lock.`);
}

async function waitForAdvisoryBarrierWaiter(
  client: Client,
  advisoryKey: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiters = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid::bigint = 0
         AND objid::bigint = $1::bigint
         AND NOT granted`,
      [advisoryKey],
    );
    if (Number(waiters.rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the reconciliation barrier.");
}

function assertEphemeralMigratedDatabase() {
  if (process.env.ADSECUTE_EPHEMERAL_DB_SEAM !== "1") {
    throw new Error(
      "Refusing native fact ownership proof outside the ephemeral migration seam.",
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const parsed = new URL(databaseUrl);
  const port = Number(parsed.port || "5432");
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (
    parsed.hostname !== "127.0.0.1" ||
    port === 5432 ||
    port === 15432 ||
    databaseName !== EPHEMERAL_DB_NAME
  ) {
    throw new Error(
      "Refusing native fact ownership proof against a non-migrations-from-zero database.",
    );
  }
  return databaseUrl;
}

function timestamp(value: unknown) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  assert(
    Number.isFinite(parsed.getTime()),
    `Expected timestamp, received ${String(value)}.`,
  );
  return parsed.toISOString();
}

function date(value: unknown) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value ?? "").slice(0, 10);
}

function number(value: unknown) {
  const parsed = Number(value);
  assert(Number.isFinite(parsed), `Expected finite number, received ${String(value)}.`);
  return parsed;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function assertSameBytes(left: unknown, right: unknown, label: string) {
  const leftBytes = stableJson(left);
  const rightBytes = stableJson(right);
  assert(
    leftBytes === rightBytes,
    `${label} diverged.\nleft=${leftBytes}\nright=${rightBytes}`,
  );
}

function authoritativeFact(input: {
  businessId: string;
  date: string;
  adId: string;
  campaignId: string;
  adsetId: string;
  creativeId: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  linkClicks: number;
  payload: Record<string, unknown>;
}): MetaAdDailyRow {
  return {
    businessId: input.businessId,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    date: input.date,
    campaignId: input.campaignId,
    adsetId: input.adsetId,
    adId: input.adId,
    adNameCurrent: `Current ${input.adId}`,
    adNameHistorical: `Historical ${input.adId}`,
    adStatus: "ACTIVE",
    destinationUrl: `https://example.invalid/${input.adId}`,
    destinationUrlRaw: `https://example.invalid/${input.adId}?raw=1`,
    destinationUrlSource: "authoritative_insights",
    destinationUrlConfidence: "exact",
    ctaType: "SHOP_NOW",
    objectStoryId: `story_${input.adId}`,
    effectiveObjectStoryId: `effective_story_${input.adId}`,
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "TRY",
    spend: input.spend,
    impressions: input.impressions,
    clicks: input.clicks,
    reach: Math.floor(input.impressions * 0.8),
    frequency: 1.25,
    conversions: input.conversions,
    revenue: input.revenue,
    roas: input.spend > 0 ? input.revenue / input.spend : 0,
    cpa: input.conversions > 0 ? input.spend / input.conversions : null,
    ctr:
      input.impressions > 0 ? (input.clicks / input.impressions) * 100 : null,
    cpc: input.clicks > 0 ? input.spend / input.clicks : null,
    linkClicks: input.linkClicks,
    sourceSnapshotId: null,
    truthState: "finalized",
    truthVersion: 7,
    finalizedAt: "2026-07-18T03:14:00.000Z",
    validationStatus: "passed",
    sourceRunId: `native-fact-owner-${input.adId}`,
    metricSchemaVersion: 3,
    payloadJson: {
      creative_id: input.creativeId,
      ...input.payload,
    },
  };
}

function warehouseProjection(row: MetaAdDailyRow) {
  return {
    businessId: row.businessId,
    providerAccountId: row.providerAccountId,
    date: date(row.date),
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    adId: row.adId,
    accountTimezone: row.accountTimezone,
    accountCurrency: row.accountCurrency,
    spend: number(row.spend),
    impressions: number(row.impressions),
    clicks: number(row.clicks),
    linkClicks: number(row.linkClicks),
    conversions: number(row.conversions),
    revenue: number(row.revenue),
    metricSchemaVersion: number(row.metricSchemaVersion),
    truthState: row.truthState,
    validationStatus: row.validationStatus,
    finalizedAt: timestamp(row.finalizedAt),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    payloadJson: row.payloadJson,
  };
}

function storedProjection(row: Record<string, unknown>) {
  return {
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    date: date(row.date),
    campaignId: row.campaign_id == null ? null : String(row.campaign_id),
    adsetId: row.adset_id == null ? null : String(row.adset_id),
    adId: String(row.ad_id),
    accountTimezone: String(row.account_timezone),
    accountCurrency: String(row.account_currency),
    spend: number(row.spend),
    impressions: number(row.impressions),
    clicks: number(row.clicks),
    linkClicks: number(row.link_clicks),
    conversions: number(row.conversions),
    revenue: number(row.revenue),
    metricSchemaVersion: number(row.metric_schema_version),
    truthState: String(row.truth_state),
    validationStatus: String(row.validation_status),
    finalizedAt: timestamp(row.finalized_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    payloadJson: row.payload_json,
  };
}

function calibrationProjection(row: Record<string, unknown>) {
  return {
    businessId: String(row.business_id),
    providerAccountRefId: String(row.provider_account_ref_id),
    providerAccountId: String(row.provider_account_id),
    date: date(row.date),
    campaignId: row.campaign_id == null ? null : String(row.campaign_id),
    adsetId: row.adset_id == null ? null : String(row.adset_id),
    adId: String(row.ad_id),
    accountTimezone: String(row.account_timezone),
    accountCurrency: String(row.account_currency),
    spend: number(row.spend),
    impressions: number(row.impressions),
    clicks: number(row.clicks),
    linkClicks: number(row.link_clicks),
    conversions: number(row.conversions),
    revenue: number(row.revenue),
    metricSchemaVersion: number(row.metric_schema_version),
    truthState: String(row.truth_state),
    validationStatus: String(row.validation_status),
    finalizedAt: timestamp(row.finalized_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    landingPageViews: number(row.landing_page_views),
    addToCart: number(row.add_to_cart),
    initiateCheckout: number(row.initiate_checkout),
    objective: String(row.objective),
    optimizationGoal: String(row.optimization_goal),
    customEventType: String(row.custom_event_type),
  };
}

function warehouseCalibrationProjection(
  row: MetaAdDailyRow,
  providerAccountRefId: string,
) {
  const payload =
    row.payloadJson && typeof row.payloadJson === "object"
      ? (row.payloadJson as Record<string, unknown>)
      : {};
  return {
    businessId: row.businessId,
    providerAccountRefId,
    providerAccountId: row.providerAccountId,
    date: date(row.date),
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    adId: row.adId,
    accountTimezone: row.accountTimezone,
    accountCurrency: row.accountCurrency,
    spend: number(row.spend),
    impressions: number(row.impressions),
    clicks: number(row.clicks),
    linkClicks: number(row.linkClicks),
    conversions: number(row.conversions),
    revenue: number(row.revenue),
    metricSchemaVersion: number(row.metricSchemaVersion),
    truthState: row.truthState,
    validationStatus: row.validationStatus,
    finalizedAt: timestamp(row.finalizedAt),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    landingPageViews: number(payload.landing_page_views),
    addToCart: number(payload.add_to_cart),
    initiateCheckout: number(payload.initiate_checkout),
    objective: "OUTCOME_SALES",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    customEventType: "PURCHASE",
  };
}

async function assertMigratedSchema(client: Client) {
  const result = await client.query<{
    native_calibration: string | null;
    meta_ad_daily: string | null;
    meta_creative_media: string | null;
    business_ref_column_count: string;
    provider_ref_column_count: string;
  }>(`
    SELECT
      to_regclass('public.engine_v3_ad_account_calibration_batches')::text
        AS native_calibration,
      to_regclass('public.meta_ad_daily')::text AS meta_ad_daily,
      to_regclass('public.meta_creative_media')::text AS meta_creative_media,
      (
        SELECT COUNT(*)::text
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'meta_ad_daily', 'meta_campaign_daily', 'meta_adset_daily'
          )
          AND column_name = 'business_ref_id'
      ) AS business_ref_column_count,
      (
        SELECT COUNT(*)::text
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'meta_ad_daily', 'meta_campaign_daily', 'meta_adset_daily'
          )
          AND column_name = 'provider_account_ref_id'
      ) AS provider_ref_column_count
  `);
  const row = result.rows[0];
  assert(
    row?.native_calibration === "engine_v3_ad_account_calibration_batches" &&
      row.meta_ad_daily === "meta_ad_daily" &&
      row.meta_creative_media === "meta_creative_media" &&
      row.business_ref_column_count === "3" &&
      row.provider_ref_column_count === "3",
    `Native fact ownership seam did not receive the fully migrated schema: ${stableJson(row)}`,
  );
}

async function readFullRowHashes(
  client: Client,
  businessId: string,
): Promise<FullRowHash[]> {
  const result = await client.query<FullRowHash>(
    `SELECT
       date::text AS date,
       ad_id,
       to_jsonb(fact)::text AS row_bytes,
       encode(digest(to_jsonb(fact)::text, 'sha256'), 'hex') AS row_hash
     FROM meta_ad_daily AS fact
     WHERE business_id = $1
     ORDER BY date, ad_id`,
    [businessId],
  );
  return result.rows;
}

async function createDecisionOriginFixtures(input: {
  client: Client;
  businessId: string;
  providerAccountRefId: string;
}) {
  const { client, businessId, providerAccountRefId } = input;
  const jobRun = await client.query<IdRow>(
    `INSERT INTO engine_v3_job_runs (
       job_name, business_ref_id, business_id, as_of_date, engine_version,
       status, finished_at, row_count
     ) VALUES (
       'native-ad-migrated-action-seam', $1::uuid, $1::text, $2::date, $3,
       'success', $4::timestamptz, 2
     )
     RETURNING id::text AS id`,
    [businessId, AS_OF_DATE, NATIVE_AD_ENGINE_VERSION, CUTOFF],
  );
  const jobRunId = jobRun.rows[0]?.id;
  assert(jobRunId, "Could not create migrated action-seam job lineage.");

  const provenance = {
    mode: "current_transaction_snapshot",
    providerAccountRefId,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    transactionCutoff: CUTOFF,
    transactionIsolation: "repeatable read",
  };
  const batch = await client.query<IdRow>(
    `INSERT INTO engine_v3_ad_account_calibration_batches (
       business_ref_id, business_id, provider, provider_account_ref_id,
       provider_account_id, as_of_date, as_of_cutoff, transaction_isolation,
       engine_version, policy_version, source_mode, source_provenance_json,
       expected_cell_count, generation_content_hash, input_manifest_hash,
       source_manifest_hash, cell_set_hash, completeness_status, job_run_id,
       computed_at
     ) VALUES (
       $1::uuid, $1::text, 'meta', $2::uuid, $3, $4::date, $5::timestamptz,
       'repeatable read', $6, 'migrated-action-seam.v1',
       'current_transaction_snapshot', $7::jsonb, 1, repeat('a', 64),
       repeat('b', 64), repeat('c', 64), repeat('d', 64), 'writing',
       $8::uuid, $5::timestamptz
     )
     RETURNING id::text AS id`,
    [
      businessId,
      providerAccountRefId,
      PROVIDER_ACCOUNT_ID,
      AS_OF_DATE,
      CUTOFF,
      NATIVE_AD_ENGINE_VERSION,
      JSON.stringify(provenance),
      jobRunId,
    ],
  );
  const batchId = batch.rows[0]?.id;
  assert(batchId, "Could not create migrated action-seam calibration batch.");

  const calibration = await client.query<IdRow>(
    `INSERT INTO engine_v3_ad_account_calibration_daily (
       batch_id, business_ref_id, business_id, provider,
       provider_account_ref_id, provider_account_id, account_timezone,
       account_currency, cell_scope, objective, funnel_cohort,
       optimization_context, as_of_date, as_of_cutoff, engine_version,
       policy_version, sample_window_start, sample_window_end,
       sample_window_days, source_ad_count, source_day_count,
       eligible_ad_count, mature_ad_count, zero_conversion_ad_count,
       roas_p75, roas_p60, refresh_ratio_p10, low_ctr_p10, account_cpa_p50,
       account_cpa_sample_count, meta_attributed_aov_mean_90d,
       meta_attributed_aov_purchase_count_90d, meta_attributed_revenue_90d,
       meta_aov_quality, mature_spend_p50, mature_spend_p75,
       winner_spend_p25, winner_spend_p50, winner_purchase_p50,
       roas_ratio_p10, roas_ratio_p25, roas_ratio_p50, roas_ratio_p75,
       funnel_calibration_json, metric_sample_counts_json,
       action_readiness_json, quality_counts_json, quality_status,
       target_authority_status, target_roas, break_even_roas,
       target_effective_at, target_recorded_at, target_authority_hash,
       source_min_date, source_max_date, source_max_updated_at,
       batch_input_manifest_hash, input_manifest_hash, source_manifest_hash,
       job_run_id, computed_at
     ) VALUES (
       $1::uuid, $2::uuid, $2::text, 'meta', $3::uuid, $4, 'Europe/Istanbul',
       'TRY', 'objective_cohort_context', 'OUTCOME_SALES', 'purchase',
       'OFFSITE_CONVERSIONS:PURCHASE', $5::date, $6::timestamptz, $7,
       'migrated-action-seam.v1', '2026-04-19'::date, $8::date, 90,
       1, 1, 1, 1, 0, 3.2, 3.0, 0.7, 1.0, 24.69, 1, 80, 5, 400,
       'ready', 123.45, 123.45, 123.45, 123.45, 5, 0.5, 0.6, 0.8, 1.0,
       '{}'::jsonb, '{}'::jsonb, '{"hardActionEligible":true}'::jsonb,
       '{}'::jsonb, 'ready', 'fresh', 2, 1.5,
       '2026-07-17T00:00:00Z'::timestamptz,
       '2026-07-17T00:00:00Z'::timestamptz, repeat('e', 64),
       $8::date, $8::date, $6::timestamptz, repeat('b', 64),
       repeat('f', 64), repeat('c', 64), $9::uuid, $6::timestamptz
     )
     RETURNING id::text AS id`,
    [
      batchId,
      businessId,
      providerAccountRefId,
      PROVIDER_ACCOUNT_ID,
      AS_OF_DATE,
      CUTOFF,
      NATIVE_AD_ENGINE_VERSION,
      SAFE_DATE,
      jobRunId,
    ],
  );
  const calibrationRowId = calibration.rows[0]?.id;
  assert(
    calibrationRowId,
    "Could not create migrated action-seam calibration cell.",
  );
  const completedBatch = await client.query<IdRow>(
    `UPDATE engine_v3_ad_account_calibration_batches
     SET completeness_status = 'complete', completed_at = $2::timestamptz
     WHERE id = $1::uuid AND completeness_status = 'writing'
     RETURNING id::text AS id`,
    [batchId, CUTOFF],
  );
  assert(
    completedBatch.rows.length === 1,
    "Migrated action-seam calibration batch did not complete exactly.",
  );

  const scopeFixtures = [
    {
      scopeType: "account" as const,
      scopeId: PROVIDER_ACCOUNT_ID,
      contextHash: "1".repeat(64),
      inputHash: "3".repeat(64),
      decisionHash: "4".repeat(64),
    },
    {
      scopeType: "campaign" as const,
      scopeId: SAFE_CAMPAIGN_ID,
      contextHash: "2".repeat(64),
      inputHash: "5".repeat(64),
      decisionHash: "6".repeat(64),
    },
  ];
  const lineages: DecisionLineageRow[] = [];
  for (const fixture of scopeFixtures) {
    const context = await client.query<IdRow>(
      `INSERT INTO engine_v3_ad_decision_evaluation_contexts (
         business_ref_id, business_id, provider_account_ref_id,
         provider_account_id, as_of_date, engine_version, scope_type,
         scope_id, contract_version, context_json, account_profile_json,
         data_health_json, flags_json, context_hash, job_run_id, evaluated_at
       ) VALUES (
         $1::uuid, $1::text, $2::uuid, $3, $4::date, $5, $6, $7, $8,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $9,
         $10::uuid, $11::timestamptz
       )
       RETURNING id::text AS id`,
      [
        businessId,
        providerAccountRefId,
        PROVIDER_ACCOUNT_ID,
        AS_OF_DATE,
        NATIVE_AD_ENGINE_VERSION,
        fixture.scopeType,
        fixture.scopeId,
        AD_DECISION_EVALUATION_CONTRACT_VERSION,
        fixture.contextHash,
        jobRunId,
        CUTOFF,
      ],
    );
    const contextId = context.rows[0]?.id;
    assert(contextId, "Could not create migrated action-seam context.");

    const creativeInput = {
      adId: SAFE_AD_ID,
      creativeId: SAFE_CREATIVE_ID,
      campaignId: SAFE_CAMPAIGN_ID,
      adsetId: SAFE_ADSET_ID,
    };
    const evaluation = await client.query<IdRow>(
      `INSERT INTO engine_v3_ad_decision_evaluations (
         context_id, business_ref_id, business_id, provider_account_ref_id,
         provider_account_id, decision_entity_type, decision_entity_id, ad_id,
         creative_id, as_of_date, engine_version, scope_type, scope_id,
         contract_version, creative_input_json, campaign_context_json,
         prior_hysteresis_json, decision_output_json, raw_label,
         hysteresis_suppressed, input_hash, decision_hash, job_run_id,
         evaluated_at
       ) VALUES (
         $1::uuid, $2::uuid, $2::text, $3::uuid, $4, 'ad', $5, $5, $6,
         $7::date, $8, $9, $10, $11, $12::jsonb, '{}'::jsonb, '{}'::jsonb,
         '{"label":"cut"}'::jsonb, 'cut', false, $13, $14, $15::uuid,
         $16::timestamptz
       )
       RETURNING id::text AS id`,
      [
        contextId,
        businessId,
        providerAccountRefId,
        PROVIDER_ACCOUNT_ID,
        SAFE_AD_ID,
        SAFE_CREATIVE_ID,
        AS_OF_DATE,
        NATIVE_AD_ENGINE_VERSION,
        fixture.scopeType,
        fixture.scopeId,
        AD_DECISION_EVALUATION_CONTRACT_VERSION,
        JSON.stringify(creativeInput),
        fixture.inputHash,
        fixture.decisionHash,
        jobRunId,
        CUTOFF,
      ],
    );
    const evaluationId = evaluation.rows[0]?.id;
    assert(evaluationId, "Could not create migrated action-seam evaluation.");

    const snapshot = await client.query<IdRow>(
      `INSERT INTO engine_v3_ad_decision_snapshots_daily (
         business_ref_id, business_id, provider_account_ref_id,
         provider_account_id, decision_entity_type, decision_entity_id, ad_id,
         creative_id, as_of_date, engine_version, scope_type, scope_id, label,
         raw_label, pre_authority_label, authority_blocker, confidence,
         truth_source, effective_target_roas, ratio_to_target, badges, reason,
         spend, purchases, roas, recent7d_roas, label_transform,
         blocked_action_type, authorized_action, job_run_id,
         creative_evidence_lifecycle_row_id, calibration_row_id, evaluation_id,
         input_hash, decision_hash, computed_at
       ) VALUES (
         $1::uuid, $1::text, $2::uuid, $3, 'ad', $4, $4, $5, $6::date, $7,
         $8, $9, 'cut', 'cut', 'cut', NULL, 92, 'commercial_truth', 2, 0.5,
         '[]'::jsonb, 'Migrated action claim seam hard Cut.', 123.45, 5, 3.2,
         3.2, NULL, NULL, 'cut', $10::uuid, NULL, $11::uuid, $12::uuid,
         $13, $14, $15::timestamptz
       )
       RETURNING id::text AS id`,
      [
        businessId,
        providerAccountRefId,
        PROVIDER_ACCOUNT_ID,
        SAFE_AD_ID,
        SAFE_CREATIVE_ID,
        AS_OF_DATE,
        NATIVE_AD_ENGINE_VERSION,
        fixture.scopeType,
        fixture.scopeId,
        jobRunId,
        calibrationRowId,
        evaluationId,
        fixture.inputHash,
        fixture.decisionHash,
        CUTOFF,
      ],
    );
    const snapshotId = snapshot.rows[0]?.id;
    assert(snapshotId, "Could not create migrated action-seam snapshot.");
    lineages.push({
      scope_type: fixture.scopeType,
      scope_id: fixture.scopeId,
      snapshot_id: snapshotId,
      evaluation_id: evaluationId,
      input_hash: fixture.inputHash,
      decision_hash: fixture.decisionHash,
    });
  }

  const episodes = lineages.map((lineage) =>
    buildAdRecommendationEpisode({
      businessId,
      businessDisplayId: businessId,
      providerAccountRefId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      adId: SAFE_AD_ID,
      creativeId: SAFE_CREATIVE_ID,
      asOfDate: AS_OF_DATE,
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      scopeType: lineage.scope_type,
      scopeId: lineage.scope_id,
      snapshotId: lineage.snapshot_id,
      evaluationId: lineage.evaluation_id,
      inputHash: lineage.input_hash,
      decisionHash: lineage.decision_hash,
      decisionLabel: "cut",
      sourceCampaignId: SAFE_CAMPAIGN_ID,
      sourceAdsetId: SAFE_ADSET_ID,
      recommendedAt: CUTOFF,
    }),
  );
  const captured = await persistAdRecommendationEpisodes(
    episodes,
    CUTOFF,
    jobRunId,
  );
  assert(captured === 2, "Migrated action seam did not persist both episodes.");
  return episodes;
}

function decisionOriginRequest(
  episode: AdRecommendationEpisode,
): DecisionOriginAdExecutionRequest {
  assert(
    episode.creativeId,
    "Decision-origin seam episode requires a creative identity.",
  );
  const base = {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: episode.businessId,
    providerAccountId: episode.providerAccountId,
    adId: episode.adId,
    snapshotId: episode.snapshotId,
    evaluationId: episode.evaluationId,
    engineVersion: episode.engineVersion,
    decisionHash: episode.decisionHash,
    action: "pause",
    creativeId: episode.creativeId,
  } satisfies Omit<DecisionOriginAdExecutionRequest, "idempotencyKey">;
  return {
    ...base,
    idempotencyKey: createDecisionOriginAdActionIdempotencyKey(base),
  };
}

function statusClaimConflictEvidence(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    code?: unknown;
    blockingActionLogId?: unknown;
    blockingOrigin?: unknown;
    reconciliationRequired?: unknown;
  };
  return typeof candidate.code === "string" &&
    typeof candidate.blockingActionLogId === "string" &&
    typeof candidate.blockingOrigin === "string"
    ? {
        code: candidate.code,
        blockingActionLogId: candidate.blockingActionLogId,
        blockingOrigin: candidate.blockingOrigin,
        reconciliationRequired:
          candidate.reconciliationRequired === true,
      }
    : null;
}

async function verifyCrossOriginStatusClaims(input: {
  client: Client;
  businessId: string;
  requestedBy: string;
  episodes: AdRecommendationEpisode[];
}) {
  const { client, businessId, requestedBy, episodes } = input;
  const nativeRequest = decisionOriginRequest(episodes[0]!);
  const manualClaim = () =>
    createMetaAdsActionLog({
      businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      adId: SAFE_AD_ID,
      creativeId: SAFE_CREATIVE_ID,
      action: "pause",
      source: "manual_operator_v1",
      requestedBy,
      payloadRequest: {
        seam: "shared-status-claim",
        action_origin: "manual_operator_v1",
      },
    });
  const clearClaims = async () => {
    await client.query(
      `DELETE FROM meta_ads_action_log
       WHERE business_id = $1::uuid
         AND ad_id = $2
         AND action IN ('pause', 'resume')`,
      [businessId, SAFE_AD_ID],
    );
  };

  const manualAttempts = await Promise.allSettled([manualClaim(), manualClaim()]);
  const manualWinners = manualAttempts.filter(
    (
      result,
    ): result is PromiseFulfilledResult<MetaAdsActionLogRow> =>
      result.status === "fulfilled",
  );
  const manualLosers = manualAttempts.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const manualConflict = statusClaimConflictEvidence(
    manualLosers[0]?.reason,
  );
  assert(
    manualWinners.length === 1 &&
      manualLosers.length === 1 &&
      manualConflict?.code === "action_in_flight" &&
      manualConflict.blockingOrigin === "manual_operator_v1",
    `Concurrent manual/manual claims did not serialize fail-closed: ${stableJson(manualAttempts.map((result) => result.status === "fulfilled" ? { status: result.status, id: result.value.id } : { status: result.status, error: statusClaimConflictEvidence(result.reason) }))}`,
  );
  const manualRows = await client.query<{
    id: string;
    provider_account_id: string | null;
    status: string;
  }>(
    `SELECT id::text, provider_account_id, status
     FROM meta_ads_action_log
     WHERE business_id = $1::uuid
       AND ad_id = $2
       AND action = 'pause'
       AND status = 'pending'`,
    [businessId, SAFE_AD_ID],
  );
  assert(
    manualRows.rows.length === 1 &&
      manualRows.rows[0]?.provider_account_id === PROVIDER_ACCOUNT_ID,
    `Manual shared claim did not persist exactly one exact provider-account row: ${stableJson(manualRows.rows)}`,
  );
  const manualWinner = manualWinners[0]!.value;
  const manualSuccess = {
    id: manualWinner.id,
    status: "success" as const,
    payloadResponse: {
      success: true,
      seam: "manual-terminal-cas",
    },
    verificationPayload: {
      id: SAFE_AD_ID,
      status: "PAUSED",
    },
  };
  const completedManual = await completeMetaAdsActionLog({
    ...manualSuccess,
    durationMs: 10,
    verifiedAt: CUTOFF,
  });
  const replayedManual = await completeMetaAdsActionLog({
    ...manualSuccess,
    durationMs: 10,
    verifiedAt: CUTOFF,
  });
  assert(
    completedManual.status === "success" &&
      replayedManual.id === completedManual.id &&
      replayedManual.status === "success",
    `An identical manual terminal completion was not idempotent: ${stableJson({ completedManual, replayedManual })}`,
  );
  let terminalConflict: unknown = null;
  try {
    await completeMetaAdsActionLog({
      id: manualWinner.id,
      status: "failure",
      errorCode: "late_internal_error",
      errorMessage: "A late handler error must not overwrite success.",
    });
  } catch (error) {
    terminalConflict = error;
  }
  assert(
    terminalConflict instanceof Error &&
      terminalConflict.message ===
        "Meta ads action log already has a different terminal outcome.",
    `A different manual terminal completion did not fail closed: ${stableJson(terminalConflict)}`,
  );
  const preservedManual = await client.query<{
    status: string;
    payload_response: Record<string, unknown> | null;
    error_code: string | null;
    error_message: string | null;
  }>(
    `SELECT status, payload_response, error_code, error_message
     FROM meta_ads_action_log
     WHERE id = $1::uuid`,
    [manualWinner.id],
  );
  assert(
    preservedManual.rows[0]?.status === "success" &&
      preservedManual.rows[0]?.payload_response?.success === true &&
      preservedManual.rows[0]?.error_code === null &&
      preservedManual.rows[0]?.error_message === null,
    `A committed manual success was overwritten after terminal CAS conflict: ${stableJson(preservedManual.rows)}`,
  );
  await clearClaims();

  const crossOriginAttempts = await Promise.allSettled([
    manualClaim(),
    createDecisionOriginMetaAdsActionLog({
      request: nativeRequest,
      requestedBy,
      payloadRequest: { seam: "shared-cross-origin-status-claim" },
    }),
  ]);
  const crossOriginWinners = crossOriginAttempts.filter(
    (
      result,
    ): result is PromiseFulfilledResult<MetaAdsActionLogRow> =>
      result.status === "fulfilled",
  );
  const crossOriginLosers = crossOriginAttempts.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const crossOriginConflict = statusClaimConflictEvidence(
    crossOriginLosers[0]?.reason,
  );
  assert(
    crossOriginWinners.length === 1 &&
      crossOriginLosers.length === 1 &&
      crossOriginConflict?.code === "action_in_flight" &&
      ["manual_operator_v1", "native_decision_v1"].includes(
        crossOriginConflict.blockingOrigin,
      ),
    `Concurrent manual/native claims did not serialize fail-closed: ${stableJson(crossOriginAttempts.map((result) => result.status === "fulfilled" ? { status: result.status, id: result.value.id, source: result.value.source } : { status: result.status, error: statusClaimConflictEvidence(result.reason) }))}`,
  );
  const crossOriginRows = await client.query<{
    count: string;
    provider_account_count: string;
  }>(
    `SELECT
       count(*)::text AS count,
       count(*) FILTER (
         WHERE provider_account_id = $3
       )::text AS provider_account_count
     FROM meta_ads_action_log
     WHERE business_id = $1::uuid
       AND ad_id = $2
       AND action = 'pause'
       AND status = 'pending'`,
    [businessId, SAFE_AD_ID, PROVIDER_ACCOUNT_ID],
  );
  assert(
    crossOriginRows.rows[0]?.count === "1" &&
      crossOriginRows.rows[0]?.provider_account_count === "1",
    `Cross-origin claim emitted more than one all-origin pending authority: ${stableJson(crossOriginRows.rows)}`,
  );
  await clearClaims();

  const legacy = await client.query<IdRow>(
    `INSERT INTO meta_ads_action_log (
       business_id, ad_id, creative_id, action, source, requested_by,
       requested_at, payload_request, status
     ) VALUES (
       $1::uuid, $2, $3, 'pause', 'ui_manual', $4::uuid,
       now() - interval '5 minutes', '{"seam":"legacy-null-account"}'::jsonb,
       'pending'
     )
     RETURNING id::text AS id`,
    [businessId, SAFE_AD_ID, SAFE_CREATIVE_ID, requestedBy],
  );
  const legacyId = legacy.rows[0]?.id;
  assert(legacyId, "Could not seed the old legacy manual pending row.");
  let oldPendingError: unknown = null;
  try {
    await createDecisionOriginMetaAdsActionLog({
      request: nativeRequest,
      requestedBy,
      payloadRequest: { seam: "legacy-null-account-blocker" },
    });
  } catch (error) {
    oldPendingError = error;
  }
  const oldPendingConflict = statusClaimConflictEvidence(oldPendingError);
  assert(
    oldPendingConflict?.code === "action_in_flight" &&
      oldPendingConflict.blockingActionLogId === legacyId &&
      oldPendingConflict.blockingOrigin === "ui_manual",
    `A five-minute-old legacy NULL-account pending row did not block the exact native claim: ${stableJson(oldPendingConflict)}`,
  );
  const legacyRows = await client.query<{
    count: string;
    provider_account_id: string | null;
  }>(
    `SELECT count(*)::text AS count, max(provider_account_id) AS provider_account_id
     FROM meta_ads_action_log
     WHERE business_id = $1::uuid
       AND ad_id = $2
       AND action = 'pause'
       AND status = 'pending'`,
    [businessId, SAFE_AD_ID],
  );
  assert(
    legacyRows.rows[0]?.count === "1" &&
      legacyRows.rows[0]?.provider_account_id === null,
    `Legacy pending authority was bypassed by a new claim: ${stableJson(legacyRows.rows)}`,
  );
  await clearClaims();
}

async function verifyAtomicDecisionOriginClaimAndRollback(input: {
  client: Client;
  businessId: string;
  requestedBy: string;
  episodes: AdRecommendationEpisode[];
}) {
  const { client, businessId, requestedBy, episodes } = input;
  assert(episodes.length === 2, "Concurrent claim seam requires two episodes.");
  const requests = episodes.map(decisionOriginRequest);
  const attempts = await Promise.allSettled(
    requests.map((request) =>
      createDecisionOriginMetaAdsActionLog({
        request,
        requestedBy,
        payloadRequest: { seam: "migrated-concurrent-claim" },
      }),
    ),
  );
  const accepted = attempts.filter(
    (
      result,
    ): result is PromiseFulfilledResult<MetaAdsActionLogRow> =>
      result.status === "fulfilled",
  );
  const rejected = attempts.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert(
    accepted.length === 1 &&
      rejected.length === 1 &&
      rejected[0]?.reason instanceof Error &&
      rejected[0].reason.message ===
        DECISION_ORIGIN_PENDING_RECONCILIATION_CODE,
    `Concurrent different canonical claims did not serialize fail-closed: ${stableJson(attempts.map((result) => result.status === "fulfilled" ? { status: result.status, id: result.value.id } : { status: result.status, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }))}`,
  );
  const winner = accepted[0]!.value;
  const winningRequest = requests.find(
    (request) => request.idempotencyKey === winner.idempotencyKey,
  );
  const losingRequest = requests.find(
    (request) => request.idempotencyKey !== winner.idempotencyKey,
  );
  assert(
    winningRequest && losingRequest,
    "Concurrent claim result did not preserve exact canonical keys.",
  );

  const claimed = await client.query<{
    idempotency_key: string;
    status: string;
    terminal_finalized_at: string | null;
  }>(
    `SELECT idempotency_key, status, terminal_finalized_at::text
     FROM meta_ads_action_log
     WHERE business_id = $1::uuid
       AND provider_account_id = $2
       AND ad_id = $3
       AND source = 'decision_origin'`,
    [businessId, PROVIDER_ACCOUNT_ID, SAFE_AD_ID],
  );
  assert(
    claimed.rows.length === 1 &&
      claimed.rows[0]?.idempotency_key === winningRequest.idempotencyKey &&
      claimed.rows[0]?.status === "pending" &&
      claimed.rows[0]?.terminal_finalized_at === null,
    `Provider-preflight claim did not leave exactly one pending canonical row: ${stableJson(claimed.rows)}`,
  );
  const noPrematureReceipt = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM engine_v3_ad_operator_action_receipts
     WHERE business_ref_id = $1::uuid AND source_ad_id = $2`,
    [businessId, SAFE_AD_ID],
  );
  assert(
    noPrematureReceipt.rows[0]?.count === "0",
    "A provider-preflight claim emitted a premature immutable receipt.",
  );
  const replay = await createDecisionOriginMetaAdsActionLog({
    request: winningRequest,
    requestedBy,
    payloadRequest: { seam: "migrated-same-key-replay" },
  });
  assert(
    replay.id === winner.id && replay.idempotentReplay === true,
    "The accepted canonical claim did not replay idempotently.",
  );

  await client.query(`
    CREATE OR REPLACE FUNCTION reject_migrated_seam_receipt_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced migrated receipt persistence failure';
    END
    $$;
    CREATE TRIGGER reject_migrated_seam_receipt_insert_trigger
    BEFORE INSERT ON engine_v3_ad_operator_action_receipts
    FOR EACH ROW EXECUTE FUNCTION reject_migrated_seam_receipt_insert()
  `);
  const verificationPayload = {
    id: SAFE_AD_ID,
    account_id: PROVIDER_ACCOUNT_ID,
    status: "PAUSED",
    creative: { id: SAFE_CREATIVE_ID },
    campaign: { id: SAFE_CAMPAIGN_ID },
    adset: { id: SAFE_ADSET_ID },
  };
  let completionError: unknown = null;
  try {
    await completeDecisionOriginMetaAdsActionLog({
      id: winner.id,
      status: "success",
      payloadResponse: { seam: "forced-receipt-rollback" },
      verificationPayload,
    });
  } catch (error) {
    completionError = error;
  }
  assert(
    completionError instanceof Error &&
      completionError.message.includes(
        "forced migrated receipt persistence failure",
      ),
    `Real completion did not surface the forced receipt failure: ${String(completionError)}`,
  );
  const rolledBack = await client.query<{
    status: string;
    provider_verified: boolean;
    verified_at: string | null;
    terminal_finalized_at: string | null;
    receipt_count: string;
  }>(
    `SELECT
       action.status, action.provider_verified,
       action.verified_at::text, action.terminal_finalized_at::text,
       count(receipt.id)::text AS receipt_count
     FROM meta_ads_action_log action
     LEFT JOIN engine_v3_ad_operator_action_receipts receipt
       ON receipt.source_action_log_id = action.id
     WHERE action.id = $1::uuid
     GROUP BY action.id`,
    [winner.id],
  );
  assert(
    rolledBack.rows.length === 1 &&
      rolledBack.rows[0]?.status === "pending" &&
      rolledBack.rows[0]?.provider_verified === false &&
      rolledBack.rows[0]?.verified_at === null &&
      rolledBack.rows[0]?.terminal_finalized_at === null &&
      rolledBack.rows[0]?.receipt_count === "0",
    `Completion/receipt failure did not roll back atomically: ${stableJson(rolledBack.rows)}`,
  );
  await client.query(`
    DROP TRIGGER reject_migrated_seam_receipt_insert_trigger
      ON engine_v3_ad_operator_action_receipts;
    DROP FUNCTION reject_migrated_seam_receipt_insert()
  `);

  const marker = await markDecisionOriginActionReconciliationRequired({
    id: winner.id,
    errorMessage: "Forced migrated receipt persistence failure.",
    outcome: "provider_write_verified_receipt_persistence_failed",
    verificationPayload,
  });
  assert(
    marker?.status === "pending" &&
      marker.providerVerified === false &&
      marker.terminalFinalizedAt === null &&
      marker.errorCode === DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
    `Reconciliation marker did not preserve fail-closed pending state: ${stableJson(marker)}`,
  );
  const marked = await client.query<{
    status: string;
    error_code: string | null;
    payload_response: Record<string, unknown> | null;
    receipt_count: string;
  }>(
    `SELECT
       action.status, action.error_code, action.payload_response,
       count(receipt.id)::text AS receipt_count
     FROM meta_ads_action_log action
     LEFT JOIN engine_v3_ad_operator_action_receipts receipt
       ON receipt.source_action_log_id = action.id
     WHERE action.id = $1::uuid
     GROUP BY action.id`,
    [winner.id],
  );
  const reconciliation = marked.rows[0]?.payload_response
    ?.decision_origin_reconciliation as Record<string, unknown> | undefined;
  assert(
    marked.rows.length === 1 &&
      marked.rows[0]?.status === "pending" &&
      marked.rows[0]?.error_code ===
        DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE &&
      marked.rows[0]?.receipt_count === "0" &&
      reconciliation?.reconciliation_required === true &&
      reconciliation.retry_allowed === false &&
      reconciliation.provider_mutation_succeeded === true &&
      reconciliation.outcome ===
        "provider_write_verified_receipt_persistence_failed",
    `Reconciliation marker/receipt state is contradictory: ${stableJson(marked.rows)}`,
  );

  let losingRetryError: unknown = null;
  try {
    await createDecisionOriginMetaAdsActionLog({
      request: losingRequest,
      requestedBy,
      payloadRequest: { seam: "migrated-losing-key-retry" },
    });
  } catch (error) {
    losingRetryError = error;
  }
  const losingRetryConflict =
    statusClaimConflictEvidence(losingRetryError);
  assert(
    losingRetryConflict?.code ===
      DECISION_ORIGIN_PENDING_RECONCILIATION_CODE &&
      losingRetryConflict.blockingActionLogId === winner.id &&
      losingRetryConflict.blockingOrigin === "native_decision_v1" &&
      losingRetryConflict.reconciliationRequired,
    `A different canonical key did not retain the typed unresolved reconciliation block: ${stableJson(losingRetryConflict)}`,
  );
  const postRetryClaims = await client.query<{
    count: string;
    action_log_id: string | null;
    idempotency_key: string | null;
  }>(
    `SELECT
       count(*)::text AS count,
       min(id::text) AS action_log_id,
       min(idempotency_key) AS idempotency_key
     FROM meta_ads_action_log
     WHERE business_id = $1::uuid
       AND provider_account_id = $2
       AND ad_id = $3
       AND source = 'decision_origin'
       AND status = 'pending'`,
    [businessId, PROVIDER_ACCOUNT_ID, SAFE_AD_ID],
  );
  assert(
    postRetryClaims.rows[0]?.count === "1" &&
      postRetryClaims.rows[0]?.action_log_id === winner.id &&
      postRetryClaims.rows[0]?.idempotency_key === winningRequest.idempotencyKey,
    `A different canonical key created a second pending authority: ${stableJson(postRetryClaims.rows)}`,
  );
}

function manualMutationTarget(input: {
  businessId: string;
  adId: string;
}) {
  return {
    businessId: input.businessId,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    adId: input.adId,
    creativeId: SAFE_CREATIVE_ID,
    campaignId: SAFE_CAMPAIGN_ID,
    adsetId: SAFE_ADSET_ID,
  };
}

function manualProviderGetEvidence(input: {
  adId: string;
  status: "ACTIVE" | "PAUSED";
}) {
  return {
    id: input.adId,
    account_id: PROVIDER_ACCOUNT_ID,
    status: input.status,
    effective_status: input.status,
    creative: { id: SAFE_CREATIVE_ID },
    campaign: {
      id: SAFE_CAMPAIGN_ID,
      status: "ACTIVE",
      effective_status: "ACTIVE",
    },
    adset: {
      id: SAFE_ADSET_ID,
      status: "ACTIVE",
      effective_status: "ACTIVE",
    },
  };
}

function manualStatusWriteVerification(input: {
  adId: string;
  observedAt: string;
  creativeId?: string;
}) {
  const creativeId = input.creativeId ?? SAFE_CREATIVE_ID;
  return {
    contractVersion:
      MANUAL_META_AD_STATUS_WRITE_VERIFICATION_CONTRACT_VERSION,
    adId: input.adId,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    creativeId,
    campaignId: SAFE_CAMPAIGN_ID,
    adsetId: SAFE_ADSET_ID,
    configuredStatus: "PAUSED",
    effectiveStatus: "PAUSED",
    campaignConfiguredStatus: "ACTIVE",
    campaignEffectiveStatus: "ACTIVE",
    adsetConfiguredStatus: "ACTIVE",
    adsetEffectiveStatus: "ACTIVE",
    policyEligible: true,
    reviewStatus: null,
    observedAt: input.observedAt,
    providerGetEvidence: {
      ...manualProviderGetEvidence({
        adId: input.adId,
        status: "PAUSED",
      }),
      creative: { id: creativeId },
    },
  };
}

function manualVerifiedMutationAttempt(input: {
  adId: string;
  timestamp: string;
}): ManualMetaProviderMutationAttemptReceipt {
  return {
    attemptCount: 1,
    method: "POST",
    path: `/${input.adId}`,
    attemptedAt: input.timestamp,
    completedAt: input.timestamp,
    providerResponseReceived: true,
    providerResponseSuccessful: true,
    httpStatus: 200,
    outcome: "provider_response_received",
    automaticRetryAttempted: false,
    transportError: null,
  };
}

async function insertRawManualVerifiedCompletion(input: {
  client: Client;
  sourceActionLogId: string;
  started: ManualMetaAdStatusMutationAttemptEvent;
  verification: Record<string, unknown>;
}) {
  const mutationAttempt = manualVerifiedMutationAttempt({
    adId: input.started.adId,
    timestamp: input.started.startedAt,
  });
  const providerResponse = { success: true };
  const evidence = {
    contractVersion:
      MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
    eventKind: "attempt_completed",
    sourceActionLogId: input.sourceActionLogId,
    attemptId: input.started.attemptId,
    target: {
      businessId: input.started.businessId,
      providerAccountRefId: input.started.providerAccountRefId,
      providerAccountId: input.started.providerAccountId,
      adId: input.started.adId,
      creativeId: input.started.creativeId,
      campaignId: input.started.campaignId,
      adsetId: input.started.adsetId,
    },
    action: input.started.action,
    postPath: input.started.postPath,
    startedAt: input.started.startedAt,
    leaseDeadline: input.started.leaseDeadline,
    completionOutcome: "provider_response_verified_success",
    mutationAttempt,
    providerOutcome: "verified_success",
    providerResponse,
    verification: input.verification,
  };
  return input.client.query(
    INSERT_MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_QUERY,
    [
      input.sourceActionLogId,
      input.started.businessId,
      input.started.providerAccountRefId,
      input.started.providerAccountId,
      input.started.adId,
      input.started.creativeId,
      input.started.campaignId,
      input.started.adsetId,
      input.started.action,
      input.started.attemptId,
      "attempt_completed",
      input.started.postPath,
      input.started.startedAt,
      input.started.leaseDeadline,
      mutationAttempt.attemptedAt,
      mutationAttempt.completedAt,
      "provider_response_verified_success",
      true,
      true,
      200,
      "verified_success",
      JSON.stringify(providerResponse),
      JSON.stringify(input.verification),
      null,
      JSON.stringify(evidence),
    ],
  );
}

async function insertRawManualStart(input: {
  client: Client;
  sourceActionLogId: string;
  businessId: string;
  providerAccountRefId: string;
  adId: string;
}) {
  const attemptId = randomUUID();
  const startedAt = new Date().toISOString();
  const leaseDeadline = new Date(
    Date.parse(startedAt) + 2 * 60 * 1_000,
  ).toISOString();
  const evidence = {
    contractVersion:
      MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
    eventKind: "attempt_started",
    sourceActionLogId: input.sourceActionLogId,
    attemptId,
    target: {
      businessId: input.businessId,
      providerAccountRefId: input.providerAccountRefId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      adId: input.adId,
      creativeId: SAFE_CREATIVE_ID,
      campaignId: SAFE_CAMPAIGN_ID,
      adsetId: SAFE_ADSET_ID,
    },
    action: "pause",
    postPath: `/${input.adId}`,
    startedAt,
    leaseDeadline,
  };
  await input.client.query(
    INSERT_MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_QUERY,
    [
      input.sourceActionLogId,
      input.businessId,
      input.providerAccountRefId,
      PROVIDER_ACCOUNT_ID,
      input.adId,
      SAFE_CREATIVE_ID,
      SAFE_CAMPAIGN_ID,
      SAFE_ADSET_ID,
      "pause",
      attemptId,
      "attempt_started",
      `/${input.adId}`,
      startedAt,
      leaseDeadline,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      JSON.stringify(evidence),
    ],
  );
  return { attemptId, startedAt, leaseDeadline };
}

async function terminalizeRawManualPreProviderFailure(input: {
  client: Client;
  sourceActionLogId: string;
  errorCode: string;
}) {
  return input.client.query(
    `UPDATE meta_ads_action_log
     SET
       status = 'failure',
       payload_response = jsonb_build_object(
         'post_claim_preflight',
         jsonb_build_object(
           'should_mutate', false,
           'blocker', $2::text
         )
       ),
       error_code = $2::text,
       error_message = 'Ephemeral exact pre-provider failure.',
       terminal_finalized_at = clock_timestamp(),
       updated_at = clock_timestamp()
     WHERE id = $1::uuid
     RETURNING id`,
    [input.sourceActionLogId, input.errorCode],
  );
}

async function readStartedAttemptForSeam(
  client: Client,
  sourceActionLogId: string,
): Promise<ManualMetaAdStatusMutationAttemptEvent> {
  const result = await client.query<{
    id: string;
    source_action_log_id: string;
    business_id: string;
    provider_account_ref_id: string;
    provider_account_id: string;
    ad_id: string;
    creative_id: string;
    campaign_id: string;
    adset_id: string;
    action: "pause" | "resume";
    attempt_id: string;
    post_path: string;
    started_at: string;
    lease_deadline: string;
    evidence_json: Record<string, unknown>;
    evidence_hash: string;
  }>(
    `SELECT
       id::text,
       source_action_log_id::text,
       business_id::text,
       provider_account_ref_id::text,
       provider_account_id,
       ad_id,
       creative_id,
       campaign_id,
       adset_id,
       action,
       attempt_id::text,
       post_path,
       started_at::text,
       lease_deadline::text,
       evidence_json,
       evidence_hash
     FROM meta_ads_action_mutation_attempt_events
     WHERE source_action_log_id = $1::uuid
       AND event_kind = 'attempt_started'`,
    [sourceActionLogId],
  );
  const row = result.rows[0];
  assert(row, "Expected one started mutation attempt.");
  return {
    id: row.id,
    contractVersion:
      MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
    sourceActionLogId: row.source_action_log_id,
    businessId: row.business_id,
    providerAccountRefId: row.provider_account_ref_id,
    providerAccountId: row.provider_account_id,
    adId: row.ad_id,
    creativeId: row.creative_id,
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    action: row.action,
    attemptId: row.attempt_id,
    eventKind: "attempt_started",
    postPath: row.post_path,
    startedAt: new Date(row.started_at).toISOString(),
    leaseDeadline: new Date(row.lease_deadline).toISOString(),
    attemptedAt: null,
    completedAt: null,
    completionOutcome: null,
    providerResponseReceived: null,
    providerResponseSuccessful: null,
    httpStatus: null,
    providerOutcome: null,
    providerResponse: null,
    verification: null,
    transportError: null,
    evidence: row.evidence_json,
    evidenceHash: row.evidence_hash,
    createdAt: new Date(row.started_at).toISOString(),
  };
}

async function createJournalContractManualSource(input: {
  businessId: string;
  requestedBy: string;
  adId: string;
}) {
  return createMetaAdsActionLog({
    businessId: input.businessId,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    adId: input.adId,
    creativeId: SAFE_CREATIVE_ID,
    action: "pause",
    source: "manual_operator_v1",
    requestedBy: input.requestedBy,
    payloadRequest: {
      mutation_journal_contract_version:
        MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
      mutation_journal_required: true,
      manual_status_mutation_target: manualMutationTarget(input),
      seam: "manual-status-reconciliation",
    },
  });
}

async function ageManualSource(
  client: Client,
  sourceActionLogId: string,
) {
  await client.query(
    `ALTER TABLE meta_ads_action_log
     DISABLE TRIGGER trg_manual_meta_ads_action_terminal_validate`,
  );
  try {
    await client.query(
      `UPDATE meta_ads_action_log
       SET requested_at =
             date_trunc('milliseconds', clock_timestamp() - interval '11 minutes'),
           updated_at =
             date_trunc('milliseconds', clock_timestamp() - interval '11 minutes')
       WHERE id = $1::uuid`,
      [sourceActionLogId],
    );
  } finally {
    await client.query(
      `ALTER TABLE meta_ads_action_log
       ENABLE TRIGGER trg_manual_meta_ads_action_terminal_validate`,
    );
  }
}

async function ageManualMutationJournal(
  client: Client,
  sourceActionLogId: string,
) {
  await client.query(
    `ALTER TABLE meta_ads_action_mutation_attempt_events
     DISABLE TRIGGER trg_meta_ads_action_mutation_attempt_immutable`,
  );
  try {
    await client.query(
      `WITH authority_time AS (
         SELECT
           date_trunc(
             'milliseconds',
             clock_timestamp() - interval '10 minutes'
           ) AS started_at,
           date_trunc(
             'milliseconds',
             clock_timestamp() - interval '8 minutes'
           ) AS lease_deadline,
           date_trunc(
             'milliseconds',
             clock_timestamp() - interval '9 minutes 30 seconds'
           ) AS attempted_at,
           date_trunc(
             'milliseconds',
             clock_timestamp() - interval '9 minutes'
           ) AS completed_at
       )
       UPDATE meta_ads_action_mutation_attempt_events event
       SET
         started_at = authority_time.started_at,
         lease_deadline = authority_time.lease_deadline,
         attempted_at = CASE
           WHEN event.event_kind = 'attempt_completed'
             THEN authority_time.attempted_at
           ELSE NULL
         END,
         completed_at = CASE
           WHEN event.event_kind = 'attempt_completed'
             THEN authority_time.completed_at
           ELSE NULL
         END,
         evidence_json =
           (
             event.evidence_json ||
             jsonb_build_object(
               'startedAt',
               to_char(
                 authority_time.started_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ),
               'leaseDeadline',
               to_char(
                 authority_time.lease_deadline AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               )
             )
           ) ||
           CASE
             WHEN event.event_kind = 'attempt_completed' THEN
               jsonb_build_object(
                 'mutationAttempt',
                 event.evidence_json->'mutationAttempt' ||
                 jsonb_build_object(
                   'attemptedAt',
                   to_char(
                     authority_time.attempted_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   ),
                   'completedAt',
                   to_char(
                     authority_time.completed_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   )
                 )
               )
             ELSE '{}'::jsonb
           END
       FROM authority_time
       WHERE event.source_action_log_id = $1::uuid`,
      [sourceActionLogId],
    );
    await client.query(
      `UPDATE meta_ads_action_mutation_attempt_events
       SET evidence_hash =
         encode(digest(evidence_json::text, 'sha256'), 'hex')
       WHERE source_action_log_id = $1::uuid`,
      [sourceActionLogId],
    );
  } finally {
    await client.query(
      `ALTER TABLE meta_ads_action_mutation_attempt_events
       ENABLE TRIGGER trg_meta_ads_action_mutation_attempt_immutable`,
    );
  }
}

async function setSameMillisecondManualSourceTime(
  client: Client,
  sourceActionLogId: string,
) {
  await client.query(
    `ALTER TABLE meta_ads_action_log
     DISABLE TRIGGER trg_manual_meta_ads_action_terminal_validate`,
  );
  try {
    await client.query(
      `UPDATE meta_ads_action_log
       SET requested_at =
         date_trunc('milliseconds', clock_timestamp()) +
         interval '0.999 milliseconds'
       WHERE id = $1::uuid`,
      [sourceActionLogId],
    );
  } finally {
    await client.query(
      `ALTER TABLE meta_ads_action_log
       ENABLE TRIGGER trg_manual_meta_ads_action_terminal_validate`,
    );
  }
}

async function reconcileReadyManualSource(input: {
  businessId: string;
  requestedBy: string;
  adId: string;
  sourceActionLogId: string;
  observedStatus: "ACTIVE" | "PAUSED";
  expectedAuthority:
    | "completed_attempt"
    | "legacy_quarantine"
    | "lease_expired_started"
    | "pre_provider_no_attempt";
  expectedOutcome:
    | "provider_response_verified_success"
    | "provider_definite_failure"
    | "attempt_lease_expired_without_completion"
    | "pre_provider_no_mutation_attempt"
    | "legacy_precontract_quarantine_elapsed";
}) {
  const candidate =
    await readManualMetaAdStatusReconciliationCandidate({
      businessId: input.businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      adId: input.adId,
    });
  assert(
    candidate.sourceActionLogId === input.sourceActionLogId &&
      candidate.readyForProviderRead &&
      candidate.blockerReason === null &&
      candidate.authorityKind === input.expectedAuthority &&
      candidate.outcome === input.expectedOutcome &&
      candidate.providerAccountRefId &&
      candidate.campaignId === SAFE_CAMPAIGN_ID &&
      candidate.adsetId === SAFE_ADSET_ID,
    `Manual status source was not ready for an exact provider GET: ${stableJson(candidate)}`,
  );
  const resolution =
    input.observedStatus === "PAUSED"
      ? ("current_state_matches_requested" as const)
      : ("current_state_matches_precondition" as const);
  const observedAt = new Date().toISOString();
  const reconciliationInput = {
    sourceActionLogId: input.sourceActionLogId,
    businessId: input.businessId,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    adId: input.adId,
    action: "pause" as const,
    resolution,
    observedStatus: input.observedStatus,
    observedEffectiveStatus: input.observedStatus,
    observedAt,
    resolvedTarget: manualMutationTarget(input),
    providerGetEvidence: manualProviderGetEvidence({
      adId: input.adId,
      status: input.observedStatus,
    }),
  };
  const settled = await reconcileManualMetaAdStatusAndCreateClaim({
    reconciliation: reconciliationInput,
    nextClaim: {
      actionOrigin: "manual_operator_v1",
      businessId: input.businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      adId: input.adId,
      creativeId: SAFE_CREATIVE_ID,
      action: "resume",
      requestedBy: input.requestedBy,
      payloadRequest: {
        dry_run: true,
        seam: "post-reconciliation-replacement-claim",
      },
    },
  });
  assert(
    settled.reconciliation.sourceActionLogId ===
      input.sourceActionLogId &&
      settled.reconciliation.sourceAuthorityKind ===
        input.expectedAuthority &&
      settled.reconciliation.sourceOutcome === input.expectedOutcome &&
      settled.reconciliation.resolution === resolution &&
      settled.claim.id !== input.sourceActionLogId &&
      settled.claim.status === "pending" &&
      settled.claim.action === "resume",
    `Reconciliation and replacement claim were not atomic/exact: ${stableJson(settled)}`,
  );
  const replayed = await appendManualMetaAdStatusReconciliationEvent(
    reconciliationInput,
  );
  assert(
    replayed.id === settled.reconciliation.id &&
      replayed.idempotentReplay === true,
    `Exact reconciliation replay was not idempotent: ${stableJson(replayed)}`,
  );
  const rows = await getDb().query<{
    reconciliation_count: string;
    replacement_count: string;
  }>(
    `SELECT
       (
         SELECT count(*)::text
         FROM meta_ads_action_reconciliation_events
         WHERE source_action_log_id = $1::uuid
       ) AS reconciliation_count,
       (
         SELECT count(*)::text
         FROM meta_ads_action_log
         WHERE business_id = $2::uuid
           AND provider_account_id = $3
           AND ad_id = $4
           AND id <> $1::uuid
           AND status = 'pending'
       ) AS replacement_count`,
    [
      input.sourceActionLogId,
      input.businessId,
      PROVIDER_ACCOUNT_ID,
      input.adId,
    ],
  );
  assert(
    rows[0]?.reconciliation_count === "1" &&
      rows[0]?.replacement_count === "1",
    `Reconciled pending source still blocked its one replacement claim: ${stableJson(rows)}`,
  );
  return settled;
}

async function verifyManualStatusTerminalAuthoritySeam(input: {
  client: Client;
  businessId: string;
  providerAccountRefId: string;
  requestedBy: string;
}) {
  const storeDrift = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_STORE_DRIFT_AD_ID,
  });
  const storeDriftStart =
    await appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: storeDrift.id,
      target: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_STORE_DRIFT_AD_ID,
      }),
      action: "pause",
      postPath: `/${MANUAL_STORE_DRIFT_AD_ID}`,
    });
  const storeDriftError = await capturedError(() =>
    appendManualMetaAdStatusMutationAttemptCompleted({
      sourceActionLogId: storeDrift.id,
      attemptId: storeDriftStart.attemptId,
      completionOutcome: "provider_response_verified_success",
      mutationAttempt: manualVerifiedMutationAttempt({
        adId: MANUAL_STORE_DRIFT_AD_ID,
        timestamp: storeDriftStart.startedAt,
      }),
      providerResponse: { success: true },
      verification: manualStatusWriteVerification({
        adId: MANUAL_STORE_DRIFT_AD_ID,
        observedAt: storeDriftStart.startedAt,
        creativeId: "creative_drifted_store_seam",
      }),
    }),
  );
  assert(
    storeDriftError instanceof Error &&
      storeDriftError.message.includes(
        "verified mutation completion geometry is invalid",
      ),
    `Store accepted a drifted verified-success completion: ${String(storeDriftError)}`,
  );
  const storeDriftRows = await input.client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM meta_ads_action_mutation_attempt_events
     WHERE source_action_log_id = $1::uuid`,
    [storeDrift.id],
  );
  assert(
    storeDriftRows.rows[0]?.count === "1",
    `Rejected store drift still persisted a completion: ${stableJson(storeDriftRows.rows)}`,
  );

  const databaseDrift = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_DATABASE_DRIFT_AD_ID,
  });
  const databaseDriftStart =
    await appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: databaseDrift.id,
      target: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_DATABASE_DRIFT_AD_ID,
      }),
      action: "pause",
      postPath: `/${MANUAL_DATABASE_DRIFT_AD_ID}`,
    });
  const databaseDriftError = await capturedError(() =>
    insertRawManualVerifiedCompletion({
      client: input.client,
      sourceActionLogId: databaseDrift.id,
      started: databaseDriftStart,
      verification: manualStatusWriteVerification({
        adId: MANUAL_DATABASE_DRIFT_AD_ID,
        observedAt: databaseDriftStart.startedAt,
        creativeId: "creative_drifted_database_seam",
      }),
    }),
  );
  assert(
    databaseDriftError instanceof Error &&
      (databaseDriftError as { code?: string }).code === "23514",
    `Database trigger accepted a drifted verified-success completion: ${String(databaseDriftError)}`,
  );
  const databaseDriftRows = await input.client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM meta_ads_action_mutation_attempt_events
     WHERE source_action_log_id = $1::uuid`,
    [databaseDrift.id],
  );
  assert(
    databaseDriftRows.rows[0]?.count === "1",
    `Rejected database drift still persisted a completion: ${stableJson(databaseDriftRows.rows)}`,
  );

  const unauthorizedTerminal = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_UNAUTHORIZED_TERMINAL_AD_ID,
  });
  const unauthorizedStoreError = await capturedError(() =>
    completeMetaAdsActionLog({
      id: unauthorizedTerminal.id,
      status: "success",
      payloadResponse: { success: true },
      verifiedAt: new Date().toISOString(),
    }),
  );
  assert(
    unauthorizedStoreError instanceof Error &&
      unauthorizedStoreError.message.includes(
        "lacks exact attempt authority",
      ),
    `Store terminalized a journal-required source without attempt authority: ${String(unauthorizedStoreError)}`,
  );
  const unauthorizedDatabaseError = await capturedError(() =>
    input.client.query(
      `UPDATE meta_ads_action_log
       SET
         status = 'success',
         payload_response = '{"success":true}'::jsonb,
         verified_at = clock_timestamp(),
         terminal_finalized_at = clock_timestamp(),
         updated_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [unauthorizedTerminal.id],
    ),
  );
  assert(
    unauthorizedDatabaseError instanceof Error &&
      (unauthorizedDatabaseError as { code?: string }).code === "23514",
    `Database trigger terminalized a journal-required source without attempt authority: ${String(unauthorizedDatabaseError)}`,
  );
  const unauthorizedState = await input.client.query<{
    status: string;
    terminal_finalized_at: string | null;
  }>(
    `SELECT status, terminal_finalized_at::text
     FROM meta_ads_action_log
     WHERE id = $1::uuid`,
    [unauthorizedTerminal.id],
  );
  assert(
    unauthorizedState.rows[0]?.status === "pending" &&
      unauthorizedState.rows[0]?.terminal_finalized_at == null,
    `Rejected terminalization changed the source fact: ${stableJson(unauthorizedState.rows)}`,
  );

  const preProviderFailure = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_PRE_PROVIDER_FAILURE_AD_ID,
  });
  const preProviderErrorCode = "manual_status_preflight_blocked";
  const preProviderTerminal = await completeMetaAdsActionLog({
    id: preProviderFailure.id,
    status: "failure",
    payloadResponse: {
      post_claim_preflight: {
        should_mutate: false,
        blocker: preProviderErrorCode,
      },
    },
    errorCode: preProviderErrorCode,
    errorMessage: "Ephemeral pre-provider blocker.",
  });
  assert(
    preProviderTerminal.status === "failure" &&
      preProviderTerminal.errorCode === preProviderErrorCode &&
      preProviderTerminal.terminalFinalizedAt != null,
    `Exact pre-provider failure proof did not authorize terminalization: ${stableJson(preProviderTerminal)}`,
  );

  const verifiedTerminal = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_VERIFIED_TERMINAL_AD_ID,
  });
  const verifiedTerminalStart =
    await appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: verifiedTerminal.id,
      target: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_VERIFIED_TERMINAL_AD_ID,
      }),
      action: "pause",
      postPath: `/${MANUAL_VERIFIED_TERMINAL_AD_ID}`,
    });
  const verifiedTerminalProof = manualStatusWriteVerification({
    adId: MANUAL_VERIFIED_TERMINAL_AD_ID,
    observedAt: verifiedTerminalStart.startedAt,
  });
  await appendManualMetaAdStatusMutationAttemptCompleted({
    sourceActionLogId: verifiedTerminal.id,
    attemptId: verifiedTerminalStart.attemptId,
    completionOutcome: "provider_response_verified_success",
    mutationAttempt: manualVerifiedMutationAttempt({
      adId: MANUAL_VERIFIED_TERMINAL_AD_ID,
      timestamp: verifiedTerminalStart.startedAt,
    }),
    providerResponse: { success: true },
    verification: verifiedTerminalProof,
  });
  const verifiedTerminalResult = await completeMetaAdsActionLog({
    id: verifiedTerminal.id,
    status: "success",
    payloadResponse: { success: true },
    verifiedAt: verifiedTerminalStart.startedAt,
    verificationPayload: verifiedTerminalProof,
  });
  assert(
    verifiedTerminalResult.status === "success" &&
      verifiedTerminalResult.terminalFinalizedAt != null,
    `Verified-success completion did not authorize success: ${stableJson(verifiedTerminalResult)}`,
  );

  const ambiguousTerminal = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_AMBIGUOUS_TERMINAL_AD_ID,
  });
  const ambiguousTerminalStart =
    await appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: ambiguousTerminal.id,
      target: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_AMBIGUOUS_TERMINAL_AD_ID,
      }),
      action: "pause",
      postPath: `/${MANUAL_AMBIGUOUS_TERMINAL_AD_ID}`,
    });
  await appendManualMetaAdStatusMutationAttemptCompleted({
    sourceActionLogId: ambiguousTerminal.id,
    attemptId: ambiguousTerminalStart.attemptId,
    completionOutcome: "provider_outcome_ambiguous",
    mutationAttempt: {
      attemptCount: 1,
      method: "POST",
      path: `/${MANUAL_AMBIGUOUS_TERMINAL_AD_ID}`,
      attemptedAt: ambiguousTerminalStart.startedAt,
      completedAt: ambiguousTerminalStart.startedAt,
      providerResponseReceived: false,
      providerResponseSuccessful: false,
      httpStatus: null,
      outcome: "outcome_ambiguous",
      automaticRetryAttempted: false,
      transportError: {
        name: "TimeoutError",
        message: "Ephemeral ambiguous provider outcome.",
      },
    },
    providerResponse: null,
    verification: null,
  });
  const ambiguousTerminalResult = await completeMetaAdsActionLog({
    id: ambiguousTerminal.id,
    status: "silent_failure",
    payloadResponse: null,
    errorCode: "provider_outcome_ambiguous",
    errorMessage: "Ephemeral provider outcome is ambiguous.",
  });
  assert(
    ambiguousTerminalResult.status === "silent_failure" &&
      ambiguousTerminalResult.terminalFinalizedAt != null,
    `Ambiguous completion did not authorize silent failure: ${stableJson(ambiguousTerminalResult)}`,
  );

  const driftProtected = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_TERMINAL_DRIFT_AD_ID,
  });
  const driftProtectedStart =
    await appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: driftProtected.id,
      target: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_TERMINAL_DRIFT_AD_ID,
      }),
      action: "pause",
      postPath: `/${MANUAL_TERMINAL_DRIFT_AD_ID}`,
    });
  const driftProtectedVerification = manualStatusWriteVerification({
    adId: MANUAL_TERMINAL_DRIFT_AD_ID,
    observedAt: driftProtectedStart.startedAt,
  });
  await appendManualMetaAdStatusMutationAttemptCompleted({
    sourceActionLogId: driftProtected.id,
    attemptId: driftProtectedStart.attemptId,
    completionOutcome: "provider_response_verified_success",
    mutationAttempt: manualVerifiedMutationAttempt({
      adId: MANUAL_TERMINAL_DRIFT_AD_ID,
      timestamp: driftProtectedStart.startedAt,
    }),
    providerResponse: { success: true },
    verification: driftProtectedVerification,
  });
  const exactTerminalParams = [
    driftProtected.id,
    JSON.stringify({ success: true }),
    JSON.stringify(driftProtectedVerification),
    driftProtectedStart.startedAt,
  ];
  const envelopeDrifts = [
    `business_id = '22222222-2222-4222-8222-222222222222'::uuid`,
    `provider_account_id = 'act_drifted_provider'`,
    `ad_id = '990000000009999'`,
    `creative_id = 'creative_drifted_terminal'`,
    `action = 'resume'`,
    `payload_request = payload_request ||
       '{"tampered_claim_envelope":true}'::jsonb`,
  ];
  for (const driftAssignment of envelopeDrifts) {
    const error = await capturedError(() =>
      input.client.query(
        `UPDATE meta_ads_action_log
         SET
           ${driftAssignment},
           status = 'success',
           payload_response = $2::jsonb,
           verification_payload = $3::jsonb,
           verified_at = $4::timestamptz,
           terminal_finalized_at = clock_timestamp(),
           updated_at = clock_timestamp()
         WHERE id = $1::uuid`,
        exactTerminalParams,
      ),
    );
    assert(
      error instanceof Error &&
        (error as { code?: string }).code === "55000",
      `Single-update terminalization accepted claim-envelope drift (${driftAssignment}): ${String(error)}`,
    );
  }
  const verificationDrifts = [
    `verification_payload = NULLIF($3::jsonb, $3::jsonb),
     verified_at = $4::timestamptz`,
    `verification_payload =
       jsonb_set($3::jsonb, '{creativeId}', '"tampered"'::jsonb),
     verified_at = $4::timestamptz`,
    `verification_payload = $3::jsonb,
     verified_at = $4::timestamptz + interval '1 millisecond'`,
  ];
  for (const verificationAssignment of verificationDrifts) {
    const error = await capturedError(() =>
      input.client.query(
        `UPDATE meta_ads_action_log
         SET
           status = 'success',
           payload_response = $2::jsonb,
           ${verificationAssignment},
           terminal_finalized_at = clock_timestamp(),
           updated_at = clock_timestamp()
         WHERE id = $1::uuid`,
        exactTerminalParams,
      ),
    );
    assert(
      error instanceof Error &&
        (error as { code?: string }).code === "23514",
      `Single-update terminalization accepted verification drift (${verificationAssignment}): ${String(error)}`,
    );
  }
  const pendingAfterRejectedDrifts = await input.client.query<{
    status: string;
    terminal_finalized_at: string | null;
  }>(
    `SELECT status, terminal_finalized_at::text
     FROM meta_ads_action_log
     WHERE id = $1::uuid`,
    [driftProtected.id],
  );
  assert(
    pendingAfterRejectedDrifts.rows[0]?.status === "pending" &&
      pendingAfterRejectedDrifts.rows[0]?.terminal_finalized_at == null,
    `Rejected terminal drifts changed the source: ${stableJson(pendingAfterRejectedDrifts.rows)}`,
  );
  const canonicalTerminal = await input.client.query<{
    status: string;
    verified_at: string;
  }>(
    `UPDATE meta_ads_action_log
     SET
       status = 'success',
       payload_response = $2::jsonb,
       verification_payload = $3::jsonb,
       verified_at = $4::timestamptz,
       terminal_finalized_at = clock_timestamp(),
       updated_at = clock_timestamp()
     WHERE id = $1::uuid
     RETURNING status, verified_at::text`,
    exactTerminalParams,
  );
  assert(
    canonicalTerminal.rows[0]?.status === "success" &&
      new Date(canonicalTerminal.rows[0]!.verified_at).toISOString() ===
        driftProtectedStart.startedAt,
    `Canonical status-only terminalization was rejected: ${stableJson(canonicalTerminal.rows)}`,
  );
  const postTerminalMutations = [
    `ad_id = '990000000009998'`,
    `payload_request = payload_request ||
       '{"post_terminal_tamper":true}'::jsonb`,
    `status = 'pending', terminal_finalized_at = NULL`,
    `status = 'failure', error_code = 'retargeted',
       error_message = 'retargeted'`,
    `verification_payload = '{}'::jsonb`,
  ];
  for (const mutation of postTerminalMutations) {
    const error = await capturedError(() =>
      input.client.query(
        `UPDATE meta_ads_action_log
         SET ${mutation}, updated_at = clock_timestamp()
         WHERE id = $1::uuid`,
        [driftProtected.id],
      ),
    );
    assert(
      error instanceof Error &&
        (error as { code?: string }).code === "55000",
      `Post-terminal journal fact mutation was accepted (${mutation}): ${String(error)}`,
    );
  }
  const immutableTerminal = await input.client.query<{
    status: string;
    ad_id: string;
    verification_payload: Record<string, unknown> | null;
  }>(
    `SELECT status, ad_id, verification_payload
     FROM meta_ads_action_log
     WHERE id = $1::uuid`,
    [driftProtected.id],
  );
  assert(
    immutableTerminal.rows[0]?.status === "success" &&
      immutableTerminal.rows[0]?.ad_id === MANUAL_TERMINAL_DRIFT_AD_ID &&
      stableJson(immutableTerminal.rows[0]?.verification_payload) ===
        stableJson(driftProtectedVerification),
    `Post-terminal mutation changed immutable fact bytes: ${stableJson(immutableTerminal.rows)}`,
  );
}

async function verifyManualAttemptCreatedAtAuthoritySeam(input: {
  client: Client;
  businessId: string;
  providerAccountRefId: string;
  requestedBy: string;
}) {
  const source = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_BACKDATED_CREATED_AT_AD_ID,
  });
  await ageManualSource(input.client, source.id);
  const started = await appendManualMetaAdStatusMutationAttemptStarted({
    sourceActionLogId: source.id,
    target: manualMutationTarget({
      businessId: input.businessId,
      adId: MANUAL_BACKDATED_CREATED_AT_AD_ID,
    }),
    action: "pause",
    postPath: `/${MANUAL_BACKDATED_CREATED_AT_AD_ID}`,
  });
  const staleProviderObservedAt = new Date(Date.now() - 1_000).toISOString();
  let completedCreatedAt: string | null = null;
  await input.client.query(
    `ALTER TABLE meta_ads_action_mutation_attempt_events
     ALTER COLUMN created_at
     SET DEFAULT (clock_timestamp() - interval '1 day')`,
  );
  try {
    const inserted = await insertRawManualVerifiedCompletion({
      client: input.client,
      sourceActionLogId: source.id,
      started,
      verification: manualStatusWriteVerification({
        adId: MANUAL_BACKDATED_CREATED_AT_AD_ID,
        observedAt: started.startedAt,
      }),
    });
    const returnedCreatedAt = (
      inserted.rows[0] as { created_at?: Date | string } | undefined
    )?.created_at;
    completedCreatedAt = returnedCreatedAt
      ? new Date(returnedCreatedAt).toISOString()
      : null;
  } finally {
    await input.client.query(
      `ALTER TABLE meta_ads_action_mutation_attempt_events
       ALTER COLUMN created_at SET DEFAULT now()`,
    );
  }
  assert(
    completedCreatedAt != null &&
      Date.parse(completedCreatedAt) >=
        Date.parse(staleProviderObservedAt) &&
      Date.now() - Date.parse(completedCreatedAt) < 30_000,
    `Mutation completion accepted a caller-controlled backdated authority anchor: ${completedCreatedAt}`,
  );
  await ageManualMutationJournal(input.client, source.id);
  const staleReconciliationError = await capturedError(() =>
    appendManualMetaAdStatusReconciliationEvent({
      sourceActionLogId: source.id,
      businessId: input.businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      adId: MANUAL_BACKDATED_CREATED_AT_AD_ID,
      action: "pause",
      resolution: "current_state_matches_requested",
      observedStatus: "PAUSED",
      observedEffectiveStatus: "PAUSED",
      observedAt: staleProviderObservedAt,
      resolvedTarget: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_BACKDATED_CREATED_AT_AD_ID,
      }),
      providerGetEvidence: manualProviderGetEvidence({
        adId: MANUAL_BACKDATED_CREATED_AT_AD_ID,
        status: "PAUSED",
      }),
    }),
  );
  assert(
    staleReconciliationError instanceof Error &&
      staleReconciliationError.message ===
        "Manual Meta status reconciliation observation predates completed-attempt authority." &&
      !["40P01", "55P03", "57014"].includes(
        String(
          (staleReconciliationError as { code?: unknown }).code ?? "",
        ),
      ),
    `Backdated completion authority accepted a stale provider observation: ${String(staleReconciliationError)}`,
  );
  const reconciliationRows = await input.client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM meta_ads_action_reconciliation_events
     WHERE source_action_log_id = $1::uuid`,
    [source.id],
  );
  assert(
    reconciliationRows.rows[0]?.count === "0",
    `Stale provider observation persisted despite the DB-created authority anchor: ${stableJson(reconciliationRows.rows)}`,
  );
}

async function verifyManualStatusConcurrencySeam(input: {
  businessId: string;
  providerAccountRefId: string;
  requestedBy: string;
}) {
  const databaseUrl = process.env.DATABASE_URL;
  assert(databaseUrl, "Concurrency seam requires DATABASE_URL.");
  const first = new Client({ connectionString: databaseUrl });
  const second = new Client({ connectionString: databaseUrl });
  await Promise.all([first.connect(), second.connect()]);
  try {
    await verifyManualAttemptCreatedAtAuthoritySeam({
      ...input,
      client: second,
    });
    const startWins = await createJournalContractManualSource({
      ...input,
      adId: MANUAL_START_WINS_RACE_AD_ID,
    });
    await first.query("BEGIN");
    await insertRawManualStart({
      client: first,
      sourceActionLogId: startWins.id,
      businessId: input.businessId,
      providerAccountRefId: input.providerAccountRefId,
      adId: MANUAL_START_WINS_RACE_AD_ID,
    });
    const blockedTerminal = capturedError(() =>
      terminalizeRawManualPreProviderFailure({
        client: second,
        sourceActionLogId: startWins.id,
        errorCode: "concurrent_pre_provider_terminal",
      }),
    );
    await assertPromisePending(
      blockedTerminal,
      "Terminalization behind an uncommitted attempt start",
    );
    await first.query("COMMIT");
    const blockedTerminalError = await blockedTerminal;
    assert(
      blockedTerminalError instanceof Error &&
        (blockedTerminalError as { code?: string }).code === "23514",
      `Attempt-start winner did not reject the stale pre-provider terminal: ${String(blockedTerminalError)}`,
    );
    const startWinnerFacts = await second.query<{
      status: string;
      attempt_count: string;
      reconciliation_count: string;
    }>(
      `SELECT
         action.status,
         (
           SELECT count(*)::text
           FROM meta_ads_action_mutation_attempt_events attempt
           WHERE attempt.source_action_log_id = action.id
         ) AS attempt_count,
         (
           SELECT count(*)::text
           FROM meta_ads_action_reconciliation_events reconciliation
           WHERE reconciliation.source_action_log_id = action.id
         ) AS reconciliation_count
       FROM meta_ads_action_log action
       WHERE action.id = $1::uuid`,
      [startWins.id],
    );
    assert(
      startWinnerFacts.rows[0]?.status === "pending" &&
        startWinnerFacts.rows[0]?.attempt_count === "1" &&
        startWinnerFacts.rows[0]?.reconciliation_count === "0",
      `Attempt-start race left contradictory facts: ${stableJson(startWinnerFacts.rows)}`,
    );

    const terminalWins = await createJournalContractManualSource({
      ...input,
      adId: MANUAL_TERMINAL_WINS_RACE_AD_ID,
    });
    await first.query("BEGIN");
    await terminalizeRawManualPreProviderFailure({
      client: first,
      sourceActionLogId: terminalWins.id,
      errorCode: "concurrent_pre_provider_terminal",
    });
    const blockedStart = capturedError(() =>
      insertRawManualStart({
        client: second,
        sourceActionLogId: terminalWins.id,
        businessId: input.businessId,
        providerAccountRefId: input.providerAccountRefId,
        adId: MANUAL_TERMINAL_WINS_RACE_AD_ID,
      }),
    );
    await assertPromisePending(
      blockedStart,
      "Attempt start behind an uncommitted terminal fact",
    );
    await first.query("COMMIT");
    const blockedStartError = await blockedStart;
    assert(
      blockedStartError instanceof Error &&
        (blockedStartError as { code?: string }).code === "23514",
      `Pre-provider terminal winner did not reject the stale start: ${String(blockedStartError)}`,
    );
    const terminalWinnerFacts = await second.query<{
      status: string;
      attempt_count: string;
      reconciliation_count: string;
    }>(
      `SELECT
         action.status,
         (
           SELECT count(*)::text
           FROM meta_ads_action_mutation_attempt_events attempt
           WHERE attempt.source_action_log_id = action.id
         ) AS attempt_count,
         (
           SELECT count(*)::text
           FROM meta_ads_action_reconciliation_events reconciliation
           WHERE reconciliation.source_action_log_id = action.id
         ) AS reconciliation_count
       FROM meta_ads_action_log action
       WHERE action.id = $1::uuid`,
      [terminalWins.id],
    );
    assert(
      terminalWinnerFacts.rows[0]?.status === "failure" &&
        terminalWinnerFacts.rows[0]?.attempt_count === "0" &&
        terminalWinnerFacts.rows[0]?.reconciliation_count === "0",
      `Pre-provider terminal race left contradictory facts: ${stableJson(terminalWinnerFacts.rows)}`,
    );

    const completionWins = await createJournalContractManualSource({
      ...input,
      adId: MANUAL_COMPLETION_WINS_RACE_AD_ID,
    });
    await ageManualSource(second, completionWins.id);
    await appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: completionWins.id,
      target: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_COMPLETION_WINS_RACE_AD_ID,
      }),
      action: "pause",
      postPath: `/${MANUAL_COMPLETION_WINS_RACE_AD_ID}`,
    });
    await ageManualMutationJournal(second, completionWins.id);
    const expiredCandidate =
      await readManualMetaAdStatusReconciliationCandidate({
        businessId: input.businessId,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        adId: MANUAL_COMPLETION_WINS_RACE_AD_ID,
      });
    assert(
      expiredCandidate.readyForProviderRead &&
        expiredCandidate.authorityKind === "lease_expired_started",
      `Expired-start race fixture was not reconciliation-ready: ${stableJson(expiredCandidate)}`,
    );
    const agedStarted = await readStartedAttemptForSeam(
      second,
      completionWins.id,
    );
    const observedAt = new Date(Date.now() - 1_000).toISOString();
    const staleReconciliation = {
      sourceActionLogId: completionWins.id,
      businessId: input.businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      adId: MANUAL_COMPLETION_WINS_RACE_AD_ID,
      action: "pause" as const,
      resolution: "current_state_matches_precondition" as const,
      observedStatus: "ACTIVE" as const,
      observedEffectiveStatus: "ACTIVE",
      observedAt,
      resolvedTarget: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_COMPLETION_WINS_RACE_AD_ID,
      }),
      providerGetEvidence: manualProviderGetEvidence({
        adId: MANUAL_COMPLETION_WINS_RACE_AD_ID,
        status: "ACTIVE",
      }),
    };
    await first.query("BEGIN");
    await insertRawManualVerifiedCompletion({
      client: first,
      sourceActionLogId: completionWins.id,
      started: agedStarted,
      verification: manualStatusWriteVerification({
        adId: MANUAL_COMPLETION_WINS_RACE_AD_ID,
        observedAt: agedStarted.startedAt,
      }),
    });
    const blockedReconciliation = capturedError(() =>
      appendManualMetaAdStatusReconciliationEvent(staleReconciliation),
    );
    await assertPromisePending(
      blockedReconciliation,
      "Expired-start reconciliation behind an uncommitted completion",
    );
    await first.query("COMMIT");
    const blockedReconciliationError = await blockedReconciliation;
    assert(
      blockedReconciliationError instanceof Error &&
        blockedReconciliationError.message ===
          "Manual Meta status reconciliation observation predates completed-attempt authority." &&
        !["40P01", "55P03", "57014"].includes(
          String(
            (blockedReconciliationError as { code?: unknown }).code ?? "",
          ),
        ),
      `Late completion did not deterministically reject the stale expired-start reconciliation: ${String(blockedReconciliationError)}`,
    );
    const completionWinnerFacts = await second.query<{
      status: string;
      attempt_count: string;
      reconciliation_count: string;
    }>(
      `SELECT
         action.status,
         (
           SELECT count(*)::text
           FROM meta_ads_action_mutation_attempt_events attempt
           WHERE attempt.source_action_log_id = action.id
         ) AS attempt_count,
         (
           SELECT count(*)::text
           FROM meta_ads_action_reconciliation_events reconciliation
           WHERE reconciliation.source_action_log_id = action.id
         ) AS reconciliation_count
       FROM meta_ads_action_log action
       WHERE action.id = $1::uuid`,
      [completionWins.id],
    );
    assert(
      completionWinnerFacts.rows[0]?.status === "pending" &&
        completionWinnerFacts.rows[0]?.attempt_count === "2" &&
        completionWinnerFacts.rows[0]?.reconciliation_count === "0",
      `Completion/reconciliation race left contradictory append-only facts: ${stableJson(completionWinnerFacts.rows)}`,
    );

    const reconciliationWins = await createJournalContractManualSource({
      ...input,
      adId: MANUAL_RECONCILIATION_WINS_RACE_AD_ID,
    });
    await ageManualSource(second, reconciliationWins.id);
    await appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: reconciliationWins.id,
      target: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_RECONCILIATION_WINS_RACE_AD_ID,
      }),
      action: "pause",
      postPath: `/${MANUAL_RECONCILIATION_WINS_RACE_AD_ID}`,
    });
    await ageManualMutationJournal(second, reconciliationWins.id);
    const reconciliationWinnerStarted = await readStartedAttemptForSeam(
      second,
      reconciliationWins.id,
    );
    const reconciliationObservedAt = new Date().toISOString();
    const reconciliationWinnerInput = {
      sourceActionLogId: reconciliationWins.id,
      businessId: input.businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      adId: MANUAL_RECONCILIATION_WINS_RACE_AD_ID,
      action: "pause" as const,
      resolution: "current_state_matches_precondition" as const,
      observedStatus: "ACTIVE" as const,
      observedEffectiveStatus: "ACTIVE",
      observedAt: reconciliationObservedAt,
      resolvedTarget: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_RECONCILIATION_WINS_RACE_AD_ID,
      }),
      providerGetEvidence: manualProviderGetEvidence({
        adId: MANUAL_RECONCILIATION_WINS_RACE_AD_ID,
        status: "ACTIVE",
      }),
    };
    const barrierKey = 731_902_841;
    let barrierHeld = false;
    try {
      await first.query(`
        CREATE OR REPLACE FUNCTION seam_hold_manual_reconciliation_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $seam_manual_reconciliation_barrier$
        BEGIN
          PERFORM pg_advisory_xact_lock(${barrierKey});
          RETURN NEW;
        END
        $seam_manual_reconciliation_barrier$;

        DROP TRIGGER IF EXISTS trg_seam_hold_manual_reconciliation_insert
        ON meta_ads_action_reconciliation_events;

        CREATE TRIGGER trg_seam_hold_manual_reconciliation_insert
        AFTER INSERT ON meta_ads_action_reconciliation_events
        FOR EACH ROW
        EXECUTE FUNCTION seam_hold_manual_reconciliation_insert();
      `);
      await first.query("SELECT pg_advisory_lock($1::bigint)", [
        barrierKey,
      ]);
      barrierHeld = true;
      const blockedReconciliation =
        appendManualMetaAdStatusReconciliationEvent(
          reconciliationWinnerInput,
        );
      await waitForAdvisoryBarrierWaiter(first, barrierKey);
      const blockedCompletion = capturedError(() =>
        appendManualMetaAdStatusMutationAttemptCompleted({
          sourceActionLogId: reconciliationWins.id,
          attemptId: reconciliationWinnerStarted.attemptId,
          completionOutcome: "provider_response_verified_success",
          mutationAttempt: manualVerifiedMutationAttempt({
            adId: MANUAL_RECONCILIATION_WINS_RACE_AD_ID,
            timestamp: reconciliationWinnerStarted.startedAt,
          }),
          providerResponse: { success: true },
          verification: manualStatusWriteVerification({
            adId: MANUAL_RECONCILIATION_WINS_RACE_AD_ID,
            observedAt: reconciliationObservedAt,
          }),
        }),
      );
      await assertPromisePending(
        blockedCompletion,
        "Late completion behind an uncommitted reconciliation",
      );
      await first.query("SELECT pg_advisory_unlock($1::bigint)", [
        barrierKey,
      ]);
      barrierHeld = false;
      const reconciliationWinner = await blockedReconciliation;
      assert(
        reconciliationWinner.sourceActionLogId === reconciliationWins.id &&
          reconciliationWinner.sourceAuthorityKind ===
            "lease_expired_started",
        `Reconciliation winner did not persist exact expired-start authority: ${stableJson(reconciliationWinner)}`,
      );
      const blockedCompletionError = await blockedCompletion;
      assert(
        blockedCompletionError instanceof Error &&
          blockedCompletionError.message ===
            "Manual Meta mutation attempt completion source changed before lock acquisition." &&
          !["40P01", "55P03", "57014"].includes(
            String(
              (blockedCompletionError as { code?: unknown }).code ?? "",
            ),
          ),
        `Reconciliation winner did not deterministically reject the late completion: ${String(blockedCompletionError)}`,
      );
    } finally {
      if (barrierHeld) {
        await first
          .query("SELECT pg_advisory_unlock($1::bigint)", [barrierKey])
          .catch(() => undefined);
      }
      await first
        .query(
          `DROP TRIGGER IF EXISTS trg_seam_hold_manual_reconciliation_insert
           ON meta_ads_action_reconciliation_events;
           DROP FUNCTION IF EXISTS seam_hold_manual_reconciliation_insert();`,
        )
        .catch(() => undefined);
    }
    const reconciliationWinnerFacts = await second.query<{
      status: string;
      attempt_count: string;
      reconciliation_count: string;
    }>(
      `SELECT
         action.status,
         (
           SELECT count(*)::text
           FROM meta_ads_action_mutation_attempt_events attempt
           WHERE attempt.source_action_log_id = action.id
         ) AS attempt_count,
         (
           SELECT count(*)::text
           FROM meta_ads_action_reconciliation_events reconciliation
           WHERE reconciliation.source_action_log_id = action.id
         ) AS reconciliation_count
       FROM meta_ads_action_log action
       WHERE action.id = $1::uuid`,
      [reconciliationWins.id],
    );
    assert(
      reconciliationWinnerFacts.rows[0]?.status === "pending" &&
        reconciliationWinnerFacts.rows[0]?.attempt_count === "1" &&
        reconciliationWinnerFacts.rows[0]?.reconciliation_count === "1",
      `Reconciliation/completion reverse race left contradictory facts: ${stableJson(reconciliationWinnerFacts.rows)}`,
    );
  } finally {
    await first.query("ROLLBACK").catch(() => undefined);
    await second.query("ROLLBACK").catch(() => undefined);
    await Promise.all([first.end(), second.end()]);
  }
}

async function verifyManualStatusReconciliationSeam(input: {
  client: Client;
  businessId: string;
  providerAccountRefId: string;
  requestedBy: string;
}) {
  await verifyManualStatusTerminalAuthoritySeam(input);
  await verifyManualStatusConcurrencySeam(input);

  const noStart = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_NO_START_AD_ID,
  });
  await ageManualSource(input.client, noStart.id);
  const noStartSettled = await reconcileReadyManualSource({
    ...input,
    adId: MANUAL_NO_START_AD_ID,
    sourceActionLogId: noStart.id,
    observedStatus: "PAUSED",
    expectedAuthority: "pre_provider_no_attempt",
    expectedOutcome: "pre_provider_no_mutation_attempt",
  });

  const sameMillisecond = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_SAME_MILLISECOND_AD_ID,
  });
  await setSameMillisecondManualSourceTime(
    input.client,
    sameMillisecond.id,
  );
  await input.client.query(
    `WITH source AS (
       SELECT
         date_trunc('milliseconds', requested_at) AS started_at,
         date_trunc('milliseconds', requested_at) + interval '2 minutes'
           AS lease_deadline
       FROM meta_ads_action_log
       WHERE id = $1::uuid
     ), attempt AS (
       SELECT
         gen_random_uuid() AS attempt_id,
         source.started_at,
         source.lease_deadline
       FROM source
     ), event AS (
       SELECT
         attempt.attempt_id,
         attempt.started_at,
         attempt.lease_deadline,
         jsonb_build_object(
           'contractVersion', $2::text,
           'eventKind', 'attempt_started',
           'sourceActionLogId', $1::text,
           'attemptId', attempt.attempt_id::text,
           'target', jsonb_build_object(
             'businessId', $3::text,
             'providerAccountRefId', $4::text,
             'providerAccountId', $5::text,
             'adId', $6::text,
             'creativeId', $7::text,
             'campaignId', $8::text,
             'adsetId', $9::text
           ),
           'action', 'pause',
           'postPath', '/' || $6::text,
           'startedAt', to_char(
             attempt.started_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           ),
           'leaseDeadline', to_char(
             attempt.lease_deadline AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )
         ) AS evidence_json
       FROM attempt
     )
     INSERT INTO meta_ads_action_mutation_attempt_events (
       source_action_log_id, business_id, provider_account_ref_id,
       provider_account_id, ad_id, creative_id, campaign_id, adset_id,
       action, attempt_id, event_kind, post_path, started_at, lease_deadline,
       evidence_json, evidence_hash
     )
     SELECT
       $1::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::text,
       $8::text, $9::text, 'pause', event.attempt_id, 'attempt_started',
       '/' || $6::text, event.started_at, event.lease_deadline,
       event.evidence_json,
       encode(digest(event.evidence_json::text, 'sha256'), 'hex')
     FROM event`,
    [
      sameMillisecond.id,
      MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
      input.businessId,
      input.providerAccountRefId,
      PROVIDER_ACCOUNT_ID,
      MANUAL_SAME_MILLISECOND_AD_ID,
      SAFE_CREATIVE_ID,
      SAFE_CAMPAIGN_ID,
      SAFE_ADSET_ID,
    ],
  );
  const sameMillisecondGeometry = await input.client.query<{
    requested_at: string;
    started_at: string;
  }>(
    `SELECT
       action.requested_at::text,
       event.started_at::text
     FROM meta_ads_action_log action
     JOIN meta_ads_action_mutation_attempt_events event
       ON event.source_action_log_id = action.id
     WHERE action.id = $1::uuid`,
    [sameMillisecond.id],
  );
  assert(
    sameMillisecondGeometry.rows.length === 1 &&
      new Date(sameMillisecondGeometry.rows[0]!.started_at).getTime() ===
        new Date(sameMillisecondGeometry.rows[0]!.requested_at).getTime(),
    `Same-millisecond claim/start geometry did not persist: ${stableJson(sameMillisecondGeometry.rows)}`,
  );

  const startedOnly = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_STARTED_ONLY_AD_ID,
  });
  await ageManualSource(input.client, startedOnly.id);
  await appendManualMetaAdStatusMutationAttemptStarted({
    sourceActionLogId: startedOnly.id,
    target: manualMutationTarget({
      businessId: input.businessId,
      adId: MANUAL_STARTED_ONLY_AD_ID,
    }),
    action: "pause",
    postPath: `/${MANUAL_STARTED_ONLY_AD_ID}`,
  });
  await ageManualMutationJournal(input.client, startedOnly.id);
  await reconcileReadyManualSource({
    ...input,
    adId: MANUAL_STARTED_ONLY_AD_ID,
    sourceActionLogId: startedOnly.id,
    observedStatus: "ACTIVE",
    expectedAuthority: "lease_expired_started",
    expectedOutcome: "attempt_lease_expired_without_completion",
  });

  const verified = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_VERIFIED_COMPLETION_AD_ID,
  });
  await ageManualSource(input.client, verified.id);
  const verifiedStart =
    await appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: verified.id,
      target: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_VERIFIED_COMPLETION_AD_ID,
      }),
      action: "pause",
      postPath: `/${MANUAL_VERIFIED_COMPLETION_AD_ID}`,
    });
  await appendManualMetaAdStatusMutationAttemptCompleted({
    sourceActionLogId: verified.id,
    attemptId: verifiedStart.attemptId,
    completionOutcome: "provider_response_verified_success",
    mutationAttempt: {
      attemptCount: 1,
      method: "POST",
      path: `/${MANUAL_VERIFIED_COMPLETION_AD_ID}`,
      attemptedAt: verifiedStart.startedAt,
      completedAt: verifiedStart.startedAt,
      providerResponseReceived: true,
      providerResponseSuccessful: true,
      httpStatus: 200,
      outcome: "provider_response_received",
      automaticRetryAttempted: false,
      transportError: null,
    },
    providerResponse: { success: true },
    verification: manualStatusWriteVerification({
      adId: MANUAL_VERIFIED_COMPLETION_AD_ID,
      observedAt: verifiedStart.startedAt,
    }),
  });
  await ageManualMutationJournal(input.client, verified.id);
  await reconcileReadyManualSource({
    ...input,
    adId: MANUAL_VERIFIED_COMPLETION_AD_ID,
    sourceActionLogId: verified.id,
    observedStatus: "ACTIVE",
    expectedAuthority: "completed_attempt",
    expectedOutcome: "provider_response_verified_success",
  });

  const definiteFailure = await createJournalContractManualSource({
    ...input,
    adId: MANUAL_FAILURE_COMPLETION_AD_ID,
  });
  await ageManualSource(input.client, definiteFailure.id);
  const failureStart =
    await appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: definiteFailure.id,
      target: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_FAILURE_COMPLETION_AD_ID,
      }),
      action: "pause",
      postPath: `/${MANUAL_FAILURE_COMPLETION_AD_ID}`,
    });
  await appendManualMetaAdStatusMutationAttemptCompleted({
    sourceActionLogId: definiteFailure.id,
    attemptId: failureStart.attemptId,
    completionOutcome: "provider_definite_failure",
    mutationAttempt: {
      attemptCount: 1,
      method: "POST",
      path: `/${MANUAL_FAILURE_COMPLETION_AD_ID}`,
      attemptedAt: failureStart.startedAt,
      completedAt: failureStart.startedAt,
      providerResponseReceived: true,
      providerResponseSuccessful: false,
      httpStatus: 200,
      outcome: "provider_response_received",
      automaticRetryAttempted: false,
      transportError: null,
    },
    providerResponse: {
      error: { code: 100, message: "ephemeral definite failure" },
    },
    verification: null,
  });
  await ageManualMutationJournal(input.client, definiteFailure.id);
  await reconcileReadyManualSource({
    ...input,
    adId: MANUAL_FAILURE_COMPLETION_AD_ID,
    sourceActionLogId: definiteFailure.id,
    observedStatus: "PAUSED",
    expectedAuthority: "completed_attempt",
    expectedOutcome: "provider_definite_failure",
  });

  const legacySource = await input.client.query<IdRow>(
    `INSERT INTO meta_ads_action_log (
       business_id, provider_account_id, ad_id, creative_id, action, source,
       requested_by, requested_at, payload_request, payload_response, status,
       error_code, error_message, verified_at, dry_run,
       terminal_finalized_at, created_at, updated_at
     ) VALUES (
       $1::uuid, NULL, $2, $3, 'pause', 'ui_manual', $4::uuid,
       date_trunc('milliseconds', clock_timestamp() - interval '8 days'),
       '{"seam":"legacy-precontract-manual-status"}'::jsonb,
       '{"legacy":"ambiguous"}'::jsonb,
       'silent_failure',
       'provider_outcome_ambiguous',
       'Legacy pre-contract provider outcome is unknown.',
       date_trunc(
         'milliseconds',
         clock_timestamp() - interval '8 days' + interval '1 minute'
       ),
       false,
       NULL,
       date_trunc('milliseconds', clock_timestamp() - interval '8 days'),
       date_trunc(
         'milliseconds',
         clock_timestamp() - interval '8 days' + interval '1 minute'
       )
     )
     RETURNING id::text AS id`,
    [
      input.businessId,
      MANUAL_LEGACY_QUARANTINE_AD_ID,
      SAFE_CREATIVE_ID,
      input.requestedBy,
    ],
  );
  const legacySourceId = legacySource.rows[0]?.id;
  assert(legacySourceId, "Could not seed legacy manual reconciliation source.");
  await input.client.query(
    `INSERT INTO meta_ad_dimensions (
       business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, campaign_id, adset_id, ad_id,
       ad_name_current, ad_status, creative_id, projection_json,
       first_seen_at, last_seen_at, source_updated_at, created_at, updated_at
     ) VALUES (
       $1::text, $1::uuid, $2, $3::uuid, $4, $5, $6,
       'Legacy reconciliation seam', 'ACTIVE', $7,
       '{"seam":"legacy-exact-target"}'::jsonb,
       clock_timestamp() - interval '30 days',
       clock_timestamp() - interval '8 days',
       clock_timestamp() - interval '8 days',
       clock_timestamp() - interval '30 days',
       clock_timestamp() - interval '8 days'
     )`,
    [
      input.businessId,
      PROVIDER_ACCOUNT_ID,
      input.providerAccountRefId,
      SAFE_CAMPAIGN_ID,
      SAFE_ADSET_ID,
      MANUAL_LEGACY_QUARANTINE_AD_ID,
      SAFE_CREATIVE_ID,
    ],
  );
  await reconcileReadyManualSource({
    businessId: input.businessId,
    requestedBy: input.requestedBy,
    adId: MANUAL_LEGACY_QUARANTINE_AD_ID,
    sourceActionLogId: legacySourceId,
    observedStatus: "ACTIVE",
    expectedAuthority: "legacy_quarantine",
    expectedOutcome: "legacy_precontract_quarantine_elapsed",
  });

  await input.client.query(
    `INSERT INTO meta_ads_action_log (
       business_id, provider_account_id, ad_id, creative_id, action, source,
       requested_by, requested_at, payload_request, status, dry_run
     )
     SELECT
       $1::uuid, $2::text, $3::text, $4::text,
       'pause', 'manual_operator_v1',
       $5::uuid,
       date_trunc('milliseconds', clock_timestamp() - make_interval(mins => age)),
       jsonb_build_object(
         'mutation_journal_contract_version', $6::text,
         'mutation_journal_required', true,
         'manual_status_mutation_target', jsonb_build_object(
           'businessId', $1::text,
           'providerAccountId', $2::text,
           'adId', $3::text,
           'creativeId', $4::text,
           'campaignId', $7::text,
           'adsetId', $8::text
         )
       ),
       'pending',
       false
     FROM (VALUES (12), (11)) AS fixture(age)`,
    [
      input.businessId,
      PROVIDER_ACCOUNT_ID,
      MANUAL_MULTIPLE_SOURCE_AD_ID,
      SAFE_CREATIVE_ID,
      input.requestedBy,
      MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
      SAFE_CAMPAIGN_ID,
      SAFE_ADSET_ID,
    ],
  );
  const contradictory =
    await readManualMetaAdStatusReconciliationCandidate({
      businessId: input.businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      adId: MANUAL_MULTIPLE_SOURCE_AD_ID,
    });
  assert(
    contradictory.unresolvedSourceCount === 2 &&
      !contradictory.readyForProviderRead &&
      contradictory.blockerReason ===
        "multiple_unresolved_manual_sources",
    `Multiple unresolved manual sources did not fail closed before provider GET: ${stableJson(contradictory)}`,
  );

  const reconciledSourceFacts = await input.client.query<{
    id: string;
    status: string;
    payload_response: Record<string, unknown> | null;
    terminal_finalized_at: string | null;
  }>(
    `SELECT
       id::text,
       status,
       payload_response,
       terminal_finalized_at::text
     FROM meta_ads_action_log
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[noStart.id, verified.id, legacySourceId]],
  );
  const reconciledFactsById = new Map(
    reconciledSourceFacts.rows.map((row) => [row.id, row]),
  );
  const noStartHistoricalFact = reconciledFactsById.get(noStart.id);
  const verifiedHistoricalFact = reconciledFactsById.get(verified.id);
  const legacyHistoricalFact = reconciledFactsById.get(legacySourceId);
  assert(
    noStartHistoricalFact?.status === "pending" &&
      noStartHistoricalFact.payload_response == null &&
      noStartHistoricalFact.terminal_finalized_at == null &&
      verifiedHistoricalFact?.status === "pending" &&
      verifiedHistoricalFact.payload_response == null &&
      verifiedHistoricalFact.terminal_finalized_at == null &&
      legacyHistoricalFact?.status === "silent_failure" &&
      legacyHistoricalFact.terminal_finalized_at == null,
    `Reconciliation rewrote a historical source terminal fact: ${stableJson(reconciledSourceFacts.rows)}`,
  );

  const reconciledStoreStartError = await capturedError(() =>
    appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: noStart.id,
      target: manualMutationTarget({
        businessId: input.businessId,
        adId: MANUAL_NO_START_AD_ID,
      }),
      action: "pause",
      postPath: `/${MANUAL_NO_START_AD_ID}`,
    }),
  );
  assert(
    reconciledStoreStartError instanceof Error,
    "Store appended a mutation start to reconciled history.",
  );

  const reconciledStoreCompletionError = await capturedError(() =>
    appendManualMetaAdStatusMutationAttemptCompleted({
      sourceActionLogId: verified.id,
      attemptId: verifiedStart.attemptId,
      completionOutcome: "provider_response_verified_success",
      mutationAttempt: manualVerifiedMutationAttempt({
        adId: MANUAL_VERIFIED_COMPLETION_AD_ID,
        timestamp: verifiedStart.startedAt,
      }),
      providerResponse: { success: true },
      verification: manualStatusWriteVerification({
        adId: MANUAL_VERIFIED_COMPLETION_AD_ID,
        observedAt: verifiedStart.startedAt,
      }),
    }),
  );
  assert(
    reconciledStoreCompletionError instanceof Error,
    "Store replayed a mutation completion into reconciled history.",
  );

  const reconciledStoreTerminalError = await capturedError(() =>
    completeMetaAdsActionLog({
      id: noStart.id,
      status: "failure",
      payloadResponse: {
        post_claim_preflight: {
          should_mutate: false,
          blocker: "reconciled_history_terminal_forbidden",
        },
      },
      errorCode: "reconciled_history_terminal_forbidden",
      errorMessage: "Reconciled history must remain unchanged.",
    }),
  );
  assert(
    reconciledStoreTerminalError instanceof Error &&
      reconciledStoreTerminalError.message.includes(
        "terminalization source is not exact",
      ),
    `Store terminalized reconciled history: ${String(reconciledStoreTerminalError)}`,
  );

  const reconciledRawStartedAt = new Date().toISOString();
  const reconciledRawLeaseDeadline = new Date(
    Date.parse(reconciledRawStartedAt) + 2 * 60 * 1_000,
  ).toISOString();
  const reconciledRawStartEvidence = {
    contractVersion:
      MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
    eventKind: "attempt_started",
    sourceActionLogId: noStart.id,
    attemptId: MANUAL_RECONCILED_RAW_ATTEMPT_ID,
    target: {
      businessId: input.businessId,
      providerAccountRefId: input.providerAccountRefId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      adId: MANUAL_NO_START_AD_ID,
      creativeId: SAFE_CREATIVE_ID,
      campaignId: SAFE_CAMPAIGN_ID,
      adsetId: SAFE_ADSET_ID,
    },
    action: "pause",
    postPath: `/${MANUAL_NO_START_AD_ID}`,
    startedAt: reconciledRawStartedAt,
    leaseDeadline: reconciledRawLeaseDeadline,
  };
  const reconciledDatabaseStartError = await capturedError(() =>
    input.client.query(
      INSERT_MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_QUERY,
      [
        noStart.id,
        input.businessId,
        input.providerAccountRefId,
        PROVIDER_ACCOUNT_ID,
        MANUAL_NO_START_AD_ID,
        SAFE_CREATIVE_ID,
        SAFE_CAMPAIGN_ID,
        SAFE_ADSET_ID,
        "pause",
        MANUAL_RECONCILED_RAW_ATTEMPT_ID,
        "attempt_started",
        `/${MANUAL_NO_START_AD_ID}`,
        reconciledRawStartedAt,
        reconciledRawLeaseDeadline,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify(reconciledRawStartEvidence),
      ],
    ),
  );
  assert(
    reconciledDatabaseStartError instanceof Error &&
      (reconciledDatabaseStartError as { code?: string }).code === "23514",
    `Database trigger appended a mutation start to reconciled history: ${String(reconciledDatabaseStartError)}`,
  );

  const reconciledDatabaseCompletionError = await capturedError(() =>
    input.client.query(
      `INSERT INTO meta_ads_action_mutation_attempt_events (
         source_action_log_id, business_id, provider_account_ref_id,
         provider_account_id, ad_id, creative_id, campaign_id, adset_id,
         action, attempt_id, event_kind, post_path, started_at, lease_deadline,
         attempted_at, completed_at, completion_outcome,
         provider_response_received, provider_response_successful,
         http_status, provider_outcome, provider_response_json,
         verification_json, transport_error_json, evidence_json, evidence_hash
       )
       SELECT
         source_action_log_id, business_id, provider_account_ref_id,
         provider_account_id, ad_id, creative_id, campaign_id, adset_id,
         action, attempt_id, event_kind, post_path, started_at, lease_deadline,
         attempted_at, completed_at, completion_outcome,
         provider_response_received, provider_response_successful,
         http_status, provider_outcome, provider_response_json,
         verification_json, transport_error_json, evidence_json, evidence_hash
       FROM meta_ads_action_mutation_attempt_events
       WHERE source_action_log_id = $1::uuid
         AND event_kind = 'attempt_completed'`,
      [verified.id],
    ),
  );
  assert(
    reconciledDatabaseCompletionError instanceof Error &&
      (reconciledDatabaseCompletionError as { code?: string }).code ===
        "23514",
    `Database trigger appended a mutation completion to reconciled history: ${String(reconciledDatabaseCompletionError)}`,
  );

  const reconciledDatabaseTerminalError = await capturedError(() =>
    input.client.query(
      `UPDATE meta_ads_action_log
       SET
         status = 'failure',
         payload_response = jsonb_build_object(
           'post_claim_preflight',
           jsonb_build_object(
             'should_mutate', false,
             'blocker', 'reconciled_history_terminal_forbidden'
           )
         ),
         error_code = 'reconciled_history_terminal_forbidden',
         error_message = 'Reconciled history must remain unchanged.',
         terminal_finalized_at = clock_timestamp(),
         updated_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [noStart.id],
    ),
  );
  assert(
    reconciledDatabaseTerminalError instanceof Error &&
      (reconciledDatabaseTerminalError as { code?: string }).code ===
        "23514",
    `Database trigger terminalized reconciled history: ${String(reconciledDatabaseTerminalError)}`,
  );
  const reconciledPostRejectionFacts = await input.client.query<{
    id: string;
    status: string;
    attempt_count: string;
  }>(
    `SELECT
       action.id::text,
       action.status,
       count(attempt.id)::text AS attempt_count
     FROM meta_ads_action_log action
     LEFT JOIN meta_ads_action_mutation_attempt_events attempt
       ON attempt.source_action_log_id = action.id
     WHERE action.id = ANY($1::uuid[])
     GROUP BY action.id, action.status
     ORDER BY action.id`,
    [[noStart.id, verified.id]],
  );
  const reconciledPostRejectionById = new Map(
    reconciledPostRejectionFacts.rows.map((row) => [row.id, row]),
  );
  assert(
    reconciledPostRejectionById.get(noStart.id)?.status === "pending" &&
      reconciledPostRejectionById.get(noStart.id)?.attempt_count === "0" &&
      reconciledPostRejectionById.get(verified.id)?.status === "pending" &&
      reconciledPostRejectionById.get(verified.id)?.attempt_count === "2",
    `Rejected reconciled-history writes changed facts: ${stableJson(reconciledPostRejectionFacts.rows)}`,
  );

  let immutableError: unknown = null;
  try {
    await input.client.query(
      `UPDATE meta_ads_action_reconciliation_events
       SET resolution = 'current_state_matches_precondition'
       WHERE id = $1::uuid`,
      [noStartSettled.reconciliation.id],
    );
  } catch (error) {
    immutableError = error;
  }
  assert(
    immutableError instanceof Error &&
      (immutableError as { code?: string }).code === "55000",
    `Reconciliation append-only guard did not reject mutation: ${String(immutableError)}`,
  );
}

async function main() {
  const databaseUrl = assertEphemeralMigratedDatabase();
  resetDbClientCache();
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await assertMigratedSchema(admin);
    const userResult = await admin.query<IdRow>(
      `INSERT INTO users (name, email, password_hash)
       VALUES (
         'Native fact ownership seam',
         'native-fact-ownership-seam@example.invalid',
         'unused'
       )
       RETURNING id::text AS id`,
    );
    const userId = userResult.rows[0]?.id;
    assert(userId, "Could not create native fact ownership seam user.");
    const businessResult = await admin.query<IdRow>(
      `INSERT INTO businesses (name, owner_id, timezone, currency)
       VALUES ('Native fact ownership seam', $1::uuid, 'Europe/Istanbul', 'TRY')
       RETURNING id::text AS id`,
      [userId],
    );
    const businessId = businessResult.rows[0]?.id;
    assert(businessId, "Could not create native fact ownership seam business.");
    const accountResult = await admin.query<IdRow>(
      `INSERT INTO provider_accounts (
         provider, external_account_id, account_name, timezone, currency
       ) VALUES (
         'meta', $1, 'Native fact ownership seam', 'Europe/Istanbul', 'TRY'
       )
       RETURNING id::text AS id`,
      [PROVIDER_ACCOUNT_ID],
    );
    const providerAccountRefId = accountResult.rows[0]?.id;
    assert(
      providerAccountRefId,
      "Could not create native fact ownership seam provider account.",
    );
    await admin.query(
      `INSERT INTO business_provider_accounts (
         business_id, provider, provider_account_ref_id, provider_account_id
       ) VALUES ($1, 'meta', $2::uuid, $3)`,
      [businessId, providerAccountRefId, PROVIDER_ACCOUNT_ID],
    );

    const safeCampaignId = SAFE_CAMPAIGN_ID;
    const safeAdsetId = SAFE_ADSET_ID;
    const unsafeCampaignId = "campaign_native_fact_unsafe";
    const unsafeAdsetId = "adset_native_fact_unsafe";
    await upsertMetaAdDailyRows(
      [
        authoritativeFact({
          businessId,
          date: SAFE_DATE,
          adId: SAFE_AD_ID,
          campaignId: safeCampaignId,
          adsetId: safeAdsetId,
          creativeId: SAFE_CREATIVE_ID,
          spend: 123.45,
          impressions: 1_000,
          clicks: 100,
          conversions: 5,
          revenue: 400,
          linkClicks: 80,
          payload: {
            landing_page_views: "71",
            add_to_cart: "9",
            initiate_checkout: "4",
            preview_url: "https://media.invalid/should-not-persist",
            preview: {
              image_url: "https://media.invalid/nested-should-not-persist",
            },
            retained_metric_proof: { source: "authoritative_sync" },
          },
        }),
        authoritativeFact({
          businessId,
          date: AS_OF_DATE,
          adId: UNSAFE_AD_ID,
          campaignId: unsafeCampaignId,
          adsetId: unsafeAdsetId,
          creativeId: "creative_native_fact_unsafe",
          spend: 25,
          impressions: 200,
          clicks: 10,
          conversions: 1,
          revenue: 30,
          linkClicks: 8,
          payload: {
            landing_page_views: "7",
            add_to_cart: "2",
            initiate_checkout: "1",
          },
        }),
      ],
      { writeMode: "authoritative_fact" },
    );

    await admin.query(
      `UPDATE meta_ad_daily
       SET
         created_at = '2026-07-17T00:00:00Z',
         updated_at = CASE
           WHEN ad_id = $3 THEN $4::timestamptz
           WHEN ad_id = $5 THEN $6::timestamptz
           ELSE updated_at
         END
       WHERE business_id = $1
         AND provider_account_id = $2
         AND ad_id IN ($3, $5)`,
      [
        businessId,
        PROVIDER_ACCOUNT_ID,
        SAFE_AD_ID,
        CUTOFF,
        UNSAFE_AD_ID,
        AFTER_CUTOFF,
      ],
    );
    await admin.query(
      `INSERT INTO meta_campaign_daily (
         business_id, business_ref_id, provider_account_id,
         provider_account_ref_id, date, campaign_id, objective,
         optimization_goal, custom_event_type, account_timezone,
         account_currency, truth_state, finalized_at, validation_status,
         created_at, updated_at
       )
       VALUES
         (
           $1::text, $1::uuid, $2, $3::uuid, $4::date, $5, 'OUTCOME_SALES',
           'OFFSITE_CONVERSIONS', 'PURCHASE', 'Europe/Istanbul', 'TRY',
           'finalized', '2026-07-18T03:14:00Z', 'passed',
           '2026-07-17T00:00:00Z', $6::timestamptz
         ),
         (
           $1::text, $1::uuid, $2, $3::uuid, $7::date, $8, 'OUTCOME_SALES',
           'OFFSITE_CONVERSIONS', 'PURCHASE', 'Europe/Istanbul', 'TRY',
           'finalized', '2026-07-18T03:14:00Z', 'passed',
           '2026-07-17T00:00:00Z', $6::timestamptz
         )`,
      [
        businessId,
        PROVIDER_ACCOUNT_ID,
        providerAccountRefId,
        SAFE_DATE,
        safeCampaignId,
        CUTOFF,
        AS_OF_DATE,
        unsafeCampaignId,
      ],
    );
    await admin.query(
      `INSERT INTO meta_adset_daily (
         business_id, business_ref_id, provider_account_id,
         provider_account_ref_id, date, campaign_id, adset_id,
         optimization_goal, custom_event_type, account_timezone,
         account_currency, truth_state, finalized_at, validation_status,
         created_at, updated_at
       )
       VALUES
         (
           $1::text, $1::uuid, $2, $3::uuid, $4::date, $5, $6,
           'OFFSITE_CONVERSIONS', 'PURCHASE', 'Europe/Istanbul', 'TRY',
           'finalized', '2026-07-18T03:14:00Z', 'passed',
           '2026-07-17T00:00:00Z', $7::timestamptz
         ),
         (
           $1::text, $1::uuid, $2, $3::uuid, $8::date, $9, $10,
           'OFFSITE_CONVERSIONS', 'PURCHASE', 'Europe/Istanbul', 'TRY',
           'finalized', '2026-07-18T03:14:00Z', 'passed',
           '2026-07-17T00:00:00Z', $7::timestamptz
         )`,
      [
        businessId,
        PROVIDER_ACCOUNT_ID,
        providerAccountRefId,
        SAFE_DATE,
        safeCampaignId,
        safeAdsetId,
        CUTOFF,
        AS_OF_DATE,
        unsafeCampaignId,
        unsafeAdsetId,
      ],
    );

    const sql = getDb();
    const storedRows = await sql.query<Record<string, unknown>>(
      `SELECT *
       FROM meta_ad_daily
       WHERE business_id = $1
         AND provider_account_id = $2
         AND ad_id IN ($3, $4)
       ORDER BY date, ad_id`,
      [businessId, PROVIDER_ACCOUNT_ID, SAFE_AD_ID, UNSAFE_AD_ID],
    );
    const warehouseRows = await getMetaAdDailyRange({
      businessId,
      providerAccountIds: [PROVIDER_ACCOUNT_ID],
      startDate: SAFE_DATE,
      endDate: AS_OF_DATE,
    });
    assert(
      storedRows.length === 2 && warehouseRows.length === 2,
      "Authoritative fact writer/current warehouse reader did not expose both rows.",
    );
    for (const warehouseRow of warehouseRows) {
      const storedRow = storedRows.find(
        (candidate) => String(candidate.ad_id) === warehouseRow.adId,
      );
      assert(storedRow, `Stored fact ${warehouseRow.adId} is missing.`);
      assertSameBytes(
        warehouseProjection(warehouseRow),
        storedProjection(storedRow),
        `Current warehouse reader bytes for ${warehouseRow.adId}`,
      );
    }

    const safeWarehouseRow = warehouseRows.find(
      (row) => row.adId === SAFE_AD_ID,
    );
    assert(safeWarehouseRow, "Cutoff-safe warehouse fact is missing.");
    const safePayload = safeWarehouseRow.payloadJson as Record<string, unknown>;
    assert(
      safePayload.preview_url === undefined &&
        safePayload.preview === undefined &&
        stableJson(safePayload.retained_metric_proof) ===
          '{"source":"authoritative_sync"}',
      `Authoritative ingestion did not strip only media payload keys: ${stableJson(safePayload)}`,
    );

    const calibrationRows = await runDbTransaction(
      async () => {
        const transactionDb = getDb();
        await transactionDb.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
        );
        const receipt = await transactionDb.query<Record<string, unknown>>(
          READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL,
        );
        assert(
          String(receipt[0]?.transaction_isolation).toLowerCase() ===
            "repeatable read",
          "Calibration source proof did not execute in REPEATABLE READ.",
        );
        return transactionDb.query<Record<string, unknown>>(
          READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
          [
            businessId,
            AS_OF_DATE,
            providerAccountRefId,
            PROVIDER_ACCOUNT_ID,
            CUTOFF,
          ],
        );
      },
      { timeoutMs: 30_000 },
    );
    assert(
      calibrationRows.length === 1 &&
        String(calibrationRows[0]?.ad_id) === SAFE_AD_ID,
      `Calibration cutoff did not include the exact-boundary row and exclude the 1ms-late row: ${stableJson(calibrationRows.map((row) => row.ad_id))}`,
    );
    assertSameBytes(
      calibrationProjection(calibrationRows[0]!),
      warehouseCalibrationProjection(
        safeWarehouseRow,
        providerAccountRefId,
      ),
      "Calibration/current warehouse shared decision-fact bytes",
    );

    await admin.query(
      `INSERT INTO meta_ad_daily (
         business_id, business_ref_id, provider_account_id,
         provider_account_ref_id, date, ad_id, ad_name_current,
         account_timezone, account_currency, spend, impressions, clicks,
         reach, conversions, revenue, roas, link_clicks, truth_state,
         truth_version, finalized_at, validation_status, metric_schema_version,
         payload_json, created_at, updated_at
       ) VALUES (
         $1::text, $1::uuid, $2, $3::uuid, $4::date, $5, 'Legacy media sentinel',
         'Europe/Istanbul', 'TRY', 10, 100, 5, 80, 1, 20, 2, 4,
         'finalized', 1, '2025-01-02T00:00:00Z', 'passed', 1,
         '{
           "landing_page_views":"4",
           "preview_url":"https://legacy-media.invalid/preview",
           "preview":{"image_url":"https://legacy-media.invalid/image"}
         }'::jsonb,
         '2025-01-02T00:00:00Z', '2025-01-03T00:00:00Z'
       )`,
      [
        businessId,
        PROVIDER_ACCOUNT_ID,
        providerAccountRefId,
        LEGACY_MEDIA_DATE,
        LEGACY_MEDIA_AD_ID,
      ],
    );
    const beforeCreativeSync = await readFullRowHashes(admin, businessId);
    assert(beforeCreativeSync.length === 3, "Fact hash fixture is incomplete.");
    await Promise.all([
      upsertMetaCreativeDailyRows([
        {
          businessId,
          providerAccountId: PROVIDER_ACCOUNT_ID,
          date: LEGACY_MEDIA_DATE,
          campaignId: null,
          adsetId: null,
          adId: LEGACY_MEDIA_AD_ID,
          creativeId: "creative_legacy_media_sentinel",
          creativeName: "Legacy media sentinel",
          headline: "Presentation-only headline",
          primaryText: "Presentation-only copy",
          descriptionText: "Presentation-only description",
          destinationUrl: "https://legacy-media.invalid/destination",
          destinationUrlRaw: "https://legacy-media.invalid/destination?raw=1",
          destinationUrlSource: "creative_api",
          destinationUrlConfidence: "high",
          ctaType: "SHOP_NOW",
          objectStoryId: "legacy_story",
          effectiveObjectStoryId: "legacy_effective_story",
          thumbnailUrl: "https://legacy-media.invalid/thumbnail",
          assetType: "image",
          accountTimezone: "Europe/Istanbul",
          accountCurrency: "TRY",
          spend: 10,
          impressions: 100,
          clicks: 5,
          reach: 80,
          frequency: 1.25,
          conversions: 1,
          revenue: 20,
          roas: 2,
          cpa: 10,
          ctr: 5,
          cpc: 2,
          linkClicks: 4,
          sourceSnapshotId: null,
          sourceRunId: "creative-sync-native-fact-ownership-seam",
          metricSchemaVersion: 3,
          payloadJson: {
            preview_url: "https://legacy-media.invalid/preview",
            presentation_only: true,
          },
        },
      ]),
      upsertMetaCreativeMediaRows([
        {
          businessId,
          providerAccountId: PROVIDER_ACCOUNT_ID,
          date: LEGACY_MEDIA_DATE,
          campaignId: null,
          adsetId: null,
          adId: LEGACY_MEDIA_AD_ID,
          creativeId: "creative_legacy_media_sentinel",
          previewUrl: "https://legacy-media.invalid/preview",
          thumbnailUrl: "https://legacy-media.invalid/thumbnail",
          payloadJson: { sentinel: "media" },
          sourceRunId: "creative-sync-native-fact-ownership-seam",
          createdAt: "2025-01-02T00:00:00.000Z",
          updatedAt: "2025-01-03T00:00:00.000Z",
        },
      ]),
    ]);
    const afterCreativeSync = await readFullRowHashes(admin, businessId);
    assertSameBytes(
      beforeCreativeSync,
      afterCreativeSync,
      "Full meta_ad_daily row bytes/hashes after creative sync persistence",
    );

    const beforePrune = afterCreativeSync;
    const pruneSummary = await pruneMetaCreativeMediaOutsideRetention({
      businessId,
      keepFromDate: AS_OF_DATE,
    });
    assert(
      pruneSummary.metaCreativeMediaDeleted === 1 &&
        pruneSummary.metaCreativeDailyUpdated === 1 &&
        pruneSummary.metaAdDailyUpdated === 0,
      `Creative media prune did not execute the expected non-fact mutations: ${stableJson(pruneSummary)}`,
    );
    const afterPrune = await readFullRowHashes(admin, businessId);
    assertSameBytes(
      beforePrune,
      afterPrune,
      "Full meta_ad_daily row bytes/hashes after creative-media prune",
    );

    const retainedLegacyPayload = await admin.query<{
      payload_json: Record<string, unknown>;
    }>(
      `SELECT payload_json
       FROM meta_ad_daily
       WHERE business_id = $1 AND ad_id = $2`,
      [businessId, LEGACY_MEDIA_AD_ID],
    );
    assert(
      retainedLegacyPayload.rows[0]?.payload_json.preview_url ===
        "https://legacy-media.invalid/preview",
      "Creative media prune changed retained legacy decision-fact payload bytes.",
    );

    const decisionEpisodes = await createDecisionOriginFixtures({
      client: admin,
      businessId,
      providerAccountRefId,
    });
    await verifyCrossOriginStatusClaims({
      client: admin,
      businessId,
      requestedBy: userId,
      episodes: decisionEpisodes,
    });
    await verifyManualStatusReconciliationSeam({
      client: admin,
      businessId,
      providerAccountRefId,
      requestedBy: userId,
    });
    await verifyAtomicDecisionOriginClaimAndRollback({
      client: admin,
      businessId,
      requestedBy: userId,
      episodes: decisionEpisodes,
    });

    console.log(
      "[native-ad-fact-ownership-seam] PASS: migrated authoritative writer/current reader bytes, REPEATABLE READ exact-cutoff calibration bytes, ingest media stripping, creative-sync fact isolation, full-row prune immutability, shared status claims, append-only manual mutation journals, canonical verified-success geometry, journal-authorized terminalization, reconciled-history write rejection, pre-provider/expired-lease/completed/legacy-quarantine reconciliation authority, exact current-state recovery, atomic replacement claims, and completion/receipt rollback.",
    );
  } finally {
    await admin.end();
    resetDbClientCache();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    resetDbClientCache();
    process.exit(1);
  });
