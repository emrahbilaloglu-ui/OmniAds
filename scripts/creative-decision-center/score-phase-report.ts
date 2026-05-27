#!/usr/bin/env node
import { getDb } from "@/lib/db";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine";

const DEFAULT_BUSINESS_NAMES = ["IwaStore", "EMOLOS", "Grandmix", "TheSwaf"];

type BusinessRow = Record<string, unknown> & {
  id: unknown;
  name: unknown;
};

type SnapshotRow = Record<string, unknown> & {
  as_of_date: unknown;
  row_count: unknown;
  action_rows: unknown;
  watching_rows: unknown;
  healthy_rows: unknown;
  conflicting_groups: unknown;
  stale_rows: unknown;
};

type OutcomeRow = Record<string, unknown> & {
  window_7_count: unknown;
  window_14_count: unknown;
  first_7d_window_closes_at: unknown;
  first_14d_window_closes_at: unknown;
};

type CompletenessRow = Record<string, unknown> & {
  total_creatives: unknown;
  review_status_present: unknown;
  policy_reason_present: unknown;
  disapproval_reason_present: unknown;
  limited_reason_present: unknown;
  first_seen_present: unknown;
  first_spend_present: unknown;
  spend_24h_present: unknown;
  impressions_24h_present: unknown;
  ctr_present: unknown;
  cpm_present: unknown;
  frequency_present: unknown;
};

type BacktestPlanRow = Record<string, unknown> & {
  scale_count: unknown;
  cut_count: unknown;
  refresh_count: unknown;
  bucket_0_20_count: unknown;
  bucket_20_40_count: unknown;
  bucket_40_60_count: unknown;
  bucket_60_80_count: unknown;
  bucket_80_100_count: unknown;
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function csvArg(name: string) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return [];
  return raw
    .slice(prefix.length)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function arg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return (
    process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ??
    fallback
  );
}

function text(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return null;
  return String(value);
}

function int(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function dateOnly(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = text(value);
  return raw ? raw.slice(0, 10) : null;
}

function coverage(present: number, total: number) {
  return total > 0 ? Number((present / total).toFixed(4)) : null;
}

async function findBusinesses(names: readonly string[]) {
  const rows = await getDb().query<BusinessRow>(
    `
    SELECT id, name
    FROM businesses
    WHERE lower(name) = ANY($1::text[])
    ORDER BY name ASC
    `,
    [names.map((name) => name.toLowerCase())],
  );
  return rows.map((row) => ({
    id: text(row.id) ?? "",
    name: text(row.name) ?? "",
  }));
}

async function readSnapshotSummary(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
}) {
  const [row] = await getDb().query<SnapshotRow>(
    `
    WITH latest_day AS (
      SELECT MAX(as_of_date) AS as_of_date
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND engine_version = $3
        AND as_of_date <= $2::date
    ),
    latest_snapshots AS (
      SELECT *
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND engine_version = $3
        AND as_of_date = (SELECT as_of_date FROM latest_day)
        AND scope_type = 'account'
        AND scope_id = '*'
    ),
    conflicts AS (
      SELECT creative_id, as_of_date, engine_version, scope_type, scope_id
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND engine_version = $3
        AND as_of_date = (SELECT as_of_date FROM latest_day)
      GROUP BY creative_id, as_of_date, engine_version, scope_type, scope_id
      HAVING COUNT(DISTINCT label) > 1
    )
    SELECT
      (SELECT as_of_date FROM latest_day) AS as_of_date,
      COUNT(*) AS row_count,
      COUNT(*) FILTER (WHERE label IN ('scale', 'cut', 'refresh')) AS action_rows,
      COUNT(*) FILTER (WHERE label NOT IN ('scale', 'cut', 'refresh', 'keep')) AS watching_rows,
      COUNT(*) FILTER (WHERE label = 'keep') AS healthy_rows,
      (SELECT COUNT(*) FROM conflicts) AS conflicting_groups,
      COUNT(*) FILTER (
        WHERE computed_at < (now() - INTERVAL '24 hours')
           OR as_of_date < ($2::date - INTERVAL '1 day')
      ) AS stale_rows
    FROM latest_snapshots
    `,
    [input.businessId, input.asOf, input.engineVersion],
  );
  return {
    asOfDate: dateOnly(row?.as_of_date),
    rowCount: int(row?.row_count),
    actionRows: int(row?.action_rows),
    watchingRows: int(row?.watching_rows),
    healthyRows: int(row?.healthy_rows),
    conflictingGroups: int(row?.conflicting_groups),
    staleRows: int(row?.stale_rows),
  };
}

async function readOutcomeSummary(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
}) {
  const [row] = await getDb().query<OutcomeRow>(
    `
    WITH current_outcomes AS (
      SELECT outcome_window_days
      FROM engine_v3_decision_outcomes_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND engine_version = $3
        AND evaluation_date <= $2::date
    ),
    earliest_snapshot AS (
      SELECT MIN(as_of_date) AS first_as_of_date
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND engine_version = $3
        AND scope_type = 'account'
        AND scope_id = '*'
    )
    SELECT
      COUNT(*) FILTER (WHERE outcome_window_days = 7) AS window_7_count,
      COUNT(*) FILTER (WHERE outcome_window_days = 14) AS window_14_count,
      ((SELECT first_as_of_date FROM earliest_snapshot) + INTERVAL '7 day')::date
        AS first_7d_window_closes_at,
      ((SELECT first_as_of_date FROM earliest_snapshot) + INTERVAL '14 day')::date
        AS first_14d_window_closes_at
    FROM current_outcomes
    `,
    [input.businessId, input.asOf, input.engineVersion],
  );
  return {
    currentVersionRows7d: int(row?.window_7_count),
    currentVersionRows14d: int(row?.window_14_count),
    first7dWindowClosesAt: dateOnly(row?.first_7d_window_closes_at),
    first14dWindowClosesAt: dateOnly(row?.first_14d_window_closes_at),
  };
}

async function readCompleteness(input: { businessId: string; asOf: string }) {
  const [row] = await getDb().query<CompletenessRow>(
    `
    WITH latest AS (
      SELECT DISTINCT ON (creative_id)
        creative_id,
        ctr,
        frequency,
        payload_json,
        launch_date,
        spend,
        impressions
      FROM meta_creative_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND date <= $2::date
        AND creative_id IS NOT NULL
      ORDER BY creative_id, date DESC, updated_at DESC
    )
    SELECT
      COUNT(*) AS total_creatives,
      COUNT(*) FILTER (
        WHERE NULLIF(payload_json->>'review_status', '') IS NOT NULL
           OR NULLIF(payload_json->>'ad_review_status', '') IS NOT NULL
           OR NULLIF(payload_json->>'approval_status', '') IS NOT NULL
      ) AS review_status_present,
      COUNT(*) FILTER (
        WHERE NULLIF(payload_json->>'policy_reason', '') IS NOT NULL
           OR NULLIF(payload_json->>'disapproval_reason', '') IS NOT NULL
           OR NULLIF(payload_json->>'limited_reason', '') IS NOT NULL
      ) AS policy_reason_present,
      COUNT(*) FILTER (
        WHERE NULLIF(payload_json->>'disapproval_reason', '') IS NOT NULL
      ) AS disapproval_reason_present,
      COUNT(*) FILTER (
        WHERE NULLIF(payload_json->>'limited_reason', '') IS NOT NULL
      ) AS limited_reason_present,
      COUNT(*) FILTER (WHERE launch_date IS NOT NULL) AS first_seen_present,
      COUNT(*) FILTER (WHERE spend > 0) AS first_spend_present,
      COUNT(*) FILTER (WHERE spend IS NOT NULL) AS spend_24h_present,
      COUNT(*) FILTER (WHERE impressions IS NOT NULL) AS impressions_24h_present,
      COUNT(*) FILTER (WHERE ctr IS NOT NULL) AS ctr_present,
      COUNT(*) FILTER (WHERE spend IS NOT NULL AND impressions > 0) AS cpm_present,
      COUNT(*) FILTER (WHERE frequency IS NOT NULL) AS frequency_present
    FROM latest
    `,
    [input.businessId, input.asOf],
  );
  const total = int(row?.total_creatives);
  const fields = {
    reviewStatus: int(row?.review_status_present),
    policyReason: int(row?.policy_reason_present),
    disapprovalReason: int(row?.disapproval_reason_present),
    limitedReason: int(row?.limited_reason_present),
    firstSeenAt: int(row?.first_seen_present),
    firstSpendAt: int(row?.first_spend_present),
    spend24h: int(row?.spend_24h_present),
    impressions24h: int(row?.impressions_24h_present),
    ctr: int(row?.ctr_present),
    cpm: int(row?.cpm_present),
    frequency: int(row?.frequency_present),
  };
  return {
    totalCreatives: total,
    fields: Object.fromEntries(
      Object.entries(fields).map(([field, present]) => [
        field,
        { present, total, coverage: coverage(present, total) },
      ]),
    ),
  };
}

function coverageValue(
  completeness: Awaited<ReturnType<typeof readCompleteness>>,
  field: string,
) {
  const value = completeness.fields[field] as
    | { coverage: number | null }
    | undefined;
  return value?.coverage ?? null;
}

function isFullyCovered(value: number | null) {
  return value !== null && value >= 0.9999;
}

function buildProofDetail(
  coverage: Record<string, number | null>,
  fields: string[],
) {
  const missingFields = fields.filter((field) => !isFullyCovered(coverage[field]));
  const coveredFields = fields.filter((field) => isFullyCovered(coverage[field]));
  return {
    available: missingFields.length === 0,
    coveragePct: fields.length > 0 ? coveredFields.length / fields.length : null,
    missingFields,
  };
}

function buildProofGateRisk(
  dataCompleteness: Awaited<ReturnType<typeof readCompleteness>>,
) {
  const reviewStatus = coverageValue(dataCompleteness, "reviewStatus");
  const policyReason = coverageValue(dataCompleteness, "policyReason");
  const disapprovalReason = coverageValue(dataCompleteness, "disapprovalReason");
  const limitedReason = coverageValue(dataCompleteness, "limitedReason");
  const spend24h = coverageValue(dataCompleteness, "spend24h");
  const impressions24h = coverageValue(dataCompleteness, "impressions24h");
  const firstSeenAt = coverageValue(dataCompleteness, "firstSeenAt");
  const firstSpendAt = coverageValue(dataCompleteness, "firstSpendAt");
  const coverage = {
    reviewStatus,
    policyReason,
    disapprovalReason,
    limitedReason,
    spend24h,
    impressions24h,
    firstSeenAt,
    firstSpendAt,
  };
  const fixPolicy = buildProofDetail(coverage, [
    "reviewStatus",
    "policyReason",
    "disapprovalReason",
    "limitedReason",
  ]);
  const fixDelivery = buildProofDetail(coverage, [
    "spend24h",
    "impressions24h",
  ]);
  const launchMonitoring = buildProofDetail(coverage, [
    "firstSeenAt",
    "firstSpendAt",
  ]);

  return {
    fix_policy_proof_available: fixPolicy.available,
    fix_delivery_proof_available: fixDelivery.available,
    launch_monitoring_proof_available: launchMonitoring.available,
    details: {
      fix_policy: fixPolicy,
      fix_delivery: fixDelivery,
      launch_monitoring: launchMonitoring,
    },
    coverage,
  };
}

async function readBacktestPlan(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
}) {
  const [row] = await getDb().query<BacktestPlanRow>(
    `
    SELECT
      COUNT(*) FILTER (WHERE label = 'scale') AS scale_count,
      COUNT(*) FILTER (WHERE label = 'cut') AS cut_count,
      COUNT(*) FILTER (WHERE label = 'refresh') AS refresh_count,
      COUNT(*) FILTER (WHERE confidence >= 0 AND confidence < 20) AS bucket_0_20_count,
      COUNT(*) FILTER (WHERE confidence >= 20 AND confidence < 40) AS bucket_20_40_count,
      COUNT(*) FILTER (WHERE confidence >= 40 AND confidence < 60) AS bucket_40_60_count,
      COUNT(*) FILTER (WHERE confidence >= 60 AND confidence < 80) AS bucket_60_80_count,
      COUNT(*) FILTER (WHERE confidence >= 80 AND confidence <= 100) AS bucket_80_100_count
    FROM engine_v3_decision_outcomes_daily
    WHERE (business_ref_id::text = $1 OR business_id = $1)
      AND engine_version = $3
      AND evaluation_date <= $2::date
    `,
    [input.businessId, input.asOf, input.engineVersion],
  );
  return {
    perActionWindowSampleSize: {
      scale: int(row?.scale_count),
      cut: int(row?.cut_count),
      refresh: int(row?.refresh_count),
    },
    perConfidenceBucketSampleSize: {
      bucket0_20: int(row?.bucket_0_20_count),
      bucket20_40: int(row?.bucket_20_40_count),
      bucket40_60: int(row?.bucket_40_60_count),
      bucket60_80: int(row?.bucket_60_80_count),
      bucket80_100: int(row?.bucket_80_100_count),
    },
    minimumSampleForPrecisionClaim: 30,
    minimumSampleForECEClaim: 10,
  };
}

async function main() {
  const asOf = arg("asOf", todayIsoDate());
  const engineVersion = arg("engineVersion", ENGINE_VERSION);
  const names = csvArg("businesses");
  const targetNames = names.length > 0 ? names : DEFAULT_BUSINESS_NAMES;
  const businesses = await findBusinesses(targetNames);
  const reviews = [];

  for (const business of businesses) {
    const [snapshot, outcome, dataCompleteness, backtestPlanSamples] = await Promise.all([
      readSnapshotSummary({ businessId: business.id, asOf, engineVersion }),
      readOutcomeSummary({ businessId: business.id, asOf, engineVersion }),
      readCompleteness({ businessId: business.id, asOf }),
      readBacktestPlan({ businessId: business.id, asOf, engineVersion }),
    ]);
    const totalOutcomeSamples =
      Object.values(backtestPlanSamples.perActionWindowSampleSize).reduce(
        (sum, value) => sum + value,
        0,
      );
    reviews.push({
      business,
      snapshot,
      outcome,
      dataCompleteness,
      proofGateRisk: buildProofGateRisk(dataCompleteness),
      backtestPlan: {
        earliest7dOutcomeDate: outcome.first7dWindowClosesAt,
        earliest14dOutcomeDate: outcome.first14dWindowClosesAt,
        ...backtestPlanSamples,
        precisionRecallStatus:
          totalOutcomeSamples >= backtestPlanSamples.minimumSampleForPrecisionClaim
            ? "measurable"
            : "not_measurable_yet",
        eceStatus:
          totalOutcomeSamples >= backtestPlanSamples.minimumSampleForECEClaim
            ? "measurable"
            : "not_measurable_yet",
        nonComputableReason:
          totalOutcomeSamples >= backtestPlanSamples.minimumSampleForPrecisionClaim
            ? null
            : "insufficient_current_version_outcome_samples",
      },
      notes: [
        snapshot.rowCount === 0 ? "no_current_snapshot_rows_for_scope" : null,
        outcome.currentVersionRows7d === 0
          ? "current_version_7d_outcomes_empty"
          : null,
        outcome.currentVersionRows14d === 0
          ? "current_version_14d_outcomes_empty"
          : null,
      ].filter(Boolean),
    });
  }

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        asOf,
        engineVersion,
        businessesRequested: targetNames,
        businessesFound: businesses.length,
        reviews,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
