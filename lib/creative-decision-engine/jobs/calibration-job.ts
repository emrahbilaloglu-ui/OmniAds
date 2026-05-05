import { getDb, runDbTransaction } from "@/lib/db";
import { STALE_TIER_WARNING_MAX_HOURS } from "../data-health";
import { ENGINE_VERSION, type AccountCalibration } from "../types";

export const JOB_NAME = "engine_v3_calibration_job";
const SAMPLE_WINDOW_DAYS = 90;
const ACCOUNT_SCOPE_TYPE = "account";
const ACCOUNT_SCOPE_ID = "*";

export interface CalibrationJobInput {
  businessId: string;
  asOf: string;
  scopeType?: typeof ACCOUNT_SCOPE_TYPE;
  scopeId?: string;
}

export interface CalibrationJobResult {
  jobRunId: string;
  status: "success" | "failed" | "skipped";
  rowsWritten: number;
  durationMs: number;
  calibration: AccountCalibration | null;
  errorMessage?: string;
}

type QualityStatus = "ready" | "low_sample" | "stale" | "fallback";

interface ComputedCalibration {
  businessId: string;
  scopeType: typeof ACCOUNT_SCOPE_TYPE;
  scopeId: string;
  asOfDate: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  sampleWindowDays: number;
  eligibleCreativeCount: number;
  matureCreativeCount: number;
  zeroConversionCount: number;
  roasP75: number | null;
  roasP60: number | null;
  refreshRatioP10: number | null;
  lowCtrP10: number | null;
  accountCpaP50: number | null;
  accountCpaSampleCount: number;
  metaAttributedAovMean90d: number | null;
  metaAttributedAovPurchaseCount90d: number;
  metaAttributedRevenue90d: number;
  metaAovQuality: AccountCalibration["metaAovQuality"];
  matureSpendP50: number | null;
  matureSpendP75: number | null;
  winnerSpendP25: number | null;
  winnerSpendP50: number | null;
  winnerPurchaseP50: number | null;
  roasRatioP10: number | null;
  roasRatioP25: number | null;
  roasRatioP50: number | null;
  roasRatioP75: number | null;
  sourceMinDate: string | null;
  sourceMaxDate: string | null;
  sourceMaxUpdatedAt: string | null;
  qualityStatus: QualityStatus;
  computedAt: string;
}

type CalibrationComputationRow = Record<string, unknown> & {
  sample_window_start: unknown;
  sample_window_end: unknown;
  sample_window_days: unknown;
  eligible_creative_count: unknown;
  mature_creative_count: unknown;
  zero_conversion_count: unknown;
  roas_p75: unknown;
  roas_p60: unknown;
  refresh_ratio_p10: unknown;
  low_ctr_p10: unknown;
  account_cpa_p50: unknown;
  account_cpa_sample_count: unknown;
  meta_attributed_aov_mean_90d: unknown;
  meta_attributed_aov_purchase_count_90d: unknown;
  meta_attributed_revenue_90d: unknown;
  meta_aov_quality: unknown;
  mature_spend_p50: unknown;
  mature_spend_p75: unknown;
  winner_spend_p25: unknown;
  winner_spend_p50: unknown;
  winner_purchase_p50: unknown;
  roas_ratio_p10: unknown;
  roas_ratio_p25: unknown;
  roas_ratio_p50: unknown;
  roas_ratio_p75: unknown;
  source_min_date: unknown;
  source_max_date: unknown;
  source_max_updated_at: unknown;
};

type JobRunIdRow = Record<string, unknown> & {
  id: unknown;
};

type AdvisoryLockRow = Record<string, unknown> & {
  acquired: unknown;
};

const COMPUTE_CALIBRATION_QUERY = `
WITH target_pack AS (
  SELECT target_roas
  FROM business_target_packs
  WHERE business_id = $2::uuid
  ORDER BY updated_at DESC
  LIMIT 1
),
per_creative_raw AS (
  SELECT
    creative_id,
    SUM(spend) AS total_spend,
    SUM(conversions) AS total_purchases,
    SUM(revenue) AS total_revenue,
    SUM(spend) FILTER (WHERE date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_spend,
    SUM(revenue) FILTER (WHERE date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_revenue,
    SUM(impressions) FILTER (WHERE date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_impressions,
    SUM(clicks) FILTER (WHERE date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_clicks,
    SUM(spend) FILTER (WHERE date >= ($1::date - INTERVAL '6 days')) AS recent_7d_spend,
    SUM(revenue) FILTER (WHERE date >= ($1::date - INTERVAL '6 days')) AS recent_7d_revenue
  FROM meta_creative_daily
  WHERE business_ref_id = $2::uuid
    AND date BETWEEN ($1::date - INTERVAL '89 days') AND $1::date
  GROUP BY creative_id
),
per_creative AS (
  SELECT
    creative_id,
    total_spend,
    total_purchases,
    total_revenue,
    CASE WHEN total_spend > 0 THEN total_revenue / total_spend END AS aggregate_roas,
    CASE
      WHEN cumulative_28d_spend > 0
      THEN cumulative_28d_revenue / cumulative_28d_spend
    END AS cumulative_28d_roas,
    CASE
      WHEN cumulative_28d_impressions > 0
      THEN cumulative_28d_clicks::numeric / NULLIF(cumulative_28d_impressions, 0) * 100
    END AS cumulative_28d_ctr,
    CASE
      WHEN recent_7d_spend > 0
      THEN recent_7d_revenue / recent_7d_spend
    END AS recent_7d_roas
  FROM per_creative_raw
),
converter_population AS (
  SELECT *
  FROM per_creative
  WHERE total_purchases >= 1
    AND total_revenue > 0
    AND total_spend > 0
),
winner_population AS (
  SELECT cp.*
  FROM converter_population cp
  CROSS JOIN target_pack tp
  WHERE tp.target_roas IS NOT NULL
    AND cp.aggregate_roas >= tp.target_roas
),
recent_ratios AS (
  SELECT
    creative_id,
    CASE
      WHEN recent_7d_roas > 0 AND cumulative_28d_roas > 0
      THEN recent_7d_roas / cumulative_28d_roas
    END AS recent_total_ratio
  FROM per_creative
),
counts AS (
  SELECT
    (SELECT COUNT(*) FROM per_creative WHERE total_spend > 0) AS eligible_creative_count,
    (SELECT COUNT(*) FROM converter_population) AS converter_count,
    (SELECT COUNT(*) FROM winner_population) AS winner_count,
    (SELECT COUNT(*) FROM per_creative WHERE total_purchases > 0) AS account_cpa_sample_count,
    (SELECT COUNT(*) FROM per_creative WHERE total_spend > 0 AND COALESCE(total_purchases, 0) = 0) AS zero_conversion_count,
    (SELECT COUNT(*) FROM recent_ratios WHERE recent_total_ratio IS NOT NULL) AS refresh_ratio_count,
    (SELECT COUNT(*) FROM per_creative WHERE cumulative_28d_ctr IS NOT NULL) AS ctr_count
),
percentiles AS (
  SELECT
    percentile_cont(0.50) WITHIN GROUP (ORDER BY total_spend / NULLIF(total_purchases, 0))
      FILTER (WHERE total_purchases > 0) AS cpa_p50_raw,
    percentile_cont(0.10) WITHIN GROUP (ORDER BY aggregate_roas) AS roas_p10_raw,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY aggregate_roas) AS roas_p25_raw,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY aggregate_roas) AS roas_p50_raw,
    percentile_cont(0.60) WITHIN GROUP (ORDER BY aggregate_roas) AS roas_p60_raw,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY aggregate_roas) AS roas_p75_raw,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY total_spend) AS mature_spend_p50,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY total_spend) AS mature_spend_p75,
    percentile_cont(0.10) WITHIN GROUP (ORDER BY aggregate_roas / NULLIF(tp.target_roas, 0))
      FILTER (WHERE tp.target_roas IS NOT NULL) AS roas_ratio_p10,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY aggregate_roas / NULLIF(tp.target_roas, 0))
      FILTER (WHERE tp.target_roas IS NOT NULL) AS roas_ratio_p25,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY aggregate_roas / NULLIF(tp.target_roas, 0))
      FILTER (WHERE tp.target_roas IS NOT NULL) AS roas_ratio_p50,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY aggregate_roas / NULLIF(tp.target_roas, 0))
      FILTER (WHERE tp.target_roas IS NOT NULL) AS roas_ratio_p75
  FROM converter_population cp
  CROSS JOIN target_pack tp
),
winner_percentiles AS (
  SELECT
    percentile_cont(0.25) WITHIN GROUP (ORDER BY total_spend) AS winner_spend_p25,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY total_spend) AS winner_spend_p50,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY total_purchases) AS winner_purchase_p50
  FROM winner_population
),
meta_aov AS (
  SELECT
    CASE WHEN SUM(conversions) > 0 THEN SUM(revenue) / SUM(conversions) END AS aov_mean,
    COALESCE(SUM(conversions), 0)::integer AS purchase_count,
    COALESCE(SUM(revenue), 0) AS total_revenue
  FROM meta_creative_daily
  WHERE business_ref_id = $2::uuid
    AND date BETWEEN ($1::date - INTERVAL '89 days') AND $1::date
    AND objective = 'OUTCOME_SALES'
),
source_bounds AS (
  SELECT
    MIN(date) AS source_min_date,
    MAX(date) AS source_max_date,
    MAX(updated_at) AS source_max_updated_at
  FROM meta_creative_daily
  WHERE business_ref_id = $2::uuid
    AND date BETWEEN ($1::date - INTERVAL '89 days') AND $1::date
)
SELECT
  ($1::date - INTERVAL '89 days')::date AS sample_window_start,
  $1::date AS sample_window_end,
  $3::integer AS sample_window_days,
  counts.eligible_creative_count,
  counts.converter_count AS mature_creative_count,
  counts.zero_conversion_count,
  CASE WHEN counts.converter_count >= 30 THEN percentiles.roas_p75_raw END AS roas_p75,
  CASE WHEN counts.converter_count >= 10 THEN percentiles.roas_p60_raw END AS roas_p60,
  CASE WHEN counts.refresh_ratio_count >= 20 THEN (
    SELECT percentile_cont(0.10) WITHIN GROUP (ORDER BY recent_total_ratio)
    FROM recent_ratios
    WHERE recent_total_ratio IS NOT NULL
  ) END AS refresh_ratio_p10,
  CASE WHEN counts.ctr_count >= 20 THEN (
    SELECT percentile_cont(0.10) WITHIN GROUP (ORDER BY cumulative_28d_ctr)
    FROM per_creative
    WHERE cumulative_28d_ctr IS NOT NULL
  ) END AS low_ctr_p10,
  CASE WHEN counts.account_cpa_sample_count >= 20 THEN percentiles.cpa_p50_raw END AS account_cpa_p50,
  counts.account_cpa_sample_count,
  meta_aov.aov_mean AS meta_attributed_aov_mean_90d,
  meta_aov.purchase_count AS meta_attributed_aov_purchase_count_90d,
  meta_aov.total_revenue AS meta_attributed_revenue_90d,
  CASE
    WHEN meta_aov.purchase_count >= 20 THEN 'ready'
    WHEN meta_aov.purchase_count >= 5 THEN 'low_sample'
    WHEN meta_aov.purchase_count >= 1 THEN 'unstable'
    ELSE 'unavailable'
  END AS meta_aov_quality,
  percentiles.mature_spend_p50,
  percentiles.mature_spend_p75,
  winner_percentiles.winner_spend_p25,
  winner_percentiles.winner_spend_p50,
  winner_percentiles.winner_purchase_p50,
  percentiles.roas_ratio_p10,
  percentiles.roas_ratio_p25,
  percentiles.roas_ratio_p50,
  percentiles.roas_ratio_p75,
  source_bounds.source_min_date,
  source_bounds.source_max_date,
  source_bounds.source_max_updated_at
FROM counts
CROSS JOIN percentiles
CROSS JOIN winner_percentiles
CROSS JOIN meta_aov
CROSS JOIN source_bounds
`;

const UPSERT_CALIBRATION_QUERY = `
INSERT INTO engine_v3_account_calibration_daily (
  business_ref_id, business_id, scope_type, scope_id, as_of_date, engine_version,
  sample_window_start, sample_window_end, sample_window_days,
  eligible_creative_count, mature_creative_count, zero_conversion_count,
  roas_p75, roas_p60, refresh_ratio_p10, low_ctr_p10,
  account_cpa_p50, account_cpa_sample_count,
  meta_attributed_aov_mean_90d, meta_attributed_aov_purchase_count_90d,
  meta_attributed_revenue_90d, meta_aov_quality,
  mature_spend_p50, mature_spend_p75,
  winner_spend_p25, winner_spend_p50, winner_purchase_p50,
  roas_ratio_p10, roas_ratio_p25, roas_ratio_p50, roas_ratio_p75,
  source_min_date, source_max_date, source_max_updated_at,
  quality_status, job_run_id, computed_at
) VALUES (
  $1::uuid, $2, $3, $4, $5::date, $6,
  $7::date, $8::date, $9::integer,
  $10::integer, $11::integer, $12::integer,
  $13::double precision, $14::double precision, $15::double precision, $16::double precision,
  $17::double precision, $18::integer,
  $19::double precision, $20::integer,
  $21::double precision, $22,
  $23::double precision, $24::double precision,
  $25::double precision, $26::double precision, $27::double precision,
  $28::double precision, $29::double precision, $30::double precision, $31::double precision,
  $32::date, $33::date, $34::timestamptz,
  $35, $36::uuid, $37::timestamptz
)
ON CONFLICT (business_ref_id, scope_type, scope_id, as_of_date, engine_version)
DO UPDATE SET
  sample_window_start = EXCLUDED.sample_window_start,
  sample_window_end = EXCLUDED.sample_window_end,
  sample_window_days = EXCLUDED.sample_window_days,
  eligible_creative_count = EXCLUDED.eligible_creative_count,
  mature_creative_count = EXCLUDED.mature_creative_count,
  zero_conversion_count = EXCLUDED.zero_conversion_count,
  roas_p75 = EXCLUDED.roas_p75,
  roas_p60 = EXCLUDED.roas_p60,
  refresh_ratio_p10 = EXCLUDED.refresh_ratio_p10,
  low_ctr_p10 = EXCLUDED.low_ctr_p10,
  account_cpa_p50 = EXCLUDED.account_cpa_p50,
  account_cpa_sample_count = EXCLUDED.account_cpa_sample_count,
  meta_attributed_aov_mean_90d = EXCLUDED.meta_attributed_aov_mean_90d,
  meta_attributed_aov_purchase_count_90d = EXCLUDED.meta_attributed_aov_purchase_count_90d,
  meta_attributed_revenue_90d = EXCLUDED.meta_attributed_revenue_90d,
  meta_aov_quality = EXCLUDED.meta_aov_quality,
  mature_spend_p50 = EXCLUDED.mature_spend_p50,
  mature_spend_p75 = EXCLUDED.mature_spend_p75,
  winner_spend_p25 = EXCLUDED.winner_spend_p25,
  winner_spend_p50 = EXCLUDED.winner_spend_p50,
  winner_purchase_p50 = EXCLUDED.winner_purchase_p50,
  roas_ratio_p10 = EXCLUDED.roas_ratio_p10,
  roas_ratio_p25 = EXCLUDED.roas_ratio_p25,
  roas_ratio_p50 = EXCLUDED.roas_ratio_p50,
  roas_ratio_p75 = EXCLUDED.roas_ratio_p75,
  source_min_date = EXCLUDED.source_min_date,
  source_max_date = EXCLUDED.source_max_date,
  source_max_updated_at = EXCLUDED.source_max_updated_at,
  quality_status = EXCLUDED.quality_status,
  job_run_id = EXCLUDED.job_run_id,
  computed_at = EXCLUDED.computed_at,
  updated_at = now()
`;

export async function runCalibrationJob(
  input: CalibrationJobInput,
): Promise<CalibrationJobResult> {
  const startedAt = Date.now();
  const scopeType = input.scopeType ?? ACCOUNT_SCOPE_TYPE;
  const scopeId = input.scopeId ?? ACCOUNT_SCOPE_ID;
  const lockKey = hashAdvisoryLock(
    `${JOB_NAME}:${input.businessId}:${input.asOf}`,
  );

  return runDbTransaction(async () => {
    const db = getDb();
    const [lockRow] = await db.query<AdvisoryLockRow>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [lockKey.toString()],
    );

    if (lockRow?.acquired !== true) {
      const durationMs = Date.now() - startedAt;
      const jobRunId = await insertJobRun({
        businessId: input.businessId,
        asOf: input.asOf,
        status: "skipped",
        durationMs,
        rowCount: 0,
        errorMessage: "Advisory lock not acquired (job may already be running)",
      });
      return {
        jobRunId,
        status: "skipped",
        rowsWritten: 0,
        durationMs,
        calibration: null,
        errorMessage: "Advisory lock not acquired (job may already be running)",
      };
    }

    const jobRunId = await insertJobRun({
      businessId: input.businessId,
      asOf: input.asOf,
      status: "running",
    });

    await db.query("SAVEPOINT engine_v3_calibration_job_work");
    try {
      const calibration = await computeCalibration({
        businessId: input.businessId,
        asOf: input.asOf,
        scopeType,
        scopeId,
      });
      await db.query(UPSERT_CALIBRATION_QUERY, [
        calibration.businessId,
        calibration.businessId,
        calibration.scopeType,
        calibration.scopeId,
        calibration.asOfDate,
        ENGINE_VERSION,
        calibration.sampleWindowStart,
        calibration.sampleWindowEnd,
        calibration.sampleWindowDays,
        calibration.eligibleCreativeCount,
        calibration.matureCreativeCount,
        calibration.zeroConversionCount,
        calibration.roasP75,
        calibration.roasP60,
        calibration.refreshRatioP10,
        calibration.lowCtrP10,
        calibration.accountCpaP50,
        calibration.accountCpaSampleCount,
        calibration.metaAttributedAovMean90d,
        calibration.metaAttributedAovPurchaseCount90d,
        calibration.metaAttributedRevenue90d,
        calibration.metaAovQuality,
        calibration.matureSpendP50,
        calibration.matureSpendP75,
        calibration.winnerSpendP25,
        calibration.winnerSpendP50,
        calibration.winnerPurchaseP50,
        calibration.roasRatioP10,
        calibration.roasRatioP25,
        calibration.roasRatioP50,
        calibration.roasRatioP75,
        calibration.sourceMinDate,
        calibration.sourceMaxDate,
        calibration.sourceMaxUpdatedAt,
        calibration.qualityStatus,
        jobRunId,
        calibration.computedAt,
      ]);

      const durationMs = Date.now() - startedAt;
      await db.query(
        `
        UPDATE engine_v3_job_runs
        SET
          status = 'success',
          finished_at = now(),
          duration_ms = $1::integer,
          row_count = 1,
          source_min_date = $2::date,
          source_max_date = $3::date,
          source_max_updated_at = $4::timestamptz,
          updated_at = now()
        WHERE id = $5::uuid
        `,
        [
          durationMs,
          calibration.sourceMinDate,
          calibration.sourceMaxDate,
          calibration.sourceMaxUpdatedAt,
          jobRunId,
        ],
      );

      return {
        jobRunId,
        status: "success",
        rowsWritten: 1,
        durationMs,
        calibration: calibrationToAccountCalibration(calibration),
      };
    } catch (error) {
      await db
        .query("ROLLBACK TO SAVEPOINT engine_v3_calibration_job_work")
        .catch(() => undefined);
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      await db
        .query(
          `
          UPDATE engine_v3_job_runs
          SET
            status = 'failed',
            finished_at = now(),
            duration_ms = $1::integer,
            row_count = 0,
            error_message = $2,
            error_json = $3::jsonb,
            updated_at = now()
          WHERE id = $4::uuid
          `,
          [durationMs, message, JSON.stringify(errorToJson(error)), jobRunId],
        )
        .catch(() => undefined);
      return {
        jobRunId,
        status: "failed",
        rowsWritten: 0,
        durationMs,
        calibration: null,
        errorMessage: message,
      };
    }
  });
}

async function insertJobRun(input: {
  businessId: string;
  asOf: string;
  status: CalibrationJobResult["status"] | "running";
  durationMs?: number;
  rowCount?: number;
  errorMessage?: string;
}) {
  const [row] = await getDb().query<JobRunIdRow>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, finished_at, duration_ms, row_count, error_message
    )
    VALUES (
      $1, $2::uuid, $3, $4::date, $5,
      $6, CASE WHEN $6 = 'running' THEN NULL ELSE now() END,
      $7::integer, $8::integer, $9
    )
    RETURNING id
    `,
    [
      JOB_NAME,
      input.businessId,
      input.businessId,
      input.asOf,
      ENGINE_VERSION,
      input.status,
      input.durationMs ?? null,
      input.rowCount ?? null,
      input.errorMessage ?? null,
    ],
  );

  const id = toStringOrNull(row?.id);
  if (id === null) {
    throw new Error("Calibration job run insert did not return an id.");
  }
  return id;
}

async function computeCalibration(input: {
  businessId: string;
  asOf: string;
  scopeType: typeof ACCOUNT_SCOPE_TYPE;
  scopeId: string;
}): Promise<ComputedCalibration> {
  const [row] = await getDb().query<CalibrationComputationRow>(
    COMPUTE_CALIBRATION_QUERY,
    [input.asOf, input.businessId, SAMPLE_WINDOW_DAYS],
  );
  const matureCreativeCount =
    toIntegerOrNull(row?.mature_creative_count) ?? 0;
  const sampleWindowDays =
    toIntegerOrNull(row?.sample_window_days) ?? SAMPLE_WINDOW_DAYS;
  const sourceMaxUpdatedAt = toIsoTimestampOrNull(row?.source_max_updated_at);

  return {
    businessId: input.businessId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    asOfDate: input.asOf,
    sampleWindowStart:
      toIsoDateOrNull(row?.sample_window_start) ??
      sampleWindowStartForAsOf(input.asOf),
    sampleWindowEnd: toIsoDateOrNull(row?.sample_window_end) ?? input.asOf,
    sampleWindowDays,
    eligibleCreativeCount:
      toIntegerOrNull(row?.eligible_creative_count) ?? 0,
    matureCreativeCount,
    zeroConversionCount: toIntegerOrNull(row?.zero_conversion_count) ?? 0,
    roasP75: toNumberOrNull(row?.roas_p75),
    roasP60: toNumberOrNull(row?.roas_p60),
    refreshRatioP10: toNumberOrNull(row?.refresh_ratio_p10),
    lowCtrP10: toNumberOrNull(row?.low_ctr_p10),
    accountCpaP50: toNumberOrNull(row?.account_cpa_p50),
    accountCpaSampleCount:
      toIntegerOrNull(row?.account_cpa_sample_count) ?? 0,
    metaAttributedAovMean90d: toNumberOrNull(
      row?.meta_attributed_aov_mean_90d,
    ),
    metaAttributedAovPurchaseCount90d:
      toIntegerOrNull(row?.meta_attributed_aov_purchase_count_90d) ?? 0,
    metaAttributedRevenue90d:
      toNumberOrNull(row?.meta_attributed_revenue_90d) ?? 0,
    metaAovQuality: toMetaAovQuality(row?.meta_aov_quality),
    matureSpendP50: toNumberOrNull(row?.mature_spend_p50),
    matureSpendP75: toNumberOrNull(row?.mature_spend_p75),
    winnerSpendP25: toNumberOrNull(row?.winner_spend_p25),
    winnerSpendP50: toNumberOrNull(row?.winner_spend_p50),
    winnerPurchaseP50: toNumberOrNull(row?.winner_purchase_p50),
    roasRatioP10: toNumberOrNull(row?.roas_ratio_p10),
    roasRatioP25: toNumberOrNull(row?.roas_ratio_p25),
    roasRatioP50: toNumberOrNull(row?.roas_ratio_p50),
    roasRatioP75: toNumberOrNull(row?.roas_ratio_p75),
    sourceMinDate: toIsoDateOrNull(row?.source_min_date),
    sourceMaxDate: toIsoDateOrNull(row?.source_max_date),
    sourceMaxUpdatedAt,
    qualityStatus: determineQualityStatus({
      matureCreativeCount,
      sampleWindowDays,
      sourceMaxUpdatedAt,
    }),
    computedAt: new Date().toISOString(),
  };
}

function calibrationToAccountCalibration(
  row: ComputedCalibration,
): AccountCalibration {
  return {
    businessId: row.businessId,
    computedAt: row.computedAt,
    matureCreativeCount: row.matureCreativeCount,
    roasP75: row.roasP75,
    roasP60: row.roasP60,
    refreshRatioP10: row.refreshRatioP10,
    lowCtrP10: row.lowCtrP10,
    accountCpaP50: row.accountCpaP50,
    accountCpaSampleCount: row.accountCpaSampleCount,
    metaAttributedAovMean90d: row.metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d: row.metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d: row.metaAttributedRevenue90d,
    matureSpendP50: row.matureSpendP50,
    matureSpendP75: row.matureSpendP75,
    winnerSpendP25: row.winnerSpendP25,
    winnerSpendP50: row.winnerSpendP50,
    winnerPurchaseP50: row.winnerPurchaseP50,
    roasRatioP10: row.roasRatioP10,
    roasRatioP25: row.roasRatioP25,
    roasRatioP50: row.roasRatioP50,
    roasRatioP75: row.roasRatioP75,
    metaAovQuality: row.metaAovQuality,
  };
}

function determineQualityStatus(input: {
  matureCreativeCount: number;
  sampleWindowDays: number;
  sourceMaxUpdatedAt: string | null;
}): QualityStatus {
  if (isOlderThanHours(input.sourceMaxUpdatedAt, STALE_TIER_WARNING_MAX_HOURS)) {
    return "stale";
  }
  if (input.matureCreativeCount >= 30) return "ready";
  if (input.matureCreativeCount >= 10) return "low_sample";
  return "low_sample";
}

export function hashAdvisoryLock(key: string): bigint {
  const uint64Size = BigInt(2) ** BigInt(64);
  const int64Max = BigInt(2) ** BigInt(63) - BigInt(1);
  let hash = BigInt("14695981039346656037");

  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index) & 0xff);
    hash = (hash * BigInt("1099511628211")) % uint64Size;
  }

  return hash <= int64Max ? hash : hash - uint64Size;
}

function sampleWindowStartForAsOf(asOf: string) {
  const parsed = new Date(`${asOf}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return asOf;
  parsed.setUTCDate(parsed.getUTCDate() - (SAMPLE_WINDOW_DAYS - 1));
  return parsed.toISOString().slice(0, 10);
}

function isOlderThanHours(timestamp: string | null, hours: number) {
  if (timestamp === null) return false;
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed > hours * 3_600_000;
}

function errorToJson(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIntegerOrNull(value: unknown): number | null {
  const number = toNumberOrNull(value);
  return number === null ? null : Math.floor(number);
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toMetaAovQuality(value: unknown): AccountCalibration["metaAovQuality"] {
  const text = toStringOrNull(value);
  if (
    text === "unavailable" ||
    text === "unstable" ||
    text === "low_sample" ||
    text === "ready"
  ) {
    return text;
  }
  return "unavailable";
}

function toIsoDateOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return formatDateOnly(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const isoDatePrefix = /^\d{4}-\d{2}-\d{2}/.exec(trimmed)?.[0] ?? null;
    if (isoDatePrefix) return isoDatePrefix;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime())
      ? null
      : parsed.toISOString().slice(0, 10);
  }
  return null;
}

function formatDateOnly(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toIsoTimestampOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
