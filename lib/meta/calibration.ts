import { getDb, runDbTransaction } from "@/lib/db";
import {
  resolveMetaFunnelCohort,
  type MetaFunnelCohort,
} from "@/lib/meta/funnel-cohort";

export const MIN_CAMPAIGN_CALIBRATION_SAMPLE = 8;
export const MIN_ACCOUNT_CALIBRATION_SAMPLE = 1;

export const META_CALIBRATION_METRICS = [
  "roas_28d",
  "cpa_28d",
  "freq_14d",
  "cpm_14d",
  "ctr_28d",
  "win_rate_28d",
  "cost_per_atc_28d",
  "cost_per_ic_28d",
  "cost_per_vc_28d",
  "atc_rate_28d",
  "atc_to_purchase_rate_28d",
  "cost_per_thruplay_28d",
  "thruplay_rate_28d",
  "cost_per_lead_28d",
  "lead_to_purchase_rate_28d",
  "cost_per_link_click_28d",
  "cost_per_lpv_28d",
  "cost_per_engagement_28d",
  "engagement_rate_28d",
] as const;

export type MetaCalibrationMetricName = (typeof META_CALIBRATION_METRICS)[number];
export type MetaCalibrationScopeType = "account" | "campaign";
export type MetaCalibrationFallbackReason =
  | "campaign_calibration_missing"
  | "campaign_sample_below_threshold"
  | "account_calibration_missing";

export interface MetaMetricPercentiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  sampleSize: number;
}

export type MetaMetricThresholdMap = Record<MetaCalibrationMetricName, MetaMetricPercentiles>;

export interface MetaCalibrationThresholds {
  metrics: MetaMetricThresholdMap;
  hardCutSpend: number;
  minRequiredSample: number;
  source: "calibrated" | "legacy_fallback";
  fallbackReason?: MetaCalibrationFallbackReason;
}

export interface MetaCalibrationScopeResult {
  thresholds: MetaCalibrationThresholds;
  scope: {
    type: MetaCalibrationScopeType;
    id: string;
    snapshotDate: string | null;
    cohort?: MetaFunnelCohort;
  };
  reason?: MetaCalibrationFallbackReason;
}

export interface RunMetaCalibrationResult {
  businessId: string;
  snapshotDate: string;
  rowsWritten: number;
  accountScopes: number;
  campaignScopes: number;
  sampleRowsTotal: number;
  sampleRowsByCohort: Record<MetaFunnelCohort, number>;
  sampleRowsAfterCohortFilter?: number;
}

interface AggregatedAdsetMetricRow {
  account_id: string;
  campaign_id: string | null;
  adset_id: string;
  optimization_goal: string | null;
  custom_event_type: string | null;
  spend_28d: unknown;
  revenue_28d: unknown;
  conversions_28d: unknown;
  impressions_28d: unknown;
  clicks_28d: unknown;
  link_clicks_28d: unknown;
  add_to_cart_28d: unknown;
  initiate_checkout_28d: unknown;
  view_content_28d: unknown;
  landing_page_views_28d: unknown;
  thruplay_actions_28d: unknown;
  post_engagement_28d: unknown;
  leads_28d: unknown;
  spend_14d: unknown;
  impressions_14d: unknown;
  reach_14d: unknown;
}

interface ComputedMetricSample {
  accountId: string;
  campaignId: string | null;
  adsetId: string;
  cohort: MetaFunnelCohort;
  mature: boolean;
  values: Partial<Record<MetaCalibrationMetricName, number>>;
}

interface CalibrationPayloadRow {
  business_id: string;
  scope_type: MetaCalibrationScopeType;
  scope_id: string;
  snapshot_date: string;
  metric_name: MetaCalibrationMetricName;
  cohort: MetaFunnelCohort;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  sample_size: number;
}

type CalibrationDbRow = {
  scope_type: MetaCalibrationScopeType;
  scope_id: string;
  snapshot_date: string;
  metric_name: MetaCalibrationMetricName;
  cohort: MetaFunnelCohort;
  p10: unknown;
  p25: unknown;
  p50: unknown;
  p75: unknown;
  p90: unknown;
  sample_size: unknown;
};

const LEGACY_METRIC_THRESHOLDS: MetaMetricThresholdMap = {
  roas_28d: { p10: 1.2, p25: 1.6, p50: 2.1, p75: 3, p90: 4, sampleSize: 0 },
  cpa_28d: { p10: 30, p25: 50, p50: 80, p75: 120, p90: 180, sampleSize: 0 },
  freq_14d: { p10: 1.1, p25: 1.4, p50: 2, p75: 3, p90: 4.5, sampleSize: 0 },
  cpm_14d: { p10: 5, p25: 10, p50: 20, p75: 35, p90: 60, sampleSize: 0 },
  ctr_28d: { p10: 0.5, p25: 0.8, p50: 1.2, p75: 2, p90: 3, sampleSize: 0 },
  win_rate_28d: { p10: 0.15, p25: 0.4, p50: 0.8, p75: 1.5, p90: 3, sampleSize: 0 },
  cost_per_atc_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  cost_per_ic_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  cost_per_vc_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  atc_rate_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  atc_to_purchase_rate_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  cost_per_thruplay_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  thruplay_rate_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  cost_per_lead_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  lead_to_purchase_rate_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  cost_per_link_click_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  cost_per_lpv_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  cost_per_engagement_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
  engagement_rate_28d: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, sampleSize: 0 },
};

const CALIBRATION_METRICS_BY_COHORT: Record<
  Exclude<MetaFunnelCohort, "unknown">,
  readonly MetaCalibrationMetricName[]
> = {
  purchase: ["roas_28d", "cpa_28d", "ctr_28d", "cpm_14d", "freq_14d", "win_rate_28d"],
  mid_funnel: [
    "cost_per_atc_28d",
    "cost_per_ic_28d",
    "cost_per_vc_28d",
    "atc_rate_28d",
    "atc_to_purchase_rate_28d",
    "ctr_28d",
    "cpm_14d",
    "freq_14d",
  ],
  upper_funnel: ["cost_per_thruplay_28d", "thruplay_rate_28d", "cpm_14d", "freq_14d"],
  lead: ["cost_per_lead_28d", "lead_to_purchase_rate_28d", "ctr_28d", "cpm_14d"],
  traffic: ["cost_per_link_click_28d", "cost_per_lpv_28d", "ctr_28d", "cpm_14d"],
  engagement: ["cost_per_engagement_28d", "engagement_rate_28d", "cpm_14d"],
};

const ZERO_INCLUSIVE_METRICS = new Set<MetaCalibrationMetricName>([
  "atc_rate_28d",
  "atc_to_purchase_rate_28d",
  "thruplay_rate_28d",
  "lead_to_purchase_rate_28d",
  "engagement_rate_28d",
]);

export const LEGACY_META_CALIBRATION_THRESHOLDS: MetaCalibrationThresholds = {
  metrics: LEGACY_METRIC_THRESHOLDS,
  hardCutSpend: 500,
  minRequiredSample: MIN_CAMPAIGN_CALIBRATION_SAMPLE,
  source: "legacy_fallback",
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value: string | Date | null | undefined) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return todayIso();
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function computeMetaPercentiles(values: number[]): MetaMetricPercentiles | null {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;

  const percentile = (p: number) => {
    if (sorted.length === 1) return sorted[0]!;
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    const low = sorted[lower]!;
    const high = sorted[upper]!;
    return low + (high - low) * weight;
  };

  return {
    p10: rounded(percentile(0.1)),
    p25: rounded(percentile(0.25)),
    p50: rounded(percentile(0.5)),
    p75: rounded(percentile(0.75)),
    p90: rounded(percentile(0.9)),
    sampleSize: sorted.length,
  };
}

function cloneLegacyThresholds(reason?: MetaCalibrationFallbackReason): MetaCalibrationThresholds {
  return {
    metrics: Object.fromEntries(
      META_CALIBRATION_METRICS.map((metric) => [
        metric,
        { ...LEGACY_METRIC_THRESHOLDS[metric] },
      ]),
    ) as MetaMetricThresholdMap,
    hardCutSpend: LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend,
    minRequiredSample: MIN_CAMPAIGN_CALIBRATION_SAMPLE,
    source: "legacy_fallback",
    ...(reason ? { fallbackReason: reason } : {}),
  };
}

function buildThresholdsFromRows(
  rows: CalibrationDbRow[],
  fallbackReason?: MetaCalibrationFallbackReason,
): MetaCalibrationThresholds {
  const metrics = Object.fromEntries(
    META_CALIBRATION_METRICS.map((metric) => [
      metric,
      { ...LEGACY_METRIC_THRESHOLDS[metric] },
    ]),
  ) as MetaMetricThresholdMap;

  for (const row of rows) {
    if (!META_CALIBRATION_METRICS.includes(row.metric_name)) continue;
    metrics[row.metric_name] = {
      p10: toNumber(row.p10),
      p25: toNumber(row.p25),
      p50: toNumber(row.p50),
      p75: toNumber(row.p75),
      p90: toNumber(row.p90),
      sampleSize: Math.max(0, Math.round(toNumber(row.sample_size))),
    };
  }

  const calibratedSampleSize = Math.max(
    ...META_CALIBRATION_METRICS.map((metric) => metrics[metric].sampleSize),
  );
  const cpaP75 = metrics.cpa_28d.p75;
  return {
    metrics,
    hardCutSpend: Math.max(LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend, cpaP75 * 3),
    minRequiredSample: MIN_CAMPAIGN_CALIBRATION_SAMPLE,
    source: calibratedSampleSize > 0 ? "calibrated" : "legacy_fallback",
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function metricValuesForSample(row: AggregatedAdsetMetricRow): ComputedMetricSample {
  const spend28 = toNumber(row.spend_28d);
  const revenue28 = toNumber(row.revenue_28d);
  const conversions28 = toNumber(row.conversions_28d);
  const impressions28 = toNumber(row.impressions_28d);
  const clicks28 = toNumber(row.clicks_28d);
  const linkClicks28 = toNumber(row.link_clicks_28d);
  const addToCart28 = toNumber(row.add_to_cart_28d);
  const initiateCheckout28 = toNumber(row.initiate_checkout_28d);
  const viewContent28 = toNumber(row.view_content_28d);
  const landingPageViews28 = toNumber(row.landing_page_views_28d);
  const thruplayActions28 = toNumber(row.thruplay_actions_28d);
  const postEngagement28 = toNumber(row.post_engagement_28d);
  const leads28 = toNumber(row.leads_28d);
  const spend14 = toNumber(row.spend_14d);
  const impressions14 = toNumber(row.impressions_14d);
  const reach14 = toNumber(row.reach_14d);
  const cohort = resolveMetaFunnelCohort({
    optimizationGoal: row.optimization_goal,
    customEventType: row.custom_event_type,
  });

  return {
    accountId: row.account_id,
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    cohort,
    mature: spend28 > 0 && impressions28 > 0,
    values: {
      roas_28d: spend28 > 0 ? revenue28 / spend28 : undefined,
      cpa_28d: conversions28 > 0 ? spend28 / conversions28 : undefined,
      freq_14d: reach14 > 0 ? impressions14 / reach14 : undefined,
      cpm_14d: impressions14 > 0 ? (spend14 / impressions14) * 1000 : undefined,
      ctr_28d: impressions28 > 0 ? (clicks28 / impressions28) * 100 : undefined,
      win_rate_28d: clicks28 > 0 ? (conversions28 / clicks28) * 100 : undefined,
      cost_per_atc_28d: addToCart28 > 0 ? spend28 / addToCart28 : undefined,
      cost_per_ic_28d: initiateCheckout28 > 0 ? spend28 / initiateCheckout28 : undefined,
      cost_per_vc_28d: viewContent28 > 0 ? spend28 / viewContent28 : undefined,
      atc_rate_28d: impressions28 > 0 ? (addToCart28 / impressions28) * 100 : undefined,
      atc_to_purchase_rate_28d: addToCart28 > 0 ? (conversions28 / addToCart28) * 100 : undefined,
      cost_per_thruplay_28d: thruplayActions28 > 0 ? spend28 / thruplayActions28 : undefined,
      thruplay_rate_28d: impressions28 > 0 ? (thruplayActions28 / impressions28) * 100 : undefined,
      cost_per_lead_28d: leads28 > 0 ? spend28 / leads28 : undefined,
      lead_to_purchase_rate_28d: leads28 > 0 ? (conversions28 / leads28) * 100 : undefined,
      cost_per_link_click_28d: linkClicks28 > 0 ? spend28 / linkClicks28 : undefined,
      cost_per_lpv_28d: landingPageViews28 > 0 ? spend28 / landingPageViews28 : undefined,
      cost_per_engagement_28d: postEngagement28 > 0 ? spend28 / postEngagement28 : undefined,
      engagement_rate_28d: impressions28 > 0 ? (postEngagement28 / impressions28) * 100 : undefined,
    },
  };
}

function mergeMetricRowsByAdset(rows: AggregatedAdsetMetricRow[]): AggregatedAdsetMetricRow[] {
  const merged = new Map<string, AggregatedAdsetMetricRow>();
  const numericFields = [
    "spend_28d",
    "revenue_28d",
    "conversions_28d",
    "impressions_28d",
    "clicks_28d",
    "link_clicks_28d",
    "add_to_cart_28d",
    "initiate_checkout_28d",
    "view_content_28d",
    "landing_page_views_28d",
    "thruplay_actions_28d",
    "post_engagement_28d",
    "leads_28d",
    "spend_14d",
    "impressions_14d",
    "reach_14d",
  ] as const;

  for (const row of rows) {
    const key = `${row.account_id}\u0000${row.campaign_id ?? ""}\u0000${row.adset_id}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }

    for (const field of numericFields) {
      existing[field] = toNumber(existing[field]) + toNumber(row[field]);
    }
  }

  return [...merged.values()];
}

function pushMetricRows(input: {
  payload: CalibrationPayloadRow[];
  businessId: string;
  snapshotDate: string;
  scopeType: MetaCalibrationScopeType;
  scopeId: string;
  cohort: Exclude<MetaFunnelCohort, "unknown">;
  samples: ComputedMetricSample[];
  sampleThreshold: number;
}) {
  if (input.samples.length < input.sampleThreshold) return;

  for (const metricName of CALIBRATION_METRICS_BY_COHORT[input.cohort]) {
    const keepValue = ZERO_INCLUSIVE_METRICS.has(metricName)
      ? isNonNegativeFinite
      : isPositiveFinite;
    const values = input.samples
      .map((sample) => sample.values[metricName])
      .filter(keepValue);
    if (values.length < input.sampleThreshold) continue;

    const percentiles = computeMetaPercentiles(values);
    if (!percentiles) continue;
    input.payload.push({
      business_id: input.businessId,
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      snapshot_date: input.snapshotDate,
      metric_name: metricName,
      cohort: input.cohort,
      p10: percentiles.p10,
      p25: percentiles.p25,
      p50: percentiles.p50,
      p75: percentiles.p75,
      p90: percentiles.p90,
      sample_size: percentiles.sampleSize,
    });
  }
}

async function readAggregatedAdsetMetricRows(
  businessId: string,
  snapshotDate: string,
): Promise<AggregatedAdsetMetricRow[]> {
  const sql = getDb();
  return (await sql`
    WITH ad_event_daily AS (
      SELECT
        business_id,
        provider_account_id,
        date,
        adset_id,
        SUM(link_clicks) AS link_clicks,
        SUM(COALESCE((NULLIF(payload_json->>'add_to_cart', ''))::numeric, 0)) AS add_to_cart,
        SUM(COALESCE((NULLIF(payload_json->>'initiate_checkout', ''))::numeric, 0)) AS initiate_checkout,
        SUM(COALESCE((NULLIF(payload_json->>'view_content', ''))::numeric, 0)) AS view_content,
        SUM(COALESCE((NULLIF(payload_json->>'landing_page_views', ''))::numeric, 0)) AS landing_page_views,
        SUM(COALESCE((NULLIF(payload_json->>'thruplay_actions', ''))::numeric, 0)) AS thruplay_actions,
        SUM(COALESCE((NULLIF(payload_json->>'post_engagement', ''))::numeric, 0)) AS post_engagement,
        SUM(COALESCE((NULLIF(payload_json->>'leads', ''))::numeric, 0)) AS leads
      FROM meta_ad_daily
      WHERE business_id = ${businessId}
        AND date BETWEEN (${snapshotDate}::date - INTERVAL '27 days') AND ${snapshotDate}::date
        AND COALESCE(truth_state, 'finalized') IN ('finalized', 'finalized_verified')
        AND adset_id IS NOT NULL
      GROUP BY business_id, provider_account_id, date, adset_id
    )
    SELECT
      adset.provider_account_id AS account_id,
      adset.campaign_id,
      adset.adset_id,
      adset.optimization_goal,
      adset.custom_event_type,
      SUM(adset.spend) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS spend_28d,
      SUM(adset.revenue) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS revenue_28d,
      SUM(adset.conversions) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS conversions_28d,
      SUM(adset.impressions) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS impressions_28d,
      SUM(adset.clicks) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS clicks_28d,
      SUM(ad_events.link_clicks) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS link_clicks_28d,
      SUM(ad_events.add_to_cart) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS add_to_cart_28d,
      SUM(ad_events.initiate_checkout) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS initiate_checkout_28d,
      SUM(ad_events.view_content) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS view_content_28d,
      SUM(ad_events.landing_page_views) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS landing_page_views_28d,
      SUM(ad_events.thruplay_actions) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS thruplay_actions_28d,
      SUM(ad_events.post_engagement) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS post_engagement_28d,
      SUM(ad_events.leads) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '27 days')) AS leads_28d,
      SUM(adset.spend) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '13 days')) AS spend_14d,
      SUM(adset.impressions) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '13 days')) AS impressions_14d,
      SUM(adset.reach) FILTER (WHERE adset.date >= (${snapshotDate}::date - INTERVAL '13 days')) AS reach_14d
    FROM meta_adset_daily adset
    LEFT JOIN ad_event_daily ad_events
      ON ad_events.business_id = adset.business_id
      AND ad_events.provider_account_id = adset.provider_account_id
      AND ad_events.date = adset.date
      AND ad_events.adset_id = adset.adset_id
    WHERE adset.business_id = ${businessId}
      AND adset.date BETWEEN (${snapshotDate}::date - INTERVAL '27 days') AND ${snapshotDate}::date
      AND COALESCE(adset.truth_state, 'finalized') IN ('finalized', 'finalized_verified')
    GROUP BY adset.provider_account_id, adset.campaign_id, adset.adset_id, adset.optimization_goal, adset.custom_event_type
  `) as AggregatedAdsetMetricRow[];
}

async function upsertCalibrationPayload(payload: CalibrationPayloadRow[], businessId: string, snapshotDate: string) {
  const sql = getDb();
  await sql`
    DELETE FROM meta_decision_calibration_daily
    WHERE business_id = ${businessId}
      AND snapshot_date = ${snapshotDate}::date
  `;
  if (payload.length === 0) return;

  await sql.query(
    `
      WITH payload AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS row(
          business_id text,
          scope_type text,
          scope_id text,
          snapshot_date date,
          metric_name text,
          cohort text,
          p10 numeric,
          p25 numeric,
          p50 numeric,
          p75 numeric,
          p90 numeric,
          sample_size integer
        )
      )
      INSERT INTO meta_decision_calibration_daily (
        business_id,
        scope_type,
        scope_id,
        snapshot_date,
        metric_name,
        cohort,
        p10,
        p25,
        p50,
        p75,
        p90,
        sample_size
      )
      SELECT
        business_id,
        scope_type,
        scope_id,
        snapshot_date,
        metric_name,
        cohort,
        p10,
        p25,
        p50,
        p75,
        p90,
        sample_size
      FROM payload
      ON CONFLICT (business_id, scope_type, scope_id, snapshot_date, metric_name, cohort)
      DO UPDATE SET
        p10 = EXCLUDED.p10,
        p25 = EXCLUDED.p25,
        p50 = EXCLUDED.p50,
        p75 = EXCLUDED.p75,
        p90 = EXCLUDED.p90,
        sample_size = EXCLUDED.sample_size
    `,
    [JSON.stringify(payload)],
  );
}

function emptyCohortCounts(): Record<MetaFunnelCohort, number> {
  return {
    purchase: 0,
    mid_funnel: 0,
    lead: 0,
    traffic: 0,
    upper_funnel: 0,
    engagement: 0,
    unknown: 0,
  };
}

function writableCohort(cohort: MetaFunnelCohort): cohort is Exclude<MetaFunnelCohort, "unknown"> {
  return cohort !== "unknown";
}

function sampleThresholdForScope(input: {
  cohort: Exclude<MetaFunnelCohort, "unknown">;
  scopeType: MetaCalibrationScopeType;
}) {
  if (input.cohort === "purchase" && input.scopeType === "account") {
    return MIN_ACCOUNT_CALIBRATION_SAMPLE;
  }
  return MIN_CAMPAIGN_CALIBRATION_SAMPLE;
}

export async function runMetaCalibrationForBusiness(
  businessId: string,
  snapshotDate: string,
): Promise<RunMetaCalibrationResult> {
  const normalizedSnapshotDate = normalizeDate(snapshotDate);
  const rawRows = await readAggregatedAdsetMetricRows(businessId, normalizedSnapshotDate);
  const payload: CalibrationPayloadRow[] = [];
  const sampleRowsByCohort = emptyCohortCounts();

  const rawRowsByCohort = new Map<MetaFunnelCohort, AggregatedAdsetMetricRow[]>();
  for (const row of rawRows) {
    const cohort = resolveMetaFunnelCohort({
      optimizationGoal: row.optimization_goal,
      customEventType: row.custom_event_type,
    });
    const list = rawRowsByCohort.get(cohort);
    if (list) list.push(row);
    else rawRowsByCohort.set(cohort, [row]);
  }

  for (const [cohort, cohortRows] of rawRowsByCohort.entries()) {
    const rows = mergeMetricRowsByAdset(cohortRows);
    sampleRowsByCohort[cohort] = rows.length;
    if (!writableCohort(cohort)) continue;

    const samples = rows.map(metricValuesForSample);
    const accountGroups = new Map<string, ComputedMetricSample[]>();
    for (const sample of samples) {
      const list = accountGroups.get(sample.accountId);
      if (list) list.push(sample);
      else accountGroups.set(sample.accountId, [sample]);
    }

    for (const [accountId, groupSamples] of accountGroups.entries()) {
      const matureSamples = groupSamples.filter((sample) => sample.mature);
      pushMetricRows({
        payload,
        businessId,
        snapshotDate: normalizedSnapshotDate,
        scopeType: "account",
        scopeId: accountId,
        cohort,
        samples: matureSamples,
        sampleThreshold: sampleThresholdForScope({ cohort, scopeType: "account" }),
      });
    }

    const campaignGroups = new Map<string, ComputedMetricSample[]>();
    for (const sample of samples) {
      if (!sample.campaignId) continue;
      const key = `${sample.accountId}\u0000${sample.campaignId}`;
      const list = campaignGroups.get(key);
      if (list) list.push(sample);
      else campaignGroups.set(key, [sample]);
    }

    for (const groupSamples of campaignGroups.values()) {
      const matureSamples = groupSamples.filter((sample) => sample.mature);
      const campaignId = matureSamples[0]?.campaignId;
      if (!campaignId) continue;
      pushMetricRows({
        payload,
        businessId,
        snapshotDate: normalizedSnapshotDate,
        scopeType: "campaign",
        scopeId: campaignId,
        cohort,
        samples: matureSamples,
        sampleThreshold: sampleThresholdForScope({ cohort, scopeType: "campaign" }),
      });
    }
  }

  await runDbTransaction(async () => {
    await upsertCalibrationPayload(payload, businessId, normalizedSnapshotDate);
  });

  return {
    businessId,
    snapshotDate: normalizedSnapshotDate,
    rowsWritten: payload.length,
    accountScopes: new Set(payload.filter((row) => row.scope_type === "account").map((row) => row.scope_id)).size,
    campaignScopes: new Set(payload.filter((row) => row.scope_type === "campaign").map((row) => row.scope_id)).size,
    sampleRowsTotal: rawRows.length,
    sampleRowsByCohort,
    sampleRowsAfterCohortFilter: sampleRowsByCohort.purchase,
  };
}

async function readCalibrationRows(input: {
  businessId: string;
  scopeType: MetaCalibrationScopeType;
  scopeId: string;
  cohort?: MetaFunnelCohort | null;
  snapshotDate?: string | null;
}): Promise<CalibrationDbRow[]> {
  const sql = getDb();
  const snapshotDate = input.snapshotDate ? normalizeDate(input.snapshotDate) : todayIso();
  const cohort = input.cohort ?? "purchase";
  return (await sql`
    WITH latest AS (
      SELECT MAX(snapshot_date) AS snapshot_date
      FROM meta_decision_calibration_daily
      WHERE business_id = ${input.businessId}
        AND scope_type = ${input.scopeType}
        AND scope_id = ${input.scopeId}
        AND cohort = ${cohort}
        AND snapshot_date <= ${snapshotDate}::date
    )
    SELECT
      scope_type,
      scope_id,
      snapshot_date::text AS snapshot_date,
      metric_name,
      cohort,
      p10,
      p25,
      p50,
      p75,
      p90,
      sample_size
    FROM meta_decision_calibration_daily
    WHERE business_id = ${input.businessId}
      AND scope_type = ${input.scopeType}
      AND scope_id = ${input.scopeId}
      AND cohort = ${cohort}
      AND snapshot_date = (SELECT snapshot_date FROM latest)
  `) as CalibrationDbRow[];
}

async function readCampaignMatureAdsetCount(input: {
  businessId: string;
  campaignId: string;
  cohort?: MetaFunnelCohort | null;
  snapshotDate?: string | null;
}) {
  const sql = getDb();
  const snapshotDate = input.snapshotDate ? normalizeDate(input.snapshotDate) : todayIso();
  const rows = (await sql`
    WITH adset_samples AS (
      SELECT
        adset_id,
        optimization_goal,
        custom_event_type,
        SUM(spend) AS spend_28d,
        SUM(impressions) AS impressions_28d
      FROM meta_adset_daily
      WHERE business_id = ${input.businessId}
        AND campaign_id = ${input.campaignId}
        AND date BETWEEN (${snapshotDate}::date - INTERVAL '27 days') AND ${snapshotDate}::date
        AND COALESCE(truth_state, 'finalized') IN ('finalized', 'finalized_verified')
      GROUP BY adset_id, optimization_goal, custom_event_type
    )
    SELECT
      adset_id,
      optimization_goal,
      custom_event_type,
      spend_28d,
      impressions_28d
    FROM adset_samples
    WHERE spend_28d > 0 AND impressions_28d > 0
  `) as Array<{
    adset_id?: unknown;
    optimization_goal?: unknown;
    custom_event_type?: unknown;
    spend_28d?: unknown;
    impressions_28d?: unknown;
  }>;

  const cohort = input.cohort ?? "purchase";
  const matureAdsets = new Set<string>();
  for (const row of rows) {
    const rowCohort = resolveMetaFunnelCohort({
      optimizationGoal: typeof row.optimization_goal === "string" ? row.optimization_goal : null,
      customEventType: typeof row.custom_event_type === "string" ? row.custom_event_type : null,
    });
    if (rowCohort !== cohort) continue;
    const adsetId = String(row.adset_id ?? "");
    if (adsetId) matureAdsets.add(adsetId);
  }
  return matureAdsets.size;
}

export async function getMetaCalibrationScope(
  businessId: string,
  scope: {
    campaignId?: string | null;
    accountId: string;
    snapshotDate?: string | null;
    cohort?: MetaFunnelCohort | null;
  },
): Promise<MetaCalibrationScopeResult> {
  const snapshotDate = scope.snapshotDate ? normalizeDate(scope.snapshotDate) : todayIso();
  const cohort = scope.cohort ?? "purchase";
  let campaignFallbackReason: MetaCalibrationFallbackReason | undefined;

  if (scope.campaignId) {
    const campaignRows = await readCalibrationRows({
      businessId,
      scopeType: "campaign",
      scopeId: scope.campaignId,
      cohort,
      snapshotDate,
    });
    if (campaignRows.length > 0) {
      return {
        thresholds: buildThresholdsFromRows(campaignRows),
        scope: {
          type: "campaign",
          id: scope.campaignId,
          snapshotDate: campaignRows[0]?.snapshot_date ?? snapshotDate,
          cohort,
        },
      };
    }

    const matureCount = await readCampaignMatureAdsetCount({
      businessId,
      campaignId: scope.campaignId,
      cohort,
      snapshotDate,
    }).catch(() => MIN_CAMPAIGN_CALIBRATION_SAMPLE);
    campaignFallbackReason =
      matureCount < MIN_CAMPAIGN_CALIBRATION_SAMPLE
        ? "campaign_sample_below_threshold"
        : "campaign_calibration_missing";
  }

  const accountRows = await readCalibrationRows({
    businessId,
    scopeType: "account",
    scopeId: scope.accountId,
    cohort,
    snapshotDate,
  });
  if (accountRows.length > 0) {
    return {
      thresholds: buildThresholdsFromRows(accountRows, campaignFallbackReason),
      scope: {
        type: "account",
        id: scope.accountId,
        snapshotDate: accountRows[0]?.snapshot_date ?? snapshotDate,
        cohort,
      },
      ...(campaignFallbackReason ? { reason: campaignFallbackReason } : {}),
    };
  }

  const reason: MetaCalibrationFallbackReason = "account_calibration_missing";
  return {
    thresholds: cloneLegacyThresholds(reason),
    scope: {
      type: "account",
      id: scope.accountId,
      snapshotDate: null,
      cohort,
    },
    reason,
  };
}
