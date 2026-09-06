import { getDb, runDbTransaction } from "@/lib/db";
import {
  readCampaignContextMap,
  type CampaignContextEntryWithProvenance,
} from "../campaign-context/source";
import { resolveAccountDecisionProfile } from "../account-decision-profile";
import {
  applyCreativeCampaignLabelGuard,
  isCampaignRoleUnresolved,
  withCreativeCampaignLabelContext,
} from "../campaign-label-guard";
import { AccountScopedDataSource, WarehouseDataSource } from "../data-source";
import { decideCreative } from "../engine";
import { resolveEngineV3Flags, type EngineV3Flags } from "../feature-flags";
import {
  ENGINE_VERSION,
  type AccountDecisionProfile,
  type DecisionProfileScope,
  type DecisionAuthorityBlocker,
  type CreativeInput,
  type DecisionLabel,
  type DecisionOutput,
  type DecisionLabelTransform,
} from "../types";
import { hashAdvisoryLock } from "./calibration-job";
import { getBusinessGuardFailure } from "./business-guard";
import {
  readPreviousPublishedLabels,
  stabilizeDecisionLabel,
} from "../decision-stability";
import { ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS } from "./job-runtime";
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

type ProviderAccountByCreativeRow = Record<string, unknown> & {
  creative_id: unknown;
  provider_account_id: unknown;
};

type SnapshotRow = Record<string, unknown> & {
  id: unknown;
  creative_id: unknown;
  label: unknown;
  confidence: unknown;
};

type PruneDecisionSnapshotRow = Record<string, unknown> & {
  pruned_snapshot_count: unknown;
  pruned_event_count: unknown;
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
  raw_label: DecisionLabel;
  pre_authority_label: DecisionLabel;
  authority_blocker: DecisionAuthorityBlocker | null;
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
  blocked_action_type: "scale" | "cut" | "refresh" | null;
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

interface DecisionSnapshotPruneResult {
  prunedSnapshots: number;
  prunedEvents: number;
  skippedBecauseEmptyPayload: boolean;
}

interface PreviousSnapshot {
  id: string;
  label: DecisionLabel;
  confidence: number;
}

// Exported for the ephemeral-postgres seam check: the write side of the
// hysteresis memory must be exercised against a real database with the
// exact production query, not a mock (an in-memory test cannot catch a
// dropped column in this recordset).
export const UPSERT_DECISION_SNAPSHOTS_QUERY = `
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
    raw_label text,
    pre_authority_label text,
    authority_blocker text,
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
    blocked_action_type text,
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
  raw_label,
  pre_authority_label,
  authority_blocker,
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
  blocked_action_type,
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
  raw_label,
  pre_authority_label,
  authority_blocker,
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
  blocked_action_type,
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
  raw_label = EXCLUDED.raw_label,
  pre_authority_label = EXCLUDED.pre_authority_label,
  authority_blocker = EXCLUDED.authority_blocker,
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
  blocked_action_type = EXCLUDED.blocked_action_type,
  job_run_id = EXCLUDED.job_run_id,
  lifecycle_row_id = EXCLUDED.lifecycle_row_id,
  calibration_row_id = EXCLUDED.calibration_row_id,
  computed_at = EXCLUDED.computed_at,
  updated_at = now()
RETURNING id, creative_id, label, confidence
`;

/*
  The physical ad account each creative belongs to, in the same preference order
  `listCreativeInputs` hydrates from: the newest lifecycle row for the creative
  first (the row the decision snapshot links to), and only for a creative that
  has none, the newest warehouse day inside the 29-day window the runtime
  hydration itself reads. `NULLIF(btrim(...), '')` is what makes "no account"
  and "a blank account" the same absence, so the caller falls back to the
  business-wide profile in both.
*/
const READ_PROVIDER_ACCOUNT_BY_CREATIVE_QUERY = `
WITH lifecycle_binding AS (
  SELECT DISTINCT ON (creative_id)
    creative_id,
    NULLIF(btrim(provider_account_id), '') AS provider_account_id
  FROM engine_v3_creative_lifecycle_daily
  WHERE business_ref_id = $1::uuid
    AND engine_version = $2
    AND creative_id = ANY($3::text[])
    AND as_of_date <= $4::date
  ORDER BY creative_id, as_of_date DESC, computed_at DESC
),
warehouse_binding AS (
  SELECT DISTINCT ON (creative_id)
    creative_id,
    NULLIF(btrim(provider_account_id), '') AS provider_account_id
  FROM meta_creative_daily
  WHERE business_ref_id = $1::uuid
    AND creative_id = ANY($3::text[])
    AND date BETWEEN ($4::date - INTERVAL '29 days') AND $4::date
  ORDER BY creative_id, date DESC, updated_at DESC
)
SELECT
  COALESCE(lifecycle_binding.creative_id, warehouse_binding.creative_id)
    AS creative_id,
  COALESCE(
    lifecycle_binding.provider_account_id,
    warehouse_binding.provider_account_id
  ) AS provider_account_id
FROM lifecycle_binding
FULL OUTER JOIN warehouse_binding
  ON warehouse_binding.creative_id = lifecycle_binding.creative_id
`;

// decision_snapshot_id uses ON DELETE SET NULL for events, so stale
// decision_changed rows need an explicit prune after their snapshots are removed.
const PRUNE_STALE_DECISION_SNAPSHOTS_QUERY = `
WITH stale_snapshots AS (
  SELECT id, creative_id
  FROM engine_v3_decision_snapshots_daily
  WHERE business_ref_id = $1::uuid
    AND as_of_date = $2::date
    AND engine_version = $3
    AND scope_type = $4
    AND scope_id = $5
    AND NOT (creative_id = ANY($6::text[]))
),
deleted_snapshots AS (
  DELETE FROM engine_v3_decision_snapshots_daily snapshots
  USING stale_snapshots stale
  WHERE snapshots.id = stale.id
  RETURNING snapshots.id, snapshots.creative_id
),
deleted_events AS (
  DELETE FROM engine_v3_decision_events events
  USING deleted_snapshots snapshots
  WHERE events.business_ref_id = $1::uuid
    AND events.event_date = $2::date
    AND events.event_type = 'decision_changed'
    AND events.creative_id = snapshots.creative_id
  RETURNING events.id
)
SELECT
  (SELECT COUNT(*) FROM deleted_snapshots)::integer AS pruned_snapshot_count,
  (SELECT COUNT(*) FROM deleted_events)::integer AS pruned_event_count
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

  return runDbTransaction(
    async () => {
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
          errorMessage:
            "Advisory lock not acquired (job may already be running)",
        });
        return {
          jobRunId,
          status: "skipped",
          snapshotsWritten: 0,
          changeEventsWritten: 0,
          durationMs,
          errorMessage:
            "Advisory lock not acquired (job may already be running)",
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
        /*
          THE BUSINESS-WIDE PROFILE, which is still resolved and still resolved
          FIRST, for two reasons that are not the per-ad decisions below.

          It is the profile for a creative that names no physical account, and
          there is nothing else it could honestly be. And `getDataHealth` on the
          next line reuses the calibration metadata this call leaves on
          `dataSource` (see `buildCalibrationDataLayerHealth`), so the read that
          precedes it decides which calibration's freshness the job reports as
          the business's. That has to stay the business's `scope_id '*'` read.
        */
        const businessProfile = await resolveAccountDecisionProfile({
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
        /*
          ONE PROFILE PER PHYSICAL AD ACCOUNT, because these decisions are.

          `listCreativeInputs` is business-wide and must be: every creative the
          business runs gets a decision. But a business can hold several Meta ad
          accounts, and every measured read `resolveAccountDecisionProfile`
          makes — the account calibration and its kind-segmented variants, the
          funnel pack, and the live Meta-attributed AOV it falls back to —
          defaults to the business's whole Meta footprint. Deciding all of them
          against that one pooled profile lets one account's samples set
          another's thresholds.

          Driven before this change against a migrated database, on a business
          holding account A (six creatives, ROAS 3.60) and account B (thirty-two
          creatives), moving ONLY B's revenue moved A's RETAINED per-ad reason:

            before  "[near scale] ROAS 3.60 (28d) above commercial target (164%)
                     - spend 280 / purchases 28 below scale floor
                     (need spend >=14, >=30); observe."
            after   "... (need spend >=76, >=30); observe."

          A's own facts were untouched. The floor an operator is told account A
          must clear was set by account B's revenue, through the pooled
          Meta-attributed AOV behind the spend unit; the same pooling sets
          `bottomQuartileRatio` and `severeLoserRatio` from percentiles over
          both accounts' creatives.

          `AccountScopedDataSource` is the same wrapper the served
          commercial-anchor panel uses in
          `app/api/meta/decisions-workspace/route.ts`, so the serving and
          retention paths now measure at the same physical-account scope. It
          scopes the MEASURED reads only: the target pack, the decision
          calibration profile and the engine flags stay business-level, because
          a target ROAS is one commercial policy for the business rather than a
          per-account setting.

          A SEPARATE `WarehouseDataSource` PER ACCOUNT, deliberately. The
          instance remembers the last calibration read it made, and
          `getDataHealth` above consumes that memory; an account-scoped read on
          the shared instance would leave one account's calibration standing in
          for the business's data health.

          THE ACCOUNT COMES FROM THE WAREHOUSE, NOT FROM `CreativeInput`.
          `CreativeInput` declares an optional `providerAccountId`, and neither
          reader behind `listCreativeInputs` populates it —
          `mapLifecycleHydrationRow` and `mapCreativeHydrationRow` in
          `lib/creative-decision-engine/data-source.ts` both build the object
          without that field — so reading it here would leave every creative
          unscoped and this whole change inert. `readProviderAccountIdByCreative`
          reads the binding from the same rows the inputs were hydrated from.
        */
        const accountByCreative = await readProviderAccountIdByCreative({
          businessId: input.businessId,
          asOf: input.asOf,
          creativeIds: creativeInputs.map(
            (creativeInput) => creativeInput.creativeId,
          ),
        });
        const profileByAccount = await resolveProfilesByProviderAccount({
          businessId: input.businessId,
          asOf: input.asOf,
          flags,
          providerAccountIds: [...accountByCreative.values()],
        });
        const profileFor = (
          creativeInput: CreativeInput,
        ): AccountDecisionProfile => {
          const account = accountByCreative.get(creativeInput.creativeId);
          if (!account) return businessProfile;
          return profileByAccount.get(account) ?? businessProfile;
        };
        const campaignLabelsById = await readCreativeCampaignRolesById({
          businessId: input.businessId,
          asOf: input.asOf,
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
                decision: decideCreative(
                  inputWithCampaignKind,
                  profileFor(creativeInput),
                  dataHealth,
                ),
                input: inputWithCampaignKind,
                campaignLabelsById,
              }),
            };
          },
        );
        const dedupedDecisions = dedupeDecisionComputations(rawDecisions);
        const previousLabels = await readPreviousPublishedLabels({
          businessId: input.businessId,
          asOf: input.asOf,
          creativeIds: dedupedDecisions.map((d) => d.input.creativeId),
        });
        const rawLabelsByCreative = new Map<string, DecisionLabel>();
        const decisions = dedupedDecisions.map((computation) => {
          const stabilized = stabilizeDecisionLabel(
            computation.decision,
            previousLabels.get(computation.input.creativeId) ?? null,
          );
          rawLabelsByCreative.set(
            computation.input.creativeId,
            stabilized.rawLabel,
          );
          return { ...computation, decision: stabilized.decision };
        });

        const creativeIds = decisions.map(
          (decision) => decision.input.creativeId,
        );
        const lifecycleJoin = await findLatestLifecycleRowIdsByCreative({
          businessId: input.businessId,
          asOf: input.asOf,
          creativeIds,
        });
        const lifecycleRowIdsByCreative = lifecycleJoin.byCreative;
        const calibrationRowId = await findLatestCalibrationRowId(input);

        const computedAt = new Date().toISOString();
        const snapshotRows = decisions.map(
          ({ input: creativeInput, decision }) =>
            toSnapshotPayloadRow({
              businessId: input.businessId,
              asOf: input.asOf,
              jobRunId,
              scope: profileFor(creativeInput).scope,
              creativeInput,
              decision,
              rawLabel:
                rawLabelsByCreative.get(creativeInput.creativeId) ??
                decision.label,
              lifecycleRowId:
                lifecycleRowIdsByCreative.get(creativeInput.creativeId) ?? null,
              calibrationRowId,
              computedAt,
            }),
        );
        /*
          PRUNING IS PER SCOPE, and the scope is a different axis from the
          physical account the reads above were scoped to.
          `resolveAccountDecisionProfile` narrows the scope only when it is
          handed a `campaignId`, which this job never does, so each profile
          resolved above reports the same `{type: "account", id: "*"}` — "the
          account level rather than a campaign's". Grouping the ids by the scope
          their own profile carries, rather than pruning every scope with one
          profile's, keeps each DELETE matched to the rows it is allowed to
          delete if that ever stops being true.
        */
        const pruneResult = await pruneStaleSnapshotsPerScope({
          businessId: input.businessId,
          asOf: input.asOf,
          decisions,
          scopeFor: (creativeInput) => profileFor(creativeInput).scope,
        });
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
                pruned_snapshot_count: pruneResult.prunedSnapshots,
                pruned_event_count: pruneResult.prunedEvents,
                lagged_lifecycle_row_count: lifecycleJoin.laggedRowCount,
                ...(pruneResult.skippedBecauseEmptyPayload
                  ? { prune_skipped_empty_payload: true }
                  : {}),
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
    },
    { timeoutMs: ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS },
  );
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
  if (input.creativeIds.length === 0) {
    return { byCreative: new Map<string, string>(), laggedRowCount: 0 };
  }

  const rows = await getDb().query<RowIdByCreativeRow>(
    `
    SELECT DISTINCT ON (creative_id) creative_id, id, as_of_date::text AS as_of_date
    FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = $1::uuid
      AND engine_version = $2
      AND creative_id = ANY($3::text[])
      AND as_of_date <= $4::date
    ORDER BY creative_id, as_of_date DESC, computed_at DESC
    `,
    [input.businessId, ENGINE_VERSION, input.creativeIds, input.asOf],
  );

  // A decision can legitimately bind a prior-day lifecycle row (catch-up,
  // partial reruns). That class was previously invisible; callers count it
  // into job metadata so "today's decision on yesterday's lifecycle" is
  // observable instead of inferred during incident review.
  let laggedRowCount = 0;
  const byCreative = new Map(
    rows.flatMap((row) => {
      const creativeId = toStringOrNull(row.creative_id);
      const id = toStringOrNull(row.id);
      const rowDate = toStringOrNull((row as { as_of_date?: unknown }).as_of_date);
      if (creativeId === null || id === null) return [];
      if (rowDate !== null && rowDate < input.asOf) laggedRowCount += 1;
      return [[creativeId, id]] as const;
    }),
  );
  return { byCreative, laggedRowCount };
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
  rawLabel: DecisionLabel;
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
    raw_label: input.rawLabel,
    pre_authority_label: input.decision.preAuthorityLabel,
    authority_blocker: input.decision.authorityBlocker,
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
    blocked_action_type:
      input.decision.blockedActionType === "scale" ||
      input.decision.blockedActionType === "cut" ||
      input.decision.blockedActionType === "refresh"
        ? input.decision.blockedActionType
        : null,
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

/**
 * The physical ad account each of these creatives belongs to.
 *
 * WHY THIS EXISTS RATHER THAN `CreativeInput.providerAccountId`. That field is
 * declared optional on the type and is left undefined by both readers behind
 * `listCreativeInputs`: `mapLifecycleHydrationRow` and
 * `mapCreativeHydrationRow` in `lib/creative-decision-engine/data-source.ts`
 * construct the input without it. Scoping on it would silently scope nothing.
 *
 * WHY THESE TWO SOURCES, IN THIS ORDER. It mirrors `listCreativeInputs` itself.
 * Its preferred reader is `engine_v3_creative_lifecycle_daily`, selected
 * `DISTINCT ON (creative_id)` newest-first, and every such row carries the
 * account it was computed for — so the account here is the account of the very
 * lifecycle row the decision snapshot then links to through
 * `findLatestLifecycleRowIdsByCreative`. Its fallback reader hydrates straight
 * from `meta_creative_daily` over the trailing 29 days, which is the second
 * branch, bounded to that same window so the lookup stays on
 * `idx_meta_creative_daily_creative (creative_id, date DESC)`.
 *
 * A creative with no row in either, or whose row carries a blank account, is
 * absent from the map. The caller answers those with the business-wide profile,
 * which is the only honest reading for a creative that names no account.
 */
async function readProviderAccountIdByCreative(input: {
  businessId: string;
  asOf: string;
  creativeIds: string[];
}): Promise<Map<string, string>> {
  if (input.creativeIds.length === 0) return new Map();

  const rows = await getDb().query<ProviderAccountByCreativeRow>(
    READ_PROVIDER_ACCOUNT_BY_CREATIVE_QUERY,
    [input.businessId, ENGINE_VERSION, input.creativeIds, input.asOf],
  );

  return new Map(
    rows.flatMap((row) => {
      const creativeId = toStringOrNull(row.creative_id);
      const providerAccountId = toStringOrNull(row.provider_account_id);
      return creativeId === null || providerAccountId === null
        ? []
        : [[creativeId, providerAccountId] as const];
    }),
  );
}

/**
 * One account decision profile per distinct physical ad account named by these
 * creatives, each resolved with its MEASURED reads scoped to that account.
 *
 * `null`, blank and whitespace-only account ids are not accounts and are not
 * resolved: a creative that names no physical account has nothing to scope to,
 * and the caller answers those with the business-wide profile.
 *
 * Each account gets its own `WarehouseDataSource` because the class remembers
 * the last calibration read it made and `getDataHealth` consumes that memory,
 * so sharing one instance would let an account-scoped read stand in for the
 * business's data health. `AccountScopedDataSource` scopes only the measured
 * reads; `getBusinessTargetPack` and `getDecisionCalibrationProfile` are
 * forwarded unchanged, because they are configured commercial policy for the
 * business rather than per-account settings.
 */
async function resolveProfilesByProviderAccount(input: {
  businessId: string;
  asOf: string;
  flags: EngineV3Flags;
  providerAccountIds: ReadonlyArray<string | null | undefined>;
}): Promise<Map<string, AccountDecisionProfile>> {
  const accounts = [
    ...new Set(
      input.providerAccountIds.flatMap((account) => {
        const trimmed = account?.trim();
        return trimmed ? [trimmed] : [];
      }),
    ),
  ];
  const resolved = await Promise.all(
    accounts.map(
      async (account) =>
        [
          account,
          await resolveAccountDecisionProfile({
            businessId: input.businessId,
            asOf: input.asOf,
            dataSource: new AccountScopedDataSource(
              new WarehouseDataSource(),
              account,
            ),
            flags: input.flags,
          }),
        ] as const,
    ),
  );
  return new Map(resolved);
}

async function pruneStaleDecisionSnapshots(input: {
  businessId: string;
  asOf: string;
  scope: DecisionProfileScope;
  currentCreativeIds: string[];
}): Promise<DecisionSnapshotPruneResult> {
  if (input.currentCreativeIds.length === 0) {
    return {
      prunedSnapshots: 0,
      prunedEvents: 0,
      skippedBecauseEmptyPayload: true,
    };
  }

  const [row] = await getDb().query<PruneDecisionSnapshotRow>(
    PRUNE_STALE_DECISION_SNAPSHOTS_QUERY,
    [
      input.businessId,
      input.asOf,
      ENGINE_VERSION,
      input.scope.type,
      input.scope.id,
      input.currentCreativeIds,
    ],
  );

  return {
    prunedSnapshots: toIntegerOrNull(row?.pruned_snapshot_count) ?? 0,
    prunedEvents: toIntegerOrNull(row?.pruned_event_count) ?? 0,
    skippedBecauseEmptyPayload: false,
  };
}

/**
 * Prunes yesterday's leftover snapshots one calibration scope at a time, using
 * for each scope only the creative ids that were decided under it.
 *
 * `pruneStaleDecisionSnapshots` deletes the rows of one `(scope_type,
 * scope_id)` that are absent from the id list it is given, so a list that mixed
 * scopes would delete another scope's live rows. Today every profile this job
 * resolves reports the same scope and this collapses to the single statement it
 * replaced; the grouping is what keeps that true rather than assumed.
 *
 * An empty decision set prunes nothing at all — exactly as the single statement
 * did — because an empty payload is indistinguishable from "the upstream read
 * failed" and must never be read as "the business has no live creatives".
 */
async function pruneStaleSnapshotsPerScope(input: {
  businessId: string;
  asOf: string;
  decisions: readonly DecisionComputation[];
  scopeFor: (creativeInput: CreativeInput) => DecisionProfileScope;
}): Promise<DecisionSnapshotPruneResult> {
  const groups = new Map<
    string,
    { scope: DecisionProfileScope; creativeIds: string[] }
  >();
  for (const { input: creativeInput } of input.decisions) {
    const scope = input.scopeFor(creativeInput);
    const key = `${scope.type} ${scope.id}`;
    const group = groups.get(key);
    if (group) {
      group.creativeIds.push(creativeInput.creativeId);
    } else {
      groups.set(key, { scope, creativeIds: [creativeInput.creativeId] });
    }
  }

  if (groups.size === 0) {
    return {
      prunedSnapshots: 0,
      prunedEvents: 0,
      skippedBecauseEmptyPayload: true,
    };
  }

  let prunedSnapshots = 0;
  let prunedEvents = 0;
  for (const group of groups.values()) {
    const result = await pruneStaleDecisionSnapshots({
      businessId: input.businessId,
      asOf: input.asOf,
      scope: group.scope,
      currentCreativeIds: group.creativeIds,
    });
    prunedSnapshots += result.prunedSnapshots;
    prunedEvents += result.prunedEvents;
  }
  return {
    prunedSnapshots,
    prunedEvents,
    skippedBecauseEmptyPayload: false,
  };
}

async function findPreviousSnapshotsByCreative(input: {
  businessId: string;
  asOf: string;
  creativeIds: string[];
}) {
  if (input.creativeIds.length === 0)
    return new Map<string, PreviousSnapshot>();

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

async function readCreativeCampaignRolesById(input: {
  businessId: string;
  asOf: string;
  creativeInputs: CreativeInput[];
}) {
  const campaignIds = Array.from(
    new Set(
      input.creativeInputs
        .map((creativeInput) => creativeInput.campaignId?.trim() || "")
        .filter(Boolean),
    ),
  );
  // D074: no live call site may touch the legacy label-map helper. An empty
  // campaign set simply has no roles.
  if (campaignIds.length === 0) {
    return new Map<string, CampaignContextEntryWithProvenance>();
  }

  const accountByCampaign = new Map<string, string | null>();
  for (const creativeInput of input.creativeInputs) {
    const campaignId = creativeInput.campaignId?.trim();
    if (!campaignId) continue;
    const providerAccountId = creativeInput.providerAccountId?.trim() || null;
    if (!accountByCampaign.has(campaignId)) {
      accountByCampaign.set(campaignId, providerAccountId);
    } else if (accountByCampaign.get(campaignId) !== providerAccountId) {
      // A campaign identity crossing physical accounts is not trustworthy.
      accountByCampaign.set(campaignId, null);
    }
  }
  const grouped = new Map<string | null, string[]>();
  for (const campaignId of campaignIds) {
    const providerAccountId = accountByCampaign.get(campaignId) ?? null;
    grouped.set(providerAccountId, [
      ...(grouped.get(providerAccountId) ?? []),
      campaignId,
    ]);
  }
  const resolved = await Promise.all(
    [...grouped].map(([providerAccountId, scopedCampaignIds]) =>
      readCampaignContextMap({
        businessId: input.businessId,
        providerAccountId,
        campaignIds: scopedCampaignIds,
        asOf: input.asOf,
      }),
    ),
  );
  return new Map(resolved.flatMap((map) => [...map]));
}

function isHardDecisionLabel(label: DecisionLabel) {
  return label === "scale" || label === "cut" || label === "refresh";
}

function normalizePreviousSnapshotForCampaignLabelGuard(
  previous: PreviousSnapshot,
  currentDecision: DecisionOutput,
): PreviousSnapshot {
  if (
    isCampaignRoleUnresolved(currentDecision) &&
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

async function insertDecisionChangeEvents(
  rows: DecisionChangeEventPayloadRow[],
) {
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
