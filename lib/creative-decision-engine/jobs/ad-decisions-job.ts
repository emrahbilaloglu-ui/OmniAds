import { getDb, runDbTransaction, type DbClient } from "@/lib/db";
import {
  NATIVE_AD_THIN_EXACT_FALLBACK_CELL,
  resolveNativeAdAccountDecisionProfile,
  type NativeAdAccountProfileDataSource,
} from "../ad-account-decision-profile";
import {
  WarehouseNativeAdAccountProfileDataSource,
  inspectNativeAdProfileSchemaCapability,
} from "../ad-account-decision-profile-store";
import { chunkDecisionRows } from "../batching";
import {
  applyCreativeCampaignLabelGuard,
  withCreativeCampaignLabelContext,
} from "../campaign-label-guard";
import {
  campaignContextProvenanceFor,
  readCampaignContextMap,
  resolveCampaignContextMode,
  type CampaignContextMap,
} from "../campaign-context/source";
import {
  buildCanonicalEvaluationProvenance,
  canonicalSha256,
  type CampaignContextProvenance,
  type NativeAdSoftOnlyDecisionProfile,
  type PriorHysteresisProvenance,
} from "../canonical-evaluation";
import {
  WarehouseDataSource,
  hashAdDecisionIdentityManifest,
  type AdDecisionHydrationResult,
  type AdDecisionHydrationReceipt,
} from "../data-source";
import {
  FATIGUE_SIGNIFICANT_DECAY_THRESHOLD,
  FATIGUE_STRONG_WINDOW_FALLBACK_ROAS,
} from "../config-values";
import { buildDataLayerHealth, composeDataHealth } from "../data-health";
import {
  adDecisionStabilityKey,
  readPreviousPublishedAdLabels,
  stabilizeDecisionLabel,
  type PreviousAdPublishedLabel,
} from "../decision-stability";
import { decideCreative } from "../engine";
import {
  adDecisionEvaluationIdentityKey,
  assertEvaluationStoreSchemaReady,
  buildAdCanonicalEvaluationProvenance,
  inspectEvaluationStoreSchemaCapability,
  persistAdDecisionEvaluations,
  type StoredAdDecisionEvaluation,
} from "../evaluation-store";
import { resolveEngineV3Flags, type EngineV3Flags } from "../feature-flags";
import {
  NATIVE_AD_ENGINE_VERSION,
  type AccountDecisionProfile,
  type AdDecisionInput,
  type AdDecisionOutput,
  type AdDisjointBandObservation,
  type CreativeInput,
  type DataHealth,
  type DecisionAuthorityBlocker,
  type DecisionLabel,
  type DecisionLabelTransform,
  type DecisionOutput,
  type DecisionProfileScope,
} from "../types";
import type { NativeAdCalibrationCell } from "./ad-calibration-job";
import { AD_CALIBRATION_JOB_NAME } from "./ad-calibration-job";
import { getBusinessGuardFailure } from "./business-guard";
import { hashAdvisoryLock } from "./calibration-job";
import { ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS } from "./job-runtime";

export const AD_DECISIONS_JOB_NAME = "engine_v3_native_ad_decisions_shadow_job";

type JobStatus = "success" | "failed" | "skipped";

export interface AdDecisionsJobInput {
  businessId: string;
  asOf: string;
}

export interface AdDecisionsJobRuntimeOptions {
  db?: DbClient;
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  businessGuard?: typeof getBusinessGuardFailure;
  resolveFlags?: (businessId: string) => Promise<EngineV3Flags>;
  dataSource?: Pick<WarehouseDataSource, "hydrateAdDecisionInputs">;
  profileDataSource?: NativeAdProfileRuntimeDataSource;
  inspectProfileSchema?: typeof inspectNativeAdProfileSchemaCapability;
}

export interface AdDecisionsJobResult {
  jobRunId: string;
  status: JobStatus;
  snapshotsWritten: number;
  changeEventsWritten: number;
  durationMs: number;
  reason?:
    | "engine_v3_disabled"
    | "business_not_found"
    | "invalid_business_id"
    | "schema_not_ready";
  errorMessage?: string;
}

export interface AdDecisionComputation {
  input: AdDecisionInput;
  decision: AdDecisionOutput;
  rawLabel: DecisionLabel;
  hysteresisSuppressed: boolean;
  campaignContext: CampaignContextProvenance;
  priorHysteresis: PriorHysteresisProvenance;
}

export interface NativeAdDecisionProfileGroup {
  key: string;
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  calibrationCell: NativeAdCalibrationCell | null;
  calibrationRowId: string | null;
  blocker: string | null;
  adInputs: AdDecisionInput[];
}

interface NativeAdDecisionRuntimeGroup extends NativeAdDecisionProfileGroup {
  dataHealth: DataHealth;
  decisions: AdDecisionComputation[];
}

interface NativeAdDecisionScopeGroup {
  scope: DecisionProfileScope;
  adInputs: AdDecisionInput[];
  decisions: AdDecisionComputation[];
}

interface NativeAdProfileRequestContext {
  providerAccountRefId: string;
  providerAccountId: string;
  accountTimezone: string;
  accountCurrency: string;
  objective: string;
  optimizationGoal: string | null;
  customEventType: string | null;
  cohort: NonNullable<AdDecisionInput["effectiveCohort"]>;
}

export interface NativeAdProfileRuntimeDataSource extends NativeAdAccountProfileDataSource {
  getNativeCalibrationRowId(cell: NativeAdCalibrationCell): Promise<string>;
}

export class NativeAdProfileProvenanceError extends Error {
  readonly code = "native_ad_profile_provenance_invalid";

  constructor(readonly details: string) {
    super(`Native ad profile provenance is invalid: ${details}`);
    this.name = "NativeAdProfileProvenanceError";
  }
}

type AdvisoryLockRow = Record<string, unknown> & { acquired: unknown };
type IdRow = Record<string, unknown> & { id: unknown };
type CountRow = Record<string, unknown> & {
  pruned_snapshot_count: unknown;
  pruned_event_count: unknown;
};
type NativeSnapshotRow = Record<string, unknown> & {
  id: unknown;
  provider_account_ref_id: unknown;
  provider_account_id: unknown;
  decision_entity_type: unknown;
  decision_entity_id: unknown;
  scope_type: unknown;
  scope_id: unknown;
  label: unknown;
  confidence: unknown;
};

export interface NativeSnapshotPayloadRow {
  business_ref_id: string;
  business_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  decision_entity_type: "ad";
  decision_entity_id: string;
  ad_id: string;
  creative_id: string | null;
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
  authorized_action: "scale" | "cut" | "refresh" | null;
  job_run_id: string;
  creative_evidence_lifecycle_row_id: string | null;
  calibration_row_id: string | null;
  evaluation_id: string;
  input_hash: string;
  decision_hash: string;
  computed_at: string;
}

export interface NativeDecisionChangeEventPayloadRow {
  business_ref_id: string;
  business_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  decision_entity_type: "ad";
  decision_entity_id: string;
  ad_id: string;
  creative_id: string | null;
  event_date: string;
  engine_version: string;
  scope_type: DecisionProfileScope["type"];
  scope_id: string;
  previous_label: DecisionLabel;
  current_label: DecisionLabel;
  previous_confidence: number;
  current_confidence: number;
  previous_decision_snapshot_id: string;
  decision_snapshot_id: string;
  job_run_id: string;
}

export interface ComparableNativeAdSnapshot {
  id: string;
  label: DecisionLabel;
  confidence: number;
}

interface NativeSnapshotPruneResult {
  prunedSnapshots: number;
  prunedEvents: number;
  skippedBecauseEmptyPayload: boolean;
  skippedUnprovenReceiptCount: number;
  authoritativeReceiptCount: number;
}

export const UPSERT_NATIVE_AD_DECISION_SNAPSHOTS_QUERY = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    business_ref_id uuid,
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    decision_entity_type text,
    decision_entity_id text,
    ad_id text,
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
    authorized_action text,
    job_run_id uuid,
    creative_evidence_lifecycle_row_id uuid,
    calibration_row_id uuid,
    evaluation_id uuid,
    input_hash text,
    decision_hash text,
    computed_at timestamptz
  )
), linked AS (
  SELECT payload.*
  FROM payload
  INNER JOIN engine_v3_ad_decision_evaluations evaluation
    ON evaluation.id = payload.evaluation_id
   AND evaluation.business_ref_id = payload.business_ref_id
   AND evaluation.business_id = payload.business_id
   AND evaluation.provider_account_ref_id = payload.provider_account_ref_id
   AND evaluation.provider_account_id = payload.provider_account_id
   AND evaluation.decision_entity_type = payload.decision_entity_type
   AND evaluation.decision_entity_id = payload.decision_entity_id
   AND evaluation.ad_id = payload.ad_id
   AND evaluation.as_of_date = payload.as_of_date
   AND evaluation.engine_version = payload.engine_version
   AND evaluation.scope_type = payload.scope_type
   AND evaluation.scope_id = payload.scope_id
   AND evaluation.input_hash = payload.input_hash
   AND evaluation.decision_hash = payload.decision_hash
   AND evaluation.job_run_id = payload.job_run_id
), deleted_existing_change_events AS (
  DELETE FROM engine_v3_ad_decision_events event
  USING linked current_row
  WHERE event.business_ref_id = current_row.business_ref_id
    AND event.provider_account_ref_id = current_row.provider_account_ref_id
    AND event.provider_account_id = current_row.provider_account_id
    AND event.decision_entity_type = current_row.decision_entity_type
    AND event.decision_entity_id = current_row.decision_entity_id
    AND event.event_date = current_row.as_of_date
    AND event.engine_version = current_row.engine_version
    AND event.scope_type = current_row.scope_type
    AND event.scope_id = current_row.scope_id
    AND event.event_type = 'decision_changed'
  RETURNING event.id
)
INSERT INTO engine_v3_ad_decision_snapshots_daily (
  business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type,
  decision_entity_id, ad_id, creative_id, as_of_date, engine_version,
  scope_type, scope_id, label, raw_label, pre_authority_label, authority_blocker,
  confidence, truth_source,
  effective_target_roas, ratio_to_target, badges, reason, spend, purchases,
  roas, recent7d_roas, label_transform, blocked_action_type, authorized_action, job_run_id,
  creative_evidence_lifecycle_row_id, calibration_row_id, evaluation_id, input_hash,
  decision_hash, computed_at
)
SELECT
  business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type,
  decision_entity_id, ad_id, creative_id, as_of_date, engine_version,
  scope_type, scope_id, label, raw_label, pre_authority_label, authority_blocker,
  confidence, truth_source,
  effective_target_roas, ratio_to_target, badges, reason, spend, purchases,
  roas, recent7d_roas, label_transform, blocked_action_type, authorized_action, job_run_id,
  creative_evidence_lifecycle_row_id, calibration_row_id, evaluation_id, input_hash,
  decision_hash, computed_at
FROM linked
WHERE (SELECT COUNT(*) FROM deleted_existing_change_events) >= 0
ON CONFLICT (
  business_ref_id, provider_account_ref_id, provider_account_id, decision_entity_type,
  decision_entity_id, as_of_date, engine_version, scope_type, scope_id
)
DO UPDATE SET
  business_id = EXCLUDED.business_id,
  provider_account_ref_id = EXCLUDED.provider_account_ref_id,
  ad_id = EXCLUDED.ad_id,
  creative_id = EXCLUDED.creative_id,
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
  authorized_action = EXCLUDED.authorized_action,
  job_run_id = EXCLUDED.job_run_id,
  creative_evidence_lifecycle_row_id = EXCLUDED.creative_evidence_lifecycle_row_id,
  calibration_row_id = EXCLUDED.calibration_row_id,
  evaluation_id = EXCLUDED.evaluation_id,
  input_hash = EXCLUDED.input_hash,
  decision_hash = EXCLUDED.decision_hash,
  computed_at = EXCLUDED.computed_at,
  updated_at = now()
RETURNING
  id,
  provider_account_ref_id,
  provider_account_id,
  decision_entity_type,
  decision_entity_id,
  scope_type,
  scope_id,
  label,
  confidence
`;

export const PRUNE_STALE_NATIVE_AD_DECISION_SNAPSHOTS_QUERY = `
WITH current_identities AS (
  SELECT *
  FROM jsonb_to_recordset($6::jsonb) AS row(
    provider_account_ref_id uuid,
    provider_account_id text,
    decision_entity_type text,
    decision_entity_id text
  )
), stale_snapshots AS (
  SELECT snapshot.id, snapshot.provider_account_ref_id,
    snapshot.provider_account_id,
    snapshot.decision_entity_type, snapshot.decision_entity_id
  FROM engine_v3_ad_decision_snapshots_daily snapshot
  WHERE snapshot.business_ref_id = $1::uuid
    AND snapshot.provider_account_ref_id = $7::uuid
    AND snapshot.as_of_date = $2::date
    AND snapshot.engine_version = $3
    AND snapshot.scope_type = $4
    AND snapshot.scope_id = $5
    AND NOT EXISTS (
      SELECT 1
      FROM current_identities identity
      WHERE identity.provider_account_ref_id = snapshot.provider_account_ref_id
        AND identity.provider_account_id = snapshot.provider_account_id
        AND identity.decision_entity_type = snapshot.decision_entity_type
        AND identity.decision_entity_id = snapshot.decision_entity_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM engine_v3_ad_decision_events retained_event
      WHERE retained_event.decision_snapshot_id = snapshot.id
        AND retained_event.event_type <> 'decision_changed'
    )
), deleted_events AS (
  DELETE FROM engine_v3_ad_decision_events event
  USING stale_snapshots stale
  WHERE event.business_ref_id = $1::uuid
    AND event.provider_account_ref_id = stale.provider_account_ref_id
    AND event.provider_account_id = stale.provider_account_id
    AND event.decision_entity_type = stale.decision_entity_type
    AND event.decision_entity_id = stale.decision_entity_id
    AND event.event_date = $2::date
    AND event.engine_version = $3
    AND event.scope_type = $4
    AND event.scope_id = $5
    AND event.event_type = 'decision_changed'
  RETURNING event.id
), deleted_snapshots AS (
  DELETE FROM engine_v3_ad_decision_snapshots_daily snapshot
  USING stale_snapshots stale
  WHERE snapshot.id = stale.id
    AND (SELECT COUNT(*) FROM deleted_events) >= 0
  RETURNING snapshot.id
)
SELECT
  (SELECT COUNT(*) FROM deleted_snapshots)::integer AS pruned_snapshot_count,
  (SELECT COUNT(*) FROM deleted_events)::integer AS pruned_event_count
`;

export const INSERT_NATIVE_AD_DECISION_CHANGE_EVENTS_QUERY = `
WITH identities AS (
  SELECT *
  FROM jsonb_to_recordset($2::jsonb) AS row(
    business_ref_id uuid,
    provider_account_ref_id uuid,
    provider_account_id text,
    decision_entity_type text,
    decision_entity_id text,
    event_date date,
    engine_version text,
    scope_type text,
    scope_id text
  )
), payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    business_ref_id uuid,
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    decision_entity_type text,
    decision_entity_id text,
    ad_id text,
    creative_id text,
    event_date date,
    engine_version text,
    scope_type text,
    scope_id text,
    previous_label text,
    current_label text,
    previous_confidence integer,
    current_confidence integer,
    previous_decision_snapshot_id uuid,
    decision_snapshot_id uuid,
    job_run_id uuid
  )
), deleted_existing AS (
  DELETE FROM engine_v3_ad_decision_events event
  USING identities identity
  WHERE event.business_ref_id = identity.business_ref_id
    AND event.provider_account_ref_id = identity.provider_account_ref_id
    AND event.provider_account_id = identity.provider_account_id
    AND event.decision_entity_type = identity.decision_entity_type
    AND event.decision_entity_id = identity.decision_entity_id
    AND event.event_date = identity.event_date
    AND event.engine_version = identity.engine_version
    AND event.scope_type = identity.scope_type
    AND event.scope_id = identity.scope_id
    AND event.event_type = 'decision_changed'
  RETURNING event.id
)
INSERT INTO engine_v3_ad_decision_events (
  business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type,
  decision_entity_id, ad_id, creative_id, event_date, engine_version,
  scope_type, scope_id, event_type, previous_label, current_label,
  previous_confidence, current_confidence, operator_evidence,
  decision_snapshot_id, job_run_id
)
SELECT
  business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type,
  decision_entity_id, ad_id, creative_id, event_date, engine_version,
  scope_type, scope_id, 'decision_changed', previous_label, current_label,
  previous_confidence, current_confidence,
  jsonb_build_object(
    'previous_decision_snapshot_id', previous_decision_snapshot_id,
    'current_decision_snapshot_id', decision_snapshot_id
  ),
  decision_snapshot_id, job_run_id
FROM payload
WHERE (SELECT COUNT(*) FROM deleted_existing) >= 0
ON CONFLICT (
  business_ref_id, provider_account_ref_id, provider_account_id,
  decision_entity_type, decision_entity_id, event_date, engine_version,
  scope_type, scope_id, event_type
) WHERE event_type = 'decision_changed'
DO UPDATE SET
  business_id = EXCLUDED.business_id,
  ad_id = EXCLUDED.ad_id,
  creative_id = EXCLUDED.creative_id,
  previous_label = EXCLUDED.previous_label,
  current_label = EXCLUDED.current_label,
  previous_confidence = EXCLUDED.previous_confidence,
  current_confidence = EXCLUDED.current_confidence,
  operator_evidence = EXCLUDED.operator_evidence,
  decision_snapshot_id = EXCLUDED.decision_snapshot_id,
  job_run_id = EXCLUDED.job_run_id,
  updated_at = now()
RETURNING id
`;

export function adDecisionsJobAdvisoryLockKey(
  input: AdDecisionsJobInput,
): bigint {
  return hashAdvisoryLock(
    `${AD_DECISIONS_JOB_NAME}:${input.businessId}:${input.asOf}`,
  );
}

export async function runAdDecisionsJob(
  input: AdDecisionsJobInput,
  options: AdDecisionsJobRuntimeOptions = {},
): Promise<AdDecisionsJobResult> {
  const startedAt = Date.now();
  const businessGuardFailure = await (
    options.businessGuard ?? getBusinessGuardFailure
  )(input.businessId);
  if (businessGuardFailure?.reason === "invalid_business_id") {
    return failedWithoutRun(
      startedAt,
      "invalid_business_id",
      businessGuardFailure.message,
    );
  }
  if (businessGuardFailure) {
    return failedWithoutRun(
      startedAt,
      "business_not_found",
      businessGuardFailure.message,
    );
  }
  const dbClient = options.db ?? getDb();

  const jobRunId = await insertAdJobRun(
    {
      ...input,
      status: "running",
      dependencyRunId: null,
    },
    dbClient,
  );

  try {
    const flags = await (options.resolveFlags ?? resolveEngineV3Flags)(
      input.businessId,
    );
    if (!flags.enabled) {
      const durationMs = Date.now() - startedAt;
      await markAdJobSkipped(
        {
          jobRunId,
          durationMs,
          message: "Engine v3 is disabled for this business.",
        },
        dbClient,
      );
      return {
        jobRunId,
        status: "skipped",
        snapshotsWritten: 0,
        changeEventsWritten: 0,
        durationMs,
        reason: "engine_v3_disabled",
      };
    }

    const transaction =
      options.transaction ??
      (<T>(fn: () => Promise<T>) =>
        runDbTransaction(fn, {
          timeoutMs: ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS,
        }));
    return await transaction(async () => {
      const db = options.db ?? getDb();
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const [lock] = await db.query<AdvisoryLockRow>(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
        [adDecisionsJobAdvisoryLockKey(input).toString()],
      );
      if (lock?.acquired !== true) {
        const durationMs = Date.now() - startedAt;
        const message =
          "Advisory lock not acquired (native ad job may already be running)";
        await markAdJobSkipped({ jobRunId, durationMs, message }, db);
        return {
          jobRunId,
          status: "skipped" as const,
          snapshotsWritten: 0,
          changeEventsWritten: 0,
          durationMs,
          errorMessage: message,
        };
      }

      const capability = await inspectEvaluationStoreSchemaCapability(db);
      const profileCapability = await (
        options.inspectProfileSchema ?? inspectNativeAdProfileSchemaCapability
      )(db);
      const missingSchema = [
        ...capability.missing,
        ...profileCapability.missing,
      ];
      if (missingSchema.length > 0) {
        const durationMs = Date.now() - startedAt;
        const message = `Native ad decision schema is not ready: ${missingSchema.join(", ")}`;
        await markAdJobFailed(
          { jobRunId, durationMs, error: new Error(message), message },
          db,
        );
        return {
          jobRunId,
          status: "failed" as const,
          snapshotsWritten: 0,
          changeEventsWritten: 0,
          durationMs,
          reason: "schema_not_ready" as const,
          errorMessage: message,
        };
      }

      const dependencyRunId = await findLatestSuccessfulAdCalibrationRun(
        input,
        db,
      );
      await setAdJobDependency(jobRunId, dependencyRunId, db);
      await db.query("SAVEPOINT engine_v3_ad_decisions_job_work");
      try {
        await assertEvaluationStoreSchemaReady(db);
        const evaluatedAt = new Date().toISOString();
        const dataSource = options.dataSource ?? new WarehouseDataSource();
        const hydration = await dataSource.hydrateAdDecisionInputs({
          businessId: input.businessId,
          asOf: input.asOf,
          decisionCutoff: evaluatedAt,
        });
        assertEmptyNativeAdHydrationIsAuthoritative(hydration);
        const adInputs = hydration.inputs;
        const nativeProfileDataSource =
          options.profileDataSource ??
          new WarehouseNativeAdAccountProfileDataSource(db);
        const profileGroups = await resolveNativeAdDecisionProfileGroups({
          businessId: input.businessId,
          asOf: input.asOf,
          adInputs,
          flags,
          dataSource: nativeProfileDataSource,
        });
        const campaignContextMode = resolveCampaignContextMode();
        const campaignContextById = await readAdCampaignContext({
          ...input,
          adInputs,
          mode: campaignContextMode,
        });
        const previousLabels = new Map<string, PreviousAdPublishedLabel>();
        for (const scopeGroup of groupNativeProfileInputsByScope(
          profileGroups,
        )) {
          const groupPrevious = await readPreviousPublishedAdLabels(
            {
              ...input,
              identities: scopeGroup.adInputs.map((ad) => ({
                providerAccountRefId: ad.providerAccountRefId,
                providerAccountId: ad.providerAccountId,
                decisionEntityType: "ad" as const,
                decisionEntityId: ad.decisionEntityId,
              })),
              scopeType: scopeGroup.scope.type,
              scopeId: scopeGroup.scope.id,
            },
            db,
          );
          mergeUniqueMap(previousLabels, groupPrevious, "hysteresis lineage");
        }

        /*
          Account-relative, and therefore built BEFORE the split into profile
          groups.

          A profile group is one calibration cell (provider account + objective
          + optimization goal + custom event type + cohort), so resolving the
          percentile per group would compare an ad only against the ads that
          share its cell. `NATIVE_AD_FREQUENCY_PRESSURE_MIN_OBSERVATIONS` is 8:
          an account with 12 ads spread over three cells would then report no
          percentile at all and force every one of them to `fatigueStatus:
          "unknown"`.
        */
        const frequencyPressureThresholdByAccount =
          resolveNativeAdFrequencyPressureThresholdsByAccount(adInputs);
        const decisionGroups = profileGroups.map((group) => {
          const dataHealth = buildNativeAdDataHealth({
            calibrationCell: group.calibrationCell,
            blocker: group.blocker,
            adInputs: group.adInputs,
            previousLabels,
            scope: group.profile.scope,
            evaluatedAt,
          });
          const decisions =
            group.blocker === null
              ? computeReadyNativeAdDecisions({
                  group,
                  businessId: input.businessId,
                  dataHealth,
                  campaignContextMode,
                  campaignContextById,
                  previousLabels,
                  frequencyPressureThresholdByAccount,
                })
              : computeSoftOnlyNativeAdDecisions({
                  businessId: input.businessId,
                  blocker: group.blocker,
                  profile: group.profile,
                  adInputs: group.adInputs,
                  campaignContextMode,
                  campaignContextById,
                  previousLabels,
                  evaluatedAt,
                });
          return {
            ...group,
            dataHealth,
            decisions,
          };
        });
        const storedEvaluations = new Map<string, StoredAdDecisionEvaluation>();
        for (const group of decisionGroups) {
          const canonicalEvaluations = group.decisions.map((computation) =>
            buildAdCanonicalEvaluationProvenance({
              identity: {
                providerAccountRefId: computation.input.providerAccountRefId,
                providerAccountId: computation.input.providerAccountId,
                decisionEntityType: "ad",
                decisionEntityId: computation.input.decisionEntityId,
                adId: computation.input.adId,
                creativeId: computation.input.creativeId,
              },
              base: buildCanonicalEvaluationProvenance({
                engineVersion: NATIVE_AD_ENGINE_VERSION,
                accountProfile: group.profile,
                dataHealth: group.dataHealth,
                flags,
                scope: group.profile.scope,
                creativeInput: computation.input,
                campaignContext: computation.campaignContext,
                priorHysteresis: computation.priorHysteresis,
                decision: computation.decision,
                rawLabel: computation.rawLabel,
                publishedLabel: computation.decision.label,
                hysteresisSuppressed: computation.hysteresisSuppressed,
                evaluatedAt,
              }),
            }),
          );
          if (canonicalEvaluations.length === 0) continue;
          const storedGroup = await persistAdDecisionEvaluations(
            {
              businessId: input.businessId,
              businessDisplayId: input.businessId,
              asOf: input.asOf,
              engineVersion: NATIVE_AD_ENGINE_VERSION,
              scope: group.profile.scope,
              jobRunId,
              evaluatedAt,
              evaluations: canonicalEvaluations,
            },
            db,
          );
          mergeUniqueMap(storedEvaluations, storedGroup, "stored evaluation");
        }
        const snapshotRows = decisionGroups.flatMap((group) =>
          group.decisions.map((computation) => {
            const key = adDecisionEvaluationIdentityKey({
              providerAccountRefId: computation.input.providerAccountRefId,
              providerAccountId: computation.input.providerAccountId,
              decisionEntityType: "ad",
              decisionEntityId: computation.input.decisionEntityId,
              adId: computation.input.adId,
              creativeId: computation.input.creativeId,
            });
            const stored = storedEvaluations.get(key);
            if (!stored) {
              throw new Error(`Native ad evaluation link missing for ${key}.`);
            }
            return toNativeSnapshotPayload({
              businessId: input.businessId,
              asOf: input.asOf,
              jobRunId,
              scope: group.profile.scope,
              computation,
              stored,
              calibrationRowId: group.calibrationRowId,
              hardActionEligibility: group.profile.hardActionEligibility,
              computedAt: evaluatedAt,
            });
          }),
        );

        const scopeGroups = groupNativeDecisionGroupsByScope(decisionGroups);
        const pruneResult: NativeSnapshotPruneResult = {
          prunedSnapshots: 0,
          prunedEvents: 0,
          skippedBecauseEmptyPayload: hydration.receipts.length === 0,
          skippedUnprovenReceiptCount: 0,
          authoritativeReceiptCount: 0,
        };
        for (const receipt of hydration.receipts) {
          const groupPrune = await pruneStaleNativeAdSnapshots(
            {
              ...input,
              scope: { type: "account", id: receipt.providerAccountId },
              currentInputs: adInputs.filter(
                (ad) =>
                  ad.providerAccountRefId === receipt.providerAccountRefId &&
                  ad.providerAccountId === receipt.providerAccountId,
              ),
              receipt,
            },
            db,
          );
          pruneResult.prunedSnapshots += groupPrune.prunedSnapshots;
          pruneResult.prunedEvents += groupPrune.prunedEvents;
          pruneResult.skippedBecauseEmptyPayload =
            pruneResult.skippedBecauseEmptyPayload &&
            groupPrune.skippedBecauseEmptyPayload;
          pruneResult.skippedUnprovenReceiptCount +=
            groupPrune.skippedUnprovenReceiptCount;
          pruneResult.authoritativeReceiptCount +=
            groupPrune.authoritativeReceiptCount;
        }
        const currentSnapshots = await upsertNativeAdDecisionSnapshots(
          snapshotRows,
          db,
        );
        const previousSnapshots = new Map<string, ComparableNativeAdSnapshot>();
        for (const scopeGroup of scopeGroups) {
          const groupPrevious = await findPreviousNativeAdSnapshots(
            {
              ...input,
              scope: scopeGroup.scope,
              adInputs: scopeGroup.adInputs,
            },
            db,
          );
          mergeUniqueMap(previousSnapshots, groupPrevious, "previous snapshot");
        }
        let changeEventsWritten = 0;
        for (const scopeGroup of scopeGroups) {
          const eventRows = buildNativeAdDecisionChangeEvents({
            ...input,
            jobRunId,
            scope: scopeGroup.scope,
            decisions: scopeGroup.decisions,
            previousSnapshots,
            currentSnapshots,
          });
          changeEventsWritten += await reconcileNativeAdDecisionChangeEvents(
            {
              ...input,
              scope: scopeGroup.scope,
              decisions: scopeGroup.decisions,
              rows: eventRows,
            },
            db,
          );
        }

        const durationMs = Date.now() - startedAt;
        await markAdJobSuccess(
          {
            jobRunId,
            durationMs,
            rowCount: currentSnapshots.size,
            changeEventsWritten,
            pruneResult,
            hydrationReceipts: hydration.receipts,
          },
          db,
        );
        return {
          jobRunId,
          status: "success" as const,
          snapshotsWritten: currentSnapshots.size,
          changeEventsWritten,
          durationMs,
        };
      } catch (error) {
        await db
          .query("ROLLBACK TO SAVEPOINT engine_v3_ad_decisions_job_work")
          .catch(() => undefined);
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        await markAdJobFailed(
          { jobRunId, durationMs, error, message },
          db,
        ).catch(() => undefined);
        return {
          jobRunId,
          status: "failed" as const,
          snapshotsWritten: 0,
          changeEventsWritten: 0,
          durationMs,
          errorMessage: message,
        };
      }
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    await markAdJobFailed(
      { jobRunId, durationMs, error, message },
      dbClient,
    ).catch(() => undefined);
    return {
      jobRunId,
      status: "failed",
      snapshotsWritten: 0,
      changeEventsWritten: 0,
      durationMs,
      errorMessage: message,
    };
  }
}

export async function resolveNativeAdDecisionProfileGroups(input: {
  businessId: string;
  asOf: string;
  adInputs: AdDecisionInput[];
  flags: EngineV3Flags;
  dataSource: NativeAdProfileRuntimeDataSource;
}): Promise<NativeAdDecisionProfileGroup[]> {
  const requestGroups = new Map<
    string,
    { context: NativeAdProfileRequestContext; adInputs: AdDecisionInput[] }
  >();
  const contextBlockedGroups = new Map<
    string,
    { blocker: string; adInputs: AdDecisionInput[] }
  >();
  for (const ad of input.adInputs) {
    const contextResult = nativeAdProfileRequestContext(ad);
    if ("blocker" in contextResult) {
      const key = `${ad.providerAccountId}\u0000${contextResult.blocker}`;
      const existing = contextBlockedGroups.get(key);
      if (existing) existing.adInputs.push(ad);
      else {
        contextBlockedGroups.set(key, {
          blocker: contextResult.blocker,
          adInputs: [ad],
        });
      }
      continue;
    }
    const context = contextResult.context;
    const key = nativeAdProfileRequestKey(context);
    const existing = requestGroups.get(key);
    if (existing) {
      existing.adInputs.push(ad);
    } else {
      requestGroups.set(key, { context, adInputs: [ad] });
    }
  }

  const groups: NativeAdDecisionProfileGroup[] = [];
  for (const { blocker, adInputs } of contextBlockedGroups.values()) {
    groups.push(
      buildSoftOnlyNativeAdProfileGroup({
        businessId: input.businessId,
        asOf: input.asOf,
        blocker,
        adInputs,
        calibrationSource: null,
        calibrationCell: null,
      }),
    );
  }
  for (const { context, adInputs } of Array.from(requestGroups.values()).sort(
    (left, right) =>
      nativeAdProfileRequestKey(left.context).localeCompare(
        nativeAdProfileRequestKey(right.context),
      ),
  )) {
    if (context.cohort !== "purchase") {
      groups.push(
        buildSoftOnlyNativeAdProfileGroup({
          businessId: input.businessId,
          asOf: input.asOf,
          blocker:
            "native_ad_profile_unready:native_non_purchase_roas_unsupported",
          adInputs,
          calibrationSource: null,
          calibrationCell: null,
        }),
      );
      continue;
    }
    const resolved = await resolveNativeAdAccountDecisionProfile({
      businessId: input.businessId,
      providerAccountId: context.providerAccountId,
      accountTimezone: context.accountTimezone,
      accountCurrency: context.accountCurrency,
      objective: context.objective,
      optimizationGoal: context.optimizationGoal,
      customEventType: context.customEventType,
      cohort: context.cohort,
      asOf: input.asOf,
      dataSource: input.dataSource,
      flags: input.flags,
      fallbackPolicy: NATIVE_AD_THIN_EXACT_FALLBACK_CELL,
    });
    if (resolved.status !== "ready") {
      const reason = resolved.reason ?? "unknown_native_profile_failure";
      if (isNativeProfileProvenanceFailure(reason)) {
        throw new NativeAdProfileProvenanceError(
          `${context.providerAccountId}/${context.objective}/${context.cohort}: ${reason}`,
        );
      }
      groups.push(
        buildSoftOnlyNativeAdProfileGroup({
          businessId: input.businessId,
          asOf: input.asOf,
          blocker: `native_ad_profile_unready:${reason}`,
          adInputs,
          calibrationSource: resolved.calibrationSource,
          calibrationCell: resolved.selectedCell,
        }),
      );
      continue;
    }
    if (resolved.profile === null || resolved.selectedCell === null) {
      throw new NativeAdProfileProvenanceError(
        `${context.providerAccountId}: ready resolver result omitted profile or calibration cell`,
      );
    }
    if (
      resolved.selectedCell.key.providerAccountRefId !==
        context.providerAccountRefId ||
      resolved.profile.scope.type !== "account" ||
      resolved.profile.scope.id !== context.providerAccountId
    ) {
      throw new NativeAdProfileProvenanceError(
        `${context.providerAccountId}: resolver returned non-native account scope ${resolved.profile.scope.type}/${resolved.profile.scope.id}`,
      );
    }
    const calibrationRowId = await input.dataSource.getNativeCalibrationRowId(
      resolved.selectedCell,
    );
    groups.push({
      key: [
        context.providerAccountId,
        resolved.selectedCell.inputManifestHash,
        resolved.profile.scope.type,
        resolved.profile.scope.id,
      ].join("\u0000"),
      profile: resolved.profile,
      calibrationCell: resolved.selectedCell,
      calibrationRowId,
      blocker: null,
      adInputs: [...adInputs].sort(
        (left, right) =>
          left.providerAccountId.localeCompare(right.providerAccountId) ||
          left.adId.localeCompare(right.adId),
      ),
    });
  }
  return groups.sort((left, right) => left.key.localeCompare(right.key));
}

function buildSoftOnlyNativeAdProfileGroup(input: {
  businessId: string;
  asOf: string;
  blocker: string;
  adInputs: AdDecisionInput[];
  calibrationSource: string | null;
  calibrationCell: NativeAdCalibrationCell | null;
}): NativeAdDecisionProfileGroup {
  const accountIds = new Set(
    input.adInputs.map((ad) => ad.providerAccountId.trim()).filter(Boolean),
  );
  if (accountIds.size !== 1) {
    throw new NativeAdProfileProvenanceError(
      `soft-only group must contain exactly one provider account; received ${accountIds.size}`,
    );
  }
  const providerAccountId = Array.from(accountIds)[0]!;
  const profile = buildNativeAdSoftOnlyDecisionProfile({
    businessId: input.businessId,
    asOf: input.asOf,
    blocker: input.blocker,
    providerAccountId,
    calibrationSource: input.calibrationSource,
    calibrationCell: input.calibrationCell,
  });
  return {
    key: [
      providerAccountId,
      "soft_only",
      input.blocker,
      input.calibrationCell?.inputManifestHash ?? "missing_cell",
    ].join("\u0000"),
    profile,
    calibrationCell: input.calibrationCell,
    calibrationRowId: null,
    blocker: input.blocker,
    adInputs: [...input.adInputs].sort(
      (left, right) =>
        left.providerAccountId.localeCompare(right.providerAccountId) ||
        left.adId.localeCompare(right.adId),
    ),
  };
}

export function buildNativeAdSoftOnlyDecisionProfile(input: {
  businessId: string;
  asOf: string;
  blocker: string;
  providerAccountId: string;
  calibrationSource: string | null;
  calibrationCell: NativeAdCalibrationCell | null;
}): NativeAdSoftOnlyDecisionProfile {
  const blockedReason = `hard_actions_blocked:${input.blocker}`;
  return {
    profileType: "native_ad_soft_only",
    businessId: input.businessId,
    asOfDate: input.asOf,
    channel: "meta",
    objectiveFamily: "sales",
    scope: { type: "account", id: input.providerAccountId },
    blocker: input.blocker,
    calibrationSource: input.calibrationSource,
    selectedCell: input.calibrationCell
      ? {
          engineVersion: input.calibrationCell.engineVersion,
          policyVersion: input.calibrationCell.policyVersion,
          inputManifestHash: input.calibrationCell.inputManifestHash,
          sourceManifestHash: input.calibrationCell.sourceManifestHash,
          qualityStatus: input.calibrationCell.qualityStatus,
        }
      : null,
    hardActionEligibility: {
      scale: false,
      cut: false,
      refresh: false,
      reason: blockedReason,
      reasons: {
        scale: blockedReason,
        cut: blockedReason,
        refresh: blockedReason,
      },
    },
  };
}

function isNativeProfileProvenanceFailure(reason: string) {
  return [
    "contract_invalid",
    "authority_mismatch",
    "cutoff_unsafe",
    "lineage_invalid",
    "replacement_set_invalid",
  ].some((token) => reason.includes(token));
}

export function buildNativeAdDataHealth(input: {
  calibrationCell: NativeAdCalibrationCell | null;
  blocker: string | null;
  adInputs: AdDecisionInput[];
  previousLabels: Map<string, PreviousAdPublishedLabel>;
  scope: DecisionProfileScope;
  evaluatedAt: string;
}): DataHealth {
  const now = new Date(input.evaluatedAt);
  const previousRows = input.adInputs
    .map((ad) =>
      input.previousLabels.get(
        adDecisionStabilityKey({
          businessId: ad.businessId,
          providerAccountRefId: ad.providerAccountRefId,
          providerAccountId: ad.providerAccountId,
          decisionEntityType: "ad",
          decisionEntityId: ad.decisionEntityId,
          scopeType: input.scope.type,
          scopeId: input.scope.id,
        }),
      ),
    )
    .filter((row): row is PreviousAdPublishedLabel => row !== undefined);

  return composeDataHealth({
    calibration: buildDataLayerHealth({
      asOfDate: input.calibrationCell?.asOfDate ?? null,
      computedAt: input.calibrationCell?.computedAt ?? null,
      sourceMaxUpdatedAt: input.calibrationCell?.sourceMaxUpdatedAt ?? null,
      now,
      fallbackMode: input.blocker === null ? "precomputed" : "insufficient",
      note:
        input.blocker === null
          ? "Native ad account calibration cell."
          : `Native ad calibration has no hard authority: ${input.blocker}`,
    }),
    lifecycle: buildDataLayerHealth({
      asOfDate: null,
      computedAt: null,
      sourceMaxUpdatedAt: null,
      now,
      fallbackMode: "insufficient",
      note: "Native ad lifecycle authority is unavailable; creative lifecycle remains explanation-only evidence.",
    }),
    decisions: buildDataLayerHealth({
      asOfDate: latestText(previousRows.map((row) => row.sourceAsOfDate)),
      computedAt: latestText(previousRows.map((row) => row.sourceComputedAt)),
      sourceMaxUpdatedAt: latestText(
        previousRows.map((row) => row.sourceComputedAt),
      ),
      now,
      fallbackMode: previousRows.length > 0 ? "precomputed" : "insufficient",
      note:
        previousRows.length > 0
          ? "Native ad hysteresis lineage."
          : "No previous native ad epoch snapshot.",
    }),
  });
}

function nativeAdProfileRequestContext(
  ad: AdDecisionInput,
): { context: NativeAdProfileRequestContext } | { blocker: string } {
  const requiredFields = [
    ["account_timezone", ad.accountTimezone],
    ["account_currency", ad.accountCurrency],
    ["objective", ad.objective],
  ] as const;
  const missing = requiredFields.find(([, value]) => !value?.trim());
  if (missing) {
    return { blocker: `native_ad_profile_context_missing:${missing[0]}` };
  }
  const cohort = ad.effectiveCohort;
  if (cohort === null || cohort === undefined) {
    return { blocker: "native_ad_profile_context_missing:effective_cohort" };
  }
  const optimizationGoal = normalizeOptionalProfileToken(ad.optimizationGoal);
  const customEventType = normalizeOptionalProfileToken(ad.customEventType);
  if (optimizationGoal === null && customEventType === null) {
    return {
      blocker: "native_ad_profile_context_missing:optimization_context",
    };
  }
  return {
    context: {
      providerAccountId: ad.providerAccountId,
      providerAccountRefId: ad.providerAccountRefId,
      accountTimezone: ad.accountTimezone!.trim(),
      accountCurrency: ad.accountCurrency!.trim().toUpperCase(),
      objective: ad.objective!.trim().toUpperCase(),
      optimizationGoal,
      customEventType,
      cohort,
    },
  };
}

function nativeAdProfileRequestKey(context: NativeAdProfileRequestContext) {
  return [
    context.providerAccountId,
    context.providerAccountRefId,
    context.accountTimezone,
    context.accountCurrency,
    context.objective,
    context.cohort,
    context.optimizationGoal ?? "",
    context.customEventType ?? "",
  ].join("\u0000");
}

function normalizeOptionalProfileToken(value: string | null | undefined) {
  const normalized =
    value
      ?.trim()
      .replace(/[\s-]+/g, "_")
      .toUpperCase() ?? "";
  return normalized || null;
}

function groupNativeProfileInputsByScope(
  groups: NativeAdDecisionProfileGroup[],
): Array<Pick<NativeAdDecisionScopeGroup, "scope" | "adInputs">> {
  const scopes = new Map<
    string,
    Pick<NativeAdDecisionScopeGroup, "scope" | "adInputs">
  >();
  for (const group of groups) {
    const key = decisionScopeKey(group.profile.scope);
    const existing = scopes.get(key);
    if (existing) existing.adInputs.push(...group.adInputs);
    else
      scopes.set(key, {
        scope: group.profile.scope,
        adInputs: [...group.adInputs],
      });
  }
  return Array.from(scopes.values()).sort((left, right) =>
    decisionScopeKey(left.scope).localeCompare(decisionScopeKey(right.scope)),
  );
}

function groupNativeDecisionGroupsByScope(
  groups: NativeAdDecisionRuntimeGroup[],
): NativeAdDecisionScopeGroup[] {
  const scopes = new Map<string, NativeAdDecisionScopeGroup>();
  for (const group of groups) {
    const key = decisionScopeKey(group.profile.scope);
    const existing = scopes.get(key);
    if (existing) {
      existing.adInputs.push(...group.adInputs);
      existing.decisions.push(...group.decisions);
    } else {
      scopes.set(key, {
        scope: group.profile.scope,
        adInputs: [...group.adInputs],
        decisions: [...group.decisions],
      });
    }
  }
  return Array.from(scopes.values()).sort((left, right) =>
    decisionScopeKey(left.scope).localeCompare(decisionScopeKey(right.scope)),
  );
}

function decisionScopeKey(scope: DecisionProfileScope) {
  return `${scope.type}\u0000${scope.id}`;
}

function mergeUniqueMap<T>(
  target: Map<string, T>,
  source: Map<string, T>,
  label: string,
) {
  for (const [key, value] of source) {
    if (target.has(key)) {
      throw new Error(`Duplicate ${label} identity: ${key}`);
    }
    target.set(key, value);
  }
}

function latestText(values: Array<string | null | undefined>) {
  const present = values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return present.sort().at(-1) ?? null;
}

function computeReadyNativeAdDecisions(input: {
  group: NativeAdDecisionProfileGroup;
  businessId: string;
  dataHealth: DataHealth;
  campaignContextMode: ReturnType<typeof resolveCampaignContextMode>;
  campaignContextById: CampaignContextMap;
  previousLabels: Map<string, PreviousAdPublishedLabel>;
  frequencyPressureThresholdByAccount: ReadonlyMap<string, number | null>;
}) {
  if (
    "profileType" in input.group.profile ||
    input.group.calibrationCell === null ||
    input.group.calibrationRowId === null
  ) {
    throw new NativeAdProfileProvenanceError(
      `${input.group.key}: ready group has incomplete native authority`,
    );
  }
  return computeNativeAdDecisions({
    businessId: input.businessId,
    profile: input.group.profile,
    dataHealth: input.dataHealth,
    adInputs: input.group.adInputs,
    campaignContextMode: input.campaignContextMode,
    campaignContextById: input.campaignContextById,
    previousLabels: input.previousLabels,
    frequencyPressureThresholdByAccount:
      input.frequencyPressureThresholdByAccount,
  });
}

export function computeSoftOnlyNativeAdDecisions(input: {
  businessId: string;
  blocker: string;
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  adInputs: AdDecisionInput[];
  campaignContextMode: ReturnType<typeof resolveCampaignContextMode>;
  campaignContextById: CampaignContextMap;
  previousLabels: Map<string, PreviousAdPublishedLabel>;
  evaluatedAt: string;
}): AdDecisionComputation[] {
  if (!("profileType" in input.profile)) {
    throw new NativeAdProfileProvenanceError(
      "soft-only decision group received a ready account profile",
    );
  }
  const optimizationOutOfScope =
    input.blocker ===
    "native_ad_profile_unready:native_non_purchase_roas_unsupported";
  return input.adInputs
    .map((adInput) => {
      const withCampaign = withCreativeCampaignLabelContext(
        adInput,
        input.campaignContextById,
      );
      const stabilityKey = adDecisionStabilityKey({
        businessId: input.businessId,
        providerAccountRefId: withCampaign.providerAccountRefId,
        providerAccountId: withCampaign.providerAccountId,
        decisionEntityType: "ad",
        decisionEntityId: withCampaign.decisionEntityId,
        scopeType: input.profile.scope.type,
        scopeId: input.profile.scope.id,
      });
      const previous = input.previousLabels.get(stabilityKey) ?? null;
      const softDecision = guardUnavailableAdMetrics(
        {
          decisionEntityType: "ad",
          decisionEntityId: withCampaign.decisionEntityId,
          adId: withCampaign.adId,
          providerAccountId: withCampaign.providerAccountId,
          creativeId: withCampaign.creativeId,
          creativeName: withCampaign.creativeName,
          label: optimizationOutOfScope ? "out_of_scope" : "diagnose",
          confidence: optimizationOutOfScope ? 40 : 0,
          reason: optimizationOutOfScope
            ? "[Purchase ROAS decision not applicable] This Ad optimizes for a non-purchase outcome, so purchase-ROAS scale/cut/refresh actions do not apply."
            : `[Native calibration unavailable - hard actions blocked] ${input.blocker}`,
          truthSource: "global_default",
          effectiveTargetRoas: 0,
          ratioToTarget: null,
          badges: [
            {
              type: "native_calibration_unavailable",
              label: optimizationOutOfScope
                ? "Purchase-ROAS calibration does not apply to this optimization outcome; scale, cut and refresh are blocked."
                : `Native calibration unavailable (${input.blocker}); scale, cut and refresh are blocked.`,
              severity: "warning",
            },
          ],
          blockers: [
            {
              predicate: optimizationOutOfScope
                ? "native_ad_purchase_roas_scope"
                : "native_ad_profile_ready",
              observed: optimizationOutOfScope
                ? "non_purchase_optimization"
                : input.blocker,
              threshold: optimizationOutOfScope ? "purchase" : "ready",
              status: "missing",
              severity: "warning",
              reason: optimizationOutOfScope
                ? "The purchase-ROAS decision motor is intentionally not used for this optimization outcome."
                : "Native calibration/profile authority is unavailable.",
            },
          ],
          metrics: {
            spend: withCampaign.spend,
            purchases: withCampaign.purchases,
            roas: withCampaign.roas,
            recent7dRoas: withCampaign.recent7dRoas,
          },
          campaignRoleStatus: withCampaign.campaignId
            ? withCampaign.campaignKind
              ? "resolved"
              : "unresolved"
            : "no_campaign",
          campaignKind: withCampaign.campaignKind ?? null,
          preAuthorityLabel: optimizationOutOfScope
            ? "out_of_scope"
            : "diagnose",
          authorityBlocker: optimizationOutOfScope
            ? null
            : "native_profile_unavailable",
          blockedActionType: null,
          engineVersion: NATIVE_AD_ENGINE_VERSION,
          generatedAt: input.evaluatedAt,
        },
        withCampaign,
      );
      const stabilized = stabilizeDecisionLabel(softDecision, previous);
      return {
        input: withCampaign,
        decision: stabilized.decision as AdDecisionOutput,
        rawLabel: stabilized.rawLabel,
        hysteresisSuppressed: stabilized.suppressed,
        campaignContext: campaignContextProvenanceFor({
          mode: input.campaignContextMode,
          campaignId: withCampaign.campaignId,
          entry: withCampaign.campaignId
            ? input.campaignContextById.get(withCampaign.campaignId)
            : null,
        }),
        priorHysteresis: toPriorHysteresisProvenance(
          input.businessId,
          withCampaign,
          previous,
        ),
      };
    })
    .sort(
      (left, right) =>
        left.input.providerAccountId.localeCompare(
          right.input.providerAccountId,
        ) || left.input.adId.localeCompare(right.input.adId),
    );
}

export function computeNativeAdDecisions(input: {
  businessId: string;
  profile: AccountDecisionProfile;
  dataHealth: DataHealth;
  adInputs: AdDecisionInput[];
  campaignContextMode: ReturnType<typeof resolveCampaignContextMode>;
  campaignContextById: CampaignContextMap;
  previousLabels: Map<string, PreviousAdPublishedLabel>;
  resolveDecision?: (
    input: CreativeInput,
    profile: AccountDecisionProfile,
    dataHealth: DataHealth,
  ) => DecisionOutput;
  /**
   * Frequency P75 per provider account, resolved over the whole account's ad
   * population rather than this group's. The job passes it; callers that hand
   * over a complete account in `adInputs` may omit it and get the same answer.
   */
  frequencyPressureThresholdByAccount?: ReadonlyMap<string, number | null>;
}): AdDecisionComputation[] {
  // Resolved once per population, never once per ad: an ad's own frequency is
  // a single observation and can never be its own percentile.
  const frequencyPressureThresholdByAccount =
    input.frequencyPressureThresholdByAccount ??
    resolveNativeAdFrequencyPressureThresholdsByAccount(input.adInputs);
  return input.adInputs
    .map((adInput) => {
      const withCampaign = withCreativeCampaignLabelContext(
        adInput,
        input.campaignContextById,
      );
      const adLifecycle = computeNativeAdLifecycleEvidence({
        ad: withCampaign,
        profile: input.profile,
        frequencyPressureThreshold:
          frequencyPressureThresholdByAccount.get(
            adInput.providerAccountId,
          ) ?? null,
      });
      const resolverInput = toResolverInput(withCampaign, adLifecycle);
      const resolveDecision = input.resolveDecision ?? decideCreative;
      const semanticDecision = normalizeSiteOwnedAdDecision(
        resolveDecision(resolverInput, input.profile, input.dataHealth),
      );
      const guarded = applyCreativeCampaignLabelGuard({
        decision: semanticDecision,
        input: withCampaign,
        campaignLabelsById: input.campaignContextById,
      });
      const adDecision = nativeAdLifecycleEvidenceBlockers(
        guardUnavailableAdMetrics(
          toNativeAdDecisionOutput(guarded, withCampaign),
          withCampaign,
        ),
        adLifecycle,
      );
      const stabilityKey = adDecisionStabilityKey({
        businessId: input.businessId,
        providerAccountRefId: withCampaign.providerAccountRefId,
        providerAccountId: withCampaign.providerAccountId,
        decisionEntityType: "ad",
        decisionEntityId: withCampaign.decisionEntityId,
        scopeType: input.profile.scope.type,
        scopeId: input.profile.scope.id,
      });
      const previous = input.previousLabels.get(stabilityKey) ?? null;
      const stabilized = stabilizeDecisionLabel(adDecision, previous);
      return {
        input: withCampaign,
        decision: stabilized.decision as AdDecisionOutput,
        rawLabel: stabilized.rawLabel,
        hysteresisSuppressed: stabilized.suppressed,
        campaignContext: campaignContextProvenanceFor({
          mode: input.campaignContextMode,
          campaignId: withCampaign.campaignId,
          entry: withCampaign.campaignId
            ? input.campaignContextById.get(withCampaign.campaignId)
            : null,
        }),
        priorHysteresis: toPriorHysteresisProvenance(
          input.businessId,
          withCampaign,
          previous,
        ),
      };
    })
    .sort(
      (left, right) =>
        left.input.providerAccountId.localeCompare(
          right.input.providerAccountId,
        ) || left.input.adId.localeCompare(right.input.adId),
    );
}

function toResolverInput(
  input: AdDecisionInput,
  adLifecycle: NativeAdLifecycleEvidence,
): CreativeInput {
  const {
    metricEvidence: _metricEvidence,
    statusEvidence: _statusEvidence,
    creativeEvidence: _creativeEvidence,
    accountTimezone: _accountTimezone,
    adBandEvidence: _adBandEvidence,
    creativeId,
    ...rest
  } = input;
  return {
    ...rest,
    // Resolver math never consumes this field. Native identity is restored on
    // the output before any canonical or persistence boundary.
    creativeId: creativeId ?? `native-ad:${input.adId}`,
    /*
      Ad-grain lifecycle, not the creative's.

      Creative-owned V1 lifecycle stays in `creativeEvidence` and is still
      never bound to an ad: one creative can back many ads, so its fatigue
      verdict is not this ad's. These two fields come from
      `computeNativeAdLifecycleEvidence`, which reads only this ad's own
      equal, disjoint, cutoff-bound 14/14 windows plus a frequency percentile
      taken across the whole PROVIDER ACCOUNT (not the profile group, which is
      one calibration cell).

      These two are the only fields that reach the RESOLVER. The contract
      version, the full evidence hash and the missing-evidence list reach the
      persisted decision by a second, narrower route: on any row that raises a
      Refresh, held or authorized, `nativeAdLifecycleEvidenceBlockers`
      publishes them on `blockers`, which `normalizeDecision` canonicalizes
      into `decision_output_json`. The decay ratios, the pressure flag and the
      prior-band verdict reach neither.
    */
    fatigueStatus: adLifecycle.fatigueStatus,
    lifecyclePosition: adLifecycle.lifecyclePosition,
    /*
      Still null, and not for want of trying.

      `days_since_peak`, `peak_roas_30d`, `peak_confidence`, the spend/ROAS
      slopes and `spend_trajectory_30d` all need a daily series. The only
      table that holds one is `engine_v3_creative_lifecycle_daily`, which is
      keyed by `creative_id` (verified against the live schema: no ad-grain
      lifecycle table exists). The ad hydration in
      `lib/creative-decision-engine/data-source.ts` aggregates `meta_ad_daily`
      into a 28-day cumulative row, a 7-day recent row, and a same-day
      spend/impressions row; nothing in that shape can locate a peak or fit a
      slope. The Meta delivery rankings and creative format are likewise read
      only from that creative-grain row.
    */
    daysSincePeak: null,
    peakRoas30d: null,
    peakConfidence: null,
    spendTrajectory30d: null,
    spendSlope7d: null,
    spendSlope30d: null,
    roasSlope7d: null,
    roasSlope30d: null,
    qualityRanking: null,
    engagementRateRanking: null,
    conversionRateRanking: null,
    creativeFormat: null,
  };
}

/**
 * The ad-grain fatigue/lifecycle evidence contract.
 *
 * Version it, because the verdict it produces is authority: `fatigued` is the
 * only value that lets `shouldRefreshOnFatigue` and the below-target branch of
 * `ratioZonesGate` publish a HARD `refresh`. The string is published on the
 * decision's blockers by `nativeAdLifecycleEvidenceBlockers` below, so a
 * consumer reading a held Refresh can name the contract that withheld it.
 *
 * v1 (superseded, never released) compared this ad's 7-day recent rollup with
 * the 21 days obtained by subtracting it from the 28-day cumulative rollup,
 * and counted ROAS decay plus purchases-per-impression decay as two signals.
 * Three things were wrong with that. The windows were unequal, so a 7-day
 * seasonal dip was measured against a 21-day mean. `INVARIANTS.md` asks for
 * `recent14` against the "directly preceding disjoint prior14 period", not any
 * disjoint pair. And purchases-per-impression is not independent of ROAS: both
 * carry the same purchase numerator, so two "signals" were one observation
 * counted twice, which is the exact substitution `DECISION_LOG.md` D037
 * forbids ("Benchmark weakening ... cannot substitute for a material CTR,
 * click-to-purchase, or ROAS decay signal").
 *
 * v2 (superseded) produced a receipt only when an admissible band pair
 * existed: `evidenceHash` was null for every Refresh HELD on missing or
 * invalid evidence, which is the outcome that most needs provenance. Two holds
 * with different causes were indistinguishable, and determinism could not be
 * demonstrated because nothing was hashed. v3 hashes a FULL receipt for every
 * outcome — bands or an explicit absence, the sorted missing-evidence codes,
 * the observed states, the winner bars and sample floors actually read, the
 * ROAS targets, the frequency reading and its threshold, and the derived
 * lifecycle state itself. The version moves because the same facts now produce
 * a different digest, and a v2 receipt must not be compared with a v3 one.
 */
export const NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT =
  "native-ad-lifecycle-evidence.v3-full-receipt";

/**
 * `INVARIANTS.md`: "Frequency pressure must be account-relative (28-day
 * creative P75 with at least eight observations). A global frequency cliff or
 * a creative's own single-row percentile must not authorize fatigue." The
 * ad-grain analogue compares ads with ads across one PROVIDER ACCOUNT at one
 * cutoff — deliberately not one profile group, because a profile group is
 * keyed by `NativeAdProfileRequestContext` (provider account + objective +
 * optimization goal + custom event type + cohort), which is one calibration
 * cell inside an account and therefore narrower than account-relative.
 */
const NATIVE_AD_FREQUENCY_PRESSURE_MIN_OBSERVATIONS = 8;

/** Both comparison periods are exactly this long, inclusive of both endpoints. */
const NATIVE_AD_BAND_LENGTH_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/**
 * One comparison period's rates, each computed from that period's own
 * numerator and denominator.
 *
 * `ctr` and `clickToPurchaseRate` are the composite: impressions to clicks,
 * then link clicks to purchases. They are separate funnel stages measured on
 * separate denominators, which is what makes two of them independent evidence
 * rather than one observation counted twice.
 */
interface NativeAdCompositeBand {
  startDate: string;
  endDate: string;
  spend: number;
  purchases: number;
  revenue: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  roas: number;
  /** Clicks per impression, as a percentage, matching `CreativeInput.ctr`. */
  ctr: number;
  /** Purchases per link click, matching `HistoricalWindow.clickToPurchaseRate`. */
  clickToPurchaseRate: number;
}

/**
 * The result of one ad's lifecycle derivation.
 *
 * What crosses into production, and by which route:
 *
 *  - `fatigueStatus` and `lifecyclePosition` are copied onto `CreativeInput` by
 *    `toResolverInput` and drive the resolver's label.
 *  - `contractVersion` and the FULL `evidenceHash` are published on the
 *    decision's `blockers` by `nativeAdLifecycleEvidenceBlockers`, on EVERY row
 *    that raises a Refresh — held (with `missingEvidence` naming the gaps) and
 *    authorized alike. `blockers` is canonicalized by `normalizeDecision` in
 *    `canonical-evaluation.ts` and stored in `decision_output_json`, so a held
 *    Refresh names the contract and the specific evidence it lacked, and an
 *    authorized Refresh carries the lineage of the evidence that granted it.
 *
 * The decay ratios, `frequencyPressure` and `priorBandWasStrong` cross by
 * neither route. They are returned so the arithmetic can be asserted directly
 * in tests, and they are NOT persisted, hashed or surfaced.
 * `buildAdCanonicalEvaluationProvenance` never sees this object. Do not write
 * a consumer against them without first putting them on the persisted
 * evaluation.
 */
export interface NativeAdLifecycleEvidence {
  fatigueStatus: CreativeInput["fatigueStatus"];
  lifecyclePosition: CreativeInput["lifecyclePosition"];
  /** Always `NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT`; carried for the blockers. */
  contractVersion: string;
  /**
   * sha256 over the FULL receipt: the bands or their explicit absence, the
   * sorted missing-evidence codes, the observed states, the winner bars and
   * sample floors, the ROAS targets, the frequency reading and its threshold,
   * and the derived lifecycle state. Two runs at the same cutoff over the same
   * facts produce the same hash; any change to the evidence or to the verdict
   * changes it.
   *
   * NEVER NULL, on purpose. Under v2 this was null whenever there was no
   * admissible band pair, which is exactly the held-Refresh case — the outcome
   * whose provenance an operator most needs. A held Refresh now carries a
   * receipt that says which gaps held it.
   */
  evidenceHash: string;
  /** Decline of `recent14` versus `prior14`, as a ratio, per composite stage. */
  ctrDecay: number | null;
  clickToPurchaseDecay: number | null;
  roasDecay: number | null;
  frequencyPressure: boolean;
  /** `prior14` cleared the account's winner spend/purchase/ROAS floors. */
  priorBandWasStrong: boolean;
  missingEvidence: string[];
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Frequency P75 per provider account.
 *
 * The map is the account-relative form the invariant asks for; the job builds
 * it once from the whole hydrated population, before the ads are split into
 * per-calibration-cell profile groups, so an account with eight ads spread
 * across three cells still gets one percentile instead of three nulls.
 */
export function resolveNativeAdFrequencyPressureThresholdsByAccount(
  adInputs: readonly AdDecisionInput[],
): ReadonlyMap<string, number | null> {
  const byAccount = new Map<string, AdDecisionInput[]>();
  for (const ad of adInputs) {
    const existing = byAccount.get(ad.providerAccountId);
    if (existing) existing.push(ad);
    else byAccount.set(ad.providerAccountId, [ad]);
  }
  return new Map(
    Array.from(byAccount, ([providerAccountId, ads]) => [
      providerAccountId,
      resolveNativeAdFrequencyPressureThreshold(ads),
    ]),
  );
}

/**
 * P75 of sibling ad frequencies over one population. Returns null below the
 * observation floor so a thin account cannot manufacture exposure pressure out
 * of two ads.
 */
export function resolveNativeAdFrequencyPressureThreshold(
  adInputs: readonly AdDecisionInput[],
): number | null {
  const observations = adInputs
    .filter((ad) => ad.metricEvidence.performanceMetricsObserved)
    .map((ad) => ad.frequency)
    .filter(finitePositive)
    .sort((left, right) => left - right);
  if (observations.length < NATIVE_AD_FREQUENCY_PRESSURE_MIN_OBSERVATIONS) {
    return null;
  }
  // Nearest-rank P75 over the sorted sample.
  const index = Math.min(
    observations.length - 1,
    Math.ceil(observations.length * 0.75) - 1,
  );
  return observations[index] ?? null;
}

/**
 * Midnight UTC of a `YYYY-MM-DD` date, or null when it is not one.
 *
 * ROUND-TRIPPED, because the shape test and `Date.parse` together are not a
 * validation. `Date.parse("2026-02-30T00:00:00.000Z")` does not fail — it
 * ROLLS OVER and returns midnight on 2026-03-02, and `Date.parse` for
 * `2026-04-31` returns 2026-05-01. Both satisfy the regex above and both are
 * finite, so an impossible date silently became a real one two days away and
 * shifted the band window it was defining. Measured on this runtime, not
 * assumed: only `2026-13-01` fails outright (NaN); every in-range-looking
 * overflow is accepted.
 *
 * Re-formatting the parsed instant and demanding the original string back is
 * what closes it: a date that is not the day it claims to be fails closed, and
 * the caller treats the band as inadmissible rather than comparing two windows
 * whose boundaries the engine invented.
 */
function parseIsoDate(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return null;
  if (new Date(parsed).toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

/** Inclusive day count of a window, so a 14-day band returns 14. */
function inclusiveDaySpan(startMs: number, endMs: number): number {
  return Math.round((endMs - startMs) / MS_PER_DAY) + 1;
}

/**
 * Admits one materialized window as a comparison period, or says exactly why
 * it cannot be one.
 *
 * Every rejection is named rather than coerced. A window whose denominators
 * are zero has no rate; substituting zero would report a 100% decay for an ad
 * that was simply not served.
 */
function admitCompositeBand(
  band: AdDisjointBandObservation | null | undefined,
  label: "recent14" | "prior14",
  cutoffMs: number,
  missingEvidence: string[],
): NativeAdCompositeBand | null {
  if (!band) {
    missingEvidence.push(`ad_${label}_window_unavailable`);
    return null;
  }
  const startMs = parseIsoDate(band.startDate);
  const endMs = parseIsoDate(band.endDate);
  if (startMs === null || endMs === null || endMs < startMs) {
    missingEvidence.push(`ad_${label}_window_dates_invalid`);
    return null;
  }
  // PIT safety: a window that reaches past the decision cutoff carries facts
  // the decision is not allowed to have seen.
  if (endMs > cutoffMs) {
    missingEvidence.push(`ad_${label}_window_after_cutoff`);
    return null;
  }
  if (inclusiveDaySpan(startMs, endMs) !== NATIVE_AD_BAND_LENGTH_DAYS) {
    missingEvidence.push(`ad_${label}_window_not_14_days`);
    return null;
  }
  if (!finitePositive(band.spend) || !finitePositive(band.impressions)) {
    missingEvidence.push(`ad_${label}_window_delivery_unavailable`);
    return null;
  }
  if (
    !finiteNonNegative(band.purchases) ||
    !finiteNonNegative(band.revenue) ||
    !finiteNonNegative(band.clicks)
  ) {
    missingEvidence.push(`ad_${label}_window_outcomes_unavailable`);
    return null;
  }
  /*
    Click-to-purchase needs a POSITIVE link-click denominator in BOTH periods,
    and null and zero are rejected for different reasons that both land here.

    `meta_ad_daily.link_clicks` is NULL for a day the provider supplied nothing
    and a number for a measured day, including a measured 0; the `ad_bands` CTE
    preserves that by summing the raw column, so a band is NULL only when every
    day in it was unsupplied. A NULL band has no rate to compute. A measured-0
    band has a zero denominator, and `purchases / 0` is not a rate either.

    This is the branch real ads take right now. Read-only inspection of the
    live warehouse on 2026-09-07 found 10,346 finalized, validated ad-day rows
    in the current 28-day window, 2,461 of them with a measured `link_clicks`
    and every one of those exactly 0, the other 7,885 NULL. The same column
    carried 7,666 positive rows in March 2026, so the composite is reachable on
    real facts, not only on fixtures.
  */
  if (!finitePositive(band.linkClicks)) {
    missingEvidence.push(`ad_${label}_window_link_clicks_unavailable`);
    return null;
  }
  return {
    startDate: band.startDate,
    endDate: band.endDate,
    spend: band.spend,
    purchases: band.purchases,
    revenue: band.revenue,
    impressions: band.impressions,
    clicks: band.clicks,
    linkClicks: band.linkClicks,
    roas: band.revenue / band.spend,
    ctr: (band.clicks / band.impressions) * 100,
    clickToPurchaseRate: band.purchases / band.linkClicks,
  };
}

/**
 * The equal, disjoint, directly adjacent 14/14 pair, or null with the reasons
 * recorded on `missingEvidence`.
 *
 * `INVARIANTS.md`: "When recent14 exists, creative fatigue decay must use the
 * directly preceding disjoint prior14 period. Overlapping cumulative rates are
 * not a substitute." Adjacency is checked arithmetically — `prior14.endDate`
 * must be the calendar day before `recent14.startDate` — so neither an overlap
 * nor a gap can pass as "directly preceding".
 */
function resolveNativeAdCompositeBands(
  ad: AdDecisionInput,
  missingEvidence: string[],
): { recent: NativeAdCompositeBand; prior: NativeAdCompositeBand } | null {
  const evidence = ad.adBandEvidence ?? null;
  if (!evidence) {
    missingEvidence.push("ad_disjoint_14d_band_evidence_unavailable");
    return null;
  }
  const cutoffMs = parseIsoDate(evidence.cutoffDate);
  if (cutoffMs === null) {
    missingEvidence.push("ad_band_cutoff_invalid");
    return null;
  }
  const recent = admitCompositeBand(
    evidence.recent14,
    "recent14",
    cutoffMs,
    missingEvidence,
  );
  const prior = admitCompositeBand(
    evidence.prior14,
    "prior14",
    cutoffMs,
    missingEvidence,
  );
  if (!recent || !prior) return null;

  const recentStartMs = parseIsoDate(recent.startDate);
  const priorEndMs = parseIsoDate(prior.endDate);
  if (
    recentStartMs === null ||
    priorEndMs === null ||
    priorEndMs !== recentStartMs - MS_PER_DAY
  ) {
    missingEvidence.push("ad_band_windows_not_directly_preceding");
    return null;
  }
  return { recent, prior };
}

function decayRatio(
  prior: number | null,
  recent: number | null,
): number | null {
  if (!finitePositive(prior) || !finiteNonNegative(recent)) return null;
  return (prior - recent) / prior;
}

/**
 * Ad-grain analogue of `isStrongHistoricalWindow` in
 * `lib/creative-decision-engine/fatigue.ts`: the same spend/purchase floors
 * and the same target/break-even ROAS bar, applied to one disjoint band.
 */
function priorBandIsStrong(
  band: NativeAdCompositeBand,
  profile: AccountDecisionProfile,
  ad: AdDecisionInput,
): boolean {
  const minSpend = profile.thresholds.winnerMemoryMinSpend ?? 0;
  const minPurchases = profile.thresholds.winnerMemoryMinPurchases ?? 1;
  if (band.spend < minSpend || band.purchases < minPurchases) return false;
  const bars: number[] = [];
  const targetRoas = ad.targetRoas ?? profile.spendUnitEvidence.targetRoas;
  const breakevenRoas =
    ad.breakevenRoas ?? profile.spendUnitEvidence.breakEvenRoas;
  if (finitePositive(targetRoas)) bars.push(targetRoas * 0.85);
  if (finitePositive(breakevenRoas)) bars.push(breakevenRoas * 1.1);
  if (bars.length === 0) return band.roas >= FATIGUE_STRONG_WINDOW_FALLBACK_ROAS;
  return band.roas >= Math.max(...bars);
}

/**
 * The evidence this contract acted on, published where a consumer can read it.
 *
 * Both Refresh outcomes carry it, and they carry the SAME two facts — the
 * contract version and the FULL evidence hash:
 *
 *  - HELD (`fatigueStatus: "unknown"`): `status: "missing"`, and the reason
 *    names the specific gaps rather than "no verdict". `ratioZonesGate`
 *    publishes the `refresh_ad_lifecycle_evidence` blocker that holds the row;
 *    this says which contract withheld it and exactly what it lacked.
 *  - AUTHORIZED (`fatigueStatus: "fatigued"`): `status: "passed"`. This is
 *    provenance, never a restriction — see `DecisionPredicateBlocker.status`
 *    in `types.ts` for why the read path cannot mistake it for one.
 *
 * Authority lineage is the reason the authorized path needs it at all.
 * `normalizeDecision` in `canonical-evaluation.ts` enumerates the fields it
 * canonicalizes into `decision_output_json` and `decisionHash`, and
 * `normalizeCreativeInput` likewise omits `adBandEvidence`. Without this entry
 * two ads whose bands and account-relative P75 differ entirely could reach
 * `fatigued` and produce byte-identical canonical decisions — one lineage for
 * two different pieces of evidence. The hash is emitted whole, not truncated:
 * a 16-hex prefix is a display convenience, and lineage that a prefix
 * collision can merge is not lineage.
 *
 * Nothing is stamped on rows that raised no Refresh at all. A healthy ad is
 * not carrying a verdict, and a provenance entry on every native row would
 * make the signal meaningless.
 *
 * `fatigueStatus` values other than `unknown` and `fatigued` are not handled
 * because they cannot accompany a Refresh: `shouldRefreshOnFatigue` in
 * `gates/ratio-zones.ts` requires `fatigued`, and the held branch beside it
 * requires `refreshLifecycleEvidenceUnavailable`, which is null-or-unknown.
 * A `none`/`watch` row reaching here would be a new Refresh producer, and it
 * gets no entry rather than a fabricated one.
 */
function nativeAdLifecycleEvidenceBlockers(
  decision: AdDecisionOutput,
  evidence: NativeAdLifecycleEvidence,
): AdDecisionOutput {
  const raisesRefresh =
    decision.blockedActionType === "refresh" ||
    decision.label === "refresh" ||
    decision.preAuthorityLabel === "refresh";
  if (!raisesRefresh) return decision;

  const withheld = evidence.fatigueStatus === "unknown";
  const confirmed = evidence.fatigueStatus === "fatigued";
  if (!withheld && !confirmed) return decision;

  const observed =
    evidence.evidenceHash === null
      ? evidence.contractVersion
      : `${evidence.contractVersion}#${evidence.evidenceHash}`;

  return {
    ...decision,
    blockers: [
      ...(decision.blockers ?? []),
      {
        predicate: "refresh_ad_lifecycle_evidence_contract",
        observed,
        threshold:
          "equal disjoint 14/14 ad-grain bands with CTR and click-to-purchase, plus an account-relative frequency P75",
        status: withheld ? "missing" : "passed",
        severity: "info",
        reason: withheld
          ? `ad-level fatigue evidence withheld by ${
              evidence.contractVersion
            }: ${evidence.missingEvidence.join(", ")}`
          : `ad-level fatigue evidence confirmed by ${evidence.contractVersion} on this ad's own equal, disjoint, cutoff-bound 14/14 bands and the account-relative frequency P75`,
      },
    ],
  };
}

/**
 * Derives this ad's own fatigue verdict and lifecycle position.
 *
 * The rule shape is the V1 fatigue motor's in `fatigue.ts`: material decay,
 * plus exposure pressure, plus memory of a strong earlier period. What changes
 * is the grain, which is entirely ad-owned:
 *
 *  - decay is measured on `recent14` against the directly preceding, equal,
 *    disjoint `prior14`, on three rates that V1 also uses — CTR,
 *    click-to-purchase and ROAS. CTR and click-to-purchase are the composite:
 *    impressions-to-clicks and clicks-to-purchases have different
 *    denominators, so agreeing is real corroboration;
 *  - exposure pressure is this ad's 28-day frequency against the P75 of every
 *    ad in the same PROVIDER ACCOUNT, minimum eight observations. The
 *    percentile is resolved once per account in
 *    `resolveNativeAdFrequencyPressureThresholdsByAccount` and passed in, never
 *    per profile group, which would be one calibration cell;
 *  - winner memory is `prior14` alone. V1 counts two strong disjoint bands out
 *    of four; an ad has exactly two, and requiring `recent14` to be strong
 *    would make `fatigued` unreachable by construction, since a fatigued ad's
 *    recent period is weak. `prior14` is disjoint from `recent14`, so it is
 *    still independent evidence.
 *
 * FAIL CLOSED. If any required piece is missing the status is `unknown`, never
 * `none`: `none` asserts the ad is not fatigued, which is a claim this
 * contract cannot make without the evidence. `unknown` is what
 * `refreshLifecycleEvidenceUnavailable` in `gates/ratio-zones.ts` reads to HOLD
 * a Refresh candidate — visible, with its reason, authorizing nothing.
 *
 * The 14/14 pair itself is now materialized: the `ad_bands` CTE in
 * `HYDRATE_AD_DECISION_INPUTS_QUERY` emits it for every hydrated ad, so a
 * missing band is an absence in `meta_ad_daily`, not an absent producer.
 *
 * On the CURRENT decision window every production ad still takes the fail-
 * closed branch, and for one nameable reason rather than a missing pipeline:
 * `meta_ad_daily.link_clicks` has no positive value anywhere in it (read-only
 * inspection, 2026-09-07 — 2,461 measured rows, all exactly 0, plus 7,885
 * NULL), so click-to-purchase has no denominator in either band. The same
 * column carried 7,666 positive rows in March 2026, and at a March cutoff 320
 * of that account population's 879 ads have positive link clicks in BOTH
 * bands. Complete evidence therefore does grant `fatigued`; today's holds are
 * a provider-feed gap, and they end without a code change when it closes.
 */
export function computeNativeAdLifecycleEvidence(input: {
  ad: AdDecisionInput;
  profile: AccountDecisionProfile;
  frequencyPressureThreshold: number | null;
}): NativeAdLifecycleEvidence {
  const missingEvidence: string[] = [];
  const bands = input.ad.metricEvidence.performanceMetricsObserved
    ? resolveNativeAdCompositeBands(input.ad, missingEvidence)
    : null;
  if (!input.ad.metricEvidence.performanceMetricsObserved) {
    missingEvidence.push("ad_performance_metrics_unobserved");
  }

  const recentSampleMinSpend = input.profile.thresholds.recentSampleMinSpend;
  const recentSampleSufficient =
    bands !== null &&
    finitePositive(recentSampleMinSpend) &&
    bands.recent.spend >= recentSampleMinSpend;
  if (bands !== null && !recentSampleSufficient) {
    missingEvidence.push("ad_recent_band_below_sample_floor");
  }

  /*
    Two different absences. No percentile AT ALL is missing evidence and
    withholds the verdict; a percentile this ad simply sits below is evidence
    of NO pressure, which `INVARIANTS.md` turns into lifecycle state rather
    than fatigue. Only the first is recorded on `missingEvidence`.
  */
  const frequencyPressureThreshold = input.frequencyPressureThreshold;
  if (frequencyPressureThreshold === null) {
    missingEvidence.push("account_relative_frequency_threshold_unavailable");
  }
  const frequencyPressure =
    frequencyPressureThreshold !== null &&
    finitePositive(input.ad.frequency) &&
    input.ad.frequency >= frequencyPressureThreshold;

  const admissible = bands !== null && recentSampleSufficient;
  const ctrDecay = admissible
    ? decayRatio(bands.prior.ctr, bands.recent.ctr)
    : null;
  const clickToPurchaseDecay = admissible
    ? decayRatio(bands.prior.clickToPurchaseRate, bands.recent.clickToPurchaseRate)
    : null;
  const roasDecay = admissible
    ? decayRatio(bands.prior.roas, bands.recent.roas)
    : null;

  const priorBandWasStrong =
    bands !== null && priorBandIsStrong(bands.prior, input.profile, input.ad);

  const decaySignals = [ctrDecay, clickToPurchaseDecay, roasDecay].filter(
    (value): value is number => value !== null,
  );
  const significantDecayCount = decaySignals.filter(
    (value) => value >= FATIGUE_SIGNIFICANT_DECAY_THRESHOLD,
  ).length;
  /*
    `INVARIANTS.md`: "A recent floor-clearing period that is non-declining
    versus its older comparison period must not be labeled `fatigued`."
    Encoded directly rather than left to follow from the decay count, so an
    improving `recent14` can never be read as wear whatever the counting rule
    later becomes.
  */
  const recentIsNonDeclining =
    decaySignals.length > 0 && decaySignals.every((value) => value <= 0);

  /*
    The composite is required, not preferred.

    D037: "Benchmark weakening can establish pressure but cannot substitute for
    a material CTR, click-to-purchase, or ROAS decay signal." ROAS alone is one
    signal on one denominator; the two funnel stages are what make a second
    signal independent. `fatigued` therefore needs at least one funnel-stage
    decay, so a purely economic drop (a price change, an AOV shift) is a
    performance question, not creative wear.

    Honest about its current force: with exactly the three signals below, two
    of which are funnel stages, `significantDecayCount >= 2` already implies
    this, and removing this clause today changes no outcome (verified by
    deleting it and re-running the contract suite). It is kept because the
    implication is a property of the signal SET, not of the rule: a fourth,
    economic signal would let two non-funnel observations form a `fatigued`
    verdict, which is what D037 forbids.
  */
  const funnelStageDecayed =
    (ctrDecay !== null && ctrDecay >= FATIGUE_SIGNIFICANT_DECAY_THRESHOLD) ||
    (clickToPurchaseDecay !== null &&
      clickToPurchaseDecay >= FATIGUE_SIGNIFICANT_DECAY_THRESHOLD);

  const evidenceComplete =
    admissible &&
    frequencyPressureThreshold !== null &&
    missingEvidence.length === 0;

  let fatigueStatus: CreativeInput["fatigueStatus"];
  if (!evidenceComplete) {
    fatigueStatus = "unknown";
  } else if (recentIsNonDeclining) {
    fatigueStatus = "none";
  } else if (
    priorBandWasStrong &&
    significantDecayCount >= 2 &&
    funnelStageDecayed &&
    frequencyPressure
  ) {
    fatigueStatus = "fatigued";
  } else if (significantDecayCount >= 1 && frequencyPressure) {
    fatigueStatus = "watch";
  } else if (!priorBandWasStrong && significantDecayCount >= 2) {
    fatigueStatus = "watch";
  } else {
    fatigueStatus = "none";
  }

  /*
    Only the non-granting positions are emitted.

    `applyPostProcess` in `lib/creative-decision-engine/gates/types.ts` adds
    +5/+3/+2 confidence and an "opportunity window" badge for `rising` and
    `plateau`. Two 14-day periods cannot certify that a window is open, and
    confidence feeds the automation act threshold, so this contract never emits
    them. `past_peak_unclear` only subtracts confidence and warns;
    `insufficient_history` behaves exactly as the previous null did, and is the
    honest position when the bands were never admissible.
  */
  const lifecyclePosition: CreativeInput["lifecyclePosition"] =
    roasDecay !== null && roasDecay >= FATIGUE_SIGNIFICANT_DECAY_THRESHOLD
      ? "past_peak_unclear"
      : "insufficient_history";

  /*
    THE FULL RECEIPT, FOR EVERY REFRESH — HELD OR AUTHORIZED.

    This hash used to be `bands ? sha256(...) : null`, so the outcome that most
    needs provenance had none: a Refresh HELD for missing or invalid evidence
    produced `evidenceHash: null` and published only the contract version. An
    operator asking "on what did you withhold this?" got the name of a contract
    and nothing it could be pinned to, and two different holds — one missing a
    window, one whose window dates were impossible — were indistinguishable.
    Determinism was equally unprovable: nothing was hashed, so nothing could be
    shown to be stable across runs.

    It is now computed for every outcome and it is never null. It is built HERE,
    after the verdict, rather than beside the bands, because the receipt has to
    cover the whole of what produced the verdict:

      - the bands, or an explicit null when there were none;
      - `missingEvidence`, SORTED, so a receipt is stable under the order the
        gaps happened to be appended in — and it is precisely what separates
        two different holds;
      - the observed states that decided whether bands were even attempted;
      - the winner bars and sample floors `priorBandIsStrong` and the recent
        sample gate actually read, including the ROAS targets they prefer off
        the ad before the profile, so a threshold change moves the hash;
      - the frequency reading and its account-relative threshold;
      - the derived state itself — `fatigueStatus`, `lifecyclePosition`,
        `priorBandWasStrong`, the decay ratios, admissibility and completeness.

    Hashing the derived state alongside its inputs is deliberate: it makes the
    receipt a claim about the verdict, so a change in the derivation that left
    every input untouched would still change the hash.
  */
  const evidenceHash = canonicalSha256({
    contractVersion: NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT,
    cutoffDate: input.ad.adBandEvidence?.cutoffDate ?? null,
    decisionEntityId: input.ad.decisionEntityId,
    providerAccountId: input.ad.providerAccountId,
    recent14: bands?.recent ?? null,
    prior14: bands?.prior ?? null,
    observed: {
      performanceMetricsObserved:
        input.ad.metricEvidence.performanceMetricsObserved,
      bandsResolved: bands !== null,
      admissible,
      recentSampleSufficient,
      evidenceComplete,
    },
    missingEvidence: [...missingEvidence].sort(),
    frequency: input.ad.frequency ?? null,
    frequencyPressureThreshold: input.frequencyPressureThreshold,
    frequencyPressure,
    floors: {
      recentSampleMinSpend: recentSampleMinSpend ?? null,
      winnerMemoryMinSpend: input.profile.thresholds.winnerMemoryMinSpend ?? null,
      winnerMemoryMinPurchases:
        input.profile.thresholds.winnerMemoryMinPurchases ?? null,
      strongWindowFallbackRoas: FATIGUE_STRONG_WINDOW_FALLBACK_ROAS,
      significantDecayThreshold: FATIGUE_SIGNIFICANT_DECAY_THRESHOLD,
      bandLengthDays: NATIVE_AD_BAND_LENGTH_DAYS,
    },
    targets: {
      targetRoas:
        input.ad.targetRoas ?? input.profile.spendUnitEvidence.targetRoas ?? null,
      breakevenRoas:
        input.ad.breakevenRoas ??
        input.profile.spendUnitEvidence.breakEvenRoas ??
        null,
    },
    derived: {
      ctrDecay,
      clickToPurchaseDecay,
      roasDecay,
      significantDecayCount,
      funnelStageDecayed,
      recentIsNonDeclining,
      priorBandWasStrong,
      fatigueStatus,
      lifecyclePosition,
    },
  });

  return {
    fatigueStatus,
    lifecyclePosition,
    contractVersion: NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT,
    evidenceHash,
    ctrDecay,
    clickToPurchaseDecay,
    roasDecay,
    frequencyPressure,
    priorBandWasStrong,
    missingEvidence,
  };
}

function toNativeAdDecisionOutput(
  decision: DecisionOutput,
  input: AdDecisionInput,
): AdDecisionOutput {
  return {
    ...decision,
    decisionEntityType: "ad",
    decisionEntityId: input.decisionEntityId,
    adId: input.adId,
    providerAccountId: input.providerAccountId,
    creativeId: input.creativeId,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
  };
}

function normalizeSiteOwnedAdDecision(
  decision: DecisionOutput,
): DecisionOutput {
  const siteOwnedIssue =
    decision.label === "diagnose" &&
    decision.badges.find(
      (badge) =>
        badge.type === "landing_page_issue" ||
        badge.type === "checkout_breakdown",
    );
  return {
    ...decision,
    label: siteOwnedIssue ? "keep" : decision.label,
    preAuthorityLabel: siteOwnedIssue ? "keep" : decision.preAuthorityLabel,
    reason: siteOwnedIssue
      ? `[Keep Ad; fix ${siteOwnedIssue.type === "landing_page_issue" ? "landing page" : "checkout"}] ${decision.reason}`
      : decision.reason,
  };
}

function guardUnavailableAdMetrics(
  decision: AdDecisionOutput,
  input: AdDecisionInput,
): AdDecisionOutput {
  if (input.metricEvidence.performanceMetricsObserved) return decision;
  const badges = decision.badges.some(
    (badge) => badge.type === "ad_metrics_unavailable",
  )
    ? decision.badges
    : [
        ...decision.badges,
        {
          type: "ad_metrics_unavailable" as const,
          label:
            "No finalized native ad insights row exists; zero spend is not treated as observed performance.",
          severity: "warning" as const,
        },
      ];
  const preserveContextFailure = decision.label === "out_of_scope";
  const hardLabel = isHardLabel(decision.label) ? decision.label : null;
  return {
    ...decision,
    label: preserveContextFailure ? "out_of_scope" : "diagnose",
    confidence: Math.min(decision.confidence, 40),
    badges,
    authorityBlocker:
      decision.authorityBlocker ??
      (hardLabel === null ? null : "native_metrics_unavailable"),
    blockedActionType: decision.blockedActionType ?? hardLabel,
    reason: `[Ad metrics unavailable - fail closed] ${decision.reason}`,
  };
}

function toPriorHysteresisProvenance(
  businessId: string,
  ad: AdDecisionInput,
  previous: PreviousAdPublishedLabel | null,
): PriorHysteresisProvenance {
  if (!previous) {
    return {
      source: "none",
      sourceBusinessId: businessId,
      sourceProviderAccountId: ad.providerAccountId,
      sourceDecisionEntityType: "ad",
      sourceDecisionEntityId: ad.decisionEntityId,
    };
  }
  return {
    source: "persisted_evaluation",
    sourceBusinessId: previous.businessId,
    sourceProviderAccountId: previous.providerAccountId,
    sourceDecisionEntityType: previous.decisionEntityType,
    sourceDecisionEntityId: previous.decisionEntityId,
    sourceEvaluationId: previous.sourceEvaluationId,
    sourceSnapshotId: previous.sourceSnapshotId,
    sourceEngineVersion: previous.sourceEngineVersion,
    sourceAsOfDate: previous.sourceAsOfDate,
    sourceInputHash: previous.sourceInputHash,
    sourceDecisionHash: previous.sourceDecisionHash,
    publishedLabel: previous.publishedLabel,
    rawLabel: previous.rawLabel,
  };
}

async function readAdCampaignContext(
  input: AdDecisionsJobInput & {
    adInputs: AdDecisionInput[];
    mode: ReturnType<typeof resolveCampaignContextMode>;
  },
) {
  const campaignIdsByAccount = new Map<string, Set<string>>();
  for (const ad of input.adInputs) {
    const providerAccountId = ad.providerAccountId.trim();
    const campaignId = ad.campaignId?.trim() ?? "";
    if (!providerAccountId || !campaignId) continue;
    const campaignIds =
      campaignIdsByAccount.get(providerAccountId) ?? new Set<string>();
    campaignIds.add(campaignId);
    campaignIdsByAccount.set(providerAccountId, campaignIds);
  }
  const maps = await Promise.all(
    [...campaignIdsByAccount].map(([providerAccountId, campaignIds]) =>
      readCampaignContextMap({
        businessId: input.businessId,
        providerAccountId,
        campaignIds: [...campaignIds].sort(),
        asOf: input.asOf,
        mode: input.mode,
      }),
    ),
  );
  return new Map(maps.flatMap((map) => [...map]));
}

export function toNativeSnapshotPayload(input: {
  businessId: string;
  asOf: string;
  jobRunId: string;
  scope: DecisionProfileScope;
  computation: AdDecisionComputation;
  stored: StoredAdDecisionEvaluation;
  calibrationRowId: string | null;
  hardActionEligibility: {
    scale: boolean;
    cut: boolean;
    refresh: boolean;
  };
  computedAt: string;
}): NativeSnapshotPayloadRow {
  const ad = input.computation.input;
  const decision = input.computation.decision;
  const authorizedAction = resolveNativeSnapshotAuthorizedAction({
    rawLabel: input.computation.rawLabel,
    publishedLabel: decision.label,
    authorityBlocker: decision.authorityBlocker,
    confidence: decision.confidence,
    calibrationRowId: input.calibrationRowId,
    hardActionEligibility: input.hardActionEligibility,
  });
  return {
    business_ref_id: input.businessId,
    business_id: input.businessId,
    provider_account_ref_id: ad.providerAccountRefId,
    provider_account_id: ad.providerAccountId,
    decision_entity_type: "ad",
    decision_entity_id: ad.decisionEntityId,
    ad_id: ad.adId,
    creative_id: ad.creativeId,
    as_of_date: input.asOf,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: input.scope.type,
    scope_id: input.scope.id,
    label: decision.label,
    raw_label: input.computation.rawLabel,
    pre_authority_label: decision.preAuthorityLabel,
    authority_blocker: decision.authorityBlocker,
    confidence: toConfidenceInteger(decision.confidence),
    truth_source: decision.truthSource,
    effective_target_roas: decision.effectiveTargetRoas,
    ratio_to_target: decision.ratioToTarget,
    badges: decision.badges,
    reason: decision.reason,
    spend: ad.spend,
    purchases: ad.purchases,
    roas: ad.roas,
    recent7d_roas: ad.recent7dRoas,
    label_transform: decision.labelTransform ?? null,
    blocked_action_type: isHardLabel(decision.blockedActionType)
      ? decision.blockedActionType
      : null,
    authorized_action: authorizedAction,
    job_run_id: input.jobRunId,
    creative_evidence_lifecycle_row_id:
      ad.creativeEvidence.sourceLifecycleRowId,
    calibration_row_id: input.calibrationRowId,
    evaluation_id: input.stored.evaluationId,
    input_hash: input.stored.inputHash,
    decision_hash: input.stored.decisionHash,
    computed_at: input.computedAt,
  };
}

function resolveNativeSnapshotAuthorizedAction(input: {
  rawLabel: DecisionLabel;
  publishedLabel: DecisionLabel;
  authorityBlocker: DecisionAuthorityBlocker | null;
  confidence: number;
  calibrationRowId: string | null;
  hardActionEligibility: {
    scale: boolean;
    cut: boolean;
    refresh: boolean;
  };
}): "scale" | "cut" | "refresh" | null {
  if (input.authorityBlocker !== null) return null;
  const hardRawLabel = isHardLabel(input.rawLabel) ? input.rawLabel : null;
  if (input.calibrationRowId === null) {
    const softOnlyLabels = new Set<DecisionLabel>([
      "diagnose",
      "out_of_scope",
      "keep",
    ]);
    if (
      hardRawLabel !== null ||
      !softOnlyLabels.has(input.publishedLabel) ||
      input.confidence > 40
    ) {
      throw new NativeAdProfileProvenanceError(
        "snapshot without native calibration attempted hard or over-confident authority",
      );
    }
    return null;
  }
  if (hardRawLabel === null) return null;
  if (input.publishedLabel !== hardRawLabel) return null;
  if (input.hardActionEligibility[hardRawLabel] !== true) {
    throw new NativeAdProfileProvenanceError(
      `native calibration does not authorize raw ${hardRawLabel}`,
    );
  }
  return hardRawLabel;
}

export async function upsertNativeAdDecisionSnapshots(
  rows: NativeSnapshotPayloadRow[],
  db: DbClient = getDb(),
): Promise<Map<string, ComparableNativeAdSnapshot>> {
  if (rows.length === 0) return new Map();
  const result = new Map<string, ComparableNativeAdSnapshot>();
  for (const batch of chunkDecisionRows(rows)) {
    const storedRows = await db.query<NativeSnapshotRow>(
      UPSERT_NATIVE_AD_DECISION_SNAPSHOTS_QUERY,
      [JSON.stringify(batch)],
    );
    const storedBatch = mapNativeSnapshots(storedRows);
    if (storedBatch.size !== batch.length) {
      throw new Error(
        `Native ad snapshot linkage incomplete: expected ${batch.length}, wrote ${storedBatch.size}.`,
      );
    }
    mergeUniqueMap(result, storedBatch, "stored snapshot");
  }
  if (result.size !== rows.length) {
    throw new Error(
      `Native ad snapshot linkage incomplete: expected ${rows.length}, wrote ${result.size}.`,
    );
  }
  return result;
}

export function assertEmptyNativeAdHydrationIsAuthoritative(
  hydration: AdDecisionHydrationResult,
): void {
  if (hydration.inputs.length > 0) return;
  if (
    hydration.receipts.length === 0 ||
    !hydration.accountCoverageComplete ||
    hydration.receipts.some(
      (receipt) =>
        !receipt.authoritativeForPrune || receipt.expectedAdCount !== 0,
    )
  ) {
    throw new Error(
      "Empty native ad hydration is not backed by complete authoritative zero-ad receipts.",
    );
  }
}

export async function pruneStaleNativeAdSnapshots(
  input: AdDecisionsJobInput & {
    scope: DecisionProfileScope;
    currentInputs: AdDecisionInput[];
    receipt: AdDecisionHydrationReceipt;
  },
  db: DbClient,
): Promise<NativeSnapshotPruneResult> {
  if (!input.receipt.authoritativeForPrune) {
    return {
      prunedSnapshots: 0,
      prunedEvents: 0,
      skippedBecauseEmptyPayload: input.currentInputs.length === 0,
      skippedUnprovenReceiptCount: 1,
      authoritativeReceiptCount: 0,
    };
  }
  if (
    input.receipt.businessId !== input.businessId ||
    input.receipt.asOfDate !== input.asOf ||
    input.receipt.scopeType !== input.scope.type ||
    input.receipt.scopeId !== input.scope.id ||
    input.receipt.providerAccountId !== input.scope.id ||
    !/^[0-9a-f]{64}$/.test(input.receipt.sourceRunHash ?? "")
  ) {
    throw new Error("Native ad prune receipt scope/lineage is invalid.");
  }
  const currentAdIds = input.currentInputs
    .map((ad) => {
      if (
        ad.businessId !== input.businessId ||
        ad.providerAccountId !== input.receipt.providerAccountId ||
        ad.providerAccountRefId !== input.receipt.providerAccountRefId
      ) {
        throw new Error("Native ad prune input escaped its receipt scope.");
      }
      return ad.adId;
    })
    .sort();
  const currentManifestHash = hashAdDecisionIdentityManifest({
    businessId: input.businessId,
    providerAccountId: input.receipt.providerAccountId,
    asOfDate: input.asOf,
    adIds: currentAdIds,
  });
  if (
    currentAdIds.length !== input.receipt.expectedAdCount ||
    currentManifestHash !== input.receipt.expectedManifestHash ||
    currentManifestHash !== input.receipt.hydratedManifestHash
  ) {
    throw new Error(
      "Native ad prune receipt manifest does not match hydration.",
    );
  }
  const identities = input.receipt.expectedAdIds.map((adId) => ({
    provider_account_ref_id: input.receipt.providerAccountRefId,
    provider_account_id: input.receipt.providerAccountId,
    decision_entity_type: "ad",
    decision_entity_id: adId,
  }));
  const [row] = await db.query<CountRow>(
    PRUNE_STALE_NATIVE_AD_DECISION_SNAPSHOTS_QUERY,
    [
      input.businessId,
      input.asOf,
      NATIVE_AD_ENGINE_VERSION,
      input.scope.type,
      input.scope.id,
      JSON.stringify(identities),
      input.receipt.providerAccountRefId,
    ],
  );
  return {
    prunedSnapshots: toInteger(row?.pruned_snapshot_count) ?? 0,
    prunedEvents: toInteger(row?.pruned_event_count) ?? 0,
    skippedBecauseEmptyPayload: false,
    skippedUnprovenReceiptCount: 0,
    authoritativeReceiptCount: 1,
  };
}

async function findPreviousNativeAdSnapshots(
  input: AdDecisionsJobInput & {
    scope: DecisionProfileScope;
    adInputs: AdDecisionInput[];
  },
  db: DbClient,
) {
  if (input.adInputs.length === 0)
    return new Map<string, ComparableNativeAdSnapshot>();
  const result = new Map<string, ComparableNativeAdSnapshot>();
  for (const adBatch of chunkDecisionRows(input.adInputs)) {
    const identities = adBatch.map((ad) => ({
      provider_account_ref_id: ad.providerAccountRefId,
      provider_account_id: ad.providerAccountId,
      decision_entity_type: "ad",
      decision_entity_id: ad.decisionEntityId,
    }));
    const rows = await db.query<NativeSnapshotRow>(
      `
    WITH identities AS (
      SELECT *
      FROM jsonb_to_recordset($3::jsonb) AS row(
        provider_account_ref_id uuid,
        provider_account_id text,
        decision_entity_type text,
        decision_entity_id text
      )
    )
    SELECT DISTINCT ON (
      snapshot.provider_account_ref_id,
      snapshot.provider_account_id,
      snapshot.decision_entity_type,
      snapshot.decision_entity_id
    )
      snapshot.id,
      snapshot.provider_account_ref_id,
      snapshot.provider_account_id,
      snapshot.decision_entity_type,
      snapshot.decision_entity_id,
      snapshot.scope_type,
      snapshot.scope_id,
      snapshot.label,
      snapshot.confidence
    FROM engine_v3_ad_decision_snapshots_daily snapshot
    INNER JOIN identities identity
      ON identity.provider_account_ref_id = snapshot.provider_account_ref_id
     AND identity.provider_account_id = snapshot.provider_account_id
     AND identity.decision_entity_type = snapshot.decision_entity_type
     AND identity.decision_entity_id = snapshot.decision_entity_id
    WHERE snapshot.business_ref_id = $1::uuid
      AND snapshot.engine_version = $2
      AND snapshot.as_of_date < $4::date
      AND snapshot.scope_type = $5
      AND snapshot.scope_id = $6
    ORDER BY
      snapshot.provider_account_ref_id,
      snapshot.provider_account_id,
      snapshot.decision_entity_type,
      snapshot.decision_entity_id,
      snapshot.as_of_date DESC,
      snapshot.computed_at DESC,
      snapshot.id DESC
    `,
      [
        input.businessId,
        NATIVE_AD_ENGINE_VERSION,
        JSON.stringify(identities),
        input.asOf,
        input.scope.type,
        input.scope.id,
      ],
    );
    mergeUniqueMap(result, mapNativeSnapshots(rows), "previous snapshot");
  }
  return result;
}

function mapNativeSnapshots(rows: NativeSnapshotRow[]) {
  const result = new Map<string, ComparableNativeAdSnapshot>();
  for (const row of rows) {
    const providerAccountRefId = toText(row.provider_account_ref_id);
    const providerAccountId = toText(row.provider_account_id);
    const decisionEntityId = toText(row.decision_entity_id);
    const scopeType = toText(row.scope_type);
    const scopeId = toText(row.scope_id);
    const id = toText(row.id);
    const label = toDecisionLabel(row.label);
    const confidence = toInteger(row.confidence);
    if (
      providerAccountRefId === null ||
      providerAccountId === null ||
      row.decision_entity_type !== "ad" ||
      decisionEntityId === null ||
      scopeType === null ||
      scopeId === null ||
      id === null ||
      label === null ||
      confidence === null
    ) {
      throw new Error("Native ad snapshot row has incomplete identity/state.");
    }
    const key = nativeSnapshotIdentityKey({
      providerAccountRefId,
      providerAccountId,
      decisionEntityType: "ad",
      decisionEntityId,
      scopeType,
      scopeId,
    });
    if (result.has(key)) {
      throw new Error(`Duplicate native ad snapshot identity: ${key}`);
    }
    result.set(key, {
      id,
      label,
      confidence,
    });
  }
  return result;
}

function nativeSnapshotIdentityKey(input: {
  providerAccountRefId: string;
  providerAccountId: string;
  decisionEntityType: "ad";
  decisionEntityId: string;
  scopeType: string;
  scopeId: string;
}) {
  return [
    input.providerAccountRefId,
    input.providerAccountId,
    input.decisionEntityType,
    input.decisionEntityId,
    input.scopeType,
    input.scopeId,
  ].join("\u0000");
}

export function buildNativeAdDecisionChangeEvents(
  input: AdDecisionsJobInput & {
    jobRunId: string;
    scope: DecisionProfileScope;
    decisions: AdDecisionComputation[];
    previousSnapshots: Map<string, ComparableNativeAdSnapshot>;
    currentSnapshots: Map<string, ComparableNativeAdSnapshot>;
  },
): NativeDecisionChangeEventPayloadRow[] {
  return input.decisions.flatMap((computation) => {
    const key = nativeSnapshotIdentityKey({
      providerAccountRefId: computation.input.providerAccountRefId,
      providerAccountId: computation.input.providerAccountId,
      decisionEntityType: "ad",
      decisionEntityId: computation.input.decisionEntityId,
      scopeType: input.scope.type,
      scopeId: input.scope.id,
    });
    const previous = input.previousSnapshots.get(key);
    const current = input.currentSnapshots.get(key);
    if (!previous || !current || previous.label === current.label) return [];
    return [
      {
        business_ref_id: input.businessId,
        business_id: input.businessId,
        provider_account_ref_id: computation.input.providerAccountRefId,
        provider_account_id: computation.input.providerAccountId,
        decision_entity_type: "ad" as const,
        decision_entity_id: computation.input.decisionEntityId,
        ad_id: computation.input.adId,
        creative_id: computation.input.creativeId,
        event_date: input.asOf,
        engine_version: NATIVE_AD_ENGINE_VERSION,
        scope_type: input.scope.type,
        scope_id: input.scope.id,
        previous_label: previous.label,
        current_label: current.label,
        previous_confidence: previous.confidence,
        current_confidence: current.confidence,
        previous_decision_snapshot_id: previous.id,
        decision_snapshot_id: current.id,
        job_run_id: input.jobRunId,
      },
    ];
  });
}

export async function reconcileNativeAdDecisionChangeEvents(
  input: AdDecisionsJobInput & {
    scope: DecisionProfileScope;
    decisions: AdDecisionComputation[];
    rows: NativeDecisionChangeEventPayloadRow[];
  },
  db: DbClient,
) {
  if (input.decisions.length === 0) return 0;
  const rowsByIdentity = new Map(
    input.rows.map((row) => [
      `${row.provider_account_ref_id}\u0000${row.provider_account_id}\u0000${row.decision_entity_id}`,
      row,
    ]),
  );
  if (rowsByIdentity.size !== input.rows.length) {
    throw new Error("Duplicate native ad decision change-event identity.");
  }
  let insertedCount = 0;
  for (const decisionBatch of chunkDecisionRows(input.decisions)) {
    const identities = decisionBatch.map((computation) => ({
      business_ref_id: input.businessId,
      provider_account_ref_id: computation.input.providerAccountRefId,
      provider_account_id: computation.input.providerAccountId,
      decision_entity_type: "ad",
      decision_entity_id: computation.input.decisionEntityId,
      event_date: input.asOf,
      engine_version: NATIVE_AD_ENGINE_VERSION,
      scope_type: input.scope.type,
      scope_id: input.scope.id,
    }));
    const rows = identities.flatMap((identity) => {
      const row = rowsByIdentity.get(
        `${identity.provider_account_ref_id}\u0000${identity.provider_account_id}\u0000${identity.decision_entity_id}`,
      );
      return row ? [row] : [];
    });
    const inserted = await db.query<IdRow>(
      INSERT_NATIVE_AD_DECISION_CHANGE_EVENTS_QUERY,
      [JSON.stringify(rows), JSON.stringify(identities)],
    );
    insertedCount += inserted.length;
  }
  return insertedCount;
}

async function findLatestSuccessfulAdCalibrationRun(
  input: AdDecisionsJobInput,
  db: DbClient,
) {
  const [row] = await db.query<IdRow>(
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
    [
      AD_CALIBRATION_JOB_NAME,
      input.businessId,
      input.asOf,
      NATIVE_AD_ENGINE_VERSION,
    ],
  );
  return toText(row?.id);
}

async function insertAdJobRun(
  input: AdDecisionsJobInput & {
    status: JobStatus | "running";
    dependencyRunId: string | null;
  },
  db: DbClient,
) {
  const [row] = await db.query<IdRow>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, dependency_run_id
    ) VALUES ($1, $2::uuid, $3, $4::date, $5, $6, $7::uuid)
    RETURNING id
    `,
    [
      AD_DECISIONS_JOB_NAME,
      input.businessId,
      input.businessId,
      input.asOf,
      NATIVE_AD_ENGINE_VERSION,
      input.status,
      input.dependencyRunId,
    ],
  );
  const id = toText(row?.id);
  if (!id)
    throw new Error("Native ad decisions job run insert returned no id.");
  return id;
}

async function setAdJobDependency(
  jobRunId: string,
  dependencyRunId: string | null,
  db: DbClient,
) {
  await db.query(
    `
    UPDATE engine_v3_job_runs
    SET dependency_run_id = $1::uuid, updated_at = clock_timestamp()
    WHERE id = $2::uuid
      AND status = 'running'
    `,
    [dependencyRunId, jobRunId],
  );
}

async function markAdJobSkipped(
  input: {
    jobRunId: string;
    durationMs: number;
    message: string;
  },
  db: DbClient,
) {
  await db.query(
    `
    UPDATE engine_v3_job_runs
    SET status = 'skipped', finished_at = clock_timestamp(),
      duration_ms = $1::integer, row_count = 0, error_message = $2,
      updated_at = clock_timestamp()
    WHERE id = $3::uuid
      AND status = 'running'
    `,
    [input.durationMs, input.message, input.jobRunId],
  );
}

export function persistedAdDecisionHydrationReceipt(
  receipt: AdDecisionHydrationReceipt,
) {
  return {
    contract_version: receipt.contractVersion,
    provider_account_ref_id: receipt.providerAccountRefId,
    provider_account_id: receipt.providerAccountId,
    decision_cutoff: receipt.decisionCutoff,
    source_run_id: receipt.sourceRunId,
    source_observed_at: receipt.sourceObservedAt,
    source_captured_at: receipt.sourceCapturedAt,
    source_run_hash: receipt.sourceRunHash,
    source_payload_hash: receipt.sourcePayloadHash,
    source_expected_row_count: receipt.sourceExpectedRowCount,
    source_persisted_row_count: receipt.sourcePersistedRowCount,
    expected_ad_count: receipt.expectedAdCount,
    expected_manifest_hash: receipt.expectedManifestHash,
    hydrated_ad_count: receipt.hydratedAdCount,
    hydrated_manifest_hash: receipt.hydratedManifestHash,
    source_complete: receipt.sourceComplete,
    hydration_complete: receipt.hydrationComplete,
    authoritative_for_prune: receipt.authoritativeForPrune,
    reason: receipt.reason,
  };
}

async function markAdJobSuccess(
  input: {
    jobRunId: string;
    durationMs: number;
    rowCount: number;
    changeEventsWritten: number;
    pruneResult: NativeSnapshotPruneResult;
    hydrationReceipts: AdDecisionHydrationReceipt[];
  },
  db: DbClient,
) {
  await db.query(
    `
    UPDATE engine_v3_job_runs
    SET status = 'success', finished_at = clock_timestamp(), duration_ms = $1::integer,
      row_count = $2::integer, error_json = $3::jsonb,
      updated_at = clock_timestamp()
    WHERE id = $4::uuid
      AND status = 'running'
    `,
    [
      input.durationMs,
      input.rowCount,
      JSON.stringify({
        metadata: {
          native_ad_grain: true,
          shadow_only: true,
          change_event_count: input.changeEventsWritten,
          pruned_snapshot_count: input.pruneResult.prunedSnapshots,
          pruned_event_count: input.pruneResult.prunedEvents,
          authoritative_prune_receipt_count:
            input.pruneResult.authoritativeReceiptCount,
          prune_skipped_unproven_receipt_count:
            input.pruneResult.skippedUnprovenReceiptCount,
          hydration_receipts: input.hydrationReceipts.map(
            persistedAdDecisionHydrationReceipt,
          ),
          ...(input.pruneResult.skippedBecauseEmptyPayload
            ? { prune_skipped_empty_payload: true }
            : {}),
        },
      }),
      input.jobRunId,
    ],
  );
}

async function markAdJobFailed(
  input: {
    jobRunId: string;
    durationMs: number;
    error: unknown;
    message: string;
  },
  db: DbClient,
) {
  await db.query(
    `
    UPDATE engine_v3_job_runs
    SET status = 'failed', finished_at = clock_timestamp(), duration_ms = $1::integer,
      row_count = 0, error_message = $2, error_json = $3::jsonb,
      updated_at = clock_timestamp()
    WHERE id = $4::uuid
      AND status = 'running'
    `,
    [
      input.durationMs,
      input.message,
      JSON.stringify(errorToJson(input.error)),
      input.jobRunId,
    ],
  );
}

function failedWithoutRun(
  startedAt: number,
  reason: NonNullable<AdDecisionsJobResult["reason"]>,
  errorMessage: string,
): AdDecisionsJobResult {
  return {
    jobRunId: "",
    status: "failed",
    snapshotsWritten: 0,
    changeEventsWritten: 0,
    durationMs: Date.now() - startedAt,
    reason,
    errorMessage,
  };
}

function isHardLabel(
  value: DecisionLabel | null | undefined,
): value is "scale" | "cut" | "refresh" {
  return value === "scale" || value === "cut" || value === "refresh";
}

function toConfidenceInteger(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function toInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function toDecisionLabel(value: unknown): DecisionLabel | null {
  return value === "scale" ||
    value === "keep" ||
    value === "refresh" ||
    value === "cut" ||
    value === "test_more" ||
    value === "diagnose" ||
    value === "out_of_scope"
    ? value
    : null;
}

function errorToJson(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...("code" in error
        ? { code: String((error as Error & { code?: unknown }).code ?? "") }
        : {}),
    };
  }
  return { name: "UnknownError", message: String(error) };
}
