import { getDb, runDbTransaction } from "@/lib/db";
import {
  computeFatigue,
  type FatigueStatus,
  type HistoricalWindow,
} from "../fatigue";
import { ENGINE_VERSION } from "../types";
import {
  hashAdvisoryLock,
  JOB_NAME as CALIBRATION_JOB_NAME,
} from "./calibration-job";

export const JOB_NAME = "engine_v3_lifecycle_job";

type JobStatus = "success" | "failed" | "skipped";
type TrajectoryStatus = "rising" | "flat" | "falling" | "volatile" | "unknown";
type LifecyclePosition =
  | "rising"
  | "plateau"
  | "closing"
  | "past_peak_natural"
  | "past_peak_unclear"
  | "volatile"
  | "insufficient_history";

export interface LifecycleJobInput {
  businessId: string;
  asOf: string;
}

export interface LifecycleJobResult {
  jobRunId: string;
  dependencyRunId: string | null;
  status: JobStatus;
  rowsWritten: number;
  durationMs: number;
  errorMessage?: string;
}

type AdvisoryLockRow = Record<string, unknown> & {
  acquired: unknown;
};

type JobRunIdRow = Record<string, unknown> & {
  id: unknown;
};

type UpsertedLifecycleRow = Record<string, unknown> & {
  creative_id: unknown;
};

type LifecycleComputationRow = Record<string, unknown> & {
  business_ref_id: unknown;
  business_id: unknown;
  provider_account_ref_id: unknown;
  provider_account_id: unknown;
  campaign_id: unknown;
  adset_id: unknown;
  ad_id: unknown;
  creative_id: unknown;
  effective_object_story_id: unknown;
  post_id: unknown;
  creative_identity_hash: unknown;
  spend_28d: unknown;
  purchases_28d: unknown;
  purchase_value_28d: unknown;
  impressions_28d: unknown;
  link_clicks_28d: unknown;
  roas_28d: unknown;
  cpa_28d: unknown;
  ctr_28d: unknown;
  frequency_28d: unknown;
  spend_7d: unknown;
  purchases_7d: unknown;
  roas_7d: unknown;
  impressions_7d: unknown;
  first_seen_date: unknown;
  last_active_date: unknown;
  active_days_30d: unknown;
  age_days: unknown;
  peak_roas_30d: unknown;
  peak_roas_date: unknown;
  days_since_peak: unknown;
  peak_confidence: unknown;
  peak_spend_30d: unknown;
  peak_purchases_30d: unknown;
  spend_slope_7d: unknown;
  spend_slope_30d: unknown;
  roas_slope_7d: unknown;
  roas_slope_30d: unknown;
  mean_spend_30d: unknown;
  std_spend_30d: unknown;
  effective_status: unknown;
  objective: unknown;
  target_roas: unknown;
  breakeven_roas: unknown;
  source_min_date: unknown;
  source_max_date: unknown;
  source_max_updated_at: unknown;
};

interface FatigueEvidenceJson {
  evidence: string[];
  missingContext: string[];
  decays: {
    ctr: number | null;
    roas: number | null;
    c2p: number | null;
  };
}

interface LifecycleUpsertRow {
  business_ref_id: string;
  business_id: string | null;
  provider_account_ref_id: string | null;
  provider_account_id: string | null;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  creative_id: string;
  effective_object_story_id: string | null;
  post_id: string | null;
  creative_identity_hash: string | null;
  as_of_date: string;
  engine_version: string;
  spend_28d: number;
  purchases_28d: number;
  purchase_value_28d: number | null;
  impressions_28d: number | null;
  link_clicks_28d: number | null;
  roas_28d: number | null;
  cpa_28d: number | null;
  ctr_28d: number | null;
  frequency_28d: number | null;
  spend_7d: number;
  purchases_7d: number;
  roas_7d: number | null;
  impressions_7d: number | null;
  first_seen_date: string | null;
  last_active_date: string | null;
  active_days_30d: number;
  age_days: number | null;
  peak_roas_30d: number | null;
  peak_roas_date: string | null;
  days_since_peak: number | null;
  peak_confidence: number | null;
  peak_spend_30d: number | null;
  peak_purchases_30d: number | null;
  spend_slope_7d: number | null;
  spend_slope_30d: number | null;
  roas_slope_7d: number | null;
  roas_slope_30d: number | null;
  spend_trajectory_30d: TrajectoryStatus;
  lifecycle_position: LifecyclePosition;
  fatigue_status: FatigueStatus;
  fatigue_confidence: number;
  fatigue_evidence: FatigueEvidenceJson;
  effective_status: string | null;
  objective: string | null;
  target_roas: number | null;
  breakeven_roas: number | null;
  data_freshness_hours: number | null;
  source_max_date: string | null;
  source_max_updated_at: string | null;
  eligible_for_lifecycle: boolean;
  job_run_id: string;
  input_hash: string | null;
  computed_at: string;
}

interface ComputedLifecycleBatch {
  rows: LifecycleUpsertRow[];
  sourceMinDate: string | null;
  sourceMaxDate: string | null;
  sourceMaxUpdatedAt: string | null;
}

const COMPUTE_LIFECYCLE_ROWS_QUERY = `
WITH selected_creatives AS (
  SELECT d.creative_id
  FROM meta_creative_daily d
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date
  GROUP BY d.creative_id
  HAVING SUM(d.spend) > 0
),
daily AS (
  SELECT
    d.business_ref_id,
    d.creative_id,
    d.date,
    SUM(d.spend)::double precision AS spend,
    SUM(d.conversions)::double precision AS purchases,
    SUM(d.revenue)::double precision AS revenue,
    SUM(d.impressions)::bigint AS impressions,
    SUM(d.clicks)::bigint AS clicks,
    SUM(d.link_clicks)::bigint AS link_clicks,
    AVG(NULLIF(d.frequency, 0)) AS frequency
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date
  GROUP BY d.business_ref_id, d.creative_id, d.date
),
daily_with_roas AS (
  SELECT
    daily.*,
    CASE WHEN daily.spend > 0 THEN daily.revenue / daily.spend END AS daily_roas
  FROM daily
),
source_bounds AS (
  SELECT
    MIN(d.date) AS source_min_date,
    MAX(d.date) AS source_max_date,
    MAX(d.updated_at) AS source_max_updated_at
  FROM meta_creative_daily d
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date
),
all_history_bounds AS (
  SELECT
    d.creative_id,
    MIN(d.date) AS first_seen_date
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date <= $2::date
  GROUP BY d.creative_id
),
windows AS (
  SELECT
    creative_id,
    COALESCE(SUM(spend) FILTER (WHERE date >= ($2::date - INTERVAL '27 days')), 0)::double precision AS spend_28d,
    COALESCE(SUM(purchases) FILTER (WHERE date >= ($2::date - INTERVAL '27 days')), 0)::double precision AS purchases_28d,
    SUM(revenue) FILTER (WHERE date >= ($2::date - INTERVAL '27 days'))::double precision AS purchase_value_28d,
    SUM(impressions) FILTER (WHERE date >= ($2::date - INTERVAL '27 days'))::bigint AS impressions_28d,
    SUM(link_clicks) FILTER (WHERE date >= ($2::date - INTERVAL '27 days'))::bigint AS link_clicks_28d,
    CASE
      WHEN SUM(spend) FILTER (WHERE date >= ($2::date - INTERVAL '27 days')) > 0
      THEN SUM(revenue) FILTER (WHERE date >= ($2::date - INTERVAL '27 days')) /
        NULLIF(SUM(spend) FILTER (WHERE date >= ($2::date - INTERVAL '27 days')), 0)
    END AS roas_28d,
    CASE
      WHEN SUM(purchases) FILTER (WHERE date >= ($2::date - INTERVAL '27 days')) > 0
      THEN SUM(spend) FILTER (WHERE date >= ($2::date - INTERVAL '27 days')) /
        NULLIF(SUM(purchases) FILTER (WHERE date >= ($2::date - INTERVAL '27 days')), 0)
    END AS cpa_28d,
    CASE
      WHEN SUM(impressions) FILTER (WHERE date >= ($2::date - INTERVAL '27 days')) > 0
      THEN SUM(clicks) FILTER (WHERE date >= ($2::date - INTERVAL '27 days'))::numeric /
        NULLIF(SUM(impressions) FILTER (WHERE date >= ($2::date - INTERVAL '27 days')), 0) * 100
    END AS ctr_28d,
    AVG(frequency) FILTER (WHERE date >= ($2::date - INTERVAL '27 days') AND frequency > 0) AS frequency_28d,
    COALESCE(SUM(spend) FILTER (WHERE date >= ($2::date - INTERVAL '6 days')), 0)::double precision AS spend_7d,
    COALESCE(SUM(purchases) FILTER (WHERE date >= ($2::date - INTERVAL '6 days')), 0)::double precision AS purchases_7d,
    CASE
      WHEN SUM(spend) FILTER (WHERE date >= ($2::date - INTERVAL '6 days')) > 0
      THEN SUM(revenue) FILTER (WHERE date >= ($2::date - INTERVAL '6 days')) /
        NULLIF(SUM(spend) FILTER (WHERE date >= ($2::date - INTERVAL '6 days')), 0)
    END AS roas_7d,
    SUM(impressions) FILTER (WHERE date >= ($2::date - INTERVAL '6 days'))::bigint AS impressions_7d,
    MAX(date) FILTER (WHERE spend > 0) AS last_active_date,
    COUNT(DISTINCT date) FILTER (WHERE date >= ($2::date - INTERVAL '29 days') AND spend > 0)::integer AS active_days_30d,
    AVG(spend) FILTER (WHERE date >= ($2::date - INTERVAL '29 days')) AS mean_spend_30d,
    STDDEV_SAMP(spend) FILTER (WHERE date >= ($2::date - INTERVAL '29 days')) AS std_spend_30d
  FROM daily_with_roas
  GROUP BY creative_id
),
rolling AS (
  SELECT
    creative_id,
    date,
    CASE
      WHEN SUM(spend) OVER rolling_window > 0
      THEN SUM(revenue) OVER rolling_window / SUM(spend) OVER rolling_window
    END AS rolling_3d_roas,
    SUM(spend) OVER rolling_window AS rolling_3d_spend,
    SUM(purchases) OVER rolling_window AS rolling_3d_purchases
  FROM daily_with_roas
  WHERE date >= ($2::date - INTERVAL '29 days')
  WINDOW rolling_window AS (
    PARTITION BY creative_id
    ORDER BY date
    ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
  )
),
peak_ranked AS (
  SELECT DISTINCT ON (creative_id)
    creative_id,
    date AS peak_roas_date,
    rolling_3d_roas AS peak_roas_30d,
    rolling_3d_spend AS peak_spend_30d,
    rolling_3d_purchases AS peak_purchases_30d
  FROM rolling
  WHERE rolling_3d_roas IS NOT NULL
  ORDER BY creative_id, rolling_3d_roas DESC NULLS LAST, date ASC
),
peak_confidence AS (
  SELECT
    peak_ranked.creative_id,
    CASE
      WHEN peak_ranked.peak_roas_30d > 0
        AND COUNT(rolling.rolling_3d_roas) > 0
      THEN COUNT(*) FILTER (
        WHERE rolling.rolling_3d_roas >= peak_ranked.peak_roas_30d * 0.8
      )::double precision / COUNT(rolling.rolling_3d_roas)
    END AS peak_confidence
  FROM peak_ranked
  LEFT JOIN rolling
    ON rolling.creative_id = peak_ranked.creative_id
   AND rolling.date BETWEEN (peak_ranked.peak_roas_date - 3) AND (peak_ranked.peak_roas_date + 3)
   AND rolling.rolling_3d_roas IS NOT NULL
  GROUP BY peak_ranked.creative_id, peak_ranked.peak_roas_30d
),
slopes AS (
  SELECT
    creative_id,
    regr_slope(spend, EXTRACT(EPOCH FROM date::timestamp) / 86400.0)
      FILTER (WHERE date >= ($2::date - INTERVAL '6 days')) AS spend_slope_7d,
    regr_slope(spend, EXTRACT(EPOCH FROM date::timestamp) / 86400.0)
      FILTER (WHERE date >= ($2::date - INTERVAL '29 days')) AS spend_slope_30d,
    regr_slope(daily_roas, EXTRACT(EPOCH FROM date::timestamp) / 86400.0)
      FILTER (WHERE date >= ($2::date - INTERVAL '6 days')) AS roas_slope_7d,
    regr_slope(daily_roas, EXTRACT(EPOCH FROM date::timestamp) / 86400.0)
      FILTER (WHERE date >= ($2::date - INTERVAL '29 days')) AS roas_slope_30d
  FROM daily_with_roas
  GROUP BY creative_id
),
latest_meta AS (
  SELECT DISTINCT ON (d.creative_id)
    d.creative_id,
    d.business_id,
    d.provider_account_id,
    d.provider_account_ref_id,
    d.campaign_id,
    d.adset_id,
    d.ad_id,
    d.effective_status,
    d.objective,
    NULLIF(d.payload_json->>'effective_object_story_id', '') AS effective_object_story_id,
    NULLIF(d.payload_json->>'post_id', '') AS post_id,
    NULLIF(d.payload_json->>'creative_identity_hash', '') AS creative_identity_hash
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date <= $2::date
  ORDER BY d.creative_id, d.date DESC, d.updated_at DESC
),
target_pack AS (
  SELECT target_roas, break_even_roas
  FROM business_target_packs
  WHERE business_id = $1::uuid
  ORDER BY updated_at DESC
  LIMIT 1
),
historical_source AS (
  SELECT
    d.creative_id,
    windows.window_key,
    d.spend,
    d.impressions,
    d.clicks,
    d.conversions,
    d.revenue,
    d.link_clicks
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  CROSS JOIN LATERAL (
    VALUES
      ('last14', d.date BETWEEN ($2::date - INTERVAL '13 days') AND $2::date),
      ('last30', d.date BETWEEN ($2::date - INTERVAL '29 days') AND $2::date),
      ('last90', d.date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date),
      ('allHistory', d.date <= $2::date)
  ) AS windows(window_key, in_window)
  WHERE d.business_ref_id = $1::uuid
    AND d.date <= $2::date
    AND windows.in_window
),
historical_aggregates AS (
  SELECT
    creative_id,
    window_key,
    COUNT(*) AS row_count,
    SUM(spend) AS spend,
    CASE
      WHEN SUM(impressions) > 0
      THEN SUM(clicks)::numeric / NULLIF(SUM(impressions), 0) * 100
    END AS ctr,
    CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) END AS roas,
    CASE
      WHEN SUM(link_clicks) > 0
      THEN SUM(conversions)::double precision / NULLIF(SUM(link_clicks), 0)
    END AS click_to_purchase_rate,
    SUM(conversions) AS purchases
  FROM historical_source
  GROUP BY creative_id, window_key
),
historical AS (
  SELECT
    creative_id,
    MAX(row_count) FILTER (WHERE window_key = 'last14') AS last14_row_count,
    MAX(spend) FILTER (WHERE window_key = 'last14') AS last14_spend,
    MAX(ctr) FILTER (WHERE window_key = 'last14') AS last14_ctr,
    MAX(roas) FILTER (WHERE window_key = 'last14') AS last14_roas,
    MAX(click_to_purchase_rate) FILTER (WHERE window_key = 'last14') AS last14_click_to_purchase_rate,
    MAX(purchases) FILTER (WHERE window_key = 'last14') AS last14_purchases,
    MAX(row_count) FILTER (WHERE window_key = 'last30') AS last30_row_count,
    MAX(spend) FILTER (WHERE window_key = 'last30') AS last30_spend,
    MAX(ctr) FILTER (WHERE window_key = 'last30') AS last30_ctr,
    MAX(roas) FILTER (WHERE window_key = 'last30') AS last30_roas,
    MAX(click_to_purchase_rate) FILTER (WHERE window_key = 'last30') AS last30_click_to_purchase_rate,
    MAX(purchases) FILTER (WHERE window_key = 'last30') AS last30_purchases,
    MAX(row_count) FILTER (WHERE window_key = 'last90') AS last90_row_count,
    MAX(spend) FILTER (WHERE window_key = 'last90') AS last90_spend,
    MAX(ctr) FILTER (WHERE window_key = 'last90') AS last90_ctr,
    MAX(roas) FILTER (WHERE window_key = 'last90') AS last90_roas,
    MAX(click_to_purchase_rate) FILTER (WHERE window_key = 'last90') AS last90_click_to_purchase_rate,
    MAX(purchases) FILTER (WHERE window_key = 'last90') AS last90_purchases,
    MAX(row_count) FILTER (WHERE window_key = 'allHistory') AS all_history_row_count,
    MAX(spend) FILTER (WHERE window_key = 'allHistory') AS all_history_spend,
    MAX(ctr) FILTER (WHERE window_key = 'allHistory') AS all_history_ctr,
    MAX(roas) FILTER (WHERE window_key = 'allHistory') AS all_history_roas,
    MAX(click_to_purchase_rate) FILTER (WHERE window_key = 'allHistory') AS all_history_click_to_purchase_rate,
    MAX(purchases) FILTER (WHERE window_key = 'allHistory') AS all_history_purchases
  FROM historical_aggregates
  GROUP BY creative_id
)
SELECT
  $1::uuid AS business_ref_id,
  latest_meta.business_id,
  latest_meta.provider_account_ref_id,
  latest_meta.provider_account_id,
  latest_meta.campaign_id,
  latest_meta.adset_id,
  latest_meta.ad_id,
  selected_creatives.creative_id,
  latest_meta.effective_object_story_id,
  latest_meta.post_id,
  latest_meta.creative_identity_hash,
  windows.spend_28d,
  windows.purchases_28d,
  windows.purchase_value_28d,
  windows.impressions_28d,
  windows.link_clicks_28d,
  windows.roas_28d,
  windows.cpa_28d,
  windows.ctr_28d,
  windows.frequency_28d,
  windows.spend_7d,
  windows.purchases_7d,
  windows.roas_7d,
  windows.impressions_7d,
  all_history_bounds.first_seen_date,
  windows.last_active_date,
  windows.active_days_30d,
  CASE
    WHEN all_history_bounds.first_seen_date IS NOT NULL
    THEN ($2::date - all_history_bounds.first_seen_date)
  END AS age_days,
  peak_ranked.peak_roas_30d,
  peak_ranked.peak_roas_date,
  CASE
    WHEN peak_ranked.peak_roas_date IS NOT NULL
    THEN ($2::date - peak_ranked.peak_roas_date)
  END AS days_since_peak,
  peak_confidence.peak_confidence,
  peak_ranked.peak_spend_30d,
  peak_ranked.peak_purchases_30d,
  slopes.spend_slope_7d,
  slopes.spend_slope_30d,
  slopes.roas_slope_7d,
  slopes.roas_slope_30d,
  windows.mean_spend_30d,
  windows.std_spend_30d,
  latest_meta.effective_status,
  latest_meta.objective,
  target_pack.target_roas,
  target_pack.break_even_roas AS breakeven_roas,
  source_bounds.source_min_date,
  source_bounds.source_max_date,
  source_bounds.source_max_updated_at,
  historical.last14_row_count,
  historical.last14_spend,
  historical.last14_ctr,
  historical.last14_roas,
  historical.last14_click_to_purchase_rate,
  historical.last14_purchases,
  historical.last30_row_count,
  historical.last30_spend,
  historical.last30_ctr,
  historical.last30_roas,
  historical.last30_click_to_purchase_rate,
  historical.last30_purchases,
  historical.last90_row_count,
  historical.last90_spend,
  historical.last90_ctr,
  historical.last90_roas,
  historical.last90_click_to_purchase_rate,
  historical.last90_purchases,
  historical.all_history_row_count,
  historical.all_history_spend,
  historical.all_history_ctr,
  historical.all_history_roas,
  historical.all_history_click_to_purchase_rate,
  historical.all_history_purchases
FROM selected_creatives
LEFT JOIN windows USING (creative_id)
LEFT JOIN all_history_bounds USING (creative_id)
LEFT JOIN peak_ranked USING (creative_id)
LEFT JOIN peak_confidence USING (creative_id)
LEFT JOIN slopes USING (creative_id)
LEFT JOIN latest_meta USING (creative_id)
LEFT JOIN historical USING (creative_id)
CROSS JOIN source_bounds
LEFT JOIN target_pack ON true
ORDER BY COALESCE(windows.spend_28d, 0) DESC, selected_creatives.creative_id ASC
`;

const UPSERT_LIFECYCLE_ROWS_QUERY = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    business_ref_id uuid,
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    campaign_id text,
    adset_id text,
    ad_id text,
    creative_id text,
    effective_object_story_id text,
    post_id text,
    creative_identity_hash text,
    as_of_date date,
    engine_version text,
    spend_28d double precision,
    purchases_28d double precision,
    purchase_value_28d double precision,
    impressions_28d bigint,
    link_clicks_28d bigint,
    roas_28d double precision,
    cpa_28d double precision,
    ctr_28d double precision,
    frequency_28d double precision,
    spend_7d double precision,
    purchases_7d double precision,
    roas_7d double precision,
    impressions_7d bigint,
    first_seen_date date,
    last_active_date date,
    active_days_30d integer,
    age_days integer,
    peak_roas_30d double precision,
    peak_roas_date date,
    days_since_peak integer,
    peak_confidence double precision,
    peak_spend_30d double precision,
    peak_purchases_30d double precision,
    spend_slope_7d double precision,
    spend_slope_30d double precision,
    roas_slope_7d double precision,
    roas_slope_30d double precision,
    spend_trajectory_30d text,
    lifecycle_position text,
    fatigue_status text,
    fatigue_confidence double precision,
    fatigue_evidence jsonb,
    effective_status text,
    objective text,
    target_roas double precision,
    breakeven_roas double precision,
    data_freshness_hours integer,
    source_max_date date,
    source_max_updated_at timestamptz,
    eligible_for_lifecycle boolean,
    job_run_id uuid,
    input_hash text,
    computed_at timestamptz
  )
)
INSERT INTO engine_v3_creative_lifecycle_daily (
  business_ref_id,
  business_id,
  provider_account_ref_id,
  provider_account_id,
  campaign_id,
  adset_id,
  ad_id,
  creative_id,
  effective_object_story_id,
  post_id,
  creative_identity_hash,
  as_of_date,
  engine_version,
  spend_28d,
  purchases_28d,
  purchase_value_28d,
  impressions_28d,
  link_clicks_28d,
  roas_28d,
  cpa_28d,
  ctr_28d,
  frequency_28d,
  spend_7d,
  purchases_7d,
  roas_7d,
  impressions_7d,
  first_seen_date,
  last_active_date,
  active_days_30d,
  age_days,
  peak_roas_30d,
  peak_roas_date,
  days_since_peak,
  peak_confidence,
  peak_spend_30d,
  peak_purchases_30d,
  spend_slope_7d,
  spend_slope_30d,
  roas_slope_7d,
  roas_slope_30d,
  spend_trajectory_30d,
  lifecycle_position,
  fatigue_status,
  fatigue_confidence,
  fatigue_evidence,
  decision_recommended_at,
  operator_response_detected_at,
  operator_response_type,
  effective_status,
  objective,
  target_roas,
  breakeven_roas,
  data_freshness_hours,
  source_max_date,
  source_max_updated_at,
  eligible_for_lifecycle,
  job_run_id,
  input_hash,
  computed_at
)
SELECT
  business_ref_id,
  business_id,
  provider_account_ref_id,
  provider_account_id,
  campaign_id,
  adset_id,
  ad_id,
  creative_id,
  effective_object_story_id,
  post_id,
  creative_identity_hash,
  as_of_date,
  engine_version,
  spend_28d,
  purchases_28d,
  purchase_value_28d,
  impressions_28d,
  link_clicks_28d,
  roas_28d,
  cpa_28d,
  ctr_28d,
  frequency_28d,
  spend_7d,
  purchases_7d,
  roas_7d,
  impressions_7d,
  first_seen_date,
  last_active_date,
  active_days_30d,
  age_days,
  peak_roas_30d,
  peak_roas_date,
  days_since_peak,
  peak_confidence,
  peak_spend_30d,
  peak_purchases_30d,
  spend_slope_7d,
  spend_slope_30d,
  roas_slope_7d,
  roas_slope_30d,
  spend_trajectory_30d,
  lifecycle_position,
  fatigue_status,
  fatigue_confidence,
  fatigue_evidence,
  NULL,
  NULL,
  NULL,
  effective_status,
  objective,
  target_roas,
  breakeven_roas,
  data_freshness_hours,
  source_max_date,
  source_max_updated_at,
  eligible_for_lifecycle,
  job_run_id,
  input_hash,
  computed_at
FROM payload
ON CONFLICT (business_ref_id, creative_id, as_of_date, engine_version)
DO UPDATE SET
  business_id = EXCLUDED.business_id,
  provider_account_ref_id = EXCLUDED.provider_account_ref_id,
  provider_account_id = EXCLUDED.provider_account_id,
  campaign_id = EXCLUDED.campaign_id,
  adset_id = EXCLUDED.adset_id,
  ad_id = EXCLUDED.ad_id,
  effective_object_story_id = EXCLUDED.effective_object_story_id,
  post_id = EXCLUDED.post_id,
  creative_identity_hash = EXCLUDED.creative_identity_hash,
  spend_28d = EXCLUDED.spend_28d,
  purchases_28d = EXCLUDED.purchases_28d,
  purchase_value_28d = EXCLUDED.purchase_value_28d,
  impressions_28d = EXCLUDED.impressions_28d,
  link_clicks_28d = EXCLUDED.link_clicks_28d,
  roas_28d = EXCLUDED.roas_28d,
  cpa_28d = EXCLUDED.cpa_28d,
  ctr_28d = EXCLUDED.ctr_28d,
  frequency_28d = EXCLUDED.frequency_28d,
  spend_7d = EXCLUDED.spend_7d,
  purchases_7d = EXCLUDED.purchases_7d,
  roas_7d = EXCLUDED.roas_7d,
  impressions_7d = EXCLUDED.impressions_7d,
  first_seen_date = EXCLUDED.first_seen_date,
  last_active_date = EXCLUDED.last_active_date,
  active_days_30d = EXCLUDED.active_days_30d,
  age_days = EXCLUDED.age_days,
  peak_roas_30d = EXCLUDED.peak_roas_30d,
  peak_roas_date = EXCLUDED.peak_roas_date,
  days_since_peak = EXCLUDED.days_since_peak,
  peak_confidence = EXCLUDED.peak_confidence,
  peak_spend_30d = EXCLUDED.peak_spend_30d,
  peak_purchases_30d = EXCLUDED.peak_purchases_30d,
  spend_slope_7d = EXCLUDED.spend_slope_7d,
  spend_slope_30d = EXCLUDED.spend_slope_30d,
  roas_slope_7d = EXCLUDED.roas_slope_7d,
  roas_slope_30d = EXCLUDED.roas_slope_30d,
  spend_trajectory_30d = EXCLUDED.spend_trajectory_30d,
  lifecycle_position = EXCLUDED.lifecycle_position,
  fatigue_status = EXCLUDED.fatigue_status,
  fatigue_confidence = EXCLUDED.fatigue_confidence,
  fatigue_evidence = EXCLUDED.fatigue_evidence,
  -- Preserve Phase 3.8 operator response columns on rerun; lifecycle owns analytical fields only.
  effective_status = EXCLUDED.effective_status,
  objective = EXCLUDED.objective,
  target_roas = EXCLUDED.target_roas,
  breakeven_roas = EXCLUDED.breakeven_roas,
  data_freshness_hours = EXCLUDED.data_freshness_hours,
  source_max_date = EXCLUDED.source_max_date,
  source_max_updated_at = EXCLUDED.source_max_updated_at,
  eligible_for_lifecycle = EXCLUDED.eligible_for_lifecycle,
  job_run_id = EXCLUDED.job_run_id,
  input_hash = EXCLUDED.input_hash,
  computed_at = EXCLUDED.computed_at,
  updated_at = now()
RETURNING creative_id
`;

export function lifecycleJobAdvisoryLockKey(input: LifecycleJobInput): bigint {
  return hashAdvisoryLock(`${JOB_NAME}:${input.businessId}:${input.asOf}`);
}

export async function runLifecycleJob(
  input: LifecycleJobInput,
): Promise<LifecycleJobResult> {
  const startedAt = Date.now();
  const lockKey = lifecycleJobAdvisoryLockKey(input);

  return runDbTransaction(async () => {
    const db = getDb();
    const [lockRow] = await db.query<AdvisoryLockRow>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [lockKey.toString()],
    );
    const dependencyRunId = await findLatestSuccessfulCalibrationRun(input);

    if (lockRow?.acquired !== true) {
      const durationMs = Date.now() - startedAt;
      const jobRunId = await insertJobRun({
        businessId: input.businessId,
        asOf: input.asOf,
        status: "skipped",
        dependencyRunId,
        durationMs,
        rowCount: 0,
        errorMessage: "Advisory lock not acquired (job may already be running)",
      });
      return {
        jobRunId,
        dependencyRunId,
        status: "skipped",
        rowsWritten: 0,
        durationMs,
        errorMessage: "Advisory lock not acquired (job may already be running)",
      };
    }

    const jobRunId = await insertJobRun({
      businessId: input.businessId,
      asOf: input.asOf,
      status: "running",
      dependencyRunId,
    });

    await db.query("SAVEPOINT engine_v3_lifecycle_job_work");
    try {
      const batch = await computeLifecycleRows({
        businessId: input.businessId,
        asOf: input.asOf,
        jobRunId,
      });
      const rowsWritten = await upsertLifecycleRows(batch.rows);
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
          rowsWritten,
          batch.sourceMinDate,
          batch.sourceMaxDate,
          batch.sourceMaxUpdatedAt,
          jobRunId,
        ],
      );

      return {
        jobRunId,
        dependencyRunId,
        status: "success",
        rowsWritten,
        durationMs,
      };
    } catch (error) {
      await db
        .query("ROLLBACK TO SAVEPOINT engine_v3_lifecycle_job_work")
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
        dependencyRunId,
        status: "failed",
        rowsWritten: 0,
        durationMs,
        errorMessage: message,
      };
    }
  });
}

async function findLatestSuccessfulCalibrationRun(input: LifecycleJobInput) {
  const [row] = await getDb().query<JobRunIdRow>(
    `
    SELECT id
    FROM engine_v3_job_runs
    WHERE job_name = $1
      AND business_ref_id = $2::uuid
      AND as_of_date <= $3::date
      AND engine_version = $4
      AND status = 'success'
    ORDER BY as_of_date DESC, finished_at DESC NULLS LAST, started_at DESC
    LIMIT 1
    `,
    [CALIBRATION_JOB_NAME, input.businessId, input.asOf, ENGINE_VERSION],
  );

  return toStringOrNull(row?.id);
}

async function insertJobRun(input: {
  businessId: string;
  asOf: string;
  status: JobStatus | "running";
  dependencyRunId: string | null;
  durationMs?: number;
  rowCount?: number;
  errorMessage?: string;
}) {
  const [row] = await getDb().query<JobRunIdRow>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, dependency_run_id, finished_at, duration_ms, row_count, error_message
    )
    VALUES (
      $1, $2::uuid, $3, $4::date, $5,
      $6, $7::uuid, CASE WHEN $6 = 'running' THEN NULL ELSE now() END,
      $8::integer, $9::integer, $10
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
      input.dependencyRunId,
      input.durationMs ?? null,
      input.rowCount ?? null,
      input.errorMessage ?? null,
    ],
  );

  const id = toStringOrNull(row?.id);
  if (id === null) {
    throw new Error("Lifecycle job run insert did not return an id.");
  }
  return id;
}

async function computeLifecycleRows(input: {
  businessId: string;
  asOf: string;
  jobRunId: string;
}): Promise<ComputedLifecycleBatch> {
  const rows = await getDb().query<LifecycleComputationRow>(
    COMPUTE_LIFECYCLE_ROWS_QUERY,
    [input.businessId, input.asOf],
  );
  const computedAt = new Date().toISOString();
  const firstRow = rows[0];
  const sourceMinDate = toIsoDateOrNull(firstRow?.source_min_date);
  const sourceMaxDate = toIsoDateOrNull(firstRow?.source_max_date);
  const sourceMaxUpdatedAt = toIsoTimestampOrNull(
    firstRow?.source_max_updated_at,
  );

  return {
    rows: rows
      .map((row) =>
        mapLifecycleComputationRow({
          row,
          businessId: input.businessId,
          asOf: input.asOf,
          jobRunId: input.jobRunId,
          computedAt,
        }),
      )
      .filter((row): row is LifecycleUpsertRow => row !== null),
    sourceMinDate,
    sourceMaxDate,
    sourceMaxUpdatedAt,
  };
}

async function upsertLifecycleRows(rows: LifecycleUpsertRow[]) {
  if (rows.length === 0) return 0;

  const upserted = await getDb().query<UpsertedLifecycleRow>(
    UPSERT_LIFECYCLE_ROWS_QUERY,
    [JSON.stringify(rows)],
  );
  return upserted.length;
}

function mapLifecycleComputationRow(input: {
  row: LifecycleComputationRow;
  businessId: string;
  asOf: string;
  jobRunId: string;
  computedAt: string;
}): LifecycleUpsertRow | null {
  const creativeId = toStringOrNull(input.row.creative_id);
  if (creativeId === null) return null;

  const spend28d = toNumberOrNull(input.row.spend_28d) ?? 0;
  const purchases28d = toNumberOrNull(input.row.purchases_28d) ?? 0;
  const linkClicks28d = toIntegerOrNull(input.row.link_clicks_28d);
  const ctr28d = toNumberOrNull(input.row.ctr_28d);
  const roas28d = toNumberOrNull(input.row.roas_28d);
  const frequency28d = toNumberOrNull(input.row.frequency_28d);
  const ageDays = toIntegerOrNull(input.row.age_days);
  const activeDays30d = toIntegerOrNull(input.row.active_days_30d) ?? 0;
  const eligibleForLifecycle =
    ageDays !== null && ageDays >= 7 && activeDays30d >= 5;
  const sourceMaxUpdatedAt = toIsoTimestampOrNull(
    input.row.source_max_updated_at,
  );
  const spendTrajectory30d = eligibleForLifecycle
    ? classifyTrajectory({
        slope30d: toNumberOrNull(input.row.spend_slope_30d),
        meanSpend30d: toNumberOrNull(input.row.mean_spend_30d),
        stdSpend30d: toNumberOrNull(input.row.std_spend_30d),
      })
    : "unknown";

  const peakRoas30d = eligibleForLifecycle
    ? toNumberOrNull(input.row.peak_roas_30d)
    : null;
  const peakRoasDate = eligibleForLifecycle
    ? toIsoDateOrNull(input.row.peak_roas_date)
    : null;
  const daysSincePeak = eligibleForLifecycle
    ? toIntegerOrNull(input.row.days_since_peak)
    : null;
  const peakConfidence = eligibleForLifecycle
    ? clamp01(toNumberOrNull(input.row.peak_confidence))
    : null;
  const recent7dRoas = toNumberOrNull(input.row.roas_7d);
  const lifecyclePosition = eligibleForLifecycle
    ? classifyLifecyclePosition({
        ageDays,
        activeDays30d,
        peakRoas30d,
        daysSincePeak,
        peakConfidence,
        spendTrajectory30d,
        roas28d,
        recent7dRoas,
      })
    : "insufficient_history";
  const fatigue = computeFatigue({
    ctr: ctr28d,
    roas: roas28d,
    clickToPurchaseRate:
      purchases28d > 0 && linkClicks28d !== null && linkClicks28d > 0
        ? purchases28d / linkClicks28d
        : null,
    historicalWindows: {
      last14: toHistoricalWindow(input.row, "last14"),
      last30: toHistoricalWindow(input.row, "last30"),
      last90: toHistoricalWindow(input.row, "last90"),
      allHistory: toHistoricalWindow(input.row, "all_history"),
    },
    spendConcentration: null,
    frequency: frequency28d,
    benchmarkRoasStatus: null,
    benchmarkClickToPurchaseStatus: null,
  });

  return {
    business_ref_id: input.businessId,
    business_id: toStringOrNull(input.row.business_id) ?? input.businessId,
    provider_account_ref_id: toStringOrNull(input.row.provider_account_ref_id),
    provider_account_id: toStringOrNull(input.row.provider_account_id),
    campaign_id: toStringOrNull(input.row.campaign_id),
    adset_id: toStringOrNull(input.row.adset_id),
    ad_id: toStringOrNull(input.row.ad_id),
    creative_id: creativeId,
    effective_object_story_id: toStringOrNull(
      input.row.effective_object_story_id,
    ),
    post_id: toStringOrNull(input.row.post_id),
    creative_identity_hash: toStringOrNull(input.row.creative_identity_hash),
    as_of_date: input.asOf,
    engine_version: ENGINE_VERSION,
    spend_28d: spend28d,
    purchases_28d: purchases28d,
    purchase_value_28d: toNumberOrNull(input.row.purchase_value_28d),
    impressions_28d: toIntegerOrNull(input.row.impressions_28d),
    link_clicks_28d: linkClicks28d,
    roas_28d: roas28d,
    cpa_28d: toNumberOrNull(input.row.cpa_28d),
    ctr_28d: ctr28d,
    frequency_28d: frequency28d,
    spend_7d: toNumberOrNull(input.row.spend_7d) ?? 0,
    purchases_7d: toNumberOrNull(input.row.purchases_7d) ?? 0,
    roas_7d: recent7dRoas,
    impressions_7d: toIntegerOrNull(input.row.impressions_7d),
    first_seen_date: toIsoDateOrNull(input.row.first_seen_date),
    last_active_date: toIsoDateOrNull(input.row.last_active_date),
    active_days_30d: activeDays30d,
    age_days: ageDays,
    peak_roas_30d: peakRoas30d,
    peak_roas_date: peakRoasDate,
    days_since_peak: daysSincePeak,
    peak_confidence: peakConfidence,
    // Peak spend/purchases use the same 3-day sum as rolling ROAS, not a single-day value.
    peak_spend_30d: eligibleForLifecycle
      ? toNumberOrNull(input.row.peak_spend_30d)
      : null,
    peak_purchases_30d: eligibleForLifecycle
      ? toNumberOrNull(input.row.peak_purchases_30d)
      : null,
    spend_slope_7d: eligibleForLifecycle
      ? toNumberOrNull(input.row.spend_slope_7d)
      : null,
    spend_slope_30d: eligibleForLifecycle
      ? toNumberOrNull(input.row.spend_slope_30d)
      : null,
    roas_slope_7d: eligibleForLifecycle
      ? toNumberOrNull(input.row.roas_slope_7d)
      : null,
    roas_slope_30d: eligibleForLifecycle
      ? toNumberOrNull(input.row.roas_slope_30d)
      : null,
    spend_trajectory_30d: spendTrajectory30d,
    lifecycle_position: lifecyclePosition,
    fatigue_status: fatigue.status,
    fatigue_confidence: fatigue.confidence,
    fatigue_evidence: {
      evidence: fatigue.evidence,
      missingContext: fatigue.missingContext,
      decays: {
        ctr: fatigue.ctrDecay,
        roas: fatigue.roasDecay,
        c2p: fatigue.clickToPurchaseDecay,
      },
    },
    effective_status: toStringOrNull(input.row.effective_status),
    objective: toStringOrNull(input.row.objective),
    target_roas: toNumberOrNull(input.row.target_roas),
    breakeven_roas: toNumberOrNull(input.row.breakeven_roas),
    data_freshness_hours: freshnessHours(sourceMaxUpdatedAt),
    source_max_date: toIsoDateOrNull(input.row.source_max_date),
    source_max_updated_at: sourceMaxUpdatedAt,
    eligible_for_lifecycle: eligibleForLifecycle,
    job_run_id: input.jobRunId,
    input_hash: null,
    computed_at: input.computedAt,
  };
}

function classifyTrajectory(input: {
  slope30d: number | null;
  meanSpend30d: number | null;
  stdSpend30d: number | null;
}): TrajectoryStatus {
  if (input.meanSpend30d === null || input.meanSpend30d <= 0) return "unknown";

  const cv = (input.stdSpend30d ?? 0) / input.meanSpend30d;
  if (cv > 1.5) return "volatile";

  if (input.slope30d === null) return "unknown";
  const significanceThreshold = input.meanSpend30d * 0.05;
  if (input.slope30d > significanceThreshold) return "rising";
  if (input.slope30d < -significanceThreshold) return "falling";
  return "flat";
}

function classifyLifecyclePosition(input: {
  ageDays: number | null;
  activeDays30d: number;
  peakRoas30d: number | null;
  daysSincePeak: number | null;
  peakConfidence: number | null;
  spendTrajectory30d: TrajectoryStatus;
  roas28d: number | null;
  recent7dRoas: number | null;
}): LifecyclePosition {
  if (
    input.ageDays === null ||
    input.ageDays < 7 ||
    input.activeDays30d < 5
  ) {
    return "insufficient_history";
  }

  if (input.peakRoas30d === null || input.daysSincePeak === null) {
    return "insufficient_history";
  }

  if (input.spendTrajectory30d === "volatile") {
    return "volatile";
  }

  if (
    input.daysSincePeak <= 3 &&
    input.recent7dRoas !== null &&
    input.peakRoas30d > 0 &&
    input.recent7dRoas >= input.peakRoas30d * 0.9
  ) {
    return "rising";
  }

  if (
    input.daysSincePeak <= 7 &&
    input.recent7dRoas !== null &&
    input.peakRoas30d > 0 &&
    input.recent7dRoas >= input.peakRoas30d * 0.85 &&
    input.recent7dRoas <= input.peakRoas30d * 1.1
  ) {
    return "plateau";
  }

  if (
    input.daysSincePeak <= 14 &&
    input.recent7dRoas !== null &&
    input.peakRoas30d > 0 &&
    input.recent7dRoas >= input.peakRoas30d * 0.7
  ) {
    return "closing";
  }

  if (input.daysSincePeak > 14) {
    if (input.spendTrajectory30d === "rising") {
      return "past_peak_natural";
    }
    return "past_peak_unclear";
  }

  return "past_peak_unclear";
}

function toHistoricalWindow(
  row: LifecycleComputationRow,
  prefix: string,
): HistoricalWindow | null {
  const rowCount = toNumberOrNull(row[`${prefix}_row_count`]) ?? 0;
  if (rowCount <= 0) return null;

  return {
    spend: toNumberOrNull(row[`${prefix}_spend`]) ?? 0,
    ctr: toNumberOrNull(row[`${prefix}_ctr`]) ?? 0,
    roas: toNumberOrNull(row[`${prefix}_roas`]) ?? 0,
    clickToPurchaseRate:
      toNumberOrNull(row[`${prefix}_click_to_purchase_rate`]) ?? 0,
    purchases: toNumberOrNull(row[`${prefix}_purchases`]) ?? 0,
  };
}

function freshnessHours(timestamp: string | null) {
  if (timestamp === null) return null;
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 3_600_000));
}

function clamp01(value: number | null) {
  if (value === null) return null;
  return Math.max(0, Math.min(1, value));
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
