import { getDb } from "@/lib/db";
import {
  buildDataLayerHealth,
  composeDataHealth,
  freshDataLayerHealth,
  STALE_TIER_WARNING_MAX_HOURS,
} from "./data-health";
import { computeFatigue, type HistoricalWindow } from "./fatigue";
import type {
  AccountCalibration,
  CampaignObjective,
  CreativeInput,
  DataHealth,
  DataLayerHealth,
  FallbackMode,
  LifecyclePosition,
  SpendTrajectory,
  StaleTier,
} from "./types";

/**
 * Adapter interface for the engine's data dependencies.
 * MockDataSource is used in development/tests until the warehouse sync
 * (meta_creative_daily) is wired. WarehouseDataSource is the production
 * implementation, populated in a later phase.
 */
export interface CreativeDecisionDataSource {
  /** Hydrate a `CreativeInput` for a given creative as of a date. */
  getCreativeInput(input: {
    creativeId: string;
    businessId: string;
    asOf: string;
  }): Promise<CreativeInput | null>;

  /** Return per-account self-calibrated values (Tier 3). */
  getAccountCalibration(input: {
    businessId: string;
    asOf: string;
  }): Promise<AccountCalibration>;

  /** Bulk fetch - used by surface to render a creative list. */
  listCreativeInputs(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]>;

  /**
   * Returns the data health snapshot for a business as of a given date.
   * Used by the API route to surface freshness in the response.
   */
  getDataHealth(input: {
    businessId: string;
    asOf: string;
  }): Promise<DataHealth>;
}

/**
 * In-memory mock used until warehouse is ready. Returns deterministic test data.
 * The fixture roughly mirrors a small TheSwaf-like account.
 */
export class MockDataSource implements CreativeDecisionDataSource {
  async getCreativeInput(input: {
    creativeId: string;
    businessId: string;
    asOf: string;
  }): Promise<CreativeInput | null> {
    return {
      creativeId: input.creativeId,
      creativeName: `Mock — ${input.creativeId}`,
      businessId: input.businessId,
      campaignId: "mock-campaign-001",
      objective: "OUTCOME_SALES",
      spend: 500,
      purchases: 8,
      purchaseValue: 1500,
      impressions: 50000,
      linkClicks: 600,
      roas: 3.0,
      cpa: 62.5,
      ctr: 1.2,
      frequency: 1.4,
      recent7dSpend: 120,
      recent7dPurchases: 2,
      recent7dRoas: 2.8,
      recent7dImpressions: 12000,
      effectiveStatus: "ACTIVE",
      ageDays: 21,
      lastSpendAt: input.asOf,
      policyReason: null,
      dataFreshnessHours: 6,
      fatigueStatus: "none",
      targetRoas: 2.2,
      breakevenRoas: 1.71,
      lifecyclePosition: "plateau",
      daysSincePeak: 5,
      peakRoas30d: 3.4,
      peakConfidence: 0.7,
      spendTrajectory30d: "flat",
      spendSlope7d: 0.5,
      spendSlope30d: 0.2,
      roasSlope7d: -0.05,
      roasSlope30d: 0.0,
    };
  }

  async getAccountCalibration(input: {
    businessId: string;
    asOf: string;
  }): Promise<AccountCalibration> {
    return {
      businessId: input.businessId,
      computedAt: new Date().toISOString(),
      matureCreativeCount: 35,
      roasP75: 2.4,
      roasP60: 1.9,
      refreshRatioP10: 0.82,
      lowCtrP10: 0.7,
    };
  }

  async listCreativeInputs(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]> {
    const ids = input.creativeIds ?? [
      "mock-creative-001",
      "mock-creative-002",
      "mock-creative-003",
    ];
    const results = await Promise.all(
      ids.map((creativeId) =>
        this.getCreativeInput({
          creativeId,
          businessId: input.businessId,
          asOf: input.asOf,
        }),
      ),
    );
    return results.filter((result): result is CreativeInput => result !== null);
  }

  async getDataHealth(input: {
    businessId: string;
    asOf: string;
  }): Promise<DataHealth> {
    return composeDataHealth({
      calibration: freshDataLayerHealth(input.asOf),
      lifecycle: freshDataLayerHealth(input.asOf),
      decisions: freshDataLayerHealth(input.asOf),
    });
  }
}

const CAMPAIGN_OBJECTIVES = new Set<CampaignObjective>([
  "OUTCOME_SALES",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_TRAFFIC",
  "OUTCOME_LEADS",
  "OUTCOME_AWARENESS",
  "OUTCOME_APP_PROMOTION",
]);

type EffectiveStatus = CreativeInput["effectiveStatus"];

const EFFECTIVE_STATUSES = new Set<NonNullable<EffectiveStatus>>([
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "REJECTED",
]);

const FATIGUE_STATUSES = new Set<NonNullable<CreativeInput["fatigueStatus"]>>([
  "none",
  "watch",
  "fatigued",
  "unknown",
]);

const LIFECYCLE_POSITIONS = new Set<LifecyclePosition>([
  "rising",
  "plateau",
  "closing",
  "past_peak_inaction",
  "past_peak_natural",
  "past_peak_unclear",
  "volatile",
  "insufficient_history",
]);

const SPEND_TRAJECTORIES = new Set<SpendTrajectory>([
  "rising",
  "flat",
  "falling",
  "volatile",
  "unknown",
]);

type CreativeHydrationRow = Record<string, unknown> & {
  creative_id: unknown;
  creative_name: unknown;
  spend: unknown;
  purchases: unknown;
  purchase_value: unknown;
  impressions: unknown;
  link_clicks: unknown;
  roas: unknown;
  cpa: unknown;
  ctr: unknown;
  frequency: unknown;
  recent_spend: unknown;
  recent_purchases: unknown;
  recent_impressions: unknown;
  recent_roas: unknown;
  effective_status: unknown;
  objective: unknown;
  campaign_id: unknown;
  last_spend_date: unknown;
  policy_reason: unknown;
  age_days: unknown;
  data_freshness_hours: unknown;
  target_roas: unknown;
  break_even_roas: unknown;
};

type CalibrationRow = Record<string, unknown> & {
  mature_count: unknown;
  roas_p75: unknown;
  roas_p60: unknown;
  refresh_ratio_p10: unknown;
  refresh_ratio_count: unknown;
  low_ctr_p10: unknown;
  ctr_count: unknown;
  source_min_date: unknown;
  source_max_date: unknown;
  source_max_updated_at: unknown;
};

type SourceMaxUpdatedAtRow = Record<string, unknown> & {
  source_max_updated_at: unknown;
};

type CalibrationTableRow = Record<string, unknown> & {
  business_ref_id: unknown;
  engine_version: unknown;
  mature_creative_count: unknown;
  roas_p75: unknown;
  roas_p60: unknown;
  refresh_ratio_p10: unknown;
  low_ctr_p10: unknown;
  computed_at: unknown;
  source_max_updated_at: unknown;
  source_max_date: unknown;
  as_of_date: unknown;
  quality_status: unknown;
};

type LifecycleTableHydrationRow = Record<string, unknown> & {
  creative_id: unknown;
  creative_name: unknown;
  campaign_id: unknown;
  objective: unknown;
  spend: unknown;
  purchases: unknown;
  purchase_value: unknown;
  impressions: unknown;
  link_clicks: unknown;
  roas: unknown;
  cpa: unknown;
  ctr: unknown;
  frequency: unknown;
  recent_spend: unknown;
  recent_purchases: unknown;
  recent_roas: unknown;
  recent_impressions: unknown;
  effective_status: unknown;
  age_days: unknown;
  last_active_date: unknown;
  policy_reason: unknown;
  source_max_updated_at: unknown;
  data_freshness_hours: unknown;
  fatigue_status: unknown;
  target_roas: unknown;
  break_even_roas: unknown;
  lifecycle_position: unknown;
  days_since_peak: unknown;
  peak_roas_30d: unknown;
  peak_confidence: unknown;
  spend_trajectory_30d: unknown;
  spend_slope_7d: unknown;
  spend_slope_30d: unknown;
  roas_slope_7d: unknown;
  roas_slope_30d: unknown;
};

type LifecycleHealthRow = Record<string, unknown> & {
  computed_at: unknown;
  source_max_updated_at: unknown;
  as_of_date: unknown;
  engine_version: unknown;
  row_count: unknown;
};

interface CalibrationReadMetadata {
  businessId: string;
  requestedAsOf: string;
  asOfDate: string | null;
  computedAt: string | null;
  sourceMaxUpdatedAt: string | null;
  fallbackMode: FallbackMode;
  note: string | null;
  staleTierOverride?: StaleTier;
}

const HYDRATE_CREATIVE_INPUTS_QUERY = `
WITH input_creatives AS (
  SELECT DISTINCT input.creative_id
  FROM unnest($3::text[]) AS input(creative_id)
  WHERE $4::boolean
),
latest_status AS (
  SELECT DISTINCT ON (d.creative_id)
    d.creative_id,
    d.effective_status
  FROM meta_creative_daily d
  WHERE NOT $4::boolean
    AND d.business_ref_id = $1::uuid
    AND d.date <= $2::date
  ORDER BY d.creative_id, d.date DESC, d.updated_at DESC
),
selected_creatives AS (
  SELECT creative_id
  FROM input_creatives

  UNION

  SELECT DISTINCT d.creative_id
  FROM meta_creative_daily d
  WHERE NOT $4::boolean
    AND d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '29 days') AND $2::date
    AND d.spend > 0

  UNION

  SELECT creative_id
  FROM latest_status
  WHERE effective_status = 'ACTIVE'
),
cumulative AS (
  SELECT
    d.creative_id,
    SUM(d.spend) AS spend,
    SUM(d.conversions) AS purchases,
    SUM(d.revenue) AS purchase_value,
    SUM(d.impressions) AS impressions,
    SUM(d.link_clicks) AS link_clicks,
    CASE WHEN SUM(d.spend) > 0 THEN SUM(d.revenue) / SUM(d.spend) END AS roas,
    CASE WHEN SUM(d.conversions) > 0 THEN SUM(d.spend) / SUM(d.conversions) END AS cpa,
    CASE
      WHEN SUM(d.impressions) > 0
      THEN SUM(d.clicks)::numeric / NULLIF(SUM(d.impressions), 0) * 100
    END AS ctr,
    AVG(d.frequency) FILTER (WHERE d.frequency > 0) AS frequency
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
  GROUP BY d.creative_id
),
recent AS (
  SELECT
    d.creative_id,
    SUM(d.spend) AS spend,
    SUM(d.conversions) AS purchases,
    SUM(d.impressions) AS impressions,
    CASE WHEN SUM(d.spend) > 0 THEN SUM(d.revenue) / SUM(d.spend) END AS roas
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '6 days') AND $2::date
  GROUP BY d.creative_id
),
latest_meta AS (
  SELECT DISTINCT ON (d.creative_id)
    d.creative_id,
    d.effective_status,
    d.objective,
    d.campaign_id,
    d.creative_name,
    d.first_spend_at,
    d.launch_date,
    d.updated_at,
    NULLIF(d.payload_json->>'policy_reason', '') AS policy_reason,
    CASE
      WHEN d.first_spend_at IS NOT NULL
      THEN ($2::date - d.first_spend_at::date)
    END AS age_days,
    CASE
      WHEN d.updated_at IS NOT NULL
      THEN FLOOR(EXTRACT(EPOCH FROM (now() - d.updated_at)) / 3600)
    END AS data_freshness_hours
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
  ORDER BY d.creative_id, d.date DESC, d.updated_at DESC
),
last_spend AS (
  SELECT d.creative_id, MAX(d.date) AS last_spend_date
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date <= $2::date
    AND d.spend > 0
  GROUP BY d.creative_id
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
      THEN SUM(conversions) / NULLIF(SUM(link_clicks), 0)
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
  c.creative_id,
  c.spend,
  c.purchases,
  c.purchase_value,
  c.impressions,
  c.link_clicks,
  c.roas,
  c.cpa,
  c.ctr,
  c.frequency,
  r.spend AS recent_spend,
  r.purchases AS recent_purchases,
  r.impressions AS recent_impressions,
  r.roas AS recent_roas,
  m.effective_status,
  m.objective,
  m.campaign_id,
  m.creative_name,
  m.policy_reason,
  m.age_days,
  m.data_freshness_hours,
  ls.last_spend_date,
  tp.target_roas,
  tp.break_even_roas,
  h.last14_row_count,
  h.last14_spend,
  h.last14_ctr,
  h.last14_roas,
  h.last14_click_to_purchase_rate,
  h.last14_purchases,
  h.last30_row_count,
  h.last30_spend,
  h.last30_ctr,
  h.last30_roas,
  h.last30_click_to_purchase_rate,
  h.last30_purchases,
  h.last90_row_count,
  h.last90_spend,
  h.last90_ctr,
  h.last90_roas,
  h.last90_click_to_purchase_rate,
  h.last90_purchases,
  h.all_history_row_count,
  h.all_history_spend,
  h.all_history_ctr,
  h.all_history_roas,
  h.all_history_click_to_purchase_rate,
  h.all_history_purchases
FROM cumulative c
LEFT JOIN recent r USING (creative_id)
LEFT JOIN latest_meta m USING (creative_id)
LEFT JOIN last_spend ls USING (creative_id)
LEFT JOIN target_pack tp ON true
LEFT JOIN historical h USING (creative_id)
ORDER BY c.spend DESC, c.creative_id ASC
`;

const ACCOUNT_CALIBRATION_QUERY = `
WITH per_creative_raw AS (
  SELECT
    creative_id,
    SUM(spend) AS total_spend,
    SUM(conversions) AS total_purchases,
    SUM(revenue) AS total_revenue,
    MIN(first_spend_at) FILTER (WHERE first_spend_at IS NOT NULL) AS first_spend_at,
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
    END AS recent_7d_roas,
    first_spend_at
  FROM per_creative_raw
),
mature AS (
  SELECT *
  FROM per_creative
  WHERE total_spend >= 300
    AND total_purchases >= 3
    AND first_spend_at IS NOT NULL
    AND first_spend_at::date BETWEEN ($1::date - INTERVAL '89 days') AND $1::date
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
  (SELECT COUNT(*) FROM mature) AS mature_count,
  (SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY aggregate_roas) FROM mature WHERE aggregate_roas IS NOT NULL) AS roas_p75,
  (SELECT percentile_cont(0.60) WITHIN GROUP (ORDER BY aggregate_roas) FROM mature WHERE aggregate_roas IS NOT NULL) AS roas_p60,
  (SELECT percentile_cont(0.10) WITHIN GROUP (ORDER BY recent_total_ratio) FROM recent_ratios WHERE recent_total_ratio IS NOT NULL) AS refresh_ratio_p10,
  (SELECT COUNT(*) FROM recent_ratios WHERE recent_total_ratio IS NOT NULL) AS refresh_ratio_count,
  (SELECT percentile_cont(0.10) WITHIN GROUP (ORDER BY cumulative_28d_ctr) FROM per_creative WHERE cumulative_28d_ctr IS NOT NULL) AS low_ctr_p10,
  (SELECT COUNT(*) FROM per_creative WHERE cumulative_28d_ctr IS NOT NULL) AS ctr_count,
  source_bounds.source_min_date,
  source_bounds.source_max_date,
  source_bounds.source_max_updated_at
FROM source_bounds
`;

const SOURCE_MAX_UPDATED_AT_QUERY = `
SELECT MAX(updated_at) AS source_max_updated_at
FROM meta_creative_daily
WHERE business_ref_id = $1::uuid
  AND date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
`;

// Reads are engine_version-agnostic to avoid table invalidation on ENGINE_VERSION bumps.
// Writes preserve engine_version for provenance.
const READ_ACCOUNT_CALIBRATION_QUERY = `
SELECT
  business_ref_id,
  engine_version,
  mature_creative_count,
  roas_p75,
  roas_p60,
  refresh_ratio_p10,
  low_ctr_p10,
  computed_at,
  source_max_updated_at,
  source_max_date,
  as_of_date,
  quality_status
FROM engine_v3_account_calibration_daily
WHERE business_ref_id = $1::uuid
  AND scope_type = 'account'
  AND scope_id = '*'
  AND as_of_date <= $2::date
ORDER BY as_of_date DESC, computed_at DESC
LIMIT 1
`;

const READ_LIFECYCLE_CREATIVE_INPUTS_QUERY = `
WITH lifecycle_rows AS (
  SELECT DISTINCT ON (l.creative_id) l.*
  FROM engine_v3_creative_lifecycle_daily l
  WHERE l.business_ref_id = $1::uuid
    AND l.as_of_date <= $2::date
    AND (NOT $4::boolean OR l.creative_id = ANY($3::text[]))
  ORDER BY l.creative_id, l.as_of_date DESC, l.computed_at DESC
),
latest_meta AS (
  SELECT DISTINCT ON (d.creative_id)
    d.creative_id,
    d.creative_name,
    NULLIF(d.payload_json->>'policy_reason', '') AS policy_reason
  FROM meta_creative_daily d
  INNER JOIN lifecycle_rows l ON l.creative_id = d.creative_id
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
)
SELECT
  l.creative_id,
  latest_meta.creative_name,
  l.campaign_id,
  l.objective,
  l.spend_28d AS spend,
  l.purchases_28d AS purchases,
  l.purchase_value_28d AS purchase_value,
  l.impressions_28d AS impressions,
  l.link_clicks_28d AS link_clicks,
  l.roas_28d AS roas,
  l.cpa_28d AS cpa,
  l.ctr_28d AS ctr,
  l.frequency_28d AS frequency,
  l.spend_7d AS recent_spend,
  l.purchases_7d AS recent_purchases,
  l.roas_7d AS recent_roas,
  l.impressions_7d AS recent_impressions,
  l.effective_status,
  l.age_days,
  l.last_active_date,
  latest_meta.policy_reason,
  l.source_max_updated_at,
  CASE
    WHEN l.source_max_updated_at IS NOT NULL
    THEN FLOOR(EXTRACT(EPOCH FROM (now() - l.source_max_updated_at)) / 3600)
  END AS data_freshness_hours,
  l.fatigue_status,
  l.lifecycle_position,
  l.days_since_peak,
  l.peak_roas_30d,
  l.peak_confidence,
  l.spend_trajectory_30d,
  l.spend_slope_7d,
  l.spend_slope_30d,
  l.roas_slope_7d,
  l.roas_slope_30d,
  target_pack.target_roas,
  target_pack.break_even_roas
FROM lifecycle_rows l
LEFT JOIN latest_meta USING (creative_id)
LEFT JOIN target_pack ON true
ORDER BY l.spend_28d DESC NULLS LAST, l.creative_id ASC
`;

const READ_LIFECYCLE_HEALTH_QUERY = `
SELECT
  MAX(computed_at) AS computed_at,
  MAX(source_max_updated_at) AS source_max_updated_at,
  MAX(as_of_date) AS as_of_date,
  MAX(engine_version) AS engine_version,
  COUNT(*) AS row_count
FROM engine_v3_creative_lifecycle_daily
WHERE business_ref_id = $1::uuid
  AND as_of_date <= $2::date
`;

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

function toCampaignObjective(value: unknown): CampaignObjective | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return CAMPAIGN_OBJECTIVES.has(text as CampaignObjective)
    ? (text as CampaignObjective)
    : null;
}

function toEffectiveStatus(value: unknown): EffectiveStatus {
  const text = toStringOrNull(value)?.toUpperCase();
  if (text === undefined || text === null) return null;
  return EFFECTIVE_STATUSES.has(text as NonNullable<EffectiveStatus>)
    ? (text as NonNullable<EffectiveStatus>)
    : null;
}

function toFatigueStatus(value: unknown): CreativeInput["fatigueStatus"] {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return FATIGUE_STATUSES.has(text as NonNullable<CreativeInput["fatigueStatus"]>)
    ? (text as NonNullable<CreativeInput["fatigueStatus"]>)
    : null;
}

function toLifecyclePosition(value: unknown): LifecyclePosition | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return LIFECYCLE_POSITIONS.has(text as LifecyclePosition)
    ? (text as LifecyclePosition)
    : null;
}

function toSpendTrajectory(value: unknown): SpendTrajectory | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return SPEND_TRAJECTORIES.has(text as SpendTrajectory)
    ? (text as SpendTrajectory)
    : null;
}

function toHistoricalWindow(
  row: CreativeHydrationRow,
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

function calculateClickToPurchaseRate(input: {
  purchases: number;
  linkClicks: number | null;
}) {
  if (input.linkClicks === null || input.linkClicks <= 0) return null;
  return input.purchases / input.linkClicks;
}

function mapCreativeHydrationRow(input: {
  row: CreativeHydrationRow;
  businessId: string;
}): CreativeInput | null {
  const creativeId = toStringOrNull(input.row.creative_id);
  if (creativeId === null) return null;

  const spend = toNumberOrNull(input.row.spend) ?? 0;
  const purchases = toNumberOrNull(input.row.purchases) ?? 0;
  const linkClicks = toNumberOrNull(input.row.link_clicks);
  const ctr = toNumberOrNull(input.row.ctr);
  const roas = toNumberOrNull(input.row.roas);
  const frequency = toNumberOrNull(input.row.frequency);
  const fatigue = computeFatigue({
    ctr,
    roas,
    clickToPurchaseRate: calculateClickToPurchaseRate({
      purchases,
      linkClicks,
    }),
    historicalWindows: {
      last14: toHistoricalWindow(input.row, "last14"),
      last30: toHistoricalWindow(input.row, "last30"),
      last90: toHistoricalWindow(input.row, "last90"),
      allHistory: toHistoricalWindow(input.row, "all_history"),
    },
    spendConcentration: null,
    frequency,
    benchmarkRoasStatus: null,
    benchmarkClickToPurchaseStatus: null,
  });

  return {
    creativeId,
    creativeName: toStringOrNull(input.row.creative_name),
    businessId: input.businessId,
    campaignId: toStringOrNull(input.row.campaign_id),
    objective: toCampaignObjective(input.row.objective),
    spend,
    purchases,
    purchaseValue: toNumberOrNull(input.row.purchase_value),
    impressions: toNumberOrNull(input.row.impressions),
    linkClicks,
    roas,
    cpa: toNumberOrNull(input.row.cpa),
    ctr,
    frequency,
    recent7dSpend: toNumberOrNull(input.row.recent_spend),
    recent7dPurchases: toNumberOrNull(input.row.recent_purchases),
    recent7dRoas: toNumberOrNull(input.row.recent_roas),
    recent7dImpressions: toNumberOrNull(input.row.recent_impressions),
    effectiveStatus: toEffectiveStatus(input.row.effective_status),
    ageDays: toIntegerOrNull(input.row.age_days),
    lastSpendAt: toIsoDateOrNull(input.row.last_spend_date),
    policyReason: toStringOrNull(input.row.policy_reason),
    dataFreshnessHours: toIntegerOrNull(input.row.data_freshness_hours),
    fatigueStatus: fatigue.status,
    targetRoas: toNumberOrNull(input.row.target_roas),
    breakevenRoas: toNumberOrNull(input.row.break_even_roas),
    lifecyclePosition: null,
    daysSincePeak: null,
    peakRoas30d: null,
    peakConfidence: null,
    spendTrajectory30d: null,
    spendSlope7d: null,
    spendSlope30d: null,
    roasSlope7d: null,
    roasSlope30d: null,
  };
}

function mapLifecycleHydrationRow(input: {
  row: LifecycleTableHydrationRow;
  businessId: string;
}): CreativeInput | null {
  const creativeId = toStringOrNull(input.row.creative_id);
  if (creativeId === null) return null;

  const sourceMaxUpdatedAt = toIsoTimestampOrNull(
    input.row.source_max_updated_at,
  );
  if (
    sourceMaxUpdatedAt === null ||
    isOlderThanHours(sourceMaxUpdatedAt, STALE_TIER_WARNING_MAX_HOURS)
  ) {
    return null;
  }

  return {
    creativeId,
    creativeName: toStringOrNull(input.row.creative_name),
    businessId: input.businessId,
    campaignId: toStringOrNull(input.row.campaign_id),
    objective: toCampaignObjective(input.row.objective),
    spend: toNumberOrNull(input.row.spend) ?? 0,
    purchases: toNumberOrNull(input.row.purchases) ?? 0,
    purchaseValue: toNumberOrNull(input.row.purchase_value),
    impressions: toNumberOrNull(input.row.impressions),
    linkClicks: toNumberOrNull(input.row.link_clicks),
    roas: toNumberOrNull(input.row.roas),
    cpa: toNumberOrNull(input.row.cpa),
    ctr: toNumberOrNull(input.row.ctr),
    frequency: toNumberOrNull(input.row.frequency),
    recent7dSpend: toNumberOrNull(input.row.recent_spend),
    recent7dPurchases: toNumberOrNull(input.row.recent_purchases),
    recent7dRoas: toNumberOrNull(input.row.recent_roas),
    recent7dImpressions: toNumberOrNull(input.row.recent_impressions),
    effectiveStatus: toEffectiveStatus(input.row.effective_status),
    ageDays: toIntegerOrNull(input.row.age_days),
    lastSpendAt: toIsoDateOrNull(input.row.last_active_date),
    policyReason: toStringOrNull(input.row.policy_reason),
    dataFreshnessHours: toIntegerOrNull(input.row.data_freshness_hours),
    fatigueStatus: toFatigueStatus(input.row.fatigue_status),
    targetRoas: toNumberOrNull(input.row.target_roas),
    breakevenRoas: toNumberOrNull(input.row.break_even_roas),
    lifecyclePosition: toLifecyclePosition(input.row.lifecycle_position),
    daysSincePeak: toIntegerOrNull(input.row.days_since_peak),
    peakRoas30d: toNumberOrNull(input.row.peak_roas_30d),
    peakConfidence: toNumberOrNull(input.row.peak_confidence),
    spendTrajectory30d: toSpendTrajectory(input.row.spend_trajectory_30d),
    spendSlope7d: toNumberOrNull(input.row.spend_slope_7d),
    spendSlope30d: toNumberOrNull(input.row.spend_slope_30d),
    roasSlope7d: toNumberOrNull(input.row.roas_slope_7d),
    roasSlope30d: toNumberOrNull(input.row.roas_slope_30d),
  };
}

function gatePercentile(input: {
  value: number | null;
  count: number;
  minimumCount: number;
}) {
  return input.count >= input.minimumCount ? input.value : null;
}

function zeroAccountCalibration(
  businessId: string,
  computedAt: string,
): AccountCalibration {
  return {
    businessId,
    computedAt,
    matureCreativeCount: 0,
    roasP75: null,
    roasP60: null,
    refreshRatioP10: null,
    lowCtrP10: null,
  };
}

function isOlderThanHours(timestamp: string, hours: number) {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return true;
  return Date.now() - parsed > hours * 3_600_000;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildWarehouseDataLayerHealth(input: {
  asOfDate: string | null;
  computedAt: string | null;
  sourceMaxUpdatedAt: string | null;
  fallbackMode: FallbackMode;
  note?: string | null;
  staleTierOverride?: StaleTier;
}): DataLayerHealth {
  const health = buildDataLayerHealth(input);
  if (input.staleTierOverride) {
    return { ...health, staleTier: input.staleTierOverride };
  }
  if (input.sourceMaxUpdatedAt === null) {
    return {
      ...health,
      staleTier: "warning",
      note: input.note ?? "unknown source freshness for warehouse-backed layer",
    };
  }
  return health;
}

/**
 * Production warehouse implementation backed by meta_creative_daily and
 * business_target_packs. The engine still consumes the same CreativeInput
 * contract as MockDataSource.
 */
export class WarehouseDataSource implements CreativeDecisionDataSource {
  private lastCalibrationMetadata: CalibrationReadMetadata | null = null;

  private async computeCreativeInputsViaRuntimeSql(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]> {
    const creativeIds = input.creativeIds ?? [];
    if (input.creativeIds && input.creativeIds.length === 0) return [];

    const rows = await getDb().query<CreativeHydrationRow>(
      HYDRATE_CREATIVE_INPUTS_QUERY,
      [input.businessId, input.asOf, creativeIds, input.creativeIds != null],
    );

    return rows
      .map((row) =>
        mapCreativeHydrationRow({
          row,
          businessId: input.businessId,
        }),
      )
      .filter((creative): creative is CreativeInput => creative !== null);
  }

  private async readCreativeInputsFromLifecycleTable(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]> {
    const creativeIds = input.creativeIds ?? [];
    if (input.creativeIds && input.creativeIds.length === 0) return [];

    let rows: LifecycleTableHydrationRow[];
    try {
      rows = await getDb().query<LifecycleTableHydrationRow>(
        READ_LIFECYCLE_CREATIVE_INPUTS_QUERY,
        [input.businessId, input.asOf, creativeIds, input.creativeIds != null],
      );
    } catch {
      return [];
    }

    return rows
      .map((row) =>
        mapLifecycleHydrationRow({
          row,
          businessId: input.businessId,
        }),
      )
      .filter((creative): creative is CreativeInput => creative !== null);
  }

  async getCreativeInput(input: {
    creativeId: string;
    businessId: string;
    asOf: string;
  }): Promise<CreativeInput | null> {
    const fromTable = await this.readCreativeInputsFromLifecycleTable({
      businessId: input.businessId,
      asOf: input.asOf,
      creativeIds: [input.creativeId],
    });
    if (fromTable[0]) return fromTable[0];

    const results = await this.computeCreativeInputsViaRuntimeSql({
      businessId: input.businessId,
      asOf: input.asOf,
      creativeIds: [input.creativeId],
    });
    return results[0] ?? null;
  }

  async getAccountCalibration(input: {
    businessId: string;
    asOf: string;
  }): Promise<AccountCalibration> {
    const precomputed = await this.readCalibrationFromTable(
      input.businessId,
      input.asOf,
    );
    if (precomputed.calibration !== null) {
      this.lastCalibrationMetadata = precomputed.metadata;
      return precomputed.calibration;
    }

    return this.computeCalibrationViaRuntimeSql(
      input,
      precomputed.note,
      precomputed.staleTierOverride,
    );
  }

  private async computeCalibrationViaRuntimeSql(
    input: {
      businessId: string;
      asOf: string;
    },
    fallbackNote: string,
    staleTierOverride?: StaleTier,
  ): Promise<AccountCalibration> {
    const computedAt = new Date().toISOString();
    let row: CalibrationRow | undefined;
    try {
      [row] = await getDb().query<CalibrationRow>(ACCOUNT_CALIBRATION_QUERY, [
        input.asOf,
        input.businessId,
      ]);
    } catch (error) {
      const sourceMaxUpdatedAt = await this.fetchSourceMaxUpdatedAt(
        input.businessId,
        input.asOf,
      ).catch(() => null);
      this.lastCalibrationMetadata = {
        businessId: input.businessId,
        requestedAsOf: input.asOf,
        asOfDate: input.asOf,
        computedAt,
        sourceMaxUpdatedAt,
        fallbackMode: "insufficient",
        note: `Calibration unavailable; runtime SQL failed after precomputed fallback (${errorMessage(error)})`,
        staleTierOverride,
      };
      return zeroAccountCalibration(input.businessId, computedAt);
    }

    const matureCount = toIntegerOrNull(row?.mature_count) ?? 0;
    const refreshRatioCount = toIntegerOrNull(row?.refresh_ratio_count) ?? 0;
    const ctrCount = toIntegerOrNull(row?.ctr_count) ?? 0;
    const sourceMaxUpdatedAt = toIsoTimestampOrNull(
      row?.source_max_updated_at,
    );
    const sourceMaxDate = toIsoDateOrNull(row?.source_max_date);

    if (matureCount === 0) {
      this.lastCalibrationMetadata = {
        businessId: input.businessId,
        requestedAsOf: input.asOf,
        asOfDate: sourceMaxDate ?? input.asOf,
        computedAt,
        sourceMaxUpdatedAt,
        fallbackMode: "insufficient",
        note:
          fallbackNote === "no precomputed row available; runtime fallback in use"
            ? fallbackNote
            : "Insufficient calibration sample (matureCreativeCount=0)",
        staleTierOverride,
      };
      return zeroAccountCalibration(input.businessId, computedAt);
    }

    const calibration: AccountCalibration = {
      businessId: input.businessId,
      computedAt,
      matureCreativeCount: matureCount,
      roasP75: gatePercentile({
        value: toNumberOrNull(row?.roas_p75),
        count: matureCount,
        minimumCount: 30,
      }),
      roasP60: gatePercentile({
        value: toNumberOrNull(row?.roas_p60),
        count: matureCount,
        minimumCount: 10,
      }),
      refreshRatioP10: gatePercentile({
        value: toNumberOrNull(row?.refresh_ratio_p10),
        count: refreshRatioCount,
        minimumCount: 20,
      }),
      lowCtrP10: gatePercentile({
        value: toNumberOrNull(row?.low_ctr_p10),
        count: ctrCount,
        minimumCount: 20,
      }),
    };
    this.lastCalibrationMetadata = {
      businessId: input.businessId,
      requestedAsOf: input.asOf,
      asOfDate: sourceMaxDate ?? input.asOf,
      computedAt,
      sourceMaxUpdatedAt,
      fallbackMode: "runtime_sql",
      note: fallbackNote,
      staleTierOverride,
    };
    return calibration;
  }

  private async readCalibrationFromTable(
    businessId: string,
    asOf: string,
  ): Promise<{
    calibration: AccountCalibration | null;
    metadata: CalibrationReadMetadata | null;
    note: string;
    staleTierOverride?: StaleTier;
  }> {
    let row: CalibrationTableRow | undefined;
    try {
      [row] = await getDb().query<CalibrationTableRow>(
        READ_ACCOUNT_CALIBRATION_QUERY,
        [businessId, asOf],
      );
    } catch (error) {
      return {
        calibration: null,
        metadata: null,
        note: `Runtime SQL fallback (precomputed calibration lookup failed for asOf ${asOf}: ${errorMessage(error)})`,
      };
    }

    if (!row) {
      return {
        calibration: null,
        metadata: null,
        note: "no precomputed row available; runtime fallback in use",
        staleTierOverride: "warning",
      };
    }

    const sourceMaxUpdatedAt = toIsoTimestampOrNull(
      row.source_max_updated_at,
    );
    const computedAt = toIsoTimestampOrNull(row.computed_at);
    const asOfDate = toIsoDateOrNull(row.as_of_date) ?? asOf;
    const engineVersion = toStringOrNull(row.engine_version) ?? "unknown";
    if (sourceMaxUpdatedAt === null) {
      return {
        calibration: null,
        metadata: {
          businessId,
          requestedAsOf: asOf,
          asOfDate,
          computedAt,
          sourceMaxUpdatedAt,
          fallbackMode: "runtime_sql",
          note: "unknown source freshness for warehouse-backed layer",
          staleTierOverride: "warning",
        },
        note: "unknown source freshness for warehouse-backed layer",
        staleTierOverride: "warning",
      };
    }

    if (isOlderThanHours(sourceMaxUpdatedAt, STALE_TIER_WARNING_MAX_HOURS)) {
      return {
        calibration: null,
        metadata: null,
        note: `Runtime SQL fallback (precomputed calibration stale for asOf ${asOf})`,
      };
    }

    const metadata: CalibrationReadMetadata = {
      businessId,
      requestedAsOf: asOf,
      asOfDate,
      computedAt,
      sourceMaxUpdatedAt,
      fallbackMode: "precomputed",
      note: `computed by engine ${engineVersion}`,
    };

    return {
      calibration: {
        businessId: toStringOrNull(row.business_ref_id) ?? businessId,
        computedAt: computedAt ?? new Date().toISOString(),
        matureCreativeCount:
          toIntegerOrNull(row.mature_creative_count) ?? 0,
        roasP75: toNumberOrNull(row.roas_p75),
        roasP60: toNumberOrNull(row.roas_p60),
        refreshRatioP10: toNumberOrNull(row.refresh_ratio_p10),
        lowCtrP10: toNumberOrNull(row.low_ctr_p10),
      },
      metadata,
      note: "",
    };
  }

  async listCreativeInputs(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]> {
    const fromTable = await this.readCreativeInputsFromLifecycleTable(input);
    if (fromTable.length > 0) return fromTable;

    return this.computeCreativeInputsViaRuntimeSql(input);
  }

  async getDataHealth(input: {
    businessId: string;
    asOf: string;
  }): Promise<DataHealth> {
    const calibration = await this.buildCalibrationDataLayerHealth(
      input.businessId,
      input.asOf,
    );
    const lifecycle = await this.buildLifecycleDataLayerHealth(
      input.businessId,
      input.asOf,
    );
    const sourceMaxUpdatedAt = await this.fetchSourceMaxUpdatedAt(
      input.businessId,
      input.asOf,
    );
    const decisions = buildDataLayerHealth({
      asOfDate: input.asOf,
      computedAt: new Date().toISOString(),
      sourceMaxUpdatedAt,
      fallbackMode: "runtime_sql",
      note: "Decision snapshots are not populated until Phase 3.5; runtime decisions are computed on request",
    });

    return composeDataHealth({
      calibration,
      lifecycle,
      decisions,
    });
  }

  private async buildCalibrationDataLayerHealth(
    businessId: string,
    asOf: string,
  ): Promise<DataLayerHealth> {
    const last = this.lastCalibrationMetadata;
    if (last?.businessId === businessId && last.requestedAsOf === asOf) {
      return buildWarehouseDataLayerHealth({
        asOfDate: last.asOfDate,
        computedAt: last.computedAt,
        sourceMaxUpdatedAt: last.sourceMaxUpdatedAt,
        fallbackMode: last.fallbackMode,
        note: last.note,
        staleTierOverride: last.staleTierOverride,
      });
    }

    const precomputed = await this.readCalibrationFromTable(businessId, asOf);
    if (precomputed.metadata !== null) {
      return buildWarehouseDataLayerHealth({
        asOfDate: precomputed.metadata.asOfDate,
        computedAt: precomputed.metadata.computedAt,
        sourceMaxUpdatedAt: precomputed.metadata.sourceMaxUpdatedAt,
        fallbackMode: precomputed.metadata.fallbackMode,
        note: precomputed.metadata.note,
        staleTierOverride: precomputed.metadata.staleTierOverride,
      });
    }

    const sourceMaxUpdatedAt = await this.fetchSourceMaxUpdatedAt(
      businessId,
      asOf,
    );
    const fallbackMode: FallbackMode =
      sourceMaxUpdatedAt === null ? "insufficient" : "runtime_sql";

    return buildWarehouseDataLayerHealth({
      asOfDate: asOf,
      computedAt: new Date().toISOString(),
      sourceMaxUpdatedAt,
      fallbackMode,
      note: precomputed.note,
      staleTierOverride: precomputed.staleTierOverride,
    });
  }

  private async buildLifecycleDataLayerHealth(
    businessId: string,
    asOf: string,
  ): Promise<DataLayerHealth> {
    let row: LifecycleHealthRow | undefined;
    try {
      [row] = await getDb().query<LifecycleHealthRow>(
        READ_LIFECYCLE_HEALTH_QUERY,
        [businessId, asOf],
      );
    } catch (error) {
      return buildWarehouseDataLayerHealth({
        asOfDate: asOf,
        computedAt: new Date().toISOString(),
        sourceMaxUpdatedAt: null,
        fallbackMode: "runtime_sql",
        note: `Lifecycle unavailable; runtime SQL fallback (${errorMessage(error)})`,
      });
    }

    const rowCount = toIntegerOrNull(row?.row_count) ?? 0;
    if (rowCount === 0) {
      return buildWarehouseDataLayerHealth({
        asOfDate: asOf,
        computedAt: new Date().toISOString(),
        sourceMaxUpdatedAt: null,
        fallbackMode: "runtime_sql",
        note: "no precomputed row available; runtime fallback in use",
        staleTierOverride: "warning",
      });
    }

    return buildWarehouseDataLayerHealth({
      asOfDate: toIsoDateOrNull(row?.as_of_date) ?? asOf,
      computedAt: toIsoTimestampOrNull(row?.computed_at),
      sourceMaxUpdatedAt: toIsoTimestampOrNull(row?.source_max_updated_at),
      fallbackMode: "precomputed",
      note: null,
    });
  }

  private async fetchSourceMaxUpdatedAt(
    businessId: string,
    asOf: string,
  ): Promise<string | null> {
    const [row] = await getDb().query<SourceMaxUpdatedAtRow>(
      SOURCE_MAX_UPDATED_AT_QUERY,
      [businessId, asOf],
    );

    return toIsoTimestampOrNull(row?.source_max_updated_at);
  }
}
