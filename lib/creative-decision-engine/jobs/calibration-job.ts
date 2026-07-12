import { getDb, runDbTransaction } from "@/lib/db";
import {
  MIN_CAMPAIGN_CALIBRATION_SAMPLE,
  SUPPORTED_OBJECTIVES,
} from "../config";
import { SAMPLE_WINDOW_DAYS } from "../config-values";
import { STALE_TIER_WARNING_MAX_HOURS } from "../data-health";
import { resolveEngineV3Flags } from "../feature-flags";
import {
  ENGINE_VERSION,
  type AccountCalibration,
  type CalibrationCampaignKind,
} from "../types";
import { getBusinessGuardFailure } from "./business-guard";
import { ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS } from "./job-runtime";

export const JOB_NAME = "engine_v3_calibration_job";
export const FUNNEL_METRIC_SAMPLE_FLOOR = 20;
const ACCOUNT_SCOPE_TYPE = "account";
const CAMPAIGN_SCOPE_TYPE = "campaign";
const ACCOUNT_SCOPE_ID = "*";
const CALIBRATION_FORMATS = [
  "overall",
  "image",
  "video",
  "carousel",
  "catalog",
] as const;
const ACCOUNT_CALIBRATION_KINDS = ["all", "main", "test", "mixed"] as const;
type CalibrationCreativeFormat = (typeof CALIBRATION_FORMATS)[number];
type CalibrationScopeType =
  typeof ACCOUNT_SCOPE_TYPE | typeof CAMPAIGN_SCOPE_TYPE;

export interface CalibrationJobInput {
  businessId: string;
  asOf: string;
  scopeType?: CalibrationScopeType;
  scopeId?: string;
}

export interface CalibrationJobResult {
  jobRunId: string;
  status: "success" | "failed" | "skipped";
  rowsWritten: number;
  durationMs: number;
  calibration: AccountCalibration | null;
  reason?: "engine_v3_disabled" | "business_not_found" | "invalid_business_id";
  errorMessage?: string;
}

type QualityStatus = "ready" | "low_sample" | "stale" | "fallback";

interface ComputedCalibration {
  businessId: string;
  scopeType: CalibrationScopeType;
  scopeId: string;
  campaignKind: CalibrationCampaignKind;
  creativeFormat: CalibrationCreativeFormat;
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
  ctrP25: number | null;
  ctrP50: number | null;
  cpmP50: number | null;
  cpmP75: number | null;
  thumbstopP25: number | null;
  thumbstopP50: number | null;
  linkToLpvP25: number | null;
  linkToLpvP50: number | null;
  linkToAtcP25: number | null;
  linkToAtcP50: number | null;
  lpvToAtcP25: number | null;
  lpvToAtcP50: number | null;
  atcToIcP25: number | null;
  atcToIcP50: number | null;
  icToPurchaseP25: number | null;
  icToPurchaseP50: number | null;
  clickToPurchaseP25: number | null;
  clickToPurchaseP50: number | null;
  funnelSampleCount: number;
  funnelQualityStatus: "ready" | "low_sample" | "insufficient";
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
  ctr_p25: unknown;
  ctr_p50: unknown;
  cpm_p50: unknown;
  cpm_p75: unknown;
  thumbstop_p25: unknown;
  thumbstop_p50: unknown;
  link_to_lpv_p25: unknown;
  link_to_lpv_p50: unknown;
  link_to_atc_p25: unknown;
  link_to_atc_p50: unknown;
  lpv_to_atc_p25: unknown;
  lpv_to_atc_p50: unknown;
  atc_to_ic_p25: unknown;
  atc_to_ic_p50: unknown;
  ic_to_purchase_p25: unknown;
  ic_to_purchase_p50: unknown;
  click_to_purchase_p25: unknown;
  click_to_purchase_p50: unknown;
  funnel_sample_count: unknown;
  funnel_quality_status: unknown;
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

type CampaignScopeRow = Record<string, unknown> & {
  campaign_id: unknown;
  mature_creative_count: unknown;
};

const COMPUTE_CALIBRATION_QUERY = `
WITH target_pack AS (
  SELECT target_roas
  FROM (
    SELECT *
    FROM business_target_pack_history
    WHERE business_id = $2::uuid
      AND effective_at < ($1::date + INTERVAL '1 day')
      AND recorded_at < ($1::date + INTERVAL '1 day')
    ORDER BY effective_at DESC, recorded_at DESC, id DESC
    LIMIT 1
  ) target_history
  WHERE operation = 'upsert'
),
per_creative_raw AS (
  SELECT
    d.creative_id,
    MAX(
      regexp_replace(
        lower(COALESCE(
          NULLIF(d.payload_json->>'format', ''),
          NULLIF(d.payload_json->>'creative_format', ''),
          d.creative_visual_format,
          d.creative_primary_type,
          'other'
        )),
        '[^a-z0-9]+',
        '_',
        'g'
      )
    ) AS raw_creative_format,
    SUM(d.spend) AS total_spend,
    SUM(d.conversions) AS total_purchases,
    SUM(d.revenue) AS total_revenue,
    SUM(d.impressions) AS total_impressions,
    SUM(d.clicks) AS total_clicks,
    SUM(d.link_clicks) AS total_link_clicks,
    SUM(COALESCE((NULLIF(d.payload_json->>'landing_page_views', ''))::numeric, 0)) AS lpv_total,
    SUM(COALESCE((NULLIF(d.payload_json->>'add_to_cart', ''))::numeric, 0)) AS atc_total,
    SUM(COALESCE((NULLIF(d.payload_json->>'initiate_checkout', ''))::numeric, 0)) AS ic_total,
    SUM(COALESCE((NULLIF(d.payload_json->>'thumbstop', ''))::numeric, 0) * d.impressions) AS thumbstop_weighted,
    SUM(d.spend) FILTER (WHERE d.date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_spend,
    SUM(d.revenue) FILTER (WHERE d.date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_revenue,
    SUM(d.impressions) FILTER (WHERE d.date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_impressions,
    SUM(d.clicks) FILTER (WHERE d.date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_clicks,
    SUM(d.spend) FILTER (WHERE d.date >= ($1::date - INTERVAL '6 days')) AS recent_7d_spend,
    SUM(d.revenue) FILTER (WHERE d.date >= ($1::date - INTERVAL '6 days')) AS recent_7d_revenue
  FROM meta_creative_daily d
  LEFT JOIN meta_campaign_labels labels
    ON labels.business_id = d.business_id
   AND labels.campaign_id = d.campaign_id
  WHERE d.business_ref_id = $2::uuid
    AND d.date BETWEEN ($1::date - INTERVAL '89 days') AND $1::date
    AND d.objective = ANY($5::text[])
    AND ($6::text IS NULL OR d.campaign_id = $6::text)
    AND ($7::text = 'all' OR labels.campaign_kind = $7::text)
  GROUP BY d.creative_id
),
per_creative AS (
  SELECT
    creative_id,
    CASE
      WHEN raw_creative_format IN ('image', 'video', 'carousel', 'catalog') THEN raw_creative_format
      WHEN raw_creative_format LIKE '%carousel%' THEN 'carousel'
      WHEN raw_creative_format LIKE '%catalog%' THEN 'catalog'
      WHEN raw_creative_format LIKE '%video%' THEN 'video'
      WHEN raw_creative_format LIKE '%image%' OR raw_creative_format LIKE '%photo%' THEN 'image'
      ELSE 'other'
    END AS creative_format,
    total_spend,
    total_purchases,
    total_revenue,
    total_impressions,
    total_clicks,
    total_link_clicks,
    lpv_total,
    atc_total,
    ic_total,
    CASE WHEN total_spend > 0 THEN total_revenue / total_spend END AS aggregate_roas,
    CASE WHEN total_impressions > 0 THEN total_clicks::numeric / NULLIF(total_impressions, 0) * 100 END AS ctr_rate,
    CASE WHEN total_impressions > 0 THEN total_spend / NULLIF(total_impressions, 0) * 1000 END AS cpm,
    CASE WHEN total_impressions > 0 THEN thumbstop_weighted / NULLIF(total_impressions, 0) END AS thumbstop_rate,
    CASE WHEN total_link_clicks > 0 THEN lpv_total / NULLIF(total_link_clicks, 0) * 100 END AS link_to_lpv_rate,
    CASE WHEN total_link_clicks > 0 THEN atc_total / NULLIF(total_link_clicks, 0) * 100 END AS link_to_atc_rate,
    CASE WHEN lpv_total > 0 THEN atc_total / NULLIF(lpv_total, 0) * 100 END AS lpv_to_atc_rate,
    CASE WHEN atc_total > 0 THEN ic_total / NULLIF(atc_total, 0) * 100 END AS atc_to_ic_rate,
    CASE WHEN ic_total > 0 THEN total_purchases / NULLIF(ic_total, 0) * 100 END AS ic_to_purchase_rate,
    CASE WHEN total_link_clicks > 0 THEN total_purchases / NULLIF(total_link_clicks, 0) * 100 END AS click_to_purchase_rate,
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
scoped_per_creative AS (
  SELECT *
  FROM per_creative
  WHERE $4::text = 'overall' OR creative_format = $4::text
),
converter_population AS (
  SELECT *
  FROM scoped_per_creative
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
  FROM scoped_per_creative
),
counts AS (
  SELECT
    (SELECT COUNT(*) FROM scoped_per_creative WHERE total_spend > 0) AS eligible_creative_count,
    (SELECT COUNT(*) FROM converter_population) AS converter_count,
    (SELECT COUNT(*) FROM winner_population) AS winner_count,
    (SELECT COUNT(*) FROM scoped_per_creative WHERE total_purchases > 0) AS account_cpa_sample_count,
    (SELECT COUNT(*) FROM scoped_per_creative WHERE total_spend > 0 AND COALESCE(total_purchases, 0) = 0) AS zero_conversion_count,
    (SELECT COUNT(*) FROM recent_ratios WHERE recent_total_ratio IS NOT NULL) AS refresh_ratio_count,
    (SELECT COUNT(*) FROM scoped_per_creative WHERE cumulative_28d_ctr IS NOT NULL) AS ctr_count,
    (
      SELECT COUNT(*)
      FROM scoped_per_creative
      WHERE ctr_rate IS NOT NULL
        OR cpm IS NOT NULL
        OR thumbstop_rate IS NOT NULL
        OR link_to_lpv_rate IS NOT NULL
        OR link_to_atc_rate IS NOT NULL
        OR lpv_to_atc_rate IS NOT NULL
        OR atc_to_ic_rate IS NOT NULL
        OR ic_to_purchase_rate IS NOT NULL
        OR click_to_purchase_rate IS NOT NULL
    ) AS funnel_sample_count
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
funnel_percentiles AS (
  SELECT
    CASE WHEN COUNT(ctr_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.25) WITHIN GROUP (ORDER BY ctr_rate)
        FILTER (WHERE ctr_rate IS NOT NULL)
    END AS ctr_p25,
    CASE WHEN COUNT(ctr_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.50) WITHIN GROUP (ORDER BY ctr_rate)
        FILTER (WHERE ctr_rate IS NOT NULL)
    END AS ctr_p50,
    CASE WHEN COUNT(cpm) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.50) WITHIN GROUP (ORDER BY cpm)
        FILTER (WHERE cpm IS NOT NULL)
    END AS cpm_p50,
    CASE WHEN COUNT(cpm) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.75) WITHIN GROUP (ORDER BY cpm)
        FILTER (WHERE cpm IS NOT NULL)
    END AS cpm_p75,
    CASE WHEN COUNT(thumbstop_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.25) WITHIN GROUP (ORDER BY thumbstop_rate)
        FILTER (WHERE thumbstop_rate IS NOT NULL)
    END AS thumbstop_p25,
    CASE WHEN COUNT(thumbstop_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.50) WITHIN GROUP (ORDER BY thumbstop_rate)
        FILTER (WHERE thumbstop_rate IS NOT NULL)
    END AS thumbstop_p50,
    CASE WHEN COUNT(link_to_lpv_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.25) WITHIN GROUP (ORDER BY link_to_lpv_rate)
        FILTER (WHERE link_to_lpv_rate IS NOT NULL)
    END AS link_to_lpv_p25,
    CASE WHEN COUNT(link_to_lpv_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.50) WITHIN GROUP (ORDER BY link_to_lpv_rate)
        FILTER (WHERE link_to_lpv_rate IS NOT NULL)
    END AS link_to_lpv_p50,
    CASE WHEN COUNT(link_to_atc_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.25) WITHIN GROUP (ORDER BY link_to_atc_rate)
        FILTER (WHERE link_to_atc_rate IS NOT NULL)
    END AS link_to_atc_p25,
    CASE WHEN COUNT(link_to_atc_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.50) WITHIN GROUP (ORDER BY link_to_atc_rate)
        FILTER (WHERE link_to_atc_rate IS NOT NULL)
    END AS link_to_atc_p50,
    CASE WHEN COUNT(lpv_to_atc_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.25) WITHIN GROUP (ORDER BY lpv_to_atc_rate)
        FILTER (WHERE lpv_to_atc_rate IS NOT NULL)
    END AS lpv_to_atc_p25,
    CASE WHEN COUNT(lpv_to_atc_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.50) WITHIN GROUP (ORDER BY lpv_to_atc_rate)
        FILTER (WHERE lpv_to_atc_rate IS NOT NULL)
    END AS lpv_to_atc_p50,
    CASE WHEN COUNT(atc_to_ic_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.25) WITHIN GROUP (ORDER BY atc_to_ic_rate)
        FILTER (WHERE atc_to_ic_rate IS NOT NULL)
    END AS atc_to_ic_p25,
    CASE WHEN COUNT(atc_to_ic_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.50) WITHIN GROUP (ORDER BY atc_to_ic_rate)
        FILTER (WHERE atc_to_ic_rate IS NOT NULL)
    END AS atc_to_ic_p50,
    CASE WHEN COUNT(ic_to_purchase_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.25) WITHIN GROUP (ORDER BY ic_to_purchase_rate)
        FILTER (WHERE ic_to_purchase_rate IS NOT NULL)
    END AS ic_to_purchase_p25,
    CASE WHEN COUNT(ic_to_purchase_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.50) WITHIN GROUP (ORDER BY ic_to_purchase_rate)
        FILTER (WHERE ic_to_purchase_rate IS NOT NULL)
    END AS ic_to_purchase_p50,
    CASE WHEN COUNT(click_to_purchase_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.25) WITHIN GROUP (ORDER BY click_to_purchase_rate)
        FILTER (WHERE click_to_purchase_rate IS NOT NULL)
    END AS click_to_purchase_p25,
    CASE WHEN COUNT(click_to_purchase_rate) >= ${FUNNEL_METRIC_SAMPLE_FLOOR}
      THEN percentile_cont(0.50) WITHIN GROUP (ORDER BY click_to_purchase_rate)
        FILTER (WHERE click_to_purchase_rate IS NOT NULL)
    END AS click_to_purchase_p50
  FROM scoped_per_creative
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
    CASE WHEN SUM(total_purchases) > 0 THEN SUM(total_revenue) / SUM(total_purchases) END AS aov_mean,
    COALESCE(SUM(total_purchases), 0)::integer AS purchase_count,
    COALESCE(SUM(total_revenue), 0) AS total_revenue
  FROM scoped_per_creative
),
source_bounds AS (
  SELECT
    MIN(d.date) AS source_min_date,
    MAX(d.date) AS source_max_date,
    MAX(d.updated_at) AS source_max_updated_at
  FROM meta_creative_daily d
  LEFT JOIN meta_campaign_labels labels
    ON labels.business_id = d.business_id
   AND labels.campaign_id = d.campaign_id
  WHERE d.business_ref_id = $2::uuid
    AND d.date BETWEEN ($1::date - INTERVAL '89 days') AND $1::date
    AND d.objective = ANY($5::text[])
    AND ($6::text IS NULL OR d.campaign_id = $6::text)
    AND ($7::text = 'all' OR labels.campaign_kind = $7::text)
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
    FROM scoped_per_creative
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
  funnel_percentiles.ctr_p25,
  funnel_percentiles.ctr_p50,
  funnel_percentiles.cpm_p50,
  funnel_percentiles.cpm_p75,
  funnel_percentiles.thumbstop_p25,
  funnel_percentiles.thumbstop_p50,
  funnel_percentiles.link_to_lpv_p25,
  funnel_percentiles.link_to_lpv_p50,
  funnel_percentiles.link_to_atc_p25,
  funnel_percentiles.link_to_atc_p50,
  funnel_percentiles.lpv_to_atc_p25,
  funnel_percentiles.lpv_to_atc_p50,
  funnel_percentiles.atc_to_ic_p25,
  funnel_percentiles.atc_to_ic_p50,
  funnel_percentiles.ic_to_purchase_p25,
  funnel_percentiles.ic_to_purchase_p50,
  funnel_percentiles.click_to_purchase_p25,
  funnel_percentiles.click_to_purchase_p50,
  counts.funnel_sample_count,
  CASE
    WHEN counts.funnel_sample_count >= 30 THEN 'ready'
    WHEN counts.funnel_sample_count >= 10 THEN 'low_sample'
    ELSE 'insufficient'
  END AS funnel_quality_status,
  source_bounds.source_min_date,
  source_bounds.source_max_date,
  source_bounds.source_max_updated_at
FROM counts
CROSS JOIN percentiles
CROSS JOIN funnel_percentiles
CROSS JOIN winner_percentiles
CROSS JOIN meta_aov
CROSS JOIN source_bounds
`;

const LIST_ELIGIBLE_CAMPAIGN_SCOPES_QUERY = `
WITH per_creative AS (
  SELECT
    campaign_id,
    creative_id,
    SUM(spend) AS total_spend,
    SUM(conversions) AS total_purchases,
    SUM(revenue) AS total_revenue
  FROM meta_creative_daily
  WHERE business_ref_id = $1::uuid
    AND date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date
    AND objective = ANY($4::text[])
    AND campaign_id IS NOT NULL
    AND campaign_id <> ''
  GROUP BY campaign_id, creative_id
),
campaign_counts AS (
  SELECT
    campaign_id,
    COUNT(*) FILTER (
      WHERE total_purchases >= 1
        AND total_revenue > 0
        AND total_spend > 0
    ) AS mature_creative_count
  FROM per_creative
  GROUP BY campaign_id
)
SELECT campaign_id, mature_creative_count
FROM campaign_counts
WHERE mature_creative_count >= $3::integer
ORDER BY campaign_id ASC
`;

const UPSERT_CALIBRATION_QUERY = `
INSERT INTO engine_v3_account_calibration_daily (
  business_ref_id, business_id, scope_type, scope_id, creative_format, as_of_date, engine_version,
  sample_window_start, sample_window_end, sample_window_days,
  eligible_creative_count, mature_creative_count, zero_conversion_count,
  roas_p75, roas_p60, refresh_ratio_p10, low_ctr_p10,
  account_cpa_p50, account_cpa_sample_count,
  meta_attributed_aov_mean_90d, meta_attributed_aov_purchase_count_90d,
  meta_attributed_revenue_90d, meta_aov_quality,
  mature_spend_p50, mature_spend_p75,
  winner_spend_p25, winner_spend_p50, winner_purchase_p50,
  roas_ratio_p10, roas_ratio_p25, roas_ratio_p50, roas_ratio_p75,
  ctr_p25, ctr_p50, cpm_p50, cpm_p75,
  thumbstop_p25, thumbstop_p50,
  link_to_lpv_p25, link_to_lpv_p50,
  link_to_atc_p25, link_to_atc_p50,
  lpv_to_atc_p25, lpv_to_atc_p50,
  atc_to_ic_p25, atc_to_ic_p50,
  ic_to_purchase_p25, ic_to_purchase_p50,
  click_to_purchase_p25, click_to_purchase_p50,
  funnel_sample_count, funnel_quality_status,
  source_min_date, source_max_date, source_max_updated_at,
  campaign_kind, quality_status, job_run_id, computed_at
) VALUES (
  $1::uuid, $2, $3, $4, $5, $6::date, $7,
  $8::date, $9::date, $10::integer,
  $11::integer, $12::integer, $13::integer,
  $14::double precision, $15::double precision, $16::double precision, $17::double precision,
  $18::double precision, $19::integer,
  $20::double precision, $21::integer,
  $22::double precision, $23,
  $24::double precision, $25::double precision,
  $26::double precision, $27::double precision, $28::double precision,
  $29::double precision, $30::double precision, $31::double precision, $32::double precision,
  $33::double precision, $34::double precision, $35::double precision, $36::double precision,
  $37::double precision, $38::double precision,
  $39::double precision, $40::double precision,
  $41::double precision, $42::double precision,
  $43::double precision, $44::double precision,
  $45::double precision, $46::double precision,
  $47::double precision, $48::double precision,
  $49::double precision, $50::double precision,
  $51::integer, $52,
  $53::date, $54::date, $55::timestamptz,
  $56, $57, $58::uuid, $59::timestamptz
)
ON CONFLICT (business_ref_id, scope_type, scope_id, campaign_kind, creative_format, as_of_date, engine_version)
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
  ctr_p25 = EXCLUDED.ctr_p25,
  ctr_p50 = EXCLUDED.ctr_p50,
  cpm_p50 = EXCLUDED.cpm_p50,
  cpm_p75 = EXCLUDED.cpm_p75,
  thumbstop_p25 = EXCLUDED.thumbstop_p25,
  thumbstop_p50 = EXCLUDED.thumbstop_p50,
  link_to_lpv_p25 = EXCLUDED.link_to_lpv_p25,
  link_to_lpv_p50 = EXCLUDED.link_to_lpv_p50,
  link_to_atc_p25 = EXCLUDED.link_to_atc_p25,
  link_to_atc_p50 = EXCLUDED.link_to_atc_p50,
  lpv_to_atc_p25 = EXCLUDED.lpv_to_atc_p25,
  lpv_to_atc_p50 = EXCLUDED.lpv_to_atc_p50,
  atc_to_ic_p25 = EXCLUDED.atc_to_ic_p25,
  atc_to_ic_p50 = EXCLUDED.atc_to_ic_p50,
  ic_to_purchase_p25 = EXCLUDED.ic_to_purchase_p25,
  ic_to_purchase_p50 = EXCLUDED.ic_to_purchase_p50,
  click_to_purchase_p25 = EXCLUDED.click_to_purchase_p25,
  click_to_purchase_p50 = EXCLUDED.click_to_purchase_p50,
  funnel_sample_count = EXCLUDED.funnel_sample_count,
  funnel_quality_status = EXCLUDED.funnel_quality_status,
  source_min_date = EXCLUDED.source_min_date,
  source_max_date = EXCLUDED.source_max_date,
  source_max_updated_at = EXCLUDED.source_max_updated_at,
  campaign_kind = EXCLUDED.campaign_kind,
  quality_status = EXCLUDED.quality_status,
  job_run_id = EXCLUDED.job_run_id,
  computed_at = EXCLUDED.computed_at,
  updated_at = now()
`;

export async function runCalibrationJob(
  input: CalibrationJobInput,
): Promise<CalibrationJobResult> {
  const startedAt = Date.now();
  const businessGuardFailure = await getBusinessGuardFailure(input.businessId);
  if (businessGuardFailure?.reason === "invalid_business_id") {
    return {
      jobRunId: "",
      status: "failed",
      rowsWritten: 0,
      durationMs: Date.now() - startedAt,
      calibration: null,
      reason: "invalid_business_id",
      errorMessage: businessGuardFailure.message,
    };
  }
  if (businessGuardFailure) {
    const durationMs = Date.now() - startedAt;
    const jobRunId = await insertJobRun({
      businessId: input.businessId,
      asOf: input.asOf,
      status: "failed",
      durationMs,
      rowCount: 0,
      errorMessage: businessGuardFailure.message,
      errorJson: businessGuardFailure.errorJson,
    });
    return {
      jobRunId,
      status: "failed",
      rowsWritten: 0,
      durationMs,
      calibration: null,
      reason: "business_not_found",
      errorMessage: businessGuardFailure.message,
    };
  }

  const flags = await resolveEngineV3Flags(input.businessId);
  if (!flags.enabled) {
    const durationMs = Date.now() - startedAt;
    const jobRunId = await insertJobRun({
      businessId: input.businessId,
      asOf: input.asOf,
      status: "skipped",
      durationMs,
      rowCount: 0,
      errorMessage: "engine_v3_disabled",
      errorJson: {
        name: "engine_v3_disabled",
        businessId: input.businessId,
      },
    });
    return {
      jobRunId,
      status: "skipped",
      rowsWritten: 0,
      durationMs,
      calibration: null,
      reason: "engine_v3_disabled",
    };
  }

  const scopeType = input.scopeType ?? ACCOUNT_SCOPE_TYPE;
  const scopeId = input.scopeId ?? ACCOUNT_SCOPE_ID;
  const lockKey = hashAdvisoryLock(
    `${JOB_NAME}:${input.businessId}:${input.asOf}`,
  );

  return runDbTransaction(
    async () => {
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
          errorMessage:
            "Advisory lock not acquired (job may already be running)",
        });
        return {
          jobRunId,
          status: "skipped",
          rowsWritten: 0,
          durationMs,
          calibration: null,
          errorMessage:
            "Advisory lock not acquired (job may already be running)",
        };
      }

      const jobRunId = await insertJobRun({
        businessId: input.businessId,
        asOf: input.asOf,
        status: "running",
      });

      await db.query("SAVEPOINT engine_v3_calibration_job_work");
      try {
        const calibrations = await computeCalibrations({
          businessId: input.businessId,
          asOf: input.asOf,
          scopeType,
          scopeId,
        });
        for (const calibration of calibrations) {
          await db.query(UPSERT_CALIBRATION_QUERY, [
            calibration.businessId,
            calibration.businessId,
            calibration.scopeType,
            calibration.scopeId,
            calibration.creativeFormat,
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
            calibration.ctrP25,
            calibration.ctrP50,
            calibration.cpmP50,
            calibration.cpmP75,
            calibration.thumbstopP25,
            calibration.thumbstopP50,
            calibration.linkToLpvP25,
            calibration.linkToLpvP50,
            calibration.linkToAtcP25,
            calibration.linkToAtcP50,
            calibration.lpvToAtcP25,
            calibration.lpvToAtcP50,
            calibration.atcToIcP25,
            calibration.atcToIcP50,
            calibration.icToPurchaseP25,
            calibration.icToPurchaseP50,
            calibration.clickToPurchaseP25,
            calibration.clickToPurchaseP50,
            calibration.funnelSampleCount,
            calibration.funnelQualityStatus,
            calibration.sourceMinDate,
            calibration.sourceMaxDate,
            calibration.sourceMaxUpdatedAt,
            calibration.campaignKind,
            calibration.qualityStatus,
            jobRunId,
            calibration.computedAt,
          ]);
        }

        const overallCalibration = calibrations.find(
          (calibration) =>
            calibration.scopeType === ACCOUNT_SCOPE_TYPE &&
            calibration.scopeId === ACCOUNT_SCOPE_ID &&
            calibration.campaignKind === "all" &&
            calibration.creativeFormat === "overall",
        );

        const durationMs = Date.now() - startedAt;
        await db.query(
          `
        UPDATE engine_v3_job_runs
        SET
          status = 'success',
          finished_at = now(),
          duration_ms = $1::integer,
          row_count = $2::integer,
          source_min_date = $3::date,
          source_max_date = $4::date,
          source_max_updated_at = $5::timestamptz,
          updated_at = now()
        WHERE id = $6::uuid
        `,
          [
            durationMs,
            calibrations.length,
            overallCalibration?.sourceMinDate ?? null,
            overallCalibration?.sourceMaxDate ?? null,
            overallCalibration?.sourceMaxUpdatedAt ?? null,
            jobRunId,
          ],
        );

        return {
          jobRunId,
          status: "success",
          rowsWritten: calibrations.length,
          durationMs,
          calibration: overallCalibration
            ? calibrationToAccountCalibration(overallCalibration)
            : null,
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
    },
    { timeoutMs: ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS },
  );
}

async function insertJobRun(input: {
  businessId: string;
  asOf: string;
  status: CalibrationJobResult["status"] | "running";
  durationMs?: number;
  rowCount?: number;
  errorMessage?: string;
  errorJson?: unknown;
}) {
  const [row] = await getDb().query<JobRunIdRow>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, finished_at, duration_ms, row_count, error_message, error_json
    )
    VALUES (
      $1, $2::uuid, $3, $4::date, $5,
      $6, CASE WHEN $6 = 'running' THEN NULL ELSE now() END,
      $7::integer, $8::integer, $9, $10::jsonb
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
      input.errorJson === undefined ? null : JSON.stringify(input.errorJson),
    ],
  );

  const id = toStringOrNull(row?.id);
  if (id === null) {
    throw new Error("Calibration job run insert did not return an id.");
  }
  return id;
}

async function computeCalibrations(input: {
  businessId: string;
  asOf: string;
  scopeType: CalibrationScopeType;
  scopeId: string;
}): Promise<ComputedCalibration[]> {
  const computedAt = new Date().toISOString();
  const calibrations: ComputedCalibration[] = [];
  const scopes: Array<{ scopeType: CalibrationScopeType; scopeId: string }> = [
    { scopeType: ACCOUNT_SCOPE_TYPE, scopeId: ACCOUNT_SCOPE_ID },
    ...(await listEligibleCampaignScopes({
      businessId: input.businessId,
      asOf: input.asOf,
    })),
  ];

  for (const scope of scopes) {
    const campaignKinds: readonly CalibrationCampaignKind[] =
      scope.scopeType === ACCOUNT_SCOPE_TYPE
        ? ACCOUNT_CALIBRATION_KINDS
        : ["all"];
    for (const creativeFormat of CALIBRATION_FORMATS) {
      for (const campaignKind of campaignKinds) {
        calibrations.push(
          await computeCalibration({
            businessId: input.businessId,
            asOf: input.asOf,
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            campaignKind,
            creativeFormat,
            computedAt,
          }),
        );
      }
    }
  }

  return calibrations;
}

async function listEligibleCampaignScopes(input: {
  businessId: string;
  asOf: string;
}): Promise<Array<{ scopeType: typeof CAMPAIGN_SCOPE_TYPE; scopeId: string }>> {
  const supportedObjectivesArray = Array.from(SUPPORTED_OBJECTIVES);
  const rows = await getDb().query<CampaignScopeRow>(
    LIST_ELIGIBLE_CAMPAIGN_SCOPES_QUERY,
    [
      input.businessId,
      input.asOf,
      MIN_CAMPAIGN_CALIBRATION_SAMPLE,
      supportedObjectivesArray,
    ],
  );

  return rows.flatMap((row) => {
    const campaignId = toStringOrNull(row.campaign_id);
    return campaignId === null
      ? []
      : [{ scopeType: CAMPAIGN_SCOPE_TYPE, scopeId: campaignId }];
  });
}

async function computeCalibration(input: {
  businessId: string;
  asOf: string;
  scopeType: CalibrationScopeType;
  scopeId: string;
  campaignKind: CalibrationCampaignKind;
  creativeFormat: CalibrationCreativeFormat;
  computedAt: string;
}): Promise<ComputedCalibration> {
  const supportedObjectivesArray = Array.from(SUPPORTED_OBJECTIVES);
  const [row] = await getDb().query<CalibrationComputationRow>(
    COMPUTE_CALIBRATION_QUERY,
    [
      input.asOf,
      input.businessId,
      SAMPLE_WINDOW_DAYS,
      input.creativeFormat,
      supportedObjectivesArray,
      input.scopeType === CAMPAIGN_SCOPE_TYPE ? input.scopeId : null,
      input.campaignKind,
    ],
  );
  const matureCreativeCount = toIntegerOrNull(row?.mature_creative_count) ?? 0;
  const sampleWindowDays =
    toIntegerOrNull(row?.sample_window_days) ?? SAMPLE_WINDOW_DAYS;
  const sourceMaxUpdatedAt = toIsoTimestampOrNull(row?.source_max_updated_at);

  return {
    businessId: input.businessId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    campaignKind: input.campaignKind,
    creativeFormat: input.creativeFormat,
    asOfDate: input.asOf,
    sampleWindowStart:
      toIsoDateOrNull(row?.sample_window_start) ??
      sampleWindowStartForAsOf(input.asOf),
    sampleWindowEnd: toIsoDateOrNull(row?.sample_window_end) ?? input.asOf,
    sampleWindowDays,
    eligibleCreativeCount: toIntegerOrNull(row?.eligible_creative_count) ?? 0,
    matureCreativeCount,
    zeroConversionCount: toIntegerOrNull(row?.zero_conversion_count) ?? 0,
    roasP75: toNumberOrNull(row?.roas_p75),
    roasP60: toNumberOrNull(row?.roas_p60),
    refreshRatioP10: toNumberOrNull(row?.refresh_ratio_p10),
    lowCtrP10: toNumberOrNull(row?.low_ctr_p10),
    accountCpaP50: toNumberOrNull(row?.account_cpa_p50),
    accountCpaSampleCount: toIntegerOrNull(row?.account_cpa_sample_count) ?? 0,
    metaAttributedAovMean90d: toNumberOrNull(row?.meta_attributed_aov_mean_90d),
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
    ctrP25: toNumberOrNull(row?.ctr_p25),
    ctrP50: toNumberOrNull(row?.ctr_p50),
    cpmP50: toNumberOrNull(row?.cpm_p50),
    cpmP75: toNumberOrNull(row?.cpm_p75),
    thumbstopP25: toNumberOrNull(row?.thumbstop_p25),
    thumbstopP50: toNumberOrNull(row?.thumbstop_p50),
    linkToLpvP25: toNumberOrNull(row?.link_to_lpv_p25),
    linkToLpvP50: toNumberOrNull(row?.link_to_lpv_p50),
    linkToAtcP25: toNumberOrNull(row?.link_to_atc_p25),
    linkToAtcP50: toNumberOrNull(row?.link_to_atc_p50),
    lpvToAtcP25: toNumberOrNull(row?.lpv_to_atc_p25),
    lpvToAtcP50: toNumberOrNull(row?.lpv_to_atc_p50),
    atcToIcP25: toNumberOrNull(row?.atc_to_ic_p25),
    atcToIcP50: toNumberOrNull(row?.atc_to_ic_p50),
    icToPurchaseP25: toNumberOrNull(row?.ic_to_purchase_p25),
    icToPurchaseP50: toNumberOrNull(row?.ic_to_purchase_p50),
    clickToPurchaseP25: toNumberOrNull(row?.click_to_purchase_p25),
    clickToPurchaseP50: toNumberOrNull(row?.click_to_purchase_p50),
    funnelSampleCount: toIntegerOrNull(row?.funnel_sample_count) ?? 0,
    funnelQualityStatus: toFunnelQualityStatus(row?.funnel_quality_status),
    sourceMinDate: toIsoDateOrNull(row?.source_min_date),
    sourceMaxDate: toIsoDateOrNull(row?.source_max_date),
    sourceMaxUpdatedAt,
    qualityStatus: determineQualityStatus({
      matureCreativeCount,
      sampleWindowDays,
      sourceMaxUpdatedAt,
    }),
    computedAt: input.computedAt,
  };
}

function calibrationToAccountCalibration(
  row: ComputedCalibration,
): AccountCalibration {
  return {
    businessId: row.businessId,
    computedAt: row.computedAt,
    campaignKind: row.campaignKind,
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
  if (
    isOlderThanHours(input.sourceMaxUpdatedAt, STALE_TIER_WARNING_MAX_HOURS)
  ) {
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

function toMetaAovQuality(
  value: unknown,
): AccountCalibration["metaAovQuality"] {
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

function toFunnelQualityStatus(
  value: unknown,
): ComputedCalibration["funnelQualityStatus"] {
  const text = toStringOrNull(value);
  if (text === "ready" || text === "low_sample" || text === "insufficient") {
    return text;
  }
  return "insufficient";
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
