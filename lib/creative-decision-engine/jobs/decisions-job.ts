import { getDb, runDbTransaction } from "@/lib/db";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import { resolveAccountDecisionProfile } from "../account-decision-profile";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  withCreativeCampaignLabelContext,
} from "../campaign-label-guard";
import { WarehouseDataSource } from "../data-source";
import { decideCreative } from "../engine";
import { resolveEngineV3Flags } from "../feature-flags";
import {
  ENGINE_VERSION,
  type DecisionProfileScope,
  type CreativeInput,
  type DecisionLabel,
  type DecisionOutput,
  type DecisionLabelTransform,
} from "../types";
import { hashAdvisoryLock } from "./calibration-job";
import { getBusinessGuardFailure } from "./business-guard";
import { JOB_NAME as LIFECYCLE_JOB_NAME } from "./lifecycle-job";

export const JOB_NAME = "engine_v3_decisions_job";

type JobStatus = "success" | "failed" | "skipped";

export interface DecisionsJobInput {
  businessId: string;
  asOf: string;
}

export interface DecisionsJobResult {
  jobRunId: string;
  status: JobStatus;
  snapshotsWritten: number;
  changeEventsWritten: number;
  durationMs: number;
  reason?: "engine_v3_disabled" | "business_not_found" | "invalid_business_id";
  errorMessage?: string;
}

type AdvisoryLockRow = Record<string, unknown> & {
  acquired: unknown;
};

type JobRunIdRow = Record<string, unknown> & {
  id: unknown;
};

type RowIdByCreativeRow = Record<string, unknown> & {
  creative_id: unknown;
  id: unknown;
};

type SnapshotRow = Record<string, unknown> & {
  id: unknown;
  creative_id: unknown;
  label: unknown;
  confidence: unknown;
};

type InsertedEventRow = Record<string, unknown> & {
  id: unknown;
};

export interface DecisionComputation {
  input: CreativeInput;
  decision: DecisionOutput;
}

interface DecisionSnapshotPayloadRow {
  business_ref_id: string;
  business_id: string;
  creative_id: string;
  as_of_date: string;
  engine_version: string;
  scope_type: DecisionProfileScope["type"];
  scope_id: string;
  label: DecisionLabel;
  confidence: number;
  truth_source: DecisionOutput["truthSource"];
  effective_target_roas: number;
  ratio_to_target: number | null;
  badges: DecisionOutput["badges"];
  reason: string;
  spend: number;
  purchases: number;
  roas: number | null;
  recent7d_roas: number | null;
  label_transform: DecisionLabelTransform | null;
  job_run_id: string;
  lifecycle_row_id: string | null;
  calibration_row_id: string | null;
  computed_at: string;
}

interface DecisionChangeEventPayloadRow {
  business_ref_id: string;
  business_id: string;
  creative_id: string;
  event_date: string;
  previous_label: DecisionLabel;
  current_label: DecisionLabel;
  previous_confidence: number;
  current_confidence: number;
  previous_decision_snapshot_id: string;
  decision_snapshot_id: string;
  job_run_id: string;
}

interface CurrentSnapshot {
  id: string;
  label: DecisionLabel;
  confidence: number;
}

interface PreviousSnapshot {
  id: string;
  label: DecisionLabel;
  confidence: number;
}

const UPSERT_DECISION_SNAPSHOTS_QUERY = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    business_ref_id uuid,
    business_id text,
    creative_id text,
    as_of_date date,
    engine_version text,
    scope_type text,
    scope_id text,
    label text,
    confidence integer,
    truth_source text,
    effective_target_roas double precision,
    ratio_to_target double precision,
    badges jsonb,
    reason text,
    spend double precision,
    purchases double precision,
    roas double precision,
    recent7d_roas double precision,
    label_transform text,
    job_run_id uuid,
    lifecycle_row_id uuid,
    calibration_row_id uuid,
    computed_at timestamptz
  )
)
INSERT INTO engine_v3_decision_snapshots_daily (
  business_ref_id,
  business_id,
  creative_id,
  as_of_date,
  engine_version,
  scope_type,
  scope_id,
  label,
  confidence,
  truth_source,
  effective_target_roas,
  ratio_to_target,
  badges,
  reason,
  spend,
  purchases,
  roas,
  recent7d_roas,
  label_transform,
  job_run_id,
  lifecycle_row_id,
  calibration_row_id,
  computed_at
)
SELECT
  business_ref_id,
  business_id,
  creative_id,
  as_of_date,
  engine_version,
  scope_type,
  scope_id,
  label,
  confidence,
  truth_source,
  effective_target_roas,
  ratio_to_target,
  badges,
  reason,
  spend,
  purchases,
  roas,
  recent7d_roas,
  label_transform,
  job_run_id,
  lifecycle_row_id,
  calibration_row_id,
  computed_at
FROM payload
ON CONFLICT (business_ref_id, creative_id, as_of_date, engine_version, scope_type, scope_id)
DO UPDATE SET
  business_id = EXCLUDED.business_id,
  scope_type = EXCLUDED.scope_type,
  scope_id = EXCLUDED.scope_id,
  label = EXCLUDED.label,
  confidence = EXCLUDED.confidence,
  truth_source = EXCLUDED.truth_source,
  effective_target_roas = EXCLUDED.effective_target_roas,
  ratio_to_target = EXCLUDED.ratio_to_target,
  badges = EXCLUDED.badges,
  reason = EXCLUDED.reason,
  spend = EXCLUDED.spend,
  purchases = EXCLUDED.purchases,
  roas = EXCLUDED.roas,
  recent7d_roas = EXCLUDED.recent7d_roas,
  label_transform = EXCLUDED.label_transform,
  job_run_id = EXCLUDED.job_run_id,
  lifecycle_row_id = EXCLUDED.lifecycle_row_id,
  calibration_row_id = EXCLUDED.calibration_row_id,
  computed_at = EXCLUDED.computed_at,
  updated_at = now()
RETURNING id, creative_id, label, confidence
`;

const INSERT_DECISION_CHANGE_EVENTS_QUERY = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    business_ref_id uuid,
    business_id text,
    creative_id text,
    event_date date,
    previous_label text,
    current_label text,
    previous_confidence integer,
    current_confidence integer,
    previous_decision_snapshot_id uuid,
    decision_snapshot_id uuid,
    job_run_id uuid
  )
)
INSERT INTO engine_v3_decision_events (
  business_ref_id,
  business_id,
  creative_id,
  event_date,
  event_type,
  previous_label,
  current_label,
  previous_confidence,
  current_confidence,
  operator_evidence,
  decision_snapshot_id,
  job_run_id
)
SELECT
  payload.business_ref_id,
  payload.business_id,
  payload.creative_id,
  payload.event_date,
  'decision_changed',
  payload.previous_label,
  payload.current_label,
  payload.previous_confidence,
  payload.current_confidence,
  jsonb_build_object(
    'previous_decision_snapshot_id', payload.previous_decision_snapshot_id,
    'current_decision_snapshot_id', payload.decision_snapshot_id
  ),
  payload.decision_snapshot_id,
  payload.job_run_id
FROM payload
WHERE NOT EXISTS (
  SELECT 1
  FROM engine_v3_decision_events existing
  WHERE existing.business_ref_id = payload.business_ref_id
    AND existing.creative_id = payload.creative_id
    AND existing.event_date = payload.event_date
    AND existing.event_type = 'decision_changed'
    AND existing.previous_label IS NOT DISTINCT FROM payload.previous_label
    AND existing.current_label IS NOT DISTINCT FROM payload.current_label
    AND existing.decision_snapshot_id IS NOT DISTINCT FROM payload.decision_snapshot_id
)
RETURNING id
`;

export function decisionsJobAdvisoryLockKey(input: DecisionsJobInput): bigint {
  return hashAdvisoryLock(`${JOB_NAME}:${input.businessId}:${input.asOf}`);
}

export async function runDecisionsJob(
  input: DecisionsJobInput,
): Promise<DecisionsJobResult> {
  const startedAt = Date.now();
  const businessGuardFailure = await getBusinessGuardFailure(input.businessId);
  if (businessGuardFailure?.reason === "invalid_business_id") {
    return {
      jobRunId: "",
      status: "failed",
      snapshotsWritten: 0,
      changeEventsWritten: 0,
      durationMs: Date.now() - startedAt,
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
      dependencyRunId: null,
      durationMs,
      rowCount: 0,
      errorMessage: businessGuardFailure.message,
      errorJson: businessGuardFailure.errorJson,
    });
    return {
      jobRunId,
      status: "failed",
      snapshotsWritten: 0,
      changeEventsWritten: 0,
      durationMs,
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
      dependencyRunId: null,
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
      snapshotsWritten: 0,
      changeEventsWritten: 0,
      durationMs,
      reason: "engine_v3_disabled",
    };
  }

  const lockKey = decisionsJobAdvisoryLockKey(input);

  return runDbTransaction(async () => {
    const db = getDb();
    const [lockRow] = await db.query<AdvisoryLockRow>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [lockKey.toString()],
    );
    const dependencyRunId = await findLatestSuccessfulLifecycleRun(input);

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
        status: "skipped",
        snapshotsWritten: 0,
        changeEventsWritten: 0,
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

    await db.query("SAVEPOINT engine_v3_decisions_job_work");
    try {
      const dataSource = new WarehouseDataSource();
      const profile = await resolveAccountDecisionProfile({
        businessId: input.businessId,
        asOf: input.asOf,
        dataSource,
        flags,
      });
      const dataHealth = await dataSource.getDataHealth({
        businessId: input.businessId,
        asOf: input.asOf,
      });
      const creativeInputs = await dataSource.listCreativeInputs({
        businessId: input.businessId,
        asOf: input.asOf,
      });
      const campaignLabelsById =
        await readCreativeCampaignLabelsById({
          businessId: input.businessId,
          creativeInputs,
        });
      const rawDecisions: DecisionComputation[] = creativeInputs.map(
        (creativeInput) => {
          const inputWithCampaignKind = withCreativeCampaignLabelContext(
            creativeInput,
            campaignLabelsById,
          );
          return {
            input: inputWithCampaignKind,
            decision: applyCreativeCampaignLabelGuard({
              decision: decideCreative(inputWithCampaignKind, profile, dataHealth),
              input: inputWithCampaignKind,
              campaignLabelsById,
            }),
          };
        },
      );
      const decisions = dedupeDecisionComputations(rawDecisions);

      const creativeIds = decisions.map((decision) => decision.input.creativeId);
      const lifecycleRowIdsByCreative =
        await findLatestLifecycleRowIdsByCreative({
          businessId: input.businessId,
          asOf: input.asOf,
          creativeIds,
        });
      const calibrationRowId = await findLatestCalibrationRowId(input);

      const computedAt = new Date().toISOString();
      const snapshotRows = decisions.map(({ input: creativeInput, decision }) =>
        toSnapshotPayloadRow({
          businessId: input.businessId,
          asOf: input.asOf,
          jobRunId,
          scope: profile.scope,
          creativeInput,
          decision,
          lifecycleRowId:
            lifecycleRowIdsByCreative.get(creativeInput.creativeId) ?? null,
          calibrationRowId,
          computedAt,
        }),
      );
      const upsertedSnapshots = await upsertDecisionSnapshots(snapshotRows);
      const snapshotsWritten = upsertedSnapshots.size;

      const previousSnapshots = await findPreviousSnapshotsByCreative({
        businessId: input.businessId,
        asOf: input.asOf,
        creativeIds,
      });
      const changeEventRows = toDecisionChangeEventRows({
        businessId: input.businessId,
        asOf: input.asOf,
        jobRunId,
        decisions,
        previousSnapshots,
        currentSnapshots: upsertedSnapshots,
      });
      const changeEventsWritten =
        await insertDecisionChangeEvents(changeEventRows);

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
          snapshotsWritten,
          JSON.stringify({
            metadata: {
              change_event_count: changeEventsWritten,
            },
          }),
          jobRunId,
        ],
      );

      return {
        jobRunId,
        status: "success",
        snapshotsWritten,
        changeEventsWritten,
        durationMs,
      };
    } catch (error) {
      await db
        .query("ROLLBACK TO SAVEPOINT engine_v3_decisions_job_work")
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
        snapshotsWritten: 0,
        changeEventsWritten: 0,
        durationMs,
        errorMessage: message,
      };
    }
  });
}

async function findLatestSuccessfulLifecycleRun(input: DecisionsJobInput) {
  const [row] = await getDb().query<JobRunIdRow>(
    `
    SELECT id
    FROM engine_v3_job_runs
    WHERE job_name = $1
      AND business_ref_id = $2::uuid
      AND as_of_date = $3::date
      AND engine_version = $4
      AND status = 'success'
    ORDER BY finished_at DESC NULLS LAST, started_at DESC
    LIMIT 1
    `,
    [LIFECYCLE_JOB_NAME, input.businessId, input.asOf, ENGINE_VERSION],
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
  errorJson?: unknown;
}) {
  const [row] = await getDb().query<JobRunIdRow>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, dependency_run_id, finished_at, duration_ms, row_count, error_message,
      error_json
    )
    VALUES (
      $1, $2::uuid, $3, $4::date, $5,
      $6, $7::uuid, CASE WHEN $6 = 'running' THEN NULL ELSE now() END,
      $8::integer, $9::integer, $10, $11::jsonb
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
      input.errorJson === undefined ? null : JSON.stringify(input.errorJson),
    ],
  );

  const id = toStringOrNull(row?.id);
  if (id === null) {
    throw new Error("Decisions job run insert did not return an id.");
  }
  return id;
}

async function findLatestLifecycleRowIdsByCreative(input: {
  businessId: string;
  asOf: string;
  creativeIds: string[];
}) {
  if (input.creativeIds.length === 0) return new Map<string, string>();

  const rows = await getDb().query<RowIdByCreativeRow>(
    `
    SELECT DISTINCT ON (creative_id) creative_id, id
    FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = $1::uuid
      AND engine_version = $2
      AND creative_id = ANY($3::text[])
      AND as_of_date <= $4::date
    ORDER BY creative_id, as_of_date DESC, computed_at DESC
    `,
    [input.businessId, ENGINE_VERSION, input.creativeIds, input.asOf],
  );

  return new Map(
    rows.flatMap((row) => {
      const creativeId = toStringOrNull(row.creative_id);
      const id = toStringOrNull(row.id);
      return creativeId !== null && id !== null ? [[creativeId, id]] : [];
    }),
  );
}

async function findLatestCalibrationRowId(input: DecisionsJobInput) {
  const [row] = await getDb().query<JobRunIdRow>(
    `
    SELECT id
    FROM engine_v3_account_calibration_daily
    WHERE business_ref_id = $1::uuid
      AND scope_type = 'account'
      AND scope_id = '*'
      AND campaign_kind = 'all'
      AND creative_format = 'overall'
      AND engine_version = $2
      AND as_of_date <= $3::date
    ORDER BY as_of_date DESC, computed_at DESC
    LIMIT 1
    `,
    [input.businessId, ENGINE_VERSION, input.asOf],
  );

  return toStringOrNull(row?.id);
}

function toSnapshotPayloadRow(input: {
  businessId: string;
  asOf: string;
  jobRunId: string;
  scope: DecisionProfileScope;
  creativeInput: CreativeInput;
  decision: DecisionOutput;
  lifecycleRowId: string | null;
  calibrationRowId: string | null;
  computedAt: string;
}): DecisionSnapshotPayloadRow {
  return {
    business_ref_id: input.businessId,
    business_id: input.businessId,
    creative_id: input.creativeInput.creativeId,
    as_of_date: input.asOf,
    engine_version: ENGINE_VERSION,
    scope_type: input.scope.type,
    scope_id: input.scope.id,
    label: input.decision.label,
    confidence: toConfidenceInteger(input.decision.confidence),
    truth_source: input.decision.truthSource,
    effective_target_roas: input.decision.effectiveTargetRoas,
    ratio_to_target: input.decision.ratioToTarget,
    badges: input.decision.badges,
    reason: input.decision.reason,
    spend: input.creativeInput.spend,
    purchases: input.creativeInput.purchases,
    roas: input.creativeInput.roas,
    recent7d_roas: input.creativeInput.recent7dRoas,
    label_transform: input.decision.labelTransform ?? null,
    job_run_id: input.jobRunId,
    lifecycle_row_id: input.lifecycleRowId,
    calibration_row_id: input.calibrationRowId,
    computed_at: input.computedAt,
  };
}

async function upsertDecisionSnapshots(rows: DecisionSnapshotPayloadRow[]) {
  if (rows.length === 0) return new Map<string, CurrentSnapshot>();

  const upsertedRows = await getDb().query<SnapshotRow>(
    UPSERT_DECISION_SNAPSHOTS_QUERY,
    [JSON.stringify(rows)],
  );

  return new Map(
    upsertedRows.flatMap((row) => {
      const creativeId = toStringOrNull(row.creative_id);
      const id = toStringOrNull(row.id);
      const label = toDecisionLabel(row.label);
      const confidence = toIntegerOrNull(row.confidence);
      return creativeId !== null &&
        id !== null &&
        label !== null &&
        confidence !== null
        ? [[creativeId, { id, label, confidence } satisfies CurrentSnapshot]]
        : [];
    }),
  );
}

async function findPreviousSnapshotsByCreative(input: {
  businessId: string;
  asOf: string;
  creativeIds: string[];
}) {
  if (input.creativeIds.length === 0) return new Map<string, PreviousSnapshot>();

  const rows = await getDb().query<SnapshotRow>(
    `
    SELECT DISTINCT ON (creative_id)
      creative_id, id, label, confidence
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
      AND engine_version = $2
      AND creative_id = ANY($3::text[])
      AND as_of_date < $4::date
      AND scope_type = 'account'
      AND scope_id = '*'
    ORDER BY creative_id, as_of_date DESC, computed_at DESC
    `,
    [input.businessId, ENGINE_VERSION, input.creativeIds, input.asOf],
  );

  return new Map(
    rows.flatMap((row) => {
      const creativeId = toStringOrNull(row.creative_id);
      const id = toStringOrNull(row.id);
      const label = toDecisionLabel(row.label);
      const confidence = toIntegerOrNull(row.confidence);
      return creativeId !== null &&
        id !== null &&
        label !== null &&
        confidence !== null
        ? [[creativeId, { id, label, confidence } satisfies PreviousSnapshot]]
        : [];
    }),
  );
}

function toDecisionChangeEventRows(input: {
  businessId: string;
  asOf: string;
  jobRunId: string;
  decisions: DecisionComputation[];
  previousSnapshots: Map<string, PreviousSnapshot>;
  currentSnapshots: Map<string, CurrentSnapshot>;
}): DecisionChangeEventPayloadRow[] {
  return input.decisions.flatMap(({ input: creativeInput, decision }) => {
    const previous = input.previousSnapshots.get(creativeInput.creativeId);
    const current = input.currentSnapshots.get(creativeInput.creativeId);
    const comparablePrevious =
      previous === undefined
        ? undefined
        : normalizePreviousSnapshotForCampaignLabelGuard(previous, decision);
    if (
      comparablePrevious === undefined ||
      current === undefined ||
      comparablePrevious.label === decision.label
    ) {
      return [];
    }

    return [
      {
        business_ref_id: input.businessId,
        business_id: input.businessId,
        creative_id: creativeInput.creativeId,
        event_date: input.asOf,
        previous_label: comparablePrevious.label,
        current_label: current.label,
        previous_confidence: comparablePrevious.confidence,
        current_confidence: current.confidence,
        previous_decision_snapshot_id: comparablePrevious.id,
        decision_snapshot_id: current.id,
        job_run_id: input.jobRunId,
      },
    ];
  });
}

const DECISION_LABEL_PRIORITY: Record<DecisionLabel, number> = {
  cut: 70,
  scale: 60,
  refresh: 50,
  diagnose: 40,
  test_more: 30,
  keep: 20,
  out_of_scope: 10,
};

function compareDecisionComputations(
  left: DecisionComputation,
  right: DecisionComputation,
): number {
  return (
    DECISION_LABEL_PRIORITY[left.decision.label] -
      DECISION_LABEL_PRIORITY[right.decision.label] ||
    toConfidenceInteger(left.decision.confidence) -
      toConfidenceInteger(right.decision.confidence) ||
    (Number.isFinite(left.input.spend) ? left.input.spend : 0) -
      (Number.isFinite(right.input.spend) ? right.input.spend : 0) ||
    (left.input.campaignId ?? "").localeCompare(right.input.campaignId ?? "")
  );
}

export function dedupeDecisionComputations(
  computations: readonly DecisionComputation[],
): DecisionComputation[] {
  const byCreativeId = new Map<string, DecisionComputation>();

  for (const computation of computations) {
    const current = byCreativeId.get(computation.input.creativeId);
    if (!current) {
      byCreativeId.set(computation.input.creativeId, computation);
      continue;
    }

    if (compareDecisionComputations(computation, current) > 0) {
      byCreativeId.set(computation.input.creativeId, computation);
    }
  }

  return Array.from(byCreativeId.values()).sort((left, right) =>
    left.input.creativeId.localeCompare(right.input.creativeId),
  );
}

async function readCreativeCampaignLabelsById(input: {
  businessId: string;
  creativeInputs: CreativeInput[];
}) {
  const campaignIds = Array.from(
    new Set(
      input.creativeInputs
        .map((creativeInput) => creativeInput.campaignId?.trim() || "")
        .filter(Boolean),
    ),
  );
  if (campaignIds.length === 0) return buildCreativeCampaignLabelMap([]);

  return buildCreativeCampaignLabelMap(
    await readMetaCampaignLabels({
      businessId: input.businessId,
      campaignIds,
    }),
  );
}

function isHardDecisionLabel(label: DecisionLabel) {
  return label === "scale" || label === "cut" || label === "refresh";
}

function normalizePreviousSnapshotForCampaignLabelGuard(
  previous: PreviousSnapshot,
  currentDecision: DecisionOutput,
): PreviousSnapshot {
  if (
    (currentDecision.campaignLabelStatus === "unlabeled" ||
      currentDecision.campaignLabelStatus === "no_campaign") &&
    isHardDecisionLabel(previous.label)
  ) {
    return {
      ...previous,
      label: "diagnose",
      confidence: Math.min(previous.confidence, 50),
    };
  }

  return previous;
}

async function insertDecisionChangeEvents(rows: DecisionChangeEventPayloadRow[]) {
  if (rows.length === 0) return 0;

  const insertedRows = await getDb().query<InsertedEventRow>(
    INSERT_DECISION_CHANGE_EVENTS_QUERY,
    [JSON.stringify(rows)],
  );
  return insertedRows.length;
}

function toConfidenceInteger(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

function toDecisionLabel(value: unknown): DecisionLabel | null {
  const text = toStringOrNull(value);
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
  return null;
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
