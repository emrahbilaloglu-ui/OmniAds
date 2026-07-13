#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine";
import {
  summarizeDecisionBacktestByLabelAndWeek,
  type CreativeDecisionBacktestRow,
  type DecisionBacktestSegmentSummary,
} from "@/lib/creative-decision-engine/backtest";
import { normalizePostgresDate } from "@/lib/creative-decision-engine/simulation/calendar-date";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

const DEFAULT_BUSINESS_IDENTIFIERS = ["IwaStore", "EMOLOS", "Grandmix", "TheSwaf"];
const DEFAULT_REPLAY_JSON =
  "docs/creative-decision-center/generated/phase0-current-engine-simulation.json";
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/phase1-outcome-baseline-checkpoint.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/PHASE1_OUTCOME_BASELINE_CHECKPOINT_2026-07-02.md";

const HARD_LABELS = new Set(["scale", "cut", "refresh"]);

type Row = Record<string, unknown>;

interface ParsedArgs {
  asOf: string;
  businessIdentifiers: string[];
  engineVersion: string;
  replayJson: string;
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
}

interface BusinessIdentity {
  id: string;
  name: string;
}

interface SnapshotTotals {
  latestAsOfDate: string | null;
  snapshotDayCount: number;
  rowCount: number;
  totalSpend: number;
  hardActionRows: number;
  blockedEvidenceRows: number;
  staleEvidenceRows: number;
  unknownFreshnessRows: number;
  staleOrUnknownRows: number;
  staleEvidenceShare: number | null;
  unknownFreshnessShare: number | null;
  staleOrUnknownShare: number | null;
  confidenceBuckets: CountMap;
  computedAtMin: string | null;
  computedAtMax: string | null;
}

interface LabelSummary {
  label: string;
  rowCount: number;
  spend: number;
  spendShare: number | null;
  avgConfidence: number | null;
  staleEvidenceRows: number;
  unknownFreshnessRows: number;
  staleOrUnknownRows: number;
  staleOrUnknownShare: number | null;
}

interface OutcomeSummary {
  label: string;
  windowDays: number;
  eligibleSnapshots: number;
  outcomeRows: number;
  knownOutcomeRows: number;
  positive: number;
  negative: number;
  neutral: number;
  unknown: number;
  coverage: number | null;
  firstEligibleDecisionDate: string | null;
  latestEligibleDecisionDate: string | null;
}

interface ClassifierVersionSummary {
  scope: "current_version" | "all_versions";
  windowDays: number;
  classifierVersion: string;
  engineVersion: string | null;
  rows: number;
  unknownRows: number;
  unknownShare: number | null;
}

interface CampaignLabelSpendCoverage {
  windowDays: number;
  totalSpend: number;
  labeledSpend: number;
  unlabeledSpend: number;
  labeledSpendShare: number | null;
  totalCampaigns: number;
  labeledCampaigns: number;
  unavailableReason: string | null;
}

interface JobRunSummary {
  jobName: string;
  asOfDate: string | null;
  status: string;
  rowCount: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
}

interface ReplayBusinessBaseline {
  business: BusinessIdentity;
  status: string;
  simulationAsOf: string | null;
  freshnessMode: string | null;
  rowCount: number;
  labels: CountMap;
  hardActionRows: number;
  blockedEvidenceRows: number;
  staleEvidenceRows: number;
  staleEvidenceShare: number | null;
  riskHints: string[];
}

interface BusinessReview {
  business: BusinessIdentity;
  persistedSnapshot: SnapshotTotals;
  labels: LabelSummary[];
  currentVersionOutcomes: OutcomeSummary[];
  allVersionOutcomes: OutcomeSummary[];
  classifierVersions: ClassifierVersionSummary[];
  campaignLabelSpendCoverage: CampaignLabelSpendCoverage;
  currentVersionBacktestSegments: DecisionBacktestSegmentSummary[];
  allVersionBacktestSegments: DecisionBacktestSegmentSummary[];
  jobRuns: JobRunSummary[];
  replayBaseline: ReplayBusinessBaseline | null;
  measurementReconciliation: {
    persistedSnapshotRows: number;
    replayDecisionRows: number | null;
    rowDelta: number | null;
    note: string;
  };
  readiness: {
    status:
      | "measurement_available"
      | "outcomes_accruing"
      | "snapshots_missing_for_current_version";
    reasons: string[];
    earliest7dWindowClosesAt: string | null;
    earliest14dWindowClosesAt: string | null;
  };
}

type CountMap = Record<string, number>;

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): ParsedArgs {
  return {
    asOf: arg(argv, "asOf", todayIsoDate()),
    businessIdentifiers:
      csvArg(argv, "businesses") ?? [...DEFAULT_BUSINESS_IDENTIFIERS],
    engineVersion: arg(argv, "engineVersion", ENGINE_VERSION),
    replayJson: arg(argv, "replayJson", DEFAULT_REPLAY_JSON),
    jsonOut: arg(argv, "jsonOut", DEFAULT_JSON_OUT),
    mdOut: arg(argv, "mdOut", DEFAULT_MD_OUT),
    writeFiles: arg(argv, "write", "1") !== "0",
  };
}

function arg(argv: string[], name: string, fallback: string) {
  const prefix = `--${name}=`;
  return argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function csvArg(argv: string[], name: string) {
  const raw = arg(argv, name, "");
  if (!raw) return null;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  return String(value);
}

function toIso(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return toText(value);
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value: number | null, digits = 4) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? rounded(numerator / denominator) : null;
}

function addDays(date: string | null, days: number) {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function confidenceBucket(confidence: number) {
  if (confidence < 50) return "00_49";
  if (confidence < 60) return "50_59";
  if (confidence < 70) return "60_69";
  if (confidence < 80) return "70_79";
  if (confidence < 90) return "80_89";
  return "90_100";
}

function increment(map: CountMap, key: string | null | undefined, by = 1) {
  const normalized = key?.trim() || "null";
  map[normalized] = (map[normalized] ?? 0) + by;
}

async function findBusinesses(identifiers: readonly string[]) {
  const normalized = identifiers.map((item) => item.toLowerCase());
  const rows = await getDb().query<Row & { id: unknown; name: unknown }>(
    `
    SELECT id::text AS id, name
    FROM businesses
    WHERE lower(name) = ANY($1::text[])
       OR id::text = ANY($2::text[])
    ORDER BY name ASC, id ASC
    `,
    [normalized, identifiers],
  );
  return rows.flatMap((row) => {
    const id = toText(row.id);
    const name = toText(row.name);
    return id && name ? [{ id, name }] : [];
  });
}

function snapshotBaseCte() {
  return `
    WITH latest_day AS (
      SELECT MAX(as_of_date) AS as_of_date
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND engine_version = $3
        AND as_of_date <= $2::date
        AND scope_type = 'account'
        AND scope_id = '*'
    ),
    base AS (
      SELECT *
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND engine_version = $3
        AND as_of_date = (SELECT as_of_date FROM latest_day)
        AND scope_type = 'account'
        AND scope_id = '*'
    )
  `;
}

function engineVersionPredicate(alias: string, parameterIndex = 3) {
  return `($${parameterIndex}::text IS NULL OR ${alias}.engine_version = $${parameterIndex})`;
}

function hasBadgeSql(type: string) {
  return `badges @> '[{"type":"${type}"}]'::jsonb`;
}

async function readSnapshotTotals(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
}): Promise<SnapshotTotals> {
  const [row] = await getDb().query<Row>(
    `
    ${snapshotBaseCte()},
    all_days AS (
      SELECT COUNT(DISTINCT as_of_date) AS snapshot_day_count
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND engine_version = $3
        AND as_of_date <= $2::date
        AND scope_type = 'account'
        AND scope_id = '*'
    )
    SELECT
      (SELECT as_of_date FROM latest_day) AS latest_as_of_date,
      (SELECT snapshot_day_count FROM all_days) AS snapshot_day_count,
      COUNT(*) AS row_count,
      COALESCE(SUM(COALESCE(spend, 0)), 0)::double precision AS total_spend,
      COUNT(*) FILTER (WHERE label = ANY($4::text[])) AS hard_action_rows,
      COUNT(*) FILTER (
        WHERE label = 'diagnose'
          AND (
            ${hasBadgeSql("scale_readiness_blocked")}
            OR ${hasBadgeSql("unlabeled_campaign_context")}
            OR ${hasBadgeSql("stale_evidence")}
            OR ${hasBadgeSql("unknown_freshness")}
          )
      ) AS blocked_evidence_rows,
      COUNT(*) FILTER (WHERE ${hasBadgeSql("stale_evidence")}) AS stale_evidence_rows,
      COUNT(*) FILTER (WHERE ${hasBadgeSql("unknown_freshness")}) AS unknown_freshness_rows,
      COUNT(*) FILTER (
        WHERE ${hasBadgeSql("stale_evidence")} OR ${hasBadgeSql("unknown_freshness")}
      ) AS stale_or_unknown_rows,
      COUNT(*) FILTER (WHERE confidence >= 0 AND confidence < 50) AS bucket_00_49,
      COUNT(*) FILTER (WHERE confidence >= 50 AND confidence < 60) AS bucket_50_59,
      COUNT(*) FILTER (WHERE confidence >= 60 AND confidence < 70) AS bucket_60_69,
      COUNT(*) FILTER (WHERE confidence >= 70 AND confidence < 80) AS bucket_70_79,
      COUNT(*) FILTER (WHERE confidence >= 80 AND confidence < 90) AS bucket_80_89,
      COUNT(*) FILTER (WHERE confidence >= 90 AND confidence <= 100) AS bucket_90_100,
      MIN(computed_at) AS computed_at_min,
      MAX(computed_at) AS computed_at_max
    FROM base
    `,
    [input.businessId, input.asOf, input.engineVersion, Array.from(HARD_LABELS)],
  );
  const rowCount = toNumber(row?.row_count);
  const staleOrUnknownRows = toNumber(row?.stale_or_unknown_rows);
  return {
    latestAsOfDate: normalizePostgresDate(row?.latest_as_of_date),
    snapshotDayCount: toNumber(row?.snapshot_day_count),
    rowCount,
    totalSpend: rounded(toNumber(row?.total_spend), 2) ?? 0,
    hardActionRows: toNumber(row?.hard_action_rows),
    blockedEvidenceRows: toNumber(row?.blocked_evidence_rows),
    staleEvidenceRows: toNumber(row?.stale_evidence_rows),
    unknownFreshnessRows: toNumber(row?.unknown_freshness_rows),
    staleOrUnknownRows,
    staleEvidenceShare: ratio(toNumber(row?.stale_evidence_rows), rowCount),
    unknownFreshnessShare: ratio(toNumber(row?.unknown_freshness_rows), rowCount),
    staleOrUnknownShare: ratio(staleOrUnknownRows, rowCount),
    confidenceBuckets: {
      "00_49": toNumber(row?.bucket_00_49),
      "50_59": toNumber(row?.bucket_50_59),
      "60_69": toNumber(row?.bucket_60_69),
      "70_79": toNumber(row?.bucket_70_79),
      "80_89": toNumber(row?.bucket_80_89),
      "90_100": toNumber(row?.bucket_90_100),
    },
    computedAtMin: toIso(row?.computed_at_min),
    computedAtMax: toIso(row?.computed_at_max),
  };
}

async function readLabelSummaries(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
  totalSpend: number;
}): Promise<LabelSummary[]> {
  const rows = await getDb().query<Row>(
    `
    ${snapshotBaseCte()}
    SELECT
      label,
      COUNT(*) AS row_count,
      COALESCE(SUM(COALESCE(spend, 0)), 0)::double precision AS spend,
      AVG(confidence)::double precision AS avg_confidence,
      COUNT(*) FILTER (WHERE ${hasBadgeSql("stale_evidence")}) AS stale_evidence_rows,
      COUNT(*) FILTER (WHERE ${hasBadgeSql("unknown_freshness")}) AS unknown_freshness_rows,
      COUNT(*) FILTER (
        WHERE ${hasBadgeSql("stale_evidence")} OR ${hasBadgeSql("unknown_freshness")}
      ) AS stale_or_unknown_rows
    FROM base
    GROUP BY label
    ORDER BY row_count DESC, label ASC
    `,
    [input.businessId, input.asOf, input.engineVersion],
  );
  return rows.map((row) => {
    const rowCount = toNumber(row.row_count);
    const spend = rounded(toNumber(row.spend), 2) ?? 0;
    const staleOrUnknownRows = toNumber(row.stale_or_unknown_rows);
    return {
      label: toText(row.label) ?? "unknown",
      rowCount,
      spend,
      spendShare: ratio(spend, input.totalSpend),
      avgConfidence: rounded(toNullableNumber(row.avg_confidence), 2),
      staleEvidenceRows: toNumber(row.stale_evidence_rows),
      unknownFreshnessRows: toNumber(row.unknown_freshness_rows),
      staleOrUnknownRows,
      staleOrUnknownShare: ratio(staleOrUnknownRows, rowCount),
    };
  });
}

async function readOutcomeSummaries(input: {
  businessId: string;
  asOf: string;
  engineVersion: string | null;
}): Promise<OutcomeSummary[]> {
  const rows = await getDb().query<Row>(
    `
    WITH windows AS (
      SELECT unnest(ARRAY[7, 14]::integer[]) AS outcome_window_days
    ),
    eligible AS (
      SELECT
        s.id,
        s.label,
        s.as_of_date,
        w.outcome_window_days
      FROM engine_v3_decision_snapshots_daily s
      CROSS JOIN windows w
      WHERE (s.business_ref_id::text = $1 OR s.business_id = $1)
        AND ${engineVersionPredicate("s")}
        AND s.scope_type = 'account'
        AND s.scope_id = '*'
        AND s.as_of_date <= ($2::date - (w.outcome_window_days * INTERVAL '1 day'))
    )
    SELECT
      e.label,
      e.outcome_window_days,
      COUNT(*) AS eligible_snapshots,
      COUNT(o.id) AS outcome_rows,
      COUNT(o.id) FILTER (WHERE o.realized_outcome <> 'unknown') AS known_outcome_rows,
      COUNT(o.id) FILTER (WHERE o.realized_outcome = 'positive') AS positive,
      COUNT(o.id) FILTER (WHERE o.realized_outcome = 'negative') AS negative,
      COUNT(o.id) FILTER (WHERE o.realized_outcome = 'neutral') AS neutral,
      COUNT(o.id) FILTER (WHERE o.realized_outcome = 'unknown') AS unknown,
      MIN(e.as_of_date) AS first_eligible_decision_date,
      MAX(e.as_of_date) AS latest_eligible_decision_date
    FROM eligible e
    LEFT JOIN engine_v3_decision_outcomes_daily o
      ON o.decision_snapshot_id = e.id
     AND o.outcome_window_days = e.outcome_window_days
     AND ${engineVersionPredicate("o")}
    GROUP BY e.label, e.outcome_window_days
    ORDER BY e.outcome_window_days ASC, e.label ASC
    `,
    [input.businessId, input.asOf, input.engineVersion],
  );

  return rows.map((row) => {
    const eligibleSnapshots = toNumber(row.eligible_snapshots);
    const outcomeRows = toNumber(row.outcome_rows);
    return {
      label: toText(row.label) ?? "unknown",
      windowDays: toNumber(row.outcome_window_days),
      eligibleSnapshots,
      outcomeRows,
      knownOutcomeRows: toNumber(row.known_outcome_rows),
      positive: toNumber(row.positive),
      negative: toNumber(row.negative),
      neutral: toNumber(row.neutral),
      unknown: toNumber(row.unknown),
      coverage: ratio(outcomeRows, eligibleSnapshots),
      firstEligibleDecisionDate: normalizePostgresDate(row.first_eligible_decision_date),
      latestEligibleDecisionDate: normalizePostgresDate(row.latest_eligible_decision_date),
    };
  });
}

async function readClassifierVersions(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
}): Promise<ClassifierVersionSummary[]> {
  const rows = await getDb().query<Row>(
    `
    WITH scoped AS (
      SELECT 'current_version'::text AS scope, *
      FROM engine_v3_decision_outcomes_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND evaluation_date <= $2::date
        AND engine_version = $3
      UNION ALL
      SELECT 'all_versions'::text AS scope, *
      FROM engine_v3_decision_outcomes_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND evaluation_date <= $2::date
    )
    SELECT
      scope,
      outcome_window_days,
      classifier_version,
      CASE WHEN scope = 'current_version' THEN engine_version ELSE NULL END AS engine_version,
      COUNT(*) AS rows,
      COUNT(*) FILTER (WHERE realized_outcome = 'unknown') AS unknown_rows
    FROM scoped
    GROUP BY scope, outcome_window_days, classifier_version, CASE WHEN scope = 'current_version' THEN engine_version ELSE NULL END
    ORDER BY scope ASC, outcome_window_days ASC, classifier_version ASC
    `,
    [input.businessId, input.asOf, input.engineVersion],
  );

  return rows.map((row) => {
    const rowsCount = toNumber(row.rows);
    const unknownRows = toNumber(row.unknown_rows);
    return {
      scope:
        toText(row.scope) === "current_version"
          ? "current_version"
          : "all_versions",
      windowDays: toNumber(row.outcome_window_days),
      classifierVersion: toText(row.classifier_version) ?? "unknown",
      engineVersion: toText(row.engine_version),
      rows: rowsCount,
      unknownRows,
      unknownShare: ratio(unknownRows, rowsCount),
    };
  });
}

async function readCampaignLabelSpendCoverage(input: {
  businessId: string;
  asOf: string;
}): Promise<CampaignLabelSpendCoverage> {
  const [row] = await getDb().query<Row>(
    `
    WITH spend_by_campaign AS (
      SELECT
        campaign_id,
        COALESCE(SUM(spend), 0)::double precision AS spend
      FROM meta_creative_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
        AND campaign_id IS NOT NULL
      GROUP BY campaign_id
    )
    SELECT
      COALESCE(SUM(spend_by_campaign.spend), 0)::double precision AS total_spend,
      COALESCE(SUM(spend_by_campaign.spend) FILTER (WHERE labels.campaign_id IS NOT NULL), 0)::double precision AS labeled_spend,
      COALESCE(SUM(spend_by_campaign.spend) FILTER (WHERE labels.campaign_id IS NULL), 0)::double precision AS unlabeled_spend,
      COUNT(*) AS total_campaigns,
      COUNT(*) FILTER (WHERE labels.campaign_id IS NOT NULL) AS labeled_campaigns
    FROM spend_by_campaign
    LEFT JOIN meta_campaign_labels labels
      ON labels.business_id = $1
     AND labels.campaign_id = spend_by_campaign.campaign_id
    `,
    [input.businessId, input.asOf],
  );
  const totalSpend = rounded(toNumber(row?.total_spend), 2) ?? 0;
  const labeledSpend = rounded(toNumber(row?.labeled_spend), 2) ?? 0;
  const totalCampaigns = toNumber(row?.total_campaigns);
  return {
    windowDays: 28,
    totalSpend,
    labeledSpend,
    unlabeledSpend: rounded(toNumber(row?.unlabeled_spend), 2) ?? 0,
    labeledSpendShare: ratio(labeledSpend, totalSpend),
    totalCampaigns,
    labeledCampaigns: toNumber(row?.labeled_campaigns),
    unavailableReason:
      totalCampaigns === 0 ? "no_campaign_spend_in_28d_window" : null,
  };
}

function toDecisionBacktestRow(row: Row): CreativeDecisionBacktestRow | null {
  const label = toText(row.label);
  const realizedOutcome = toText(row.realized_outcome);
  if (
    label !== "scale" &&
    label !== "keep" &&
    label !== "refresh" &&
    label !== "cut" &&
    label !== "test_more" &&
    label !== "diagnose" &&
    label !== "out_of_scope"
  ) {
    return null;
  }
  if (
    realizedOutcome !== "positive" &&
    realizedOutcome !== "negative" &&
    realizedOutcome !== "neutral" &&
    realizedOutcome !== "unknown"
  ) {
    return null;
  }
  const severity = toText(row.severity);
  return {
    creativeId: toText(row.creative_id) ?? "",
    asOfDate: normalizePostgresDate(row.decision_as_of_date) ?? "",
    label,
    confidence: toNumber(row.confidence),
    realizedOutcome,
    severity:
      severity === "critical" ||
      severity === "high" ||
      severity === "medium" ||
      severity === "low"
        ? severity
        : undefined,
  };
}

async function readBacktestSegments(input: {
  businessId: string;
  asOf: string;
  engineVersion: string | null;
  activeCreativeCount: number;
}) {
  const rows = await getDb().query<Row>(
    `
    SELECT
      creative_id,
      decision_as_of_date,
      label,
      confidence,
      realized_outcome,
      severity
    FROM engine_v3_decision_outcomes_daily
    WHERE (business_ref_id::text = $1 OR business_id = $1)
      AND outcome_window_days = 14
      AND decision_as_of_date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date
      AND ($3::text IS NULL OR engine_version = $3)
    ORDER BY decision_as_of_date ASC, creative_id ASC
    `,
    [input.businessId, input.asOf, input.engineVersion],
  );
  const backtestRows = rows.flatMap((row) => {
    const parsed = toDecisionBacktestRow(row);
    return parsed ? [parsed] : [];
  });
  if (backtestRows.length === 0) return [];

  const snapshotRowCount = new Set(backtestRows.map((row) => row.creativeId)).size;
  return summarizeDecisionBacktestByLabelAndWeek({
    rows: backtestRows,
    coverage: {
      activeCreativeCount: input.activeCreativeCount,
      snapshotRowCount,
      staleSnapshotCount: 0,
      conflictingSnapshotCount: 0,
    },
    minSegmentSampleSize: 30,
  });
}

async function readRecentJobRuns(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
}): Promise<JobRunSummary[]> {
  const rows = await getDb().query<Row>(
    `
    SELECT DISTINCT ON (job_name)
      job_name,
      as_of_date,
      status,
      row_count,
      started_at,
      finished_at,
      error_message
    FROM engine_v3_job_runs
    WHERE (business_ref_id::text = $1 OR business_id = $1)
      AND engine_version = $3
      AND as_of_date <= $2::date
      AND job_name IN (
        'engine_v3_account_calibration_job',
        'engine_v3_creative_lifecycle_job',
        'engine_v3_decisions_job',
        'engine_v3_decision_outcomes_job'
      )
    ORDER BY job_name, started_at DESC
    `,
    [input.businessId, input.asOf, input.engineVersion],
  );
  return rows.map((row) => ({
    jobName: toText(row.job_name) ?? "unknown",
    asOfDate: normalizePostgresDate(row.as_of_date),
    status: toText(row.status) ?? "unknown",
    rowCount: toNullableNumber(row.row_count),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    errorMessage: toText(row.error_message),
  }));
}

function readReplayBaselines(path: string): Map<string, ReplayBusinessBaseline> {
  if (!existsSync(path)) return new Map();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    reviews?: Array<Record<string, unknown>>;
  };
  const baselines = new Map<string, ReplayBusinessBaseline>();
  for (const review of parsed.reviews ?? []) {
    const businessRaw = review.business as Record<string, unknown> | undefined;
    const id = toText(businessRaw?.id);
    const name = toText(businessRaw?.name);
    if (!id || !name) continue;
    const source = review.source as Record<string, unknown> | null | undefined;
    const distributions = review.distributions as
      | { label?: CountMap; blockedActionType?: CountMap }
      | null
      | undefined;
    const risks = review.risks as
      | {
          staleEvidenceRows?: unknown;
          hardActionRows?: unknown;
          blockedHardActionRows?: unknown;
        }
      | null
      | undefined;
    const rowCount = toNumber(source?.dedupedDecisionCount);
    const staleEvidenceRows = toNumber(risks?.staleEvidenceRows);
    baselines.set(id, {
      business: { id, name },
      status: toText(review.status) ?? "unknown",
      simulationAsOf: normalizePostgresDate(review.simulationAsOf),
      freshnessMode: toText(review.freshnessMode),
      rowCount,
      labels: distributions?.label ?? {},
      hardActionRows: toNumber(risks?.hardActionRows),
      blockedEvidenceRows: toNumber(risks?.blockedHardActionRows),
      staleEvidenceRows,
      staleEvidenceShare: ratio(staleEvidenceRows, rowCount),
      riskHints: Array.isArray(review.riskHints)
        ? review.riskHints.map((item) => String(item))
        : [],
    });
  }
  return baselines;
}

function buildReadiness(input: {
  totals: SnapshotTotals;
  outcomes: OutcomeSummary[];
}) {
  const reasons: string[] = [];
  if (input.totals.rowCount === 0) {
    reasons.push("no_current_engine_version_persisted_snapshots");
    return {
      status: "snapshots_missing_for_current_version" as const,
      reasons,
      earliest7dWindowClosesAt: null,
      earliest14dWindowClosesAt: null,
    };
  }

  const earliest7dWindowClosesAt = addDays(input.totals.latestAsOfDate, 7);
  const earliest14dWindowClosesAt = addDays(input.totals.latestAsOfDate, 14);
  const totalOutcomeRows = input.outcomes.reduce(
    (sum, row) => sum + row.outcomeRows,
    0,
  );
  const eligibleRows = input.outcomes.reduce(
    (sum, row) => sum + row.eligibleSnapshots,
    0,
  );

  if (eligibleRows === 0) {
    reasons.push("no_closed_outcome_windows_for_current_engine_version");
  }
  if (eligibleRows > 0 && totalOutcomeRows < eligibleRows) {
    reasons.push("outcome_rows_not_complete_for_closed_windows");
  }
  if (totalOutcomeRows === 0) {
    reasons.push("current_engine_version_outcomes_empty");
  }

  return {
    status:
      totalOutcomeRows > 0
        ? ("measurement_available" as const)
        : ("outcomes_accruing" as const),
    reasons,
    earliest7dWindowClosesAt,
    earliest14dWindowClosesAt,
  };
}

function formatNumber(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatPct(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function labelCountsText(labels: CountMap) {
  const entries = Object.entries(labels).sort((left, right) => {
    return right[1] - left[1] || left[0].localeCompare(right[0]);
  });
  return entries.length > 0
    ? entries.map(([label, count]) => `${label}: ${count}`).join(", ")
    : "-";
}

function confidenceBucketsText(buckets: CountMap) {
  return Object.entries(buckets)
    .map(([bucket, count]) => `${bucket}: ${count}`)
    .join(", ");
}

function buildMarkdown(report: {
  generatedAt: string;
  asOf: string;
  engineVersion: string;
  businessesFound: number;
  reviews: BusinessReview[];
  replayJson: string;
  liveStatus: Record<string, unknown>;
}) {
  const lines: string[] = [];
  lines.push("# Phase 1 Outcome/Baseline Measurement Checkpoint");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`As-of date: ${report.asOf}`);
  lines.push(`Engine version: \`${report.engineVersion}\``);
  lines.push("Read-only: yes. DB mutation: no. Resolver/formula change: no.");
  lines.push(
    `Live status: attempted=${String(report.liveStatus.attempted)}, source=${String(report.liveStatus.source)}, tables=${Array.isArray(report.liveStatus.tables) ? report.liveStatus.tables.join(", ") : "-"}.`,
  );
  lines.push("");
  lines.push("## Verdict");
  const missingSnapshots = report.reviews.filter(
    (review) => review.readiness.status === "snapshots_missing_for_current_version",
  ).length;
  const measurementAvailable = report.reviews.filter(
    (review) => review.readiness.status === "measurement_available",
  ).length;
  if (missingSnapshots === report.reviews.length) {
    lines.push(
      "Current-version persisted snapshot evidence is not ready yet. This is expected before the scheduled producer chain writes the new `ENGINE_VERSION`; do not claim outcome precision from this checkpoint.",
    );
  } else if (measurementAvailable === 0) {
    lines.push(
      "Current-version snapshots exist, but realized outcome rows are still accruing or incomplete. Use this report as a baseline coverage/readiness check, not as a precision claim.",
    );
  } else {
    lines.push(
      "At least one business has current-version realized outcome rows. Precision/calibration work may use only the rows and windows marked covered below.",
    );
  }
  lines.push("");
  lines.push("## Business Readiness");
  lines.push(
    "| Business | Status | Snapshot day | Rows | Hard rows | Blocked evidence | Stale/unknown share | Spend covered | 7d outcomes | 14d outcomes | Reasons |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const review of report.reviews) {
    const outcomes7 = review.currentVersionOutcomes
      .filter((row) => row.windowDays === 7)
      .reduce((sum, row) => sum + row.outcomeRows, 0);
    const outcomes14 = review.currentVersionOutcomes
      .filter((row) => row.windowDays === 14)
      .reduce((sum, row) => sum + row.outcomeRows, 0);
    lines.push(
      `| ${review.business.name} | ${review.readiness.status} | ${review.persistedSnapshot.latestAsOfDate ?? "-"} | ${review.persistedSnapshot.rowCount} | ${review.persistedSnapshot.hardActionRows} | ${review.persistedSnapshot.blockedEvidenceRows} | ${formatPct(review.persistedSnapshot.staleOrUnknownShare)} | ${formatNumber(review.persistedSnapshot.totalSpend, 2)} | ${outcomes7} | ${outcomes14} | ${review.readiness.reasons.join(", ") || "-"} |`,
    );
  }
  lines.push("");
  lines.push("## Campaign Label Spend Coverage");
  lines.push("| Business | Window | Total spend | Labeled spend | Labeled share | Labeled campaigns | Note |");
  lines.push("|---|---:|---:|---:|---:|---:|---|");
  for (const review of report.reviews) {
    const coverage = review.campaignLabelSpendCoverage;
    lines.push(
      `| ${review.business.name} | ${coverage.windowDays}d | ${formatNumber(coverage.totalSpend, 2)} | ${formatNumber(coverage.labeledSpend, 2)} | ${formatPct(coverage.labeledSpendShare)} | ${coverage.labeledCampaigns}/${coverage.totalCampaigns} | ${coverage.unavailableReason ?? "-"} |`,
    );
  }
  lines.push("");
  lines.push("## Persisted Label Baseline");
  lines.push(
    "| Business | Label | Rows | Spend | Spend share | Avg confidence | Stale rows | Unknown freshness rows | Stale/unknown share |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const review of report.reviews) {
    if (review.labels.length === 0) {
      lines.push(`| ${review.business.name} | - | 0 | - | - | - | 0 | 0 | - |`);
      continue;
    }
    for (const label of review.labels) {
      lines.push(
        `| ${review.business.name} | ${label.label} | ${label.rowCount} | ${formatNumber(label.spend, 2)} | ${formatPct(label.spendShare)} | ${formatNumber(label.avgConfidence, 2)} | ${label.staleEvidenceRows} | ${label.unknownFreshnessRows} | ${formatPct(label.staleOrUnknownShare)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Current-Version Outcome Windows");
  lines.push(
    "| Business | Window | Label | Eligible snapshots | Outcome rows | Known | Positive | Negative | Neutral | Unknown | Coverage |",
  );
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const review of report.reviews) {
    if (review.currentVersionOutcomes.length === 0) {
      lines.push(`| ${review.business.name} | - | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |`);
      continue;
    }
    for (const outcome of review.currentVersionOutcomes) {
      lines.push(
        `| ${review.business.name} | ${outcome.windowDays} | ${outcome.label} | ${outcome.eligibleSnapshots} | ${outcome.outcomeRows} | ${outcome.knownOutcomeRows} | ${outcome.positive} | ${outcome.negative} | ${outcome.neutral} | ${outcome.unknown} | ${formatPct(outcome.coverage)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## All-Version Historical Outcome Context");
  lines.push("Current version remains the measurement source of truth. This all-version panel is historical context only.");
  lines.push(
    "| Business | Window | Label | Eligible snapshots | Outcome rows | Known | Positive | Negative | Neutral | Unknown | Coverage |",
  );
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const review of report.reviews) {
    if (review.allVersionOutcomes.length === 0) {
      lines.push(`| ${review.business.name} | - | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |`);
      continue;
    }
    for (const outcome of review.allVersionOutcomes) {
      lines.push(
        `| ${review.business.name} | ${outcome.windowDays} | ${outcome.label} | ${outcome.eligibleSnapshots} | ${outcome.outcomeRows} | ${outcome.knownOutcomeRows} | ${outcome.positive} | ${outcome.negative} | ${outcome.neutral} | ${outcome.unknown} | ${formatPct(outcome.coverage)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Classifier Version Distribution");
  lines.push("| Business | Scope | Window | Classifier | Engine version | Rows | Unknown share |");
  lines.push("|---|---|---:|---|---|---:|---:|");
  for (const review of report.reviews) {
    if (review.classifierVersions.length === 0) {
      lines.push(`| ${review.business.name} | - | - | - | - | 0 | - |`);
      continue;
    }
    for (const item of review.classifierVersions) {
      lines.push(
        `| ${review.business.name} | ${item.scope} | ${item.windowDays} | ${item.classifierVersion} | ${item.engineVersion ?? "all"} | ${item.rows} | ${formatPct(item.unknownShare)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Backtest Segment Status");
  lines.push("Uses `summarizeDecisionBacktestByLabelAndWeek`; pooled ECE is intentionally not reported because hard/non-hard polarity differs.");
  lines.push("| Business | Current-version segments | All-version segments | Defensible all-version segments |");
  lines.push("|---|---:|---:|---:|");
  for (const review of report.reviews) {
    lines.push(
      `| ${review.business.name} | ${review.currentVersionBacktestSegments.length} | ${review.allVersionBacktestSegments.length} | ${review.allVersionBacktestSegments.filter((segment) => segment.sampleReliable).length} |`,
    );
  }
  lines.push("");
  lines.push("## Confidence Buckets");
  lines.push("| Business | Buckets | Stale share | Unknown freshness share | Computed at range |");
  lines.push("|---|---|---:|---:|---|");
  for (const review of report.reviews) {
    lines.push(
      `| ${review.business.name} | ${confidenceBucketsText(review.persistedSnapshot.confidenceBuckets)} | ${formatPct(review.persistedSnapshot.staleEvidenceShare)} | ${formatPct(review.persistedSnapshot.unknownFreshnessShare)} | ${review.persistedSnapshot.computedAtMin ?? "-"} -> ${review.persistedSnapshot.computedAtMax ?? "-"} |`,
    );
  }
  lines.push("");
  lines.push("## Provisional Replay Baseline");
  lines.push(
    `Source: \`${report.replayJson}\`. This section is distribution context only; it is not persisted outcome evidence.`,
  );
  lines.push("| Business | Replay day | Rows | Labels | Hard rows | Blocked rows | Stale share |");
  lines.push("|---|---:|---:|---|---:|---:|---:|");
  for (const review of report.reviews) {
    const replay = review.replayBaseline;
    if (!replay) {
      lines.push(`| ${review.business.name} | - | 0 | - | 0 | 0 | - |`);
      continue;
    }
    lines.push(
      `| ${review.business.name} | ${replay.simulationAsOf ?? "-"} | ${replay.rowCount} | ${labelCountsText(replay.labels)} | ${replay.hardActionRows} | ${replay.blockedEvidenceRows} | ${formatPct(replay.staleEvidenceShare)} |`,
    );
  }
  lines.push("");
  lines.push("## Evidence Limits");
  lines.push("- This report does not prove precision, recall, ECE, or causal correctness unless outcome rows are present and covered.");
  lines.push("- Current-version rows are filtered by `ENGINE_VERSION`; older-version outcomes are deliberately excluded.");
  lines.push("- `stale/unknown share` is based on persisted decision badges (`stale_evidence`, `unknown_freshness`) when snapshots exist.");
  lines.push("- Historical/all-version outcome context is separated from current-version evidence and must not be used as current precision proof.");
  lines.push("- Pooled ECE is not emitted here because the existing hard/non-hard realized-outcome polarity is not comparable across label classes.");
  lines.push("- No resolver thresholds or buyer-action mappings were changed in this phase.");
  return `${lines.join("\n")}\n`;
}

async function buildReport(args: ParsedArgs) {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const replayBaselines = readReplayBaselines(args.replayJson);
  const businesses = await findBusinesses(args.businessIdentifiers);
  const reviews: BusinessReview[] = [];

  for (const business of businesses) {
    const totals = await readSnapshotTotals({
      businessId: business.id,
      asOf: args.asOf,
      engineVersion: args.engineVersion,
    });
    const [labels, outcomes, jobRuns] = await Promise.all([
      readLabelSummaries({
        businessId: business.id,
        asOf: args.asOf,
        engineVersion: args.engineVersion,
        totalSpend: totals.totalSpend,
      }),
      readOutcomeSummaries({
        businessId: business.id,
        asOf: args.asOf,
        engineVersion: args.engineVersion,
      }),
      readRecentJobRuns({
        businessId: business.id,
        asOf: args.asOf,
        engineVersion: args.engineVersion,
      }),
    ]);
    const replayBaseline = replayBaselines.get(business.id) ?? null;
    const [
      allVersionOutcomes,
      classifierVersions,
      campaignLabelSpendCoverage,
      currentVersionBacktestSegments,
      allVersionBacktestSegments,
    ] = await Promise.all([
      readOutcomeSummaries({
        businessId: business.id,
        asOf: args.asOf,
        engineVersion: null,
      }),
      readClassifierVersions({
        businessId: business.id,
        asOf: args.asOf,
        engineVersion: args.engineVersion,
      }),
      readCampaignLabelSpendCoverage({
        businessId: business.id,
        asOf: args.asOf,
      }),
      readBacktestSegments({
        businessId: business.id,
        asOf: args.asOf,
        engineVersion: args.engineVersion,
        activeCreativeCount: replayBaseline?.rowCount ?? totals.rowCount,
      }),
      readBacktestSegments({
        businessId: business.id,
        asOf: args.asOf,
        engineVersion: null,
        activeCreativeCount: replayBaseline?.rowCount ?? totals.rowCount,
      }),
    ]);
    reviews.push({
      business,
      persistedSnapshot: totals,
      labels,
      currentVersionOutcomes: outcomes,
      allVersionOutcomes,
      classifierVersions,
      campaignLabelSpendCoverage,
      currentVersionBacktestSegments,
      allVersionBacktestSegments,
      jobRuns,
      replayBaseline,
      measurementReconciliation: {
        persistedSnapshotRows: totals.rowCount,
        replayDecisionRows: replayBaseline?.rowCount ?? null,
        rowDelta:
          replayBaseline?.rowCount === undefined
            ? null
            : totals.rowCount - replayBaseline.rowCount,
        note:
          totals.rowCount === 0 && replayBaseline?.rowCount
            ? "current_version_persisted_snapshots_not_written_yet"
            : "current_version_snapshot_rows_available",
      },
      readiness: buildReadiness({ totals, outcomes }),
    });
  }

  const liveStatus = {
    attempted: true,
    source: "live_db_read_only",
    databaseUrlPresent: Boolean(process.env.DATABASE_URL?.trim()),
    completedAt: new Date().toISOString(),
    currentEngineVersion: args.engineVersion,
    tables: [
      "businesses",
      "engine_v3_decision_snapshots_daily",
      "engine_v3_decision_outcomes_daily",
      "engine_v3_job_runs",
      "meta_creative_daily",
      "meta_campaign_labels",
    ],
  };

  return {
    contractVersion: "adsecute.phase1.outcome-baseline-checkpoint.v1" as const,
    generatedAt: new Date().toISOString(),
    asOf: args.asOf,
    readOnly: true as const,
    mutatesData: false as const,
    engineVersion: args.engineVersion,
    businessesRequested: args.businessIdentifiers,
    businessesFound: businesses.length,
    liveStatus,
    replayJson: args.replayJson,
    reviews,
    limitations: [
      "Only current ENGINE_VERSION persisted snapshots/outcomes count as measurement evidence.",
      "Phase 0 replay rows are provisional distribution context, not realized outcome evidence.",
      "No DB writes, provider writes, migrations, commits, or resolver/formula changes are performed by this script.",
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await withOperationalStartupLogsSilenced(() => buildReport(args));
  const markdown = buildMarkdown(report);

  if (args.writeFiles) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    mkdirSync(dirname(args.mdOut), { recursive: true });
    writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(args.mdOut, markdown);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    resetDbClientCache();
  });
