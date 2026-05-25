import { getDb, runDbTransaction } from "@/lib/db";
import {
  classifyCreativeDecisionOutcome,
  CREATIVE_OUTCOME_CLASSIFIER_VERSION,
} from "../outcome-classifier";
import { ENGINE_VERSION, type DecisionLabel } from "../types";
import { hashAdvisoryLock } from "./calibration-job";

export const JOB_NAME = "engine_v3_decision_outcomes_job";
export const DECISION_OUTCOME_WINDOWS_DAYS = [7, 14] as const;
export const DECISION_OUTCOME_LOOKBACK_DAYS = 120;
export const DECISION_OUTCOME_BATCH_LIMIT = 5_000;

type JobStatus = "success" | "failed" | "skipped";

export interface DecisionOutcomesJobInput {
  businessId: string;
  asOf: string;
  windowsDays?: readonly number[];
  lookbackDays?: number;
  batchLimit?: number;
}

export interface DecisionOutcomesJobResult {
  jobRunId: string;
  status: JobStatus;
  outcomesWritten: number;
  durationMs: number;
  errorMessage?: string;
}

type AdvisoryLockRow = Record<string, unknown> & {
  acquired: unknown;
};

type JobRunIdRow = Record<string, unknown> & {
  id: unknown;
};

type OutcomeSourceRow = Record<string, unknown> & {
  decision_snapshot_id: unknown;
  business_ref_id: unknown;
  business_id: unknown;
  creative_id: unknown;
  decision_as_of_date: unknown;
  evaluation_date: unknown;
  outcome_window_days: unknown;
  engine_version: unknown;
  label: unknown;
  confidence: unknown;
  effective_target_roas: unknown;
  baseline_spend: unknown;
  baseline_purchases: unknown;
  baseline_roas: unknown;
  outcome_spend: unknown;
  outcome_purchases: unknown;
  outcome_revenue: unknown;
  outcome_roas: unknown;
};

interface OutcomePayloadRow {
  decision_snapshot_id: string;
  business_ref_id: string;
  business_id: string | null;
  creative_id: string;
  decision_as_of_date: string;
  evaluation_date: string;
  outcome_window_days: number;
  engine_version: string;
  label: DecisionLabel;
  confidence: number;
  effective_target_roas: number;
  baseline_spend: number | null;
  baseline_purchases: number | null;
  baseline_roas: number | null;
  outcome_spend: number;
  outcome_purchases: number;
  outcome_revenue: number;
  outcome_roas: number | null;
  realized_outcome: string;
  severity: string;
  classifier_version: string;
  evidence_json: Record<string, unknown>;
  job_run_id: string;
  computed_at: string;
}

const READ_OUTCOME_SOURCE_ROWS_QUERY = `
WITH windows AS (
  SELECT unnest($3::integer[]) AS outcome_window_days
),
eligible_snapshots AS (
  SELECT s.*
  FROM engine_v3_decision_snapshots_daily s
  WHERE (s.business_ref_id::text = $1 OR s.business_id = $1)
    AND s.engine_version = $4
    AND s.scope_type = 'account'
    AND s.scope_id = '*'
    AND s.as_of_date BETWEEN ($2::date - (($5::integer - 1) * INTERVAL '1 day')) AND $2::date
),
candidate_windows AS (
  SELECT
    s.id AS decision_snapshot_id,
    s.business_ref_id,
    s.business_id,
    s.creative_id,
    s.as_of_date AS decision_as_of_date,
    $2::date AS evaluation_date,
    w.outcome_window_days,
    s.engine_version,
    s.label,
    s.confidence,
    s.effective_target_roas,
    s.spend AS baseline_spend,
    s.purchases AS baseline_purchases,
    s.roas AS baseline_roas
  FROM eligible_snapshots s
  CROSS JOIN windows w
  WHERE s.as_of_date <= ($2::date - (w.outcome_window_days * INTERVAL '1 day'))
    AND NOT EXISTS (
      SELECT 1
      FROM engine_v3_decision_outcomes_daily existing
      WHERE existing.decision_snapshot_id = s.id
        AND existing.outcome_window_days = w.outcome_window_days
    )
)
SELECT
  c.decision_snapshot_id,
  c.business_ref_id,
  c.business_id,
  c.creative_id,
  c.decision_as_of_date,
  c.evaluation_date,
  c.outcome_window_days,
  c.engine_version,
  c.label,
  c.confidence,
  c.effective_target_roas,
  c.baseline_spend,
  c.baseline_purchases,
  c.baseline_roas,
  COALESCE(SUM(d.spend), 0)::double precision AS outcome_spend,
  COALESCE(SUM(d.conversions), 0)::double precision AS outcome_purchases,
  COALESCE(SUM(d.revenue), 0)::double precision AS outcome_revenue,
  CASE
    WHEN COALESCE(SUM(d.spend), 0) > 0
    THEN COALESCE(SUM(d.revenue), 0) / NULLIF(SUM(d.spend), 0)
  END AS outcome_roas
FROM candidate_windows c
LEFT JOIN meta_creative_daily d
  ON (d.business_ref_id::text = $1 OR d.business_id = $1)
 AND d.creative_id = c.creative_id
 AND d.date > c.decision_as_of_date
 AND d.date <= (c.decision_as_of_date + (c.outcome_window_days * INTERVAL '1 day'))::date
GROUP BY
  c.decision_snapshot_id,
  c.business_ref_id,
  c.business_id,
  c.creative_id,
  c.decision_as_of_date,
  c.evaluation_date,
  c.outcome_window_days,
  c.engine_version,
  c.label,
  c.confidence,
  c.effective_target_roas,
  c.baseline_spend,
  c.baseline_purchases,
  c.baseline_roas
ORDER BY c.decision_as_of_date ASC, c.creative_id ASC, c.outcome_window_days ASC
LIMIT $6::integer
`;

const INSERT_OUTCOMES_QUERY = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    decision_snapshot_id uuid,
    business_ref_id uuid,
    business_id text,
    creative_id text,
    decision_as_of_date date,
    evaluation_date date,
    outcome_window_days integer,
    engine_version text,
    label text,
    confidence integer,
    effective_target_roas double precision,
    baseline_spend double precision,
    baseline_purchases double precision,
    baseline_roas double precision,
    outcome_spend double precision,
    outcome_purchases double precision,
    outcome_revenue double precision,
    outcome_roas double precision,
    realized_outcome text,
    severity text,
    classifier_version text,
    evidence_json jsonb,
    job_run_id uuid,
    computed_at timestamptz
  )
)
INSERT INTO engine_v3_decision_outcomes_daily (
  decision_snapshot_id,
  business_ref_id,
  business_id,
  creative_id,
  decision_as_of_date,
  evaluation_date,
  outcome_window_days,
  engine_version,
  label,
  confidence,
  effective_target_roas,
  baseline_spend,
  baseline_purchases,
  baseline_roas,
  outcome_spend,
  outcome_purchases,
  outcome_revenue,
  outcome_roas,
  realized_outcome,
  severity,
  classifier_version,
  evidence_json,
  job_run_id,
  computed_at
)
SELECT
  decision_snapshot_id,
  business_ref_id,
  business_id,
  creative_id,
  decision_as_of_date,
  evaluation_date,
  outcome_window_days,
  engine_version,
  label,
  confidence,
  effective_target_roas,
  baseline_spend,
  baseline_purchases,
  baseline_roas,
  outcome_spend,
  outcome_purchases,
  outcome_revenue,
  outcome_roas,
  realized_outcome,
  severity,
  classifier_version,
  evidence_json,
  job_run_id,
  computed_at
FROM payload
ON CONFLICT (decision_snapshot_id, outcome_window_days)
DO UPDATE SET
  evaluation_date = EXCLUDED.evaluation_date,
  outcome_spend = EXCLUDED.outcome_spend,
  outcome_purchases = EXCLUDED.outcome_purchases,
  outcome_revenue = EXCLUDED.outcome_revenue,
  outcome_roas = EXCLUDED.outcome_roas,
  realized_outcome = EXCLUDED.realized_outcome,
  severity = EXCLUDED.severity,
  classifier_version = EXCLUDED.classifier_version,
  evidence_json = EXCLUDED.evidence_json,
  job_run_id = EXCLUDED.job_run_id,
  computed_at = EXCLUDED.computed_at,
  updated_at = now()
RETURNING id
`;

export function decisionOutcomesJobAdvisoryLockKey(
  input: DecisionOutcomesJobInput,
): bigint {
  return hashAdvisoryLock(`${JOB_NAME}:${input.businessId}:${input.asOf}`);
}

export async function runDecisionOutcomesJob(
  input: DecisionOutcomesJobInput,
): Promise<DecisionOutcomesJobResult> {
  const startedAt = Date.now();
  const lockKey = decisionOutcomesJobAdvisoryLockKey(input);

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
        outcomesWritten: 0,
        durationMs,
        errorMessage: "Advisory lock not acquired (job may already be running)",
      };
    }

    const jobRunId = await insertJobRun({
      businessId: input.businessId,
      asOf: input.asOf,
      status: "running",
    });

    await db.query("SAVEPOINT engine_v3_decision_outcomes_job_work");
    try {
      const sourceRows = await readOutcomeSourceRows(input);
      const computedAt = new Date().toISOString();
      const payloadRows = sourceRows.map((row) =>
        toOutcomePayloadRow({ row, jobRunId, computedAt }),
      );
      const outcomesWritten = await insertOutcomes(payloadRows);
      const durationMs = Date.now() - startedAt;

      await db.query(
        `
        UPDATE engine_v3_job_runs
        SET
          status = 'success',
          finished_at = now(),
          duration_ms = $1::integer,
          row_count = $2::integer,
          error_json = $3::jsonb,
          updated_at = now()
        WHERE id = $4::uuid
        `,
        [
          durationMs,
          outcomesWritten,
          JSON.stringify({
            metadata: {
              classifier_version: CREATIVE_OUTCOME_CLASSIFIER_VERSION,
              windows_days: input.windowsDays ?? DECISION_OUTCOME_WINDOWS_DAYS,
            },
          }),
          jobRunId,
        ],
      );

      return {
        jobRunId,
        status: "success",
        outcomesWritten,
        durationMs,
      };
    } catch (error) {
      await db
        .query("ROLLBACK TO SAVEPOINT engine_v3_decision_outcomes_job_work")
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
        outcomesWritten: 0,
        durationMs,
        errorMessage: message,
      };
    }
  });
}

async function insertJobRun(input: {
  businessId: string;
  asOf: string;
  status: JobStatus | "running";
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
    throw new Error("Decision outcomes job run insert did not return an id.");
  }
  return id;
}

async function readOutcomeSourceRows(input: DecisionOutcomesJobInput) {
  return getDb().query<OutcomeSourceRow>(READ_OUTCOME_SOURCE_ROWS_QUERY, [
    input.businessId,
    input.asOf,
    input.windowsDays ?? DECISION_OUTCOME_WINDOWS_DAYS,
    ENGINE_VERSION,
    input.lookbackDays ?? DECISION_OUTCOME_LOOKBACK_DAYS,
    input.batchLimit ?? DECISION_OUTCOME_BATCH_LIMIT,
  ]);
}

function toOutcomePayloadRow(input: {
  row: OutcomeSourceRow;
  jobRunId: string;
  computedAt: string;
}): OutcomePayloadRow {
  const label = toDecisionLabel(input.row.label);
  const confidence = toIntegerOrNull(input.row.confidence) ?? 0;
  const effectiveTargetRoas =
    toNumberOrNull(input.row.effective_target_roas) ?? 0;
  const baselineSpend = toNumberOrNull(input.row.baseline_spend);
  const baselinePurchases = toNumberOrNull(input.row.baseline_purchases);
  const baselineRoas = toNumberOrNull(input.row.baseline_roas);
  const outcomeSpend = toNumberOrNull(input.row.outcome_spend) ?? 0;
  const outcomePurchases = toNumberOrNull(input.row.outcome_purchases) ?? 0;
  const outcomeRevenue = toNumberOrNull(input.row.outcome_revenue) ?? 0;
  const outcomeRoas = toNumberOrNull(input.row.outcome_roas);
  const outcomeWindowDays =
    toIntegerOrNull(input.row.outcome_window_days) ?? DECISION_OUTCOME_WINDOWS_DAYS[0];
  const classification = classifyCreativeDecisionOutcome({
    label,
    confidence,
    effectiveTargetRoas,
    baselineSpend,
    baselinePurchases,
    baselineRoas,
    outcomeSpend,
    outcomePurchases,
    outcomeRevenue,
    outcomeRoas,
    outcomeWindowDays,
  });

  return {
    decision_snapshot_id: requiredString(
      input.row.decision_snapshot_id,
      "decision_snapshot_id",
    ),
    business_ref_id: requiredString(input.row.business_ref_id, "business_ref_id"),
    business_id: toStringOrNull(input.row.business_id),
    creative_id: requiredString(input.row.creative_id, "creative_id"),
    decision_as_of_date: requiredDate(input.row.decision_as_of_date, "decision_as_of_date"),
    evaluation_date: requiredDate(input.row.evaluation_date, "evaluation_date"),
    outcome_window_days: outcomeWindowDays,
    engine_version: requiredString(input.row.engine_version, "engine_version"),
    label,
    confidence,
    effective_target_roas: effectiveTargetRoas,
    baseline_spend: baselineSpend,
    baseline_purchases: baselinePurchases,
    baseline_roas: baselineRoas,
    outcome_spend: outcomeSpend,
    outcome_purchases: outcomePurchases,
    outcome_revenue: outcomeRevenue,
    outcome_roas: outcomeRoas,
    realized_outcome: classification.realizedOutcome,
    severity: classification.severity,
    classifier_version: CREATIVE_OUTCOME_CLASSIFIER_VERSION,
    evidence_json: classification.evidence,
    job_run_id: input.jobRunId,
    computed_at: input.computedAt,
  };
}

async function insertOutcomes(rows: OutcomePayloadRow[]) {
  if (rows.length === 0) return 0;
  const inserted = await getDb().query<Record<string, unknown>>(
    INSERT_OUTCOMES_QUERY,
    [JSON.stringify(rows)],
  );
  return inserted.length;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

function requiredString(value: unknown, field: string): string {
  const text = toStringOrNull(value)?.trim();
  if (!text) throw new Error(`Missing outcome source field: ${field}`);
  return text;
}

function requiredDate(value: unknown, field: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = requiredString(value, field).slice(0, 10);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid outcome source date field: ${field}`);
  }
  return date.toISOString().slice(0, 10);
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIntegerOrNull(value: unknown): number | null {
  const parsed = toNumberOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function toDecisionLabel(value: unknown): DecisionLabel {
  const text = requiredString(value, "label");
  if (
    text === "scale" ||
    text === "keep" ||
    text === "refresh" ||
    text === "cut" ||
    text === "test_more" ||
    text === "diagnose" ||
    text === "out_of_scope"
  ) {
    return text;
  }
  throw new Error(`Unexpected decision label in outcome source: ${text}`);
}

function errorToJson(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}
