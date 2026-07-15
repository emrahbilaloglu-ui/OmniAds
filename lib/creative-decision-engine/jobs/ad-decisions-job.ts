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
  readCampaignContextLabelMap,
  resolveCampaignContextMode,
  type CampaignContextLabelMap,
} from "../campaign-context/source";
import {
  buildCanonicalEvaluationProvenance,
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
  const blockedReason = `hard_actions_blocked:${input.blocker}`;
  const profile: NativeAdSoftOnlyDecisionProfile = {
    profileType: "native_ad_soft_only",
    businessId: input.businessId,
    asOfDate: input.asOf,
    channel: "meta",
    objectiveFamily: "sales",
    scope: { type: "account", id: providerAccountId },
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
  campaignContextById: CampaignContextLabelMap;
  previousLabels: Map<string, PreviousAdPublishedLabel>;
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
  });
}

export function computeSoftOnlyNativeAdDecisions(input: {
  businessId: string;
  blocker: string;
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  adInputs: AdDecisionInput[];
  campaignContextMode: ReturnType<typeof resolveCampaignContextMode>;
  campaignContextById: CampaignContextLabelMap;
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
          campaignLabelStatus: withCampaign.campaignId
            ? withCampaign.campaignKind
              ? "labeled"
              : "unlabeled"
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
  campaignContextById: CampaignContextLabelMap;
  previousLabels: Map<string, PreviousAdPublishedLabel>;
  resolveDecision?: (
    input: CreativeInput,
    profile: AccountDecisionProfile,
    dataHealth: DataHealth,
  ) => DecisionOutput;
}): AdDecisionComputation[] {
  return input.adInputs
    .map((adInput) => {
      const withCampaign = withCreativeCampaignLabelContext(
        adInput,
        input.campaignContextById,
      );
      const resolverInput = toResolverInput(withCampaign);
      const resolveDecision = input.resolveDecision ?? decideCreative;
      const semanticDecision = normalizeSiteOwnedAdDecision(
        resolveDecision(resolverInput, input.profile, input.dataHealth),
      );
      const guarded = applyCreativeCampaignLabelGuard({
        decision: semanticDecision,
        input: withCampaign,
        campaignLabelsById: input.campaignContextById,
      });
      const adDecision = guardUnavailableAdMetrics(
        toNativeAdDecisionOutput(guarded, withCampaign),
        withCampaign,
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

function toResolverInput(input: AdDecisionInput): CreativeInput {
  const {
    metricEvidence: _metricEvidence,
    statusEvidence: _statusEvidence,
    creativeEvidence: _creativeEvidence,
    accountTimezone: _accountTimezone,
    accountCurrency: _accountCurrency,
    creativeId,
    ...rest
  } = input;
  return {
    ...rest,
    // Resolver math never consumes this field. Native identity is restored on
    // the output before any canonical or persistence boundary.
    creativeId: creativeId ?? `native-ad:${input.adId}`,
    // Creative-owned V1 lifecycle is retained only in creativeEvidence. Native
    // ad labels cannot consume it until an ad-level lifecycle contract exists.
    fatigueStatus: null,
    lifecyclePosition: null,
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
  const campaignIds = Array.from(
    new Set(
      input.adInputs.map((ad) => ad.campaignId?.trim() ?? "").filter(Boolean),
    ),
  ).sort();
  return readCampaignContextLabelMap({
    businessId: input.businessId,
    campaignIds,
    asOf: input.asOf,
    mode: input.mode,
  });
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
          hydration_receipts: input.hydrationReceipts.map((receipt) => ({
            contract_version: receipt.contractVersion,
            provider_account_ref_id: receipt.providerAccountRefId,
            provider_account_id: receipt.providerAccountId,
            source_run_id: receipt.sourceRunId,
            source_run_hash: receipt.sourceRunHash,
            expected_ad_count: receipt.expectedAdCount,
            expected_manifest_hash: receipt.expectedManifestHash,
            hydrated_ad_count: receipt.hydratedAdCount,
            hydrated_manifest_hash: receipt.hydratedManifestHash,
            authoritative_for_prune: receipt.authoritativeForPrune,
            reason: receipt.reason,
          })),
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
