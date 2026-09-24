import { getDb, runDbTransaction } from "@/lib/db";
import {
  buildMetaCompleteWindowSql,
  buildMetaFunnelStageSql,
  type MetaFunnelStageId,
} from "@/lib/meta/funnel-stage-parse";
import {
  buildAdDayAuthoritativeLinkClicksSql,
  buildAdDayLinkClicksMissingSql,
} from "@/lib/meta/link-click-parse";
import { buildMetaAdDayProviderZeroReceiptSql } from "@/lib/meta/ad-day-provider-zero-receipt";
import {
  resolveMetaFunnelCohort,
  type MetaFunnelCohort,
} from "@/lib/meta/funnel-cohort";
import type { MetaCampaignKind } from "@/lib/meta/campaign-label-types";

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
export type MetaCalibrationCampaignKind = "all" | MetaCampaignKind;
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
    campaignKind?: MetaCalibrationCampaignKind;
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

export interface AggregatedAdsetMetricRow {
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
  /*
    How many decision-bearing adset-days inside the 28-day window did NOT
    measure the ad-derived field beside it (see `buildMetaCompleteWindowSql`).
    Carried out of SQL so `mergeMetricRowsByAdset` can apply the same window
    rule when it folds an adset's (goal, event) sub-windows together: a NULL
    sub-window with zero missing days held only inert days and is not a gap,
    while a NULL sub-window with missing days is. Optional because the reader is
    the only producer; an absent count is read as UNKNOWN and fails closed.
  */
  link_clicks_28d_missing_days?: unknown;
  add_to_cart_28d_missing_days?: unknown;
  initiate_checkout_28d_missing_days?: unknown;
  view_content_28d_missing_days?: unknown;
  landing_page_views_28d_missing_days?: unknown;
  post_engagement_28d_missing_days?: unknown;
  leads_28d_missing_days?: unknown;
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
  campaign_kind: MetaCalibrationCampaignKind;
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
  campaign_kind: MetaCalibrationCampaignKind;
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

/**
 * For counts that come out of the provider's `actions` array.
 *
 * `toNumber` maps null to 0, which is right for a metric the provider always
 * reports and wrong for one it omits. An ad-day whose payload carries no
 * `actions` array measured nothing; the SQL keeps that as NULL, and collapsing
 * it to 0 here turned "we never saw this funnel stage" into "this stage
 * happened zero times" one layer above, where `ZERO_INCLUSIVE_METRICS` admits
 * a 0 as a real observation and feeds it to the percentiles.
 */
function toMeasuredCountOrNull(value: unknown): number | null {
  /*
    Strict about the SHAPE too, not only about null. `Number("")` is 0 and
    `Number(true)` is 1, so a bare `Number(value)` would have turned an empty
    string or a boolean into a confident count. A count is a finite,
    non-negative number (a float8 SUM arrives as one) or a non-empty numeric
    string (a numeric SUM arrives as one); anything else is unmeasured.
  */
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * The missing-day count beside a window sum, or null when it is UNKNOWN.
 * Unknown is not zero: a window whose completeness cannot be read is treated
 * as incomplete wherever that matters (`readWindowMeasurement`,
 * `mergeWindowMeasurement`).
 */
function toMissingDayCountOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The ad-derived window fields and the missing-day count that qualifies each.
 * `thruplay_actions_28d` is deliberately absent: it has no verified provider
 * contract on this grain, the reader emits NULL for it, and it has no
 * completeness to carry (see `readAggregatedAdsetMetricRows`).
 */
const AD_DERIVED_WINDOW_FIELDS = [
  ["link_clicks_28d", "link_clicks_28d_missing_days"],
  ["add_to_cart_28d", "add_to_cart_28d_missing_days"],
  ["initiate_checkout_28d", "initiate_checkout_28d_missing_days"],
  ["view_content_28d", "view_content_28d_missing_days"],
  ["landing_page_views_28d", "landing_page_views_28d_missing_days"],
  ["post_engagement_28d", "post_engagement_28d_missing_days"],
  ["leads_28d", "leads_28d_missing_days"],
] as const satisfies ReadonlyArray<
  readonly [keyof AggregatedAdsetMetricRow, keyof AggregatedAdsetMetricRow]
>;

type AdDerivedWindowField = (typeof AD_DERIVED_WINDOW_FIELDS)[number][0];

const AD_DERIVED_WINDOW_MISSING_FIELD = Object.fromEntries(
  AD_DERIVED_WINDOW_FIELDS,
) as Record<AdDerivedWindowField, (typeof AD_DERIVED_WINDOW_FIELDS)[number][1]>;

/**
 * One window measurement: the sum when the window is complete, else null.
 *
 * The SQL already returns NULL for an incomplete window, so for rows straight
 * out of the reader this is `toMeasuredCountOrNull`. It also refuses a value
 * that arrives beside a POSITIVE missing-day count: a sum over a window that
 * skipped delivered days is a partial sum, never a measurement, whoever
 * produced the row.
 */
function readWindowMeasurement(
  row: AggregatedAdsetMetricRow,
  field: AdDerivedWindowField,
): number | null {
  const missing = toMissingDayCountOrNull(row[AD_DERIVED_WINDOW_MISSING_FIELD[field]]);
  if (missing !== null && missing > 0) return null;
  return toMeasuredCountOrNull(row[field]);
}

/**
 * THE WINDOW RULE, applied to two sub-windows of the same adset.
 *
 * `readAggregatedAdsetMetricRows` groups by (goal, event) as well as by adset,
 * so an adset whose goal changed inside the 28 days arrives as several rows
 * that `mergeMetricRowsByAdset` folds back together. Each row is itself a
 * `buildMetaCompleteWindowSql` sum, and folding them must keep that rule
 * rather than undo it:
 *
 *   incomplete + anything   -> NULL, and the fold stays incomplete
 *   zero + zero             -> 0
 *   value + empty           -> value   (empty = no measurement AND no missing
 *                                       day: the sub-window held only inert
 *                                       days, which are not gaps)
 *
 * A side is INCOMPLETE when its missing-day count is positive, or when that
 * count is unknown and its value is null — an unreadable completeness can
 * only ever make a window incomplete, never complete.
 */
function mergeWindowMeasurement(
  left: { value: unknown; missing: unknown },
  right: { value: unknown; missing: unknown },
): { value: number | null; missing: number | null } {
  const leftValue = toMeasuredCountOrNull(left.value);
  const rightValue = toMeasuredCountOrNull(right.value);
  const leftMissing = toMissingDayCountOrNull(left.missing);
  const rightMissing = toMissingDayCountOrNull(right.missing);
  const missing =
    leftMissing === null || rightMissing === null ? null : leftMissing + rightMissing;
  const incomplete = (value: number | null, missingDays: number | null) =>
    missingDays === null ? value === null : missingDays > 0;
  if (incomplete(leftValue, leftMissing) || incomplete(rightValue, rightMissing)) {
    return { value: null, missing: missing ?? null };
  }
  const value =
    leftValue === null
      ? rightValue
      : rightValue === null
        ? leftValue
        : leftValue + rightValue;
  return { value, missing };
}

/** A rate is only a measurement when its numerator was actually measured. */
function measuredRate(
  numerator: number | null,
  denominator: number,
): number | undefined {
  if (numerator === null || denominator <= 0) return undefined;
  return (numerator / denominator) * 100;
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

function normalizeCalibrationCampaignKind(
  value: MetaCalibrationCampaignKind | null | undefined,
): MetaCalibrationCampaignKind {
  if (value === "main" || value === "test" || value === "mixed") return value;
  return "all";
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
  /*
    Link clicks are an ad-derived window like every funnel stage below, and
    they were the one left on `toNumber`: a NULL window (a delivered adset-day
    the provider never reported link clicks for) became 0, and a partial window
    became a confident denominator for `cost_per_link_click_28d`.
  */
  const linkClicks28 = readWindowMeasurement(row, "link_clicks_28d");
  const addToCart28 = readWindowMeasurement(row, "add_to_cart_28d");
  const initiateCheckout28 = readWindowMeasurement(row, "initiate_checkout_28d");
  const viewContent28 = readWindowMeasurement(row, "view_content_28d");
  const landingPageViews28 = readWindowMeasurement(row, "landing_page_views_28d");
  /*
    R5: no verified provider contract for a thruplay numerator exists on this
    grain (no top-level key and no `thruplay` action type in any stored
    `actions` array), so the reader emits NULL and this side does not look at
    the column either. `cost_per_thruplay_28d` and `thruplay_rate_28d` are
    therefore absent — never a fabricated 0% — until a real source lands.
  */
  const thruplayActions28: number | null = null;
  const postEngagement28 = readWindowMeasurement(row, "post_engagement_28d");
  const leads28 = readWindowMeasurement(row, "leads_28d");
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
      cost_per_atc_28d:
        addToCart28 !== null && addToCart28 > 0 ? spend28 / addToCart28 : undefined,
      cost_per_ic_28d:
        initiateCheckout28 !== null && initiateCheckout28 > 0
          ? spend28 / initiateCheckout28
          : undefined,
      cost_per_vc_28d:
        viewContent28 !== null && viewContent28 > 0 ? spend28 / viewContent28 : undefined,
      // ZERO-INCLUSIVE: an unmeasured numerator must be absent, not 0%.
      atc_rate_28d: measuredRate(addToCart28, impressions28),
      atc_to_purchase_rate_28d:
        addToCart28 !== null && addToCart28 > 0
          ? (conversions28 / addToCart28) * 100
          : undefined,
      cost_per_thruplay_28d:
        thruplayActions28 !== null && thruplayActions28 > 0
          ? spend28 / thruplayActions28
          : undefined,
      // ZERO-INCLUSIVE: same rule, and thruplay has no source on this table
      // at all, so it is absent on every row rather than a measured zero.
      thruplay_rate_28d: measuredRate(thruplayActions28, impressions28),
      cost_per_lead_28d:
        leads28 !== null && leads28 > 0 ? spend28 / leads28 : undefined,
      lead_to_purchase_rate_28d:
        leads28 !== null && leads28 > 0
          ? (conversions28 / leads28) * 100
          : undefined,
      cost_per_link_click_28d:
        linkClicks28 !== null && linkClicks28 > 0 ? spend28 / linkClicks28 : undefined,
      cost_per_lpv_28d:
        landingPageViews28 !== null && landingPageViews28 > 0
          ? spend28 / landingPageViews28
          : undefined,
      cost_per_engagement_28d:
        postEngagement28 !== null && postEngagement28 > 0
          ? spend28 / postEngagement28
          : undefined,
      // ZERO-INCLUSIVE: an unmeasured numerator must be absent, not 0%.
      engagement_rate_28d: measuredRate(postEngagement28, impressions28),
    },
  };
}

/*
  The merge used to add EVERY field with `toNumber(a) + toNumber(b)`, which is
  NULL + NULL = 0 and NULL + 5 = 5. That quietly refuted the reader's own
  promise that an unmeasured window is "carried all the way out": the moment an
  adset arrived as two (goal, event) rows, an unmeasured funnel window became a
  measured zero (and entered ZERO_INCLUSIVE percentiles as a real 0%), and a
  partial window became a complete-looking sum.

  So the merge is split by what the field IS:
    - spend, revenue, conversions, impressions, clicks and the 14-day fields
      come from meta_adset_daily's NOT NULL columns and keep `toNumber`;
    - every ad-derived measurement goes through `mergeWindowMeasurement`, which
      applies the same complete-or-null rule the SQL window applied;
    - thruplay has no verified provider contract on this grain, so it stays
      null whatever the rows say (R5: never fabricate a numerator).
*/
function mergeMetricRowsByAdset(rows: AggregatedAdsetMetricRow[]): AggregatedAdsetMetricRow[] {
  const merged = new Map<string, AggregatedAdsetMetricRow>();
  const alwaysReportedFields = [
    "spend_28d",
    "revenue_28d",
    "conversions_28d",
    "impressions_28d",
    "clicks_28d",
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

    for (const field of alwaysReportedFields) {
      existing[field] = toNumber(existing[field]) + toNumber(row[field]);
    }
    for (const [field, missingField] of AD_DERIVED_WINDOW_FIELDS) {
      const next = mergeWindowMeasurement(
        { value: existing[field], missing: existing[missingField] },
        { value: row[field], missing: row[missingField] },
      );
      existing[field] = next.value;
      existing[missingField] = next.missing;
    }
    existing.thruplay_actions_28d = null;
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
  campaignKind?: MetaCalibrationCampaignKind | null;
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
      campaign_kind: normalizeCalibrationCampaignKind(input.campaignKind),
      p10: percentiles.p10,
      p25: percentiles.p25,
      p50: percentiles.p50,
      p75: percentiles.p75,
      p90: percentiles.p90,
      sample_size: percentiles.sampleSize,
    });
  }
}

/*
  The adset calibration reads `meta_ad_daily`, whose `payload_json` carries the
  provider's `actions` array — never the top-level `add_to_cart` /
  `landing_page_views` keys these expressions used to ask for. Every one of them
  resolved to nothing and `COALESCE(..., 0)` then published it as a measured
  zero, so `atc_rate_28d`, `engagement_rate_28d` and their siblings entered the
  percentiles as fabricated 0% observations.

  `SUM(...) FILTER (WHERE measured)` is NULL when nothing was measured, and that
  NULL is now carried all the way out. The first version of this change stopped
  at the SQL and said the TypeScript side was behaviour-identical because
  `toNumber` mapped the NULL back to 0 — which was true, and was the whole
  problem: `atc_rate_28d`, `thruplay_rate_28d` and `engagement_rate_28d` are in
  `ZERO_INCLUSIVE_METRICS`, so `isNonNegativeFinite` admitted that 0 as a real
  observation and every unmeasured ad-day went on voting "0%" in the
  percentiles. The fabrication had moved one layer up, not gone.

  The actions-derived counts are therefore read with `toMeasuredCountOrNull`
  and the rates that depend on them go through `measuredRate`, which returns
  `undefined` — absent, and dropped by the sample filter — when the numerator
  was never measured. A MEASURED zero (the provider reported the stage as zero,
  or omitted it from a present `actions` array) still enters the sample as a
  real 0, which is the distinction the whole change exists to keep.

  `thruplay_actions` is a stronger case of the same thing: there is no
  top-level key for it here AND no `thruplay` action type in any stored
  `actions` array across 90 days of production, so every row was unmeasured and
  every row was publishing a fabricated 0% thruplay rate. Its `COALESCE(..., 0)`
  is gone too. Closing it needs a real provider field, which is a separate
  change; until then the metric is absent rather than zero.

  This query became `sql.query(text, params)` because the tagged-template form
  binds every `${}` as a parameter, so a raw SQL fragment cannot be interpolated
  into it. The only two bound values are the business id and the snapshot date.
*/
/*
  THE WINDOW RULE (`META_METRIC_WINDOW_COMPLETENESS_RULE`), and the three ways
  this reader used to break it.

  1. LINK CLICKS READ THE RAW COLUMN. `SUM(link_clicks)` summed
     `meta_ad_daily.link_clicks` exactly as stored. That column was
     `NOT NULL DEFAULT 0` for most of its life and the old writer supplied a
     literal zero whenever Meta supplied no actions breakdown, so a stored zero
     is not evidence of a measured zero. Each ad-day now goes through
     `buildAdDayAuthoritativeLinkClicksSql` — D095's column-versus-payload
     ladder, the one the native readers use — so a legacy zero with no payload
     provenance is unknown here exactly as it is there.

  2. EVERY WINDOW WAS A PARTIAL SUM. `SUM(value) FILTER (WHERE measured)` kept
     "measured zero" and "not measured" apart per ad-day and then threw that
     away across days: a measured 0 plus a delivered day the provider never
     reported returned a confident 0, and three measured days plus eleven
     unreported ones returned a positive number that looked exactly like
     complete coverage — while the impressions denominator it was divided by
     (from `meta_adset_daily`) covered all fourteen. Every ad-derived figure now
     takes its sum from `buildMetaCompleteWindowSql`, at both levels:
       - per adset-day, over that day's ad rows, with the stage's own
         `missingSql` (or `buildAdDayLinkClicksMissingSql`) and the ad-day
         decision-bearing activity predicate;
       - per adset, over the adset-days of the 28-day window, where a day is
         missing when its adset-day sum is NULL and decision-bearing when EITHER
         grain says it did something.

  3. DELIVERED ADSET-DAYS WITH NO AD ROWS VANISHED. The spine is
     `meta_adset_daily`; the ad rows arrive through a LEFT JOIN. An adset-day
     that delivered but has no ad rows joined to NULL and `SUM` skipped it, so
     its spend and impressions sat in every denominator while none of its
     events were anywhere. That NULL is now a missing day like any other, and
     it makes every ad-derived window it touches incomplete. An adset-day that
     did nothing at all is still not a gap.

  The activity predicate is the one `lib/creative-decision-engine/data-source.ts`
  names `AD_DAY_DECISION_BEARING_ACTIVITY_SQL` (impressions OR spend OR clicks
  OR conversions OR revenue, each COALESCEd to 0). It is restated here with a
  relation qualifier rather than imported: that constant is unqualified and
  lives inside the native engine's loader, which `lib/meta` does not import.
  `lib/meta/funnel-stage-wiring.test.ts` pins the two spellings together.

  `thruplay_actions` now emits NULL outright (R5). It read a top-level key that
  `meta_ad_daily` has never carried, so it had no verified provider contract,
  and it cast whatever it found with `::numeric` — a single malformed value
  would have aborted the whole calibration query instead of staying missing
  (R4).
*/
const ADSET_CALIBRATION_AD_DAY = "ad_day";

export const ADSET_FUNNEL_STAGE_SQL = buildMetaFunnelStageSql({
  payloadExpression: `${ADSET_CALIBRATION_AD_DAY}.payload_json`,
  lateralAlias: "funnel_actions",
  providerZeroProofSql: "source_receipt.provider_zero_receipt_verified",
  stages: [
    "landing_page_view",
    "add_to_cart",
    "initiate_checkout",
    "view_content",
    "post_engagement",
    "lead",
  ],
});

function decisionBearingActivitySql(qualifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(qualifier)) {
    throw new Error(`meta_calibration_activity_sql_qualifier_invalid:${qualifier}`);
  }
  return `(
      COALESCE(${qualifier}.impressions, 0) > 0
      OR COALESCE(${qualifier}.spend, 0) > 0
      OR COALESCE(${qualifier}.clicks, 0) > 0
      OR COALESCE(${qualifier}.conversions, 0) > 0
      OR COALESCE(${qualifier}.revenue, 0) > 0
    )`;
}

/** The ad-day decision-bearing predicate, qualified for this reader's `meta_ad_daily` alias. */
export const ADSET_CALIBRATION_AD_DAY_ACTIVITY_SQL = decisionBearingActivitySql(
  ADSET_CALIBRATION_AD_DAY,
);

/** The same predicate over the `meta_adset_daily` spine. */
export const ADSET_CALIBRATION_ADSET_DAY_ACTIVITY_SQL = decisionBearingActivitySql("adset");

const ADSET_WINDOW_28D_FILTER_SQL = "adset.date >= ($2::date - INTERVAL '27 days')";

const stageMeasurement = (column: string, stage: MetaFunnelStageId) => ({
  column,
  valueSql: ADSET_FUNNEL_STAGE_SQL.valueSql(stage),
  missingSql: ADSET_FUNNEL_STAGE_SQL.missingSql(stage),
});

/**
 * Every ad-derived measurement this reader aggregates. `column` names the
 * adset-day sum and, suffixed `_28d` / `_28d_missing_days`, the output fields
 * `AD_DERIVED_WINDOW_FIELDS` reads back.
 */
const ADSET_AD_DERIVED_MEASUREMENTS: ReadonlyArray<{
  column: string;
  valueSql: string;
  missingSql: string;
}> = [
  {
    column: "link_clicks",
    valueSql: buildAdDayAuthoritativeLinkClicksSql({
      qualifier: ADSET_CALIBRATION_AD_DAY,
      providerZeroProofSql: "source_receipt.provider_zero_receipt_verified",
    }),
    missingSql: buildAdDayLinkClicksMissingSql({
      qualifier: ADSET_CALIBRATION_AD_DAY,
      providerZeroProofSql: "source_receipt.provider_zero_receipt_verified",
    }),
  },
  stageMeasurement("add_to_cart", "add_to_cart"),
  stageMeasurement("initiate_checkout", "initiate_checkout"),
  stageMeasurement("view_content", "view_content"),
  stageMeasurement("landing_page_views", "landing_page_view"),
  stageMeasurement("post_engagement", "post_engagement"),
  stageMeasurement("leads", "lead"),
];

const AD_DAY_READING_COLUMNS_SQL = ADSET_AD_DERIVED_MEASUREMENTS.flatMap(
  (measurement) => [
    `        ${measurement.valueSql} AS ${measurement.column}_value`,
    `        ${measurement.missingSql} AS ${measurement.column}_missing`,
  ],
).join(",\n");

const ADSET_DAY_SUM_COLUMNS_SQL = ADSET_AD_DERIVED_MEASUREMENTS.map((measurement) => {
  const window = buildMetaCompleteWindowSql({
    valueSql: `${measurement.column}_value`,
    missingSql: `${measurement.column}_missing`,
    activitySql: "decision_bearing",
  });
  return `        ${window.sumSql} AS ${measurement.column}`;
}).join(",\n");

const ADSET_WINDOW_COLUMNS_SQL = ADSET_AD_DERIVED_MEASUREMENTS.flatMap((measurement) => {
  const window = buildMetaCompleteWindowSql({
    valueSql: `ad_events.${measurement.column}`,
    missingSql: `(ad_events.${measurement.column} IS NULL)`,
    activitySql: `(${ADSET_CALIBRATION_ADSET_DAY_ACTIVITY_SQL} OR COALESCE(ad_events.decision_bearing_ad_rows, 0) > 0)`,
    rowFilterSql: ADSET_WINDOW_28D_FILTER_SQL,
  });
  return [
    `      ${window.sumSql} AS ${measurement.column}_28d`,
    `      ${window.missingDeliveredRowsSql} AS ${measurement.column}_28d_missing_days`,
  ];
}).join(",\n");

/**
 * Exported for the real-PostgreSQL seam
 * (`lib/meta/calibration-window.db.test.ts`); production calls it only from
 * `runMetaCalibrationForBusiness`.
 */
export async function readAggregatedAdsetMetricRows(
  businessId: string,
  snapshotDate: string,
): Promise<AggregatedAdsetMetricRow[]> {
  const sql = getDb();
  return (await sql.query(
    `
    WITH ad_day_readings AS (
      SELECT
        ad_day.business_id,
        ad_day.provider_account_id,
        ad_day.date,
        ad_day.adset_id,
        ${ADSET_CALIBRATION_AD_DAY_ACTIVITY_SQL} AS decision_bearing,
${AD_DAY_READING_COLUMNS_SQL}
      FROM meta_ad_daily ad_day
      LEFT JOIN LATERAL (
        SELECT ${buildMetaAdDayProviderZeroReceiptSql({
          qualifier: ADSET_CALIBRATION_AD_DAY,
          cutoffSql: "transaction_timestamp()",
        })} AS provider_zero_receipt_verified
        OFFSET 0
      ) source_receipt ON TRUE
      ${ADSET_FUNNEL_STAGE_SQL.lateralSql}
      WHERE ad_day.business_id = $1
        AND ad_day.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
        AND COALESCE(ad_day.truth_state, 'finalized') IN ('finalized', 'finalized_verified')
        AND ad_day.adset_id IS NOT NULL
    ),
    ad_event_daily AS (
      SELECT
        business_id,
        provider_account_id,
        date,
        adset_id,
        (COUNT(*) FILTER (WHERE decision_bearing))::integer AS decision_bearing_ad_rows,
${ADSET_DAY_SUM_COLUMNS_SQL}
      FROM ad_day_readings
      GROUP BY business_id, provider_account_id, date, adset_id
    )
    SELECT
      adset.provider_account_id AS account_id,
      adset.campaign_id,
      adset.adset_id,
      adset.optimization_goal,
      adset.custom_event_type,
      SUM(adset.spend) FILTER (WHERE adset.date >= ($2::date - INTERVAL '27 days')) AS spend_28d,
      SUM(adset.revenue) FILTER (WHERE adset.date >= ($2::date - INTERVAL '27 days')) AS revenue_28d,
      SUM(adset.conversions) FILTER (WHERE adset.date >= ($2::date - INTERVAL '27 days')) AS conversions_28d,
      SUM(adset.impressions) FILTER (WHERE adset.date >= ($2::date - INTERVAL '27 days')) AS impressions_28d,
      SUM(adset.clicks) FILTER (WHERE adset.date >= ($2::date - INTERVAL '27 days')) AS clicks_28d,
${ADSET_WINDOW_COLUMNS_SQL},
      NULL::double precision AS thruplay_actions_28d,
      SUM(adset.spend) FILTER (WHERE adset.date >= ($2::date - INTERVAL '13 days')) AS spend_14d,
      SUM(adset.impressions) FILTER (WHERE adset.date >= ($2::date - INTERVAL '13 days')) AS impressions_14d,
      SUM(adset.reach) FILTER (WHERE adset.date >= ($2::date - INTERVAL '13 days')) AS reach_14d
    FROM meta_adset_daily adset
    LEFT JOIN ad_event_daily ad_events
      ON ad_events.business_id = adset.business_id
      AND ad_events.provider_account_id = adset.provider_account_id
      AND ad_events.date = adset.date
      AND ad_events.adset_id = adset.adset_id
    WHERE adset.business_id = $1
      AND adset.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
      AND COALESCE(adset.truth_state, 'finalized') IN ('finalized', 'finalized_verified')
    GROUP BY adset.provider_account_id, adset.campaign_id, adset.adset_id, adset.optimization_goal, adset.custom_event_type
`,
    [businessId, snapshotDate],
  )) as AggregatedAdsetMetricRow[];
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
          campaign_kind text,
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
        campaign_kind,
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
        campaign_kind,
        p10,
        p25,
        p50,
        p75,
        p90,
        sample_size
      FROM payload
      ON CONFLICT (business_id, scope_type, scope_id, snapshot_date, metric_name, cohort, campaign_kind)
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
  campaignKind?: MetaCalibrationCampaignKind | null;
  snapshotDate?: string | null;
}): Promise<CalibrationDbRow[]> {
  const sql = getDb();
  const snapshotDate = input.snapshotDate ? normalizeDate(input.snapshotDate) : todayIso();
  const cohort = input.cohort ?? "purchase";
  const campaignKind = normalizeCalibrationCampaignKind(input.campaignKind);
  return (await sql`
    WITH latest AS (
      SELECT snapshot_date, campaign_kind
      FROM meta_decision_calibration_daily
      WHERE business_id = ${input.businessId}
        AND scope_type = ${input.scopeType}
        AND scope_id = ${input.scopeId}
        AND cohort = ${cohort}
        AND snapshot_date <= ${snapshotDate}::date
        AND (
          campaign_kind = ${campaignKind}
          OR (${campaignKind} <> 'all' AND campaign_kind = 'all')
        )
      GROUP BY snapshot_date, campaign_kind
      ORDER BY
        CASE WHEN campaign_kind = ${campaignKind} THEN 0 ELSE 1 END,
        snapshot_date DESC
      LIMIT 1
    )
    SELECT
      scope_type,
      scope_id,
      snapshot_date::text AS snapshot_date,
      metric_name,
      cohort,
      campaign_kind,
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
      AND campaign_kind = (SELECT campaign_kind FROM latest)
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
    campaignKind?: MetaCalibrationCampaignKind | null;
  },
): Promise<MetaCalibrationScopeResult> {
  const snapshotDate = scope.snapshotDate ? normalizeDate(scope.snapshotDate) : todayIso();
  const cohort = scope.cohort ?? "purchase";
  const campaignKind = normalizeCalibrationCampaignKind(scope.campaignKind);
  let campaignFallbackReason: MetaCalibrationFallbackReason | undefined;

  if (scope.campaignId) {
    const campaignRows = await readCalibrationRows({
      businessId,
      scopeType: "campaign",
      scopeId: scope.campaignId,
      cohort,
      campaignKind,
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
          campaignKind: campaignRows[0]?.campaign_kind ?? campaignKind,
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
    campaignKind,
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
        campaignKind: accountRows[0]?.campaign_kind ?? campaignKind,
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
      campaignKind,
    },
    reason,
  };
}
