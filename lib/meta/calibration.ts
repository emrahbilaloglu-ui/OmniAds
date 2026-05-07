import { getDb, runDbTransaction } from "@/lib/db";

export const MIN_CAMPAIGN_CALIBRATION_SAMPLE = 8;
export const MIN_ACCOUNT_CALIBRATION_SAMPLE = 1;

export const META_CALIBRATION_METRICS = [
  "roas_28d",
  "cpa_28d",
  "freq_14d",
  "cpm_14d",
  "ctr_28d",
  "win_rate_28d",
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
  };
  reason?: MetaCalibrationFallbackReason;
}

export interface RunMetaCalibrationResult {
  businessId: string;
  snapshotDate: string;
  rowsWritten: number;
  accountScopes: number;
  campaignScopes: number;
}

interface AggregatedAdsetMetricRow {
  account_id: string;
  campaign_id: string | null;
  adset_id: string;
  spend_28d: unknown;
  revenue_28d: unknown;
  conversions_28d: unknown;
  impressions_28d: unknown;
  clicks_28d: unknown;
  spend_14d: unknown;
  impressions_14d: unknown;
  reach_14d: unknown;
}

interface ComputedMetricSample {
  accountId: string;
  campaignId: string | null;
  adsetId: string;
  mature: boolean;
  values: Partial<Record<MetaCalibrationMetricName, number>>;
}

interface CalibrationPayloadRow {
  business_id: string;
  scope_type: MetaCalibrationScopeType;
  scope_id: string;
  snapshot_date: string;
  metric_name: MetaCalibrationMetricName;
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
};

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
  const spend14 = toNumber(row.spend_14d);
  const impressions14 = toNumber(row.impressions_14d);
  const reach14 = toNumber(row.reach_14d);

  return {
    accountId: row.account_id,
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    mature: spend28 > 0 && impressions28 > 0,
    values: {
      roas_28d: spend28 > 0 ? revenue28 / spend28 : undefined,
      cpa_28d: conversions28 > 0 ? spend28 / conversions28 : undefined,
      freq_14d: reach14 > 0 ? impressions14 / reach14 : undefined,
      cpm_14d: impressions14 > 0 ? (spend14 / impressions14) * 1000 : undefined,
      ctr_28d: impressions28 > 0 ? (clicks28 / impressions28) * 100 : undefined,
      win_rate_28d: clicks28 > 0 ? (conversions28 / clicks28) * 100 : undefined,
    },
  };
}

function pushMetricRows(input: {
  payload: CalibrationPayloadRow[];
  businessId: string;
  snapshotDate: string;
  scopeType: MetaCalibrationScopeType;
  scopeId: string;
  samples: ComputedMetricSample[];
}) {
  for (const metricName of META_CALIBRATION_METRICS) {
    const percentiles = computeMetaPercentiles(
      input.samples
        .map((sample) => sample.values[metricName])
        .filter(isPositiveFinite),
    );
    if (!percentiles) continue;
    input.payload.push({
      business_id: input.businessId,
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      snapshot_date: input.snapshotDate,
      metric_name: metricName,
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
    SELECT
      provider_account_id AS account_id,
      campaign_id,
      adset_id,
      SUM(spend) FILTER (WHERE date >= (${snapshotDate}::date - INTERVAL '27 days')) AS spend_28d,
      SUM(revenue) FILTER (WHERE date >= (${snapshotDate}::date - INTERVAL '27 days')) AS revenue_28d,
      SUM(conversions) FILTER (WHERE date >= (${snapshotDate}::date - INTERVAL '27 days')) AS conversions_28d,
      SUM(impressions) FILTER (WHERE date >= (${snapshotDate}::date - INTERVAL '27 days')) AS impressions_28d,
      SUM(clicks) FILTER (WHERE date >= (${snapshotDate}::date - INTERVAL '27 days')) AS clicks_28d,
      SUM(spend) FILTER (WHERE date >= (${snapshotDate}::date - INTERVAL '13 days')) AS spend_14d,
      SUM(impressions) FILTER (WHERE date >= (${snapshotDate}::date - INTERVAL '13 days')) AS impressions_14d,
      SUM(reach) FILTER (WHERE date >= (${snapshotDate}::date - INTERVAL '13 days')) AS reach_14d
    FROM meta_adset_daily
    WHERE business_id = ${businessId}
      AND date BETWEEN (${snapshotDate}::date - INTERVAL '27 days') AND ${snapshotDate}::date
      AND COALESCE(truth_state, 'finalized') IN ('finalized', 'finalized_verified')
    GROUP BY provider_account_id, campaign_id, adset_id
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
        p10,
        p25,
        p50,
        p75,
        p90,
        sample_size
      FROM payload
      ON CONFLICT (business_id, scope_type, scope_id, snapshot_date, metric_name)
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

export async function runMetaCalibrationForBusiness(
  businessId: string,
  snapshotDate: string,
): Promise<RunMetaCalibrationResult> {
  const normalizedSnapshotDate = normalizeDate(snapshotDate);
  const rawRows = await readAggregatedAdsetMetricRows(businessId, normalizedSnapshotDate);
  const samples = rawRows.map(metricValuesForSample);
  const payload: CalibrationPayloadRow[] = [];

  const accountGroups = new Map<string, ComputedMetricSample[]>();
  for (const sample of samples) {
    const list = accountGroups.get(sample.accountId);
    if (list) list.push(sample);
    else accountGroups.set(sample.accountId, [sample]);
  }

  for (const [accountId, groupSamples] of accountGroups.entries()) {
    const matureSamples = groupSamples.filter((sample) => sample.mature);
    if (matureSamples.length < MIN_ACCOUNT_CALIBRATION_SAMPLE) continue;
    pushMetricRows({
      payload,
      businessId,
      snapshotDate: normalizedSnapshotDate,
      scopeType: "account",
      scopeId: accountId,
      samples: matureSamples,
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
    if (matureSamples.length < MIN_CAMPAIGN_CALIBRATION_SAMPLE) continue;
    const campaignId = matureSamples[0]?.campaignId;
    if (!campaignId) continue;
    pushMetricRows({
      payload,
      businessId,
      snapshotDate: normalizedSnapshotDate,
      scopeType: "campaign",
      scopeId: campaignId,
      samples: matureSamples,
    });
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
  };
}

async function readCalibrationRows(input: {
  businessId: string;
  scopeType: MetaCalibrationScopeType;
  scopeId: string;
  snapshotDate?: string | null;
}): Promise<CalibrationDbRow[]> {
  const sql = getDb();
  const snapshotDate = input.snapshotDate ? normalizeDate(input.snapshotDate) : todayIso();
  return (await sql`
    WITH latest AS (
      SELECT MAX(snapshot_date) AS snapshot_date
      FROM meta_decision_calibration_daily
      WHERE business_id = ${input.businessId}
        AND scope_type = ${input.scopeType}
        AND scope_id = ${input.scopeId}
        AND snapshot_date <= ${snapshotDate}::date
    )
    SELECT
      scope_type,
      scope_id,
      snapshot_date::text AS snapshot_date,
      metric_name,
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
      AND snapshot_date = (SELECT snapshot_date FROM latest)
  `) as CalibrationDbRow[];
}

async function readCampaignMatureAdsetCount(input: {
  businessId: string;
  campaignId: string;
  snapshotDate?: string | null;
}) {
  const sql = getDb();
  const snapshotDate = input.snapshotDate ? normalizeDate(input.snapshotDate) : todayIso();
  const rows = (await sql`
    WITH adset_samples AS (
      SELECT
        adset_id,
        SUM(spend) AS spend_28d,
        SUM(impressions) AS impressions_28d
      FROM meta_adset_daily
      WHERE business_id = ${input.businessId}
        AND campaign_id = ${input.campaignId}
        AND date BETWEEN (${snapshotDate}::date - INTERVAL '27 days') AND ${snapshotDate}::date
        AND COALESCE(truth_state, 'finalized') IN ('finalized', 'finalized_verified')
      GROUP BY adset_id
    )
    SELECT COUNT(*)::int AS mature_count
    FROM adset_samples
    WHERE spend_28d > 0 AND impressions_28d > 0
  `) as Array<{ mature_count?: unknown }>;
  return Math.max(0, Math.round(toNumber(rows[0]?.mature_count)));
}

export async function getMetaCalibrationScope(
  businessId: string,
  scope: { campaignId?: string | null; accountId: string; snapshotDate?: string | null },
): Promise<MetaCalibrationScopeResult> {
  const snapshotDate = scope.snapshotDate ? normalizeDate(scope.snapshotDate) : todayIso();
  let campaignFallbackReason: MetaCalibrationFallbackReason | undefined;

  if (scope.campaignId) {
    const campaignRows = await readCalibrationRows({
      businessId,
      scopeType: "campaign",
      scopeId: scope.campaignId,
      snapshotDate,
    });
    if (campaignRows.length > 0) {
      return {
        thresholds: buildThresholdsFromRows(campaignRows),
        scope: {
          type: "campaign",
          id: scope.campaignId,
          snapshotDate: campaignRows[0]?.snapshot_date ?? snapshotDate,
        },
      };
    }

    const matureCount = await readCampaignMatureAdsetCount({
      businessId,
      campaignId: scope.campaignId,
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
    snapshotDate,
  });
  if (accountRows.length > 0) {
    return {
      thresholds: buildThresholdsFromRows(accountRows, campaignFallbackReason),
      scope: {
        type: "account",
        id: scope.accountId,
        snapshotDate: accountRows[0]?.snapshot_date ?? snapshotDate,
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
    },
    reason,
  };
}
