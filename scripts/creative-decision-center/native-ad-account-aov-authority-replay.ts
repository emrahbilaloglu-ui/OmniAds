#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import type { NativeAdCalibrationCellQuery } from "@/lib/creative-decision-engine/ad-account-decision-profile";
import type {
  CampaignContextEntryWithProvenance,
  CampaignContextLabelMap,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { isAccountAovRevenueArithmeticConsistent } from "@/lib/creative-decision-engine/account-decision-profile";
import {
  canonicalSha256,
  stableCanonicalJson,
  type CampaignContextProvenance,
  type NativeAdSoftOnlyDecisionProfile,
} from "@/lib/creative-decision-engine/canonical-evaluation";
import type { DecisionCalibrationProfileConfig } from "@/lib/creative-decision-engine/data-source";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import {
  adDecisionStabilityKey,
  PENDING_TRANSITION_BADGE,
  type PreviousAdPublishedLabel,
} from "@/lib/creative-decision-engine/decision-stability";
import {
  effectiveCommercialStopLossThresholds,
  resolveCanonicalCutZone,
  resolveCutBoundary,
  resolveExpandedEconomicRecentEvidence,
  resolveRatioZoneCutMaturityMatch,
  shouldActivateCommercialStopLossCutRepair,
  type CanonicalCutZone,
  type ExpandedEconomicRecentEvidence,
} from "@/lib/creative-decision-engine/gates/cut-policy";
import type { GateContext } from "@/lib/creative-decision-engine/gates/types";
import {
  readEnvDefaults,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import { selectKindAwareDecisionProfile } from "@/lib/creative-decision-engine/kind-aware-profile";
import {
  READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
  READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
  computeNativeAdCalibrationBatch,
  computeNativeAdCalibrationCellSetHash,
  assertNativeAdCalibrationBatchContract,
  mapNativeAdCalibrationSourceRow,
  mapNativeAdTargetAuthorityRow,
  recomputeNativeAdCalibrationCellInputManifestHash,
  type NativeAdCalibrationBatch,
  type NativeAdCalibrationCell,
  type NativeAdCalibrationSourceRow,
  type NativeAdTargetAuthorityInput,
  AD_CALIBRATION_JOB_NAME,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import {
  AD_DECISIONS_JOB_NAME,
  computeSoftOnlyNativeAdDecisions,
  computeNativeAdDecisions,
  resolveNativeAdDecisionProfileGroups,
  toNativeSnapshotPayload,
  type AdDecisionComputation,
  type NativeAdProfileRuntimeDataSource,
  type NativeSnapshotPayloadRow,
} from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION } from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import {
  NATIVE_AD_ENGINE_VERSION,
  type AccountDecisionProfile,
  type AdDecisionInput,
  type CreativeInput,
  type DataHealth,
  type DecisionKindSource,
  type DecisionBadge,
  type DecisionLabel,
} from "@/lib/creative-decision-engine/types";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

const CONTRACT_VERSION =
  "adsecute.meta.native-ad-account-aov-current-day-production-parity.v7" as const;
const PERSISTED_INPUT_SOURCE_MODE =
  "current_day_persisted_native_decision_input" as const;
const AOV_SOURCE_MODE =
  "current_day_cutoff_bound_immutable_canonical_ad_fact_dimensions_and_aov" as const;
const PROFILE_CONFIG_SOURCE_MODE =
  "production_native_profile_config_absent_defaults" as const;
export const COMPACT_REPLAY_PROOF_CONTRACT_VERSION =
  "adsecute.meta.native-ad-account-aov-replay-compact-proof.v7" as const;
export const REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION =
  "native-ad-replay-calibration-context-proof.v1" as const;
export const REPLAY_CALIBRATION_CONTEXT_PROOF_SET_CONTRACT_VERSION =
  "native-ad-replay-calibration-context-proof-set.v1" as const;
const STATEMENT_TIMEOUT_MS = 30_000;
const TUNNEL_PORT = "15432";

const EXACT_MEDIA_BUYER_PROVIDER_ACCOUNT_IDS = {
  theSwafMain: "act_822913786458311",
  iwaStore: "act_1087566732415606",
  emolos: "act_1054905059780305",
  grandmix: "act_805150454596350",
} as const;

const EXACT_GRANDMIX_AD_IDS = {
  claudeBathroomMeta: "120247018755120316",
  bathroomMetaShipping: "120249371633480316",
} as const;

export interface ExpectedProviderAccountScope {
  businessSelector: string;
  providerAccountId: string;
}

export interface SchedulerPopulationManifestRow {
  schedulerPosition: number;
  businessId: string;
  businessName: string;
  providerAccountRefId: string;
  providerAccountId: string;
}

type DbRow = Record<string, unknown>;

export interface ParsedArgs {
  asOfDate: string;
  businesses: string[];
  providerAccounts: ExpectedProviderAccountScope[];
  auditProviderAccounts: ExpectedProviderAccountScope[];
  jsonOut: string | null;
  compactJsonOut: string | null;
  provenanceExcludePaths: string[];
  stdoutMode: "full" | "compact" | "none";
}

export interface BaselineRow {
  cohortKey: string;
  businessId: string;
  businessName: string;
  providerAccountRefId: string;
  providerAccountId: string;
  currentProviderAccountName: string | null;
  currentAccountTimezone: string | null;
  currentAccountCurrency: string | null;
  accountTimezone: string | null;
  accountCurrency: string | null;
  asOfDate: string;
  calibrationCutoff: string;
  calibrationCutoffSource:
    "persisted_calibration_batch" | "evaluation_fallback";
  snapshotId: string;
  evaluationId: string;
  contextId: string;
  jobRunId: string;
  anchorDecisionRowCount: number;
  anchorActualSnapshotCount: number;
  anchorSelectedScopeSnapshotCount: number;
  calibrationJobRunId: string;
  calibrationJobRowCount: number;
  calibrationJobExpectedCellCount: number;
  calibrationJobRowsWritten: number;
  calibrationJobProviderAccountCount: number;
  calibrationWaveReceiptCount: number;
  calibrationWaveBatchCount: number;
  calibrationWaveExpectedCellCount: number;
  calibrationWaveActualCellCount: number;
  calibrationWaveReceiptContradictions: number;
  calibrationBatchId: string;
  calibrationBatchJobRunId: string;
  calibrationBatchExpectedCellCount: number;
  calibrationBatchActualCellCount: number;
  calibrationBatchGenerationContentHash: string;
  calibrationBatchInputManifestHash: string;
  calibrationBatchSourceManifestHash: string;
  calibrationBatchCellSetHash: string;
  calibrationReceiptCount: number;
  calibrationReceiptGenerationContentHash: string | null;
  calibrationReceiptInputManifestHash: string | null;
  calibrationReceiptSourceManifestHash: string | null;
  calibrationReceiptCellSetHash: string | null;
  calibrationLineageValid: boolean;
  hydrationReceiptCount: number;
  hydrationExpectedAdCount: number | null;
  hydrationExpectedManifestHash: string | null;
  hydrationHydratedAdCount: number | null;
  hydrationHydratedManifestHash: string | null;
  hydrationAuthoritativeForPrune: boolean;
  engineVersion: string;
  scopeType: "account";
  scopeId: string;
  inputHash: string;
  decisionHash: string;
  contextHash: string;
  recomputedContextHash: string;
  recomputedInputHash: string;
  recomputedDecisionHash: string;
  snapshotProjectionHash: string;
  recomputedSnapshotProjectionHash: string;
  snapshotProjectionValid: boolean;
  canonicalEnvelopeValid: boolean;
  contextContractVersion: string;
  evaluationContractVersion: string;
  contextJson: Record<string, unknown>;
  decisionOutput: Record<string, unknown>;
  creativeId: string | null;
  calibrationRowId: string | null;
  persistedProfileStatus: "ready" | "soft_only";
  evaluatedAt: string;
  creativeInput: AdDecisionInput;
  campaignContext: CampaignContextProvenance;
  priorHysteresis: Record<string, unknown>;
  priorHysteresisLineageValid: boolean;
  priorHysteresisSourceComputedAt: string | null;
  accountProfile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  dataHealth: DataHealth;
  flags: EngineV3Flags;
  baseline: {
    preAuthorityLabel: DecisionLabel;
    authorityBlocker: string | null;
    rawLabel: DecisionLabel;
    publishedLabel: DecisionLabel;
    blockedActionType: "scale" | "cut" | "refresh" | null;
    authorizedAction: "scale" | "cut" | "refresh" | null;
    hysteresisSuppressed: boolean;
    confidence: number;
    reason: string;
    badges: DecisionBadge[];
  };
}

interface AccountSlice {
  sliceKey: string;
  accountKey: string;
  businessId: string;
  businessName: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountTimezone: string | null;
  accountCurrency: string | null;
  calibrationCutoff: string;
  cutoffSource: BaselineRow["calibrationCutoffSource"];
  rows: BaselineRow[];
}

export interface PreparedAccountSlice extends AccountSlice {
  batch: NativeAdCalibrationBatch;
  cells: NativeAdCalibrationCell[];
  targetAuthority: NativeAdTargetAuthorityInput | null;
  profileConfig: DecisionCalibrationProfileConfig | null;
  rawSourceRowCount: number;
  rawReceiptHash: string;
  authorityProofContradictions: number;
  dimensionProofContradictions: number;
  sourceDimensionProof: {
    sourceAccountCurrency: string;
    sourceAccountTimezone: string;
    sourceTimezoneSelectionDate: string;
    anchoredAccountCurrency: string | null;
    anchoredAccountTimezone: string | null;
    currencyDriftedFromAnchor: boolean;
    timezoneDriftedFromAnchor: boolean;
    driftContradictions: number;
  };
}

export type ReplayAnchorDimensionAssessmentStatus =
  | "exact"
  | "authenticated_source_repair"
  | "unresolved_contradiction";

export interface ReplayAnchorDimensionAssessment {
  contractVersion: "native-ad-replay-anchor-dimension-assessment.v1";
  status: ReplayAnchorDimensionAssessmentStatus;
  observedDriftDimensions: number;
  authenticatedRepairDimensions: number;
  contradictionCodes: string[];
  unresolvedContradictions: number;
  proofHash: string;
}

interface ReplaySlicePreparationFailure {
  sliceKeyHash: string;
  accountKeyHash: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  rowCount: number;
  error: string;
}

export interface MediaBuyerProfileBoundaryValues {
  bottomQuartileRatio: number | null;
  commercialMaturitySpend: number | null;
  hardCutSpend: number | null;
  recentSampleMinSpend: number | null;
}

export interface MediaBuyerProfileBoundaryProjection {
  profileKind: "account_decision_profile" | "native_ad_soft_only";
  boundarySemantics: "canonical_ratio_boundary; commercial_stop-loss overlay is Cut spend-depth only";
  canonical: MediaBuyerProfileBoundaryValues | null;
  commercialStopLossOverlay: MediaBuyerProfileBoundaryValues | null;
}

export interface ReplayDecisionProjection {
  preAuthorityLabel: DecisionLabel;
  authorityBlocker: string | null;
  rawLabel: DecisionLabel;
  publishedLabel: DecisionLabel;
  blockedActionType: "scale" | "cut" | "refresh" | null;
  authorizedAction: "scale" | "cut" | "refresh" | null;
  hysteresisSuppressed: boolean;
  confidence: number;
  reason: string;
  badges: DecisionBadge[];
}

export interface D063PolicyAuditProjection {
  zone: CanonicalCutZone | null;
  legacyRatio: number | null;
  safeLegacyRatio: number | null;
  economicUpperRatio: number | null;
  recentEvidenceStatus: ExpandedEconomicRecentEvidence["status"] | null;
  matureForCut: boolean;
  accountAovOverlayInstalled: boolean;
  accountAovOverlayActivated: boolean;
  canonicalBottomQuartileRatio: number | null;
  currentProjection: ReplayDecisionProjection;
  preD063CompatibleProjection: ReplayDecisionProjection | null;
  legacySafeZoneProjectionDrift: boolean;
}

export interface ReplayCalibrationContextProof {
  contractVersion: typeof REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION;
  cohortKey: string;
  accountKey: string;
  inputManifestHash: string;
  persistedInput: AdDecisionInput;
  challengerInput: AdDecisionInput;
  inputDiffPaths: string[];
  persistedProjection: ReplayDecisionProjection;
  challengerProjection: ReplayDecisionProjection;
  persistedProfile:
    | AccountDecisionProfile
    | NativeAdSoftOnlyDecisionProfile;
  challengerProfile:
    | AccountDecisionProfile
    | NativeAdSoftOnlyDecisionProfile;
  persistedDataHealth: DataHealth;
  challengerDataHealth: DataHealth;
  persistedCampaignContext: CampaignContextProvenance;
  challengerCampaignContext: CampaignContextProvenance;
  profileDiffPaths: string[];
  dataHealthDiffPaths: string[];
  contextMaterialHash: string;
  proofHash: string;
}

export interface ChallengerRow {
  cohortKey: string;
  accountKey: string;
  status: "computed" | "failed";
  error: string | null;
  inputManifestHash: string;
  priorHysteresisReplayable: boolean;
  priorHysteresisStatus:
    "none" | "current_epoch_replayed" | "epoch_mismatch" | "incomplete_lineage";
  priorHysteresisSourceEngineVersion: string | null;
  priorRawLabel: DecisionLabel | null;
  priorPublishedLabel: DecisionLabel | null;
  profileStatus: "ready" | "soft_only" | "not_computed";
  profileReason: string | null;
  persistedScaleRefreshProfileHash: string;
  challengerScaleRefreshProfileHash: string | null;
  persistedDataHealthHash: string;
  challengerDataHealthHash: string | null;
  calibrationContextProof: ReplayCalibrationContextProof | null;
  profileBoundaryProjection: MediaBuyerProfileBoundaryProjection | null;
  selectedCellCutAuthorityBasis:
    | "calibrated_relative"
    | "calibrated_relative_with_economic_stop_loss"
    | "commercial_stop_loss"
    | null;
  selectedCellMetaAovPurchaseCount: number | null;
  selectedCellMetaAovQuality: string | null;
  selectedCellRoasRatioP25: number | null;
  selectedCellMatureAdCount: number | null;
  repairAuthoritySelected: boolean | null;
  spendUnitAuthorityBasis:
    "target_cpa" | "operator_aov" | "physical_account_purchase_aov_90d" | null;
  spendUnitAuthorityStatus: string | null;
  accountAovEvidenceStatus: string | null;
  calibrationRowId: string | null;
  calibrationInputManifestHash: string | null;
  calibrationSourceManifestHash: string | null;
  preAuthorityLabel: DecisionLabel | null;
  authorityBlocker: string | null;
  rawLabel: DecisionLabel | null;
  publishedLabel: DecisionLabel | null;
  blockedActionType: "scale" | "cut" | "refresh" | null;
  hysteresisSuppressed: boolean | null;
  simulatedAuthorizedAction: "scale" | "cut" | "refresh" | null;
  confidence: number | null;
  reason: string | null;
  badges: DecisionBadge[] | null;
  roas: number | null;
  breakEvenRoas: number | null;
  effectiveTargetRoas: number | null;
  ratioToTarget: number | null;
  policyAudit: D063PolicyAuditProjection | null;
}

export const READ_SCHEDULER_POPULATION_MANIFEST_SQL = `
/* native-ad-account-aov-replay: exact scheduler-equivalent business/account manifest */
WITH scheduler_active_businesses AS MATERIALIZED (
  SELECT
    business.id,
    business.name,
    business.created_at,
    ROW_NUMBER() OVER (ORDER BY business.created_at) AS scheduler_position
  FROM businesses business
  WHERE business.is_demo_business = FALSE
  ORDER BY business.created_at
  LIMIT 500
), scheduler_enabled_businesses AS MATERIALIZED (
  SELECT active.*
  FROM scheduler_active_businesses active
  LEFT JOIN business_engine_v3_flags flags
    ON flags.business_id = active.id
  WHERE COALESCE(flags.enabled, $1::boolean) = TRUE
)
SELECT
  enabled.scheduler_position::integer AS scheduler_position,
  enabled.id::text AS business_id,
  enabled.name AS business_name,
  binding.provider_account_ref_id::text AS provider_account_ref_id,
  binding.provider_account_id
FROM scheduler_enabled_businesses enabled
JOIN business_provider_accounts binding
  ON binding.business_id = enabled.id::text
 AND binding.provider = 'meta'
ORDER BY
  enabled.scheduler_position,
  enabled.id,
  binding.provider_account_ref_id,
  binding.provider_account_id
`;

export const READ_FIXED_BASELINE_ANCHORS_SQL = `
/* native-ad-account-aov-replay: discover bounded immutable wave anchors */
WITH expected_provider_scope AS MATERIALIZED (
  SELECT expected_scope.business_selector
  FROM jsonb_to_recordset(COALESCE($6::jsonb, '[]'::jsonb))
    AS expected_scope(
      business_selector text,
      provider_account_id text
    )
), decision_anchor AS (
  SELECT DISTINCT ON (job.business_ref_id)
    job.*,
    business.name AS business_name
  FROM engine_v3_job_runs job
  JOIN businesses business ON business.id = job.business_ref_id
  WHERE job.as_of_date = $1::date
    AND job.engine_version = $2
    AND job.job_name = $4
    AND job.status = 'success'
    AND (
      $3::text[] IS NULL
      OR job.business_ref_id::text = ANY($3::text[])
      OR business.name = ANY($3::text[])
    )
    AND (
      $6::jsonb IS NULL
      OR EXISTS (
        SELECT 1
        FROM expected_provider_scope expected_scope
        WHERE expected_scope.business_selector = job.business_ref_id::text
           OR expected_scope.business_selector = business.name
      )
    )
  ORDER BY
    job.business_ref_id,
    job.finished_at DESC NULLS LAST,
    job.started_at DESC,
    job.id DESC
), anchored_wave AS (
  SELECT
    decision_anchor.id::text AS job_run_id,
    decision_anchor.business_ref_id::text AS business_id,
    decision_anchor.business_name
  FROM decision_anchor
  JOIN engine_v3_job_runs calibration_job
    ON calibration_job.id = decision_anchor.dependency_run_id
   AND calibration_job.business_ref_id = decision_anchor.business_ref_id
   AND calibration_job.business_id = decision_anchor.business_id
   AND calibration_job.as_of_date = decision_anchor.as_of_date
   AND calibration_job.engine_version = decision_anchor.engine_version
   AND calibration_job.job_name = $5
   AND calibration_job.status = 'success'
)
SELECT
  anchor.job_run_id,
  anchor.business_id,
  anchor.business_name
FROM anchored_wave anchor
ORDER BY anchor.business_id, anchor.job_run_id
`;

export const READ_FIXED_BASELINE_IDENTITIES_SQL = `
/* native-ad-account-aov-replay: bounded identities for one immutable wave */
SELECT
  snapshot.job_run_id::text AS job_run_id,
  snapshot.business_ref_id::text AS business_id,
  snapshot.id::text AS snapshot_id,
  snapshot.provider_account_ref_id::text AS provider_account_ref_id,
  snapshot.provider_account_id
FROM engine_v3_ad_decision_snapshots_daily snapshot
WHERE snapshot.job_run_id = $1::uuid
  AND snapshot.business_ref_id = $2::uuid
  AND snapshot.business_id = $2::uuid::text
  AND snapshot.as_of_date = $3::date
  AND snapshot.engine_version = $4
  AND snapshot.decision_entity_type = 'ad'
  AND snapshot.decision_entity_id = snapshot.ad_id
  AND snapshot.scope_type = 'account'
  AND snapshot.scope_id = snapshot.provider_account_id
  AND (
    $5::text[] IS NULL
    OR snapshot.provider_account_id = ANY($5::text[])
  )
ORDER BY
  snapshot.provider_account_ref_id,
  snapshot.provider_account_id,
  snapshot.decision_entity_type,
  snapshot.decision_entity_id,
  snapshot.scope_type,
  snapshot.scope_id
`;

export const READ_FIXED_BASELINE_ANCHOR_PROOF_SQL = `
/* native-ad-account-aov-replay: one bounded business-anchor proof */
WITH anchor AS (
  SELECT
    job.*,
    business.name AS business_name,
    calibration_job.id AS calibration_job_run_id,
    calibration_job.row_count AS calibration_job_row_count,
    (calibration_job.error_json #>> '{metadata,expected_cell_count}')::integer
      AS calibration_job_expected_cell_count,
    (calibration_job.error_json #>> '{metadata,rows_written}')::integer
      AS calibration_job_rows_written,
    (calibration_job.error_json #>> '{metadata,provider_account_count}')::integer
      AS calibration_job_provider_account_count,
    calibration_job.error_json AS calibration_error_json
  FROM engine_v3_job_runs job
  JOIN businesses business ON business.id = job.business_ref_id
  JOIN engine_v3_job_runs calibration_job
    ON calibration_job.id = job.dependency_run_id
   AND calibration_job.business_ref_id = job.business_ref_id
   AND calibration_job.business_id = job.business_id
   AND calibration_job.as_of_date = job.as_of_date
   AND calibration_job.engine_version = job.engine_version
   AND calibration_job.job_name = $3
   AND calibration_job.status = 'success'
  WHERE job.id = $1::uuid
    AND job.status = 'success'
), snapshot_count AS (
  SELECT
    COUNT(*)::integer AS actual_snapshot_count
  FROM anchor
  JOIN engine_v3_ad_decision_snapshots_daily snapshot
    ON snapshot.job_run_id = anchor.id
   AND snapshot.business_ref_id = anchor.business_ref_id
   AND snapshot.business_id = anchor.business_id
   AND snapshot.as_of_date = anchor.as_of_date
   AND snapshot.engine_version = anchor.engine_version
), selected_snapshot_count AS (
  SELECT COUNT(snapshot.id)::integer AS selected_scope_snapshot_count
  FROM anchor
  CROSS JOIN unnest($2::uuid[]) AS requested(snapshot_id)
  JOIN engine_v3_ad_decision_snapshots_daily snapshot
    ON snapshot.id = requested.snapshot_id
  WHERE snapshot.job_run_id = anchor.id
    AND snapshot.business_ref_id = anchor.business_ref_id
    AND snapshot.business_id = anchor.business_id
    AND snapshot.as_of_date = anchor.as_of_date
    AND snapshot.engine_version = anchor.engine_version
    AND snapshot.decision_entity_type = 'ad'
    AND snapshot.decision_entity_id = snapshot.ad_id
    AND snapshot.scope_type = 'account'
    AND snapshot.scope_id = snapshot.provider_account_id
), receipt_rows AS MATERIALIZED (
  SELECT wave_receipt.value AS receipt
  FROM anchor
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(anchor.calibration_error_json #> '{metadata,batches}', '[]'::jsonb)
  ) AS wave_receipt(value)
), receipt_matches AS MATERIALIZED (
  SELECT
    receipt.receipt,
    batch.id AS batch_id,
    batch.expected_cell_count,
    batch.generation_content_hash,
    batch.input_manifest_hash,
    batch.source_manifest_hash,
    batch.cell_set_hash
  FROM receipt_rows receipt
  CROSS JOIN anchor
  LEFT JOIN engine_v3_ad_account_calibration_batches batch
    ON batch.id::text = receipt.receipt->>'batch_id'
   AND batch.job_run_id = anchor.calibration_job_run_id
   AND batch.business_ref_id = anchor.business_ref_id
   AND batch.business_id = anchor.business_id
   AND batch.as_of_date = anchor.as_of_date
   AND batch.engine_version = anchor.engine_version
   AND batch.completeness_status = 'complete'
), relevant_batches AS MATERIALIZED (
  SELECT DISTINCT receipt.batch_id
  FROM receipt_matches receipt
  WHERE receipt.batch_id IS NOT NULL
), cell_counts AS MATERIALIZED (
  SELECT
    relevant.batch_id,
    COUNT(cell.id)::integer AS actual_cell_count
  FROM relevant_batches relevant
  LEFT JOIN engine_v3_ad_account_calibration_daily cell
    ON cell.batch_id = relevant.batch_id
  GROUP BY relevant.batch_id
), wave_proof AS (
  SELECT
    COUNT(receipt.receipt)::integer AS receipt_count,
    COUNT(receipt.batch_id)::integer AS batch_count,
    COALESCE(SUM(receipt.expected_cell_count), 0)::integer
      AS expected_cell_count,
    COALESCE(SUM(cell_count.actual_cell_count), 0)::integer
      AS actual_cell_count,
    COUNT(*) FILTER (
      WHERE receipt.receipt IS NOT NULL
        AND (
          receipt.batch_id IS NULL
          OR receipt.generation_content_hash IS DISTINCT FROM
               receipt.receipt->>'generation_content_hash'
          OR receipt.input_manifest_hash IS DISTINCT FROM
               receipt.receipt->>'input_manifest_hash'
          OR receipt.source_manifest_hash IS DISTINCT FROM
               receipt.receipt->>'source_manifest_hash'
          OR receipt.cell_set_hash IS DISTINCT FROM
               receipt.receipt->>'cell_set_hash'
        )
    )::integer AS receipt_contradictions
  FROM (SELECT 1) singleton
  LEFT JOIN receipt_matches receipt ON TRUE
  LEFT JOIN cell_counts cell_count ON cell_count.batch_id = receipt.batch_id
)
SELECT
  anchor.id::text AS job_run_id,
  anchor.business_ref_id::text AS business_id,
  anchor.business_name,
  anchor.row_count AS anchor_decision_row_count,
  snapshot_count.actual_snapshot_count AS anchor_actual_snapshot_count,
  selected_snapshot_count.selected_scope_snapshot_count
    AS anchor_selected_scope_snapshot_count,
  anchor.calibration_job_run_id::text AS calibration_job_run_id,
  anchor.calibration_job_row_count,
  anchor.calibration_job_expected_cell_count,
  anchor.calibration_job_rows_written,
  anchor.calibration_job_provider_account_count,
  wave_proof.receipt_count AS calibration_wave_receipt_count,
  wave_proof.batch_count AS calibration_wave_batch_count,
  wave_proof.expected_cell_count AS calibration_wave_expected_cell_count,
  wave_proof.actual_cell_count AS calibration_wave_actual_cell_count,
  wave_proof.receipt_contradictions
    AS calibration_wave_receipt_contradictions
FROM anchor
CROSS JOIN snapshot_count
CROSS JOIN selected_snapshot_count
CROSS JOIN wave_proof
`;

export const READ_FIXED_BASELINE_ACCOUNT_PROOF_SQL = `
/* native-ad-account-aov-replay: one bounded physical-account receipt proof */
WITH anchor AS (
  SELECT
    job.*,
    calibration_job.id AS calibration_job_run_id,
    calibration_job.error_json AS calibration_error_json
  FROM engine_v3_job_runs job
  JOIN engine_v3_job_runs calibration_job
    ON calibration_job.id = job.dependency_run_id
   AND calibration_job.business_ref_id = job.business_ref_id
   AND calibration_job.business_id = job.business_id
   AND calibration_job.as_of_date = job.as_of_date
   AND calibration_job.engine_version = job.engine_version
   AND calibration_job.job_name = $4
   AND calibration_job.status = 'success'
  WHERE job.id = $1::uuid
    AND job.status = 'success'
), calibration_receipt AS (
  SELECT
    COUNT(*)::integer AS receipt_count,
    (jsonb_agg(value ORDER BY value::text)->0) AS receipt
  FROM anchor
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(anchor.calibration_error_json #> '{metadata,batches}', '[]'::jsonb)
  ) AS calibration_value(value)
  WHERE value->>'provider_account_ref_id' = $2::uuid::text
    AND value->>'provider_account_id' = $3
), hydration_receipt AS (
  SELECT
    COUNT(*)::integer AS receipt_count,
    (jsonb_agg(value ORDER BY value::text)->0) AS receipt
  FROM anchor
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(anchor.error_json #> '{metadata,hydration_receipts}', '[]'::jsonb)
  ) AS hydration_value(value)
  WHERE value->>'provider_account_ref_id' = $2::uuid::text
    AND value->>'provider_account_id' = $3
), batch_match AS MATERIALIZED (
  SELECT batch.*
  FROM anchor
  CROSS JOIN calibration_receipt
  LEFT JOIN engine_v3_ad_account_calibration_batches batch
    ON batch.id::text = calibration_receipt.receipt->>'batch_id'
   AND batch.job_run_id = anchor.calibration_job_run_id
   AND batch.business_ref_id = anchor.business_ref_id
   AND batch.business_id = anchor.business_id
   AND batch.provider = 'meta'
   AND batch.provider_account_ref_id = $2::uuid
   AND batch.provider_account_id = $3
   AND batch.as_of_date = anchor.as_of_date
   AND batch.engine_version = anchor.engine_version
   AND batch.completeness_status = 'complete'
), cell_count AS (
  SELECT COUNT(cell.id)::integer AS actual_cell_count
  FROM batch_match batch
  LEFT JOIN engine_v3_ad_account_calibration_daily cell
    ON cell.batch_id = batch.id
)
SELECT
  anchor.id::text AS job_run_id,
  anchor.business_ref_id::text AS business_id,
  $2::uuid::text AS provider_account_ref_id,
  $3::text AS provider_account_id,
  account.account_name AS current_provider_account_name,
  NULLIF(BTRIM(account.timezone), '') AS current_account_timezone,
  NULLIF(BTRIM(account.currency), '') AS current_account_currency,
  batch.id::text AS calibration_batch_id,
  batch.job_run_id::text AS calibration_batch_job_run_id,
  batch.expected_cell_count AS calibration_batch_expected_cell_count,
  COALESCE(cell_count.actual_cell_count, 0)
    AS calibration_batch_actual_cell_count,
  batch.generation_content_hash AS calibration_batch_generation_content_hash,
  batch.input_manifest_hash AS calibration_batch_input_manifest_hash,
  batch.source_manifest_hash AS calibration_batch_source_manifest_hash,
  batch.cell_set_hash AS calibration_batch_cell_set_hash,
  calibration_receipt.receipt_count AS calibration_receipt_count,
  calibration_receipt.receipt->>'generation_content_hash'
    AS calibration_receipt_generation_content_hash,
  calibration_receipt.receipt->>'input_manifest_hash'
    AS calibration_receipt_input_manifest_hash,
  calibration_receipt.receipt->>'source_manifest_hash'
    AS calibration_receipt_source_manifest_hash,
  calibration_receipt.receipt->>'cell_set_hash'
    AS calibration_receipt_cell_set_hash,
  batch.as_of_cutoff::text AS calibration_cutoff,
  'persisted_calibration_batch'::text AS calibration_cutoff_source,
  hydration_receipt.receipt_count AS hydration_receipt_count,
  (hydration_receipt.receipt->>'expected_ad_count')::integer
    AS hydration_expected_ad_count,
  hydration_receipt.receipt->>'expected_manifest_hash'
    AS hydration_expected_manifest_hash,
  (hydration_receipt.receipt->>'hydrated_ad_count')::integer
    AS hydration_hydrated_ad_count,
  hydration_receipt.receipt->>'hydrated_manifest_hash'
    AS hydration_hydrated_manifest_hash,
  COALESCE(
    (hydration_receipt.receipt->>'authoritative_for_prune')::boolean,
    FALSE
  ) AS hydration_authoritative_for_prune
FROM anchor
JOIN provider_accounts account
  ON account.id = $2::uuid
 AND account.provider = 'meta'
 AND account.external_account_id = $3
CROSS JOIN calibration_receipt
CROSS JOIN hydration_receipt
CROSS JOIN batch_match batch
CROSS JOIN cell_count
`;

export const READ_FIXED_BASELINE_ROW_PAYLOAD_SQL = `
/* native-ad-account-aov-replay: bounded immutable payload chunk by snapshot PK */
SELECT
  snapshot.id::text AS snapshot_id,
  evaluation.id::text AS evaluation_id,
  evaluation.context_id::text AS context_id,
  snapshot.job_run_id::text AS job_run_id,
  snapshot.business_ref_id::text AS business_id,
  snapshot.provider_account_ref_id::text AS provider_account_ref_id,
  snapshot.provider_account_id,
  snapshot.ad_id AS persisted_ad_id,
  snapshot.creative_id AS persisted_creative_id,
  snapshot.calibration_row_id::text AS snapshot_calibration_row_id,
  NULLIF(BTRIM(evaluation.creative_input_json->>'accountTimezone'), '')
    AS account_timezone,
  NULLIF(BTRIM(evaluation.creative_input_json->>'accountCurrency'), '')
    AS account_currency,
  snapshot.as_of_date::text AS as_of_date,
  snapshot.engine_version,
  snapshot.scope_type,
  snapshot.scope_id,
  snapshot.input_hash::text AS input_hash,
  snapshot.decision_hash::text AS decision_hash,
  context.context_hash::text AS context_hash,
  context.contract_version AS context_contract_version,
  evaluation.contract_version AS evaluation_contract_version,
  context.context_json,
  evaluation.creative_input_json,
  evaluation.campaign_context_json,
  evaluation.prior_hysteresis_json,
  evaluation.decision_output_json,
  CASE
    WHEN evaluation.prior_hysteresis_json->>'source' = 'none' THEN TRUE
    WHEN evaluation.prior_hysteresis_json->>'source' = 'persisted_evaluation'
      THEN prior_evaluation.id IS NOT NULL
        AND prior_snapshot.computed_at IS NOT NULL
    ELSE FALSE
  END AS prior_hysteresis_lineage_valid,
  CASE
    WHEN prior_evaluation.id IS NOT NULL
      THEN prior_snapshot.computed_at::text
    ELSE NULL
  END AS prior_hysteresis_source_computed_at,
  context.account_profile_json,
  context.data_health_json,
  context.flags_json,
  snapshot.pre_authority_label,
  snapshot.authority_blocker,
  snapshot.raw_label,
  snapshot.label AS published_label,
  snapshot.blocked_action_type,
  snapshot.authorized_action,
  snapshot.confidence,
  snapshot.truth_source,
  snapshot.effective_target_roas,
  snapshot.ratio_to_target,
  snapshot.reason,
  snapshot.badges,
  snapshot.spend AS snapshot_spend,
  snapshot.purchases AS snapshot_purchases,
  snapshot.roas AS snapshot_roas,
  snapshot.recent7d_roas AS snapshot_recent7d_roas,
  snapshot.label_transform AS snapshot_label_transform,
  snapshot.creative_evidence_lifecycle_row_id::text
    AS snapshot_creative_evidence_lifecycle_row_id,
  snapshot.computed_at::text AS snapshot_computed_at,
  evaluation.hysteresis_suppressed,
  evaluation.evaluated_at::text AS evaluated_at,
  CASE
    WHEN snapshot.calibration_row_id IS NULL THEN TRUE
    ELSE calibration.id IS NOT NULL
  END AS calibration_lineage_valid
FROM engine_v3_ad_decision_snapshots_daily snapshot
JOIN engine_v3_ad_decision_evaluations evaluation
  ON evaluation.id = snapshot.evaluation_id
 AND evaluation.job_run_id = snapshot.job_run_id
 AND evaluation.business_ref_id = snapshot.business_ref_id
 AND evaluation.business_id = snapshot.business_id
 AND evaluation.provider_account_ref_id = snapshot.provider_account_ref_id
 AND evaluation.provider_account_id = snapshot.provider_account_id
 AND evaluation.decision_entity_type = snapshot.decision_entity_type
 AND evaluation.decision_entity_id = snapshot.decision_entity_id
 AND evaluation.ad_id = snapshot.ad_id
 AND evaluation.creative_id IS NOT DISTINCT FROM snapshot.creative_id
 AND evaluation.as_of_date = snapshot.as_of_date
 AND evaluation.engine_version = snapshot.engine_version
 AND evaluation.scope_type = snapshot.scope_type
 AND evaluation.scope_id = snapshot.scope_id
 AND evaluation.input_hash = snapshot.input_hash
 AND evaluation.decision_hash = snapshot.decision_hash
JOIN engine_v3_ad_decision_evaluation_contexts context
  ON context.id = evaluation.context_id
 AND context.job_run_id = evaluation.job_run_id
 AND context.business_ref_id = evaluation.business_ref_id
 AND context.business_id = evaluation.business_id
 AND context.provider_account_ref_id = evaluation.provider_account_ref_id
 AND context.provider_account_id = evaluation.provider_account_id
 AND context.as_of_date = evaluation.as_of_date
 AND context.engine_version = evaluation.engine_version
 AND context.scope_type = evaluation.scope_type
 AND context.scope_id = evaluation.scope_id
LEFT JOIN engine_v3_ad_decision_snapshots_daily prior_snapshot
  ON evaluation.prior_hysteresis_json->>'source' = 'persisted_evaluation'
 AND prior_snapshot.id = CASE
       WHEN evaluation.prior_hysteresis_json->>'sourceSnapshotId'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN (evaluation.prior_hysteresis_json->>'sourceSnapshotId')::uuid
       ELSE NULL
     END
 AND prior_snapshot.id::text =
       evaluation.prior_hysteresis_json->>'sourceSnapshotId'
 AND prior_snapshot.business_ref_id = snapshot.business_ref_id
 AND prior_snapshot.business_id = snapshot.business_id
 AND prior_snapshot.provider_account_ref_id = snapshot.provider_account_ref_id
 AND prior_snapshot.provider_account_id = snapshot.provider_account_id
 AND prior_snapshot.decision_entity_type = snapshot.decision_entity_type
 AND prior_snapshot.decision_entity_id = snapshot.decision_entity_id
 AND prior_snapshot.ad_id = snapshot.ad_id
 AND prior_snapshot.scope_type = snapshot.scope_type
 AND prior_snapshot.scope_id = snapshot.scope_id
 AND prior_snapshot.engine_version =
       evaluation.prior_hysteresis_json->>'sourceEngineVersion'
 AND prior_snapshot.as_of_date::text =
       evaluation.prior_hysteresis_json->>'sourceAsOfDate'
 AND prior_snapshot.input_hash::text =
       evaluation.prior_hysteresis_json->>'sourceInputHash'
 AND prior_snapshot.decision_hash::text =
       evaluation.prior_hysteresis_json->>'sourceDecisionHash'
 AND prior_snapshot.label =
       evaluation.prior_hysteresis_json->>'publishedLabel'
 AND prior_snapshot.raw_label IS NOT DISTINCT FROM
       evaluation.prior_hysteresis_json->>'rawLabel'
 AND evaluation.prior_hysteresis_json->>'sourceBusinessId' =
       snapshot.business_ref_id::text
 AND evaluation.prior_hysteresis_json->>'sourceProviderAccountId' =
       snapshot.provider_account_id
 AND evaluation.prior_hysteresis_json->>'sourceDecisionEntityType' =
       snapshot.decision_entity_type
 AND evaluation.prior_hysteresis_json->>'sourceDecisionEntityId' =
       snapshot.decision_entity_id
 AND prior_snapshot.as_of_date < snapshot.as_of_date
LEFT JOIN engine_v3_ad_decision_evaluations prior_evaluation
  ON prior_evaluation.id = CASE
       WHEN evaluation.prior_hysteresis_json->>'sourceEvaluationId'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN (evaluation.prior_hysteresis_json->>'sourceEvaluationId')::uuid
       ELSE NULL
     END
 AND prior_evaluation.id::text =
       evaluation.prior_hysteresis_json->>'sourceEvaluationId'
 AND prior_evaluation.id = prior_snapshot.evaluation_id
 AND prior_evaluation.job_run_id = prior_snapshot.job_run_id
 AND prior_evaluation.business_ref_id = prior_snapshot.business_ref_id
 AND prior_evaluation.business_id = prior_snapshot.business_id
 AND prior_evaluation.provider_account_ref_id =
       prior_snapshot.provider_account_ref_id
 AND prior_evaluation.provider_account_id = prior_snapshot.provider_account_id
 AND prior_evaluation.decision_entity_type = prior_snapshot.decision_entity_type
 AND prior_evaluation.decision_entity_id = prior_snapshot.decision_entity_id
 AND prior_evaluation.ad_id = prior_snapshot.ad_id
 AND prior_evaluation.as_of_date = prior_snapshot.as_of_date
 AND prior_evaluation.engine_version = prior_snapshot.engine_version
 AND prior_evaluation.scope_type = prior_snapshot.scope_type
 AND prior_evaluation.scope_id = prior_snapshot.scope_id
 AND prior_evaluation.input_hash = prior_snapshot.input_hash
 AND prior_evaluation.decision_hash = prior_snapshot.decision_hash
LEFT JOIN engine_v3_ad_account_calibration_daily calibration
  ON calibration.id = snapshot.calibration_row_id
 AND calibration.batch_id = $6::uuid
 AND calibration.business_ref_id = snapshot.business_ref_id
 AND calibration.business_id = snapshot.business_id
 AND calibration.provider_account_ref_id = snapshot.provider_account_ref_id
 AND calibration.provider_account_id = snapshot.provider_account_id
 AND calibration.as_of_date = snapshot.as_of_date
 AND calibration.engine_version = snapshot.engine_version
WHERE snapshot.id = ANY($1::uuid[])
  AND snapshot.job_run_id = $2::uuid
  AND snapshot.business_ref_id = $3::uuid
  AND snapshot.business_id = $3::uuid::text
  AND snapshot.provider_account_ref_id = $4::uuid
  AND snapshot.provider_account_id = $5
  AND snapshot.decision_entity_type = 'ad'
  AND snapshot.decision_entity_id = snapshot.ad_id
  AND snapshot.scope_type = 'account'
  AND snapshot.scope_id = snapshot.provider_account_id
ORDER BY
  snapshot.business_ref_id,
  snapshot.provider_account_ref_id,
  snapshot.provider_account_id,
  snapshot.decision_entity_type,
  snapshot.decision_entity_id,
  snapshot.scope_type,
  snapshot.scope_id
`;

export const FIXED_BASELINE_PAYLOAD_CHUNK_SIZE = 200;

interface FixedBaselineAnchor {
  jobRunId: string;
  businessId: string;
  businessName: string;
}

interface FixedBaselineIdentity {
  jobRunId: string;
  businessId: string;
  snapshotId: string;
  providerAccountRefId: string;
  providerAccountId: string;
}

interface FixedBaselinePopulationObservation {
  anchors: FixedBaselineAnchor[];
  identities: FixedBaselineIdentity[];
}

export interface FixedBaselineReadStatement {
  sequence: number;
  kind: "anchors" | "identities" | "anchor_proof" | "account_proof" | "payload";
  scope: string;
  rowCount: number;
  durationMs: number;
}

export interface FixedBaselineReadDiagnostics {
  strategy: "same_transaction_bounded_multi_statement_v1";
  statementTimeoutMs: number;
  payloadChunkSize: number;
  statementCount: number;
  totalDurationMs: number;
  anchorCount: number;
  accountCount: number;
  identityCount: number;
  reboundRowCount: number;
  exactRebindValidated: true;
  cohortIdentityHash: string;
  rowsByKind: Record<FixedBaselineReadStatement["kind"], number>;
  statements: FixedBaselineReadStatement[];
}

function fixedBaselineAnchor(row: DbRow): FixedBaselineAnchor {
  return {
    jobRunId: text(row.job_run_id, "anchor.job_run_id"),
    businessId: text(row.business_id, "anchor.business_id"),
    businessName: text(row.business_name, "anchor.business_name"),
  };
}

function fixedBaselineIdentity(row: DbRow): FixedBaselineIdentity {
  return {
    jobRunId: text(row.job_run_id, "identity.job_run_id"),
    businessId: text(row.business_id, "identity.business_id"),
    snapshotId: text(row.snapshot_id, "identity.snapshot_id"),
    providerAccountRefId: text(
      row.provider_account_ref_id,
      "identity.provider_account_ref_id",
    ),
    providerAccountId: text(
      row.provider_account_id,
      "identity.provider_account_id",
    ),
  };
}

function schedulerPopulationManifestRow(
  row: DbRow,
): SchedulerPopulationManifestRow {
  const schedulerPosition = nonnegativeInteger(
    row.scheduler_position,
    "scheduler_population.scheduler_position",
  );
  if (schedulerPosition < 1) {
    throw new TypeError(
      "scheduler_population.scheduler_position must be positive",
    );
  }
  return {
    schedulerPosition,
    businessId: text(row.business_id, "scheduler_population.business_id"),
    businessName: text(
      row.business_name,
      "scheduler_population.business_name",
    ),
    providerAccountRefId: text(
      row.provider_account_ref_id,
      "scheduler_population.provider_account_ref_id",
    ),
    providerAccountId: text(
      row.provider_account_id,
      "scheduler_population.provider_account_id",
    ),
  };
}

function schedulerAccountIdentityKey(
  row: Pick<
    SchedulerPopulationManifestRow,
    "businessId" | "providerAccountRefId" | "providerAccountId"
  >,
) {
  return [
    row.businessId,
    row.providerAccountRefId,
    row.providerAccountId,
  ].join("\u0000");
}

function schedulerAccountIdentityProjection(
  row: Pick<
    SchedulerPopulationManifestRow,
    "businessId" | "providerAccountRefId" | "providerAccountId"
  >,
) {
  return {
    businessId: row.businessId,
    providerAccountRefId: row.providerAccountRefId,
    providerAccountId: row.providerAccountId,
  };
}

export function buildSchedulerPopulationCoverage(input: {
  required: boolean;
  envDefaultEnabled: boolean;
  manifestRows: readonly SchedulerPopulationManifestRow[];
  observedAnchors: readonly FixedBaselineAnchor[];
  observedIdentities: readonly FixedBaselineIdentity[];
}) {
  if (!input.required) {
    return {
      required: false,
      mode: "explicit_requested_scope" as const,
      schedulerContract: {
        activeBusinessLimit: 500,
        excludesDemoBusinesses: true,
        businessOrder: "created_at_asc",
        enabledSource: "business_override_then_current_env_default",
        metaEligibilitySource: "business_provider_accounts",
      },
      readWithinReplayRepeatableReadTransaction: true,
      envDefaultEnabled: input.envDefaultEnabled,
      expectedBusinessCount: 0,
      expectedProviderAccountCount: 0,
      observedAnchorCount: input.observedAnchors.length,
      observedIdentityAccountCount: new Set(
        input.observedIdentities.map((row) =>
          schedulerAccountIdentityKey(row),
        ),
      ).size,
      manifestHash: canonicalSha256([]),
      expectedBusinesses: [],
      expectedProviderAccounts: [],
      missingBusinessAnchors: [],
      unexpectedBusinessAnchors: [],
      duplicateBusinessAnchors: [],
      missingProviderAccountIdentities: [],
      unexpectedProviderAccountIdentities: [],
      anchorBusinessesWithoutIdentities: [],
      contradictions: 0,
    };
  }

  const expectedBusinesses = [
    ...new Map(
      input.manifestRows.map((row) => [
        row.businessId,
        {
          schedulerPosition: row.schedulerPosition,
          businessId: row.businessId,
          businessName: row.businessName,
        },
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.schedulerPosition - right.schedulerPosition ||
      left.businessId.localeCompare(right.businessId),
  );
  const expectedProviderAccounts = [
    ...new Map(
      input.manifestRows.map((row) => [
        schedulerAccountIdentityKey(row),
        schedulerAccountIdentityProjection(row),
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.businessId.localeCompare(right.businessId) ||
      left.providerAccountRefId.localeCompare(right.providerAccountRefId) ||
      left.providerAccountId.localeCompare(right.providerAccountId),
  );
  const expectedBusinessIds = new Set(
    expectedBusinesses.map((row) => row.businessId),
  );
  const expectedAccountKeys = new Set(
    expectedProviderAccounts.map(schedulerAccountIdentityKey),
  );
  const anchorsByBusiness = new Map<string, FixedBaselineAnchor[]>();
  for (const anchor of input.observedAnchors) {
    const rows = anchorsByBusiness.get(anchor.businessId) ?? [];
    rows.push(anchor);
    anchorsByBusiness.set(anchor.businessId, rows);
  }
  const observedAccounts = [
    ...new Map(
      input.observedIdentities.map((row) => [
        schedulerAccountIdentityKey(row),
        schedulerAccountIdentityProjection(row),
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.businessId.localeCompare(right.businessId) ||
      left.providerAccountRefId.localeCompare(right.providerAccountRefId) ||
      left.providerAccountId.localeCompare(right.providerAccountId),
  );
  const observedAccountKeys = new Set(
    observedAccounts.map(schedulerAccountIdentityKey),
  );
  const observedIdentityBusinessIds = new Set(
    observedAccounts.map((row) => row.businessId),
  );
  const missingBusinessAnchors = expectedBusinesses
    .filter((row) => !anchorsByBusiness.has(row.businessId))
    .map((row) => row.businessId);
  const unexpectedBusinessAnchors = [...anchorsByBusiness.keys()]
    .filter((businessId) => !expectedBusinessIds.has(businessId))
    .sort();
  const duplicateBusinessAnchors = [...anchorsByBusiness.entries()]
    .filter(([, anchors]) => anchors.length !== 1)
    .map(([businessId]) => businessId)
    .sort();
  const missingProviderAccountIdentities = expectedProviderAccounts.filter(
    (row) => !observedAccountKeys.has(schedulerAccountIdentityKey(row)),
  );
  const unexpectedProviderAccountIdentities = observedAccounts.filter(
    (row) => !expectedAccountKeys.has(schedulerAccountIdentityKey(row)),
  );
  const anchorBusinessesWithoutIdentities = [...anchorsByBusiness.keys()]
    .filter((businessId) => !observedIdentityBusinessIds.has(businessId))
    .sort();
  const contradictions =
    missingBusinessAnchors.length +
    unexpectedBusinessAnchors.length +
    duplicateBusinessAnchors.length +
    missingProviderAccountIdentities.length +
    unexpectedProviderAccountIdentities.length +
    anchorBusinessesWithoutIdentities.length;

  return {
    required: true,
    mode: "unfiltered_scheduler_population" as const,
    schedulerContract: {
      activeBusinessLimit: 500,
      excludesDemoBusinesses: true,
      businessOrder: "created_at_asc",
      enabledSource: "business_override_then_current_env_default",
      metaEligibilitySource: "business_provider_accounts",
    },
    readWithinReplayRepeatableReadTransaction: true,
    envDefaultEnabled: input.envDefaultEnabled,
    expectedBusinessCount: expectedBusinesses.length,
    expectedProviderAccountCount: expectedProviderAccounts.length,
    observedAnchorCount: input.observedAnchors.length,
    observedIdentityAccountCount: observedAccounts.length,
    manifestHash: canonicalSha256({
      envDefaultEnabled: input.envDefaultEnabled,
      businesses: expectedBusinesses,
      providerAccounts: expectedProviderAccounts,
    }),
    expectedBusinesses,
    expectedProviderAccounts,
    missingBusinessAnchors,
    unexpectedBusinessAnchors,
    duplicateBusinessAnchors,
    missingProviderAccountIdentities,
    unexpectedProviderAccountIdentities,
    anchorBusinessesWithoutIdentities,
    contradictions,
  };
}

function fixedBaselineAccountKey(
  identity: Pick<
    FixedBaselineIdentity,
    "jobRunId" | "businessId" | "providerAccountRefId" | "providerAccountId"
  >,
) {
  return [
    identity.jobRunId,
    identity.businessId,
    identity.providerAccountRefId,
    identity.providerAccountId,
  ].join("\u0000");
}

function exactRowIdentity(input: {
  row: DbRow;
  identity: FixedBaselineIdentity;
  label: string;
}) {
  const actual = fixedBaselineIdentity(input.row);
  if (
    actual.jobRunId !== input.identity.jobRunId ||
    actual.businessId !== input.identity.businessId ||
    actual.snapshotId !== input.identity.snapshotId ||
    actual.providerAccountRefId !== input.identity.providerAccountRefId ||
    actual.providerAccountId !== input.identity.providerAccountId
  ) {
    throw new Error(
      `${input.label} identity mismatch for snapshot ${input.identity.snapshotId}`,
    );
  }
}

export function rebindFixedBaselineCohortRows(input: {
  anchorRows: readonly DbRow[];
  identityRows: readonly DbRow[];
  anchorProofRows: readonly DbRow[];
  accountProofRows: readonly DbRow[];
  payloadRows: readonly DbRow[];
}): DbRow[] {
  const anchors = new Map<string, FixedBaselineAnchor>();
  for (const rawAnchor of input.anchorRows) {
    const anchor = fixedBaselineAnchor(rawAnchor);
    if (anchors.has(anchor.jobRunId)) {
      throw new Error(`Duplicate fixed baseline anchor ${anchor.jobRunId}`);
    }
    anchors.set(anchor.jobRunId, anchor);
  }

  const identities = new Map<string, FixedBaselineIdentity>();
  const identityCountByAnchor = new Map<string, number>();
  const accounts = new Map<string, FixedBaselineIdentity>();
  for (const rawIdentity of input.identityRows) {
    const identity = fixedBaselineIdentity(rawIdentity);
    const anchor = anchors.get(identity.jobRunId);
    if (!anchor || anchor.businessId !== identity.businessId) {
      throw new Error(
        `Identity ${identity.snapshotId} does not rebind to its frozen anchor`,
      );
    }
    if (identities.has(identity.snapshotId)) {
      throw new Error(
        `Duplicate fixed baseline snapshot ${identity.snapshotId}`,
      );
    }
    identities.set(identity.snapshotId, identity);
    identityCountByAnchor.set(
      identity.jobRunId,
      (identityCountByAnchor.get(identity.jobRunId) ?? 0) + 1,
    );
    accounts.set(fixedBaselineAccountKey(identity), identity);
  }

  const anchorProofs = new Map<string, DbRow>();
  for (const proof of input.anchorProofRows) {
    const jobRunId = text(proof.job_run_id, "anchor_proof.job_run_id");
    if (anchorProofs.has(jobRunId)) {
      throw new Error(`Duplicate anchor proof ${jobRunId}`);
    }
    const anchor = anchors.get(jobRunId);
    if (
      !anchor ||
      text(proof.business_id, "anchor_proof.business_id") !==
        anchor.businessId ||
      text(proof.business_name, "anchor_proof.business_name") !==
        anchor.businessName
    ) {
      throw new Error(`Anchor proof ${jobRunId} changed frozen identity`);
    }
    const expectedSelectedCount = identityCountByAnchor.get(jobRunId) ?? 0;
    const actualSelectedCount = nonnegativeInteger(
      proof.anchor_selected_scope_snapshot_count,
      "anchor_proof.anchor_selected_scope_snapshot_count",
    );
    if (actualSelectedCount !== expectedSelectedCount) {
      throw new Error(
        `Anchor ${jobRunId} selected cardinality changed: identities=${expectedSelectedCount}, proof=${actualSelectedCount}`,
      );
    }
    anchorProofs.set(jobRunId, proof);
  }
  if (anchorProofs.size !== anchors.size) {
    throw new Error(
      `Anchor proof cardinality mismatch: anchors=${anchors.size}, proofs=${anchorProofs.size}`,
    );
  }

  const accountProofs = new Map<string, DbRow>();
  for (const proof of input.accountProofRows) {
    const proofIdentity = {
      jobRunId: text(proof.job_run_id, "account_proof.job_run_id"),
      businessId: text(proof.business_id, "account_proof.business_id"),
      providerAccountRefId: text(
        proof.provider_account_ref_id,
        "account_proof.provider_account_ref_id",
      ),
      providerAccountId: text(
        proof.provider_account_id,
        "account_proof.provider_account_id",
      ),
    };
    const key = fixedBaselineAccountKey(proofIdentity);
    if (!accounts.has(key)) {
      throw new Error(`Unexpected fixed baseline account proof ${key}`);
    }
    if (accountProofs.has(key)) {
      throw new Error(`Duplicate fixed baseline account proof ${key}`);
    }
    accountProofs.set(key, proof);
  }
  if (accountProofs.size !== accounts.size) {
    throw new Error(
      `Account proof cardinality mismatch: accounts=${accounts.size}, proofs=${accountProofs.size}`,
    );
  }

  const payloads = new Map<string, DbRow>();
  for (const payload of input.payloadRows) {
    const snapshotId = text(payload.snapshot_id, "payload.snapshot_id");
    const identity = identities.get(snapshotId);
    if (!identity) {
      throw new Error(`Unexpected fixed baseline payload ${snapshotId}`);
    }
    exactRowIdentity({ row: payload, identity, label: "Payload" });
    if (payloads.has(snapshotId)) {
      throw new Error(`Duplicate fixed baseline payload ${snapshotId}`);
    }
    payloads.set(snapshotId, payload);
  }
  if (payloads.size !== identities.size) {
    throw new Error(
      `Payload cardinality mismatch: identities=${identities.size}, payloads=${payloads.size}`,
    );
  }

  return [...identities.values()]
    .sort(
      (left, right) =>
        left.businessId.localeCompare(right.businessId) ||
        left.providerAccountRefId.localeCompare(right.providerAccountRefId) ||
        left.providerAccountId.localeCompare(right.providerAccountId) ||
        left.snapshotId.localeCompare(right.snapshotId),
    )
    .map((identity) => {
      const anchor = anchors.get(identity.jobRunId)!;
      const anchorProof = anchorProofs.get(identity.jobRunId)!;
      const accountProof = accountProofs.get(
        fixedBaselineAccountKey(identity),
      )!;
      const payload = payloads.get(identity.snapshotId)!;
      return {
        ...payload,
        ...anchorProof,
        ...accountProof,
        snapshot_id: identity.snapshotId,
        job_run_id: identity.jobRunId,
        business_id: identity.businessId,
        business_name: anchor.businessName,
        provider_account_ref_id: identity.providerAccountRefId,
        provider_account_id: identity.providerAccountId,
      };
    });
}

function providerAccountIdsForAnchor(
  args: ParsedArgs,
  anchor: FixedBaselineAnchor,
): string[] | null {
  if (args.providerAccounts.length === 0) return null;
  return [
    ...new Set(
      args.providerAccounts
        .filter(
          (scope) =>
            scope.businessSelector === anchor.businessId ||
            scope.businessSelector === anchor.businessName,
        )
        .map((scope) => scope.providerAccountId),
    ),
  ].sort();
}

function fixedBaselineChunks<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function loadFixedBaselineCohort(input: {
  client: Client;
  args: ParsedArgs;
}): Promise<{
  rows: DbRow[];
  diagnostics: FixedBaselineReadDiagnostics;
  populationObservation: FixedBaselinePopulationObservation;
}> {
  const startedAt = Date.now();
  const statements: FixedBaselineReadStatement[] = [];
  const read = async (
    kind: FixedBaselineReadStatement["kind"],
    scope: string,
    sql: string,
    values: unknown[],
  ) => {
    const statementStartedAt = Date.now();
    try {
      const result = await input.client.query<DbRow>(sql, values);
      statements.push({
        sequence: statements.length + 1,
        kind,
        scope,
        rowCount: result.rowCount ?? result.rows.length,
        durationMs: Date.now() - statementStartedAt,
      });
      return result.rows;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Bounded baseline ${kind} read failed for ${scope} after ${Date.now() - statementStartedAt}ms: ${reason}`,
      );
    }
  };

  const providerScopeJson =
    input.args.providerAccounts.length > 0
      ? JSON.stringify(
          input.args.providerAccounts.map((scope) => ({
            business_selector: scope.businessSelector,
            provider_account_id: scope.providerAccountId,
          })),
        )
      : null;
  const anchorRows = await read(
    "anchors",
    "requested_scope",
    READ_FIXED_BASELINE_ANCHORS_SQL,
    [
      input.args.asOfDate,
      NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION,
      input.args.businesses.length > 0 ? input.args.businesses : null,
      AD_DECISIONS_JOB_NAME,
      AD_CALIBRATION_JOB_NAME,
      providerScopeJson,
    ],
  );
  const unfiltered =
    input.args.businesses.length === 0 &&
    input.args.providerAccounts.length === 0;
  if (anchorRows.length === 0 && !unfiltered) {
    throw new Error(
      `No persisted baseline anchors found for ${input.args.asOfDate} at ${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}`,
    );
  }
  const anchors = anchorRows.map(fixedBaselineAnchor);
  if (
    new Set(anchors.map((anchor) => anchor.jobRunId)).size !== anchors.length
  ) {
    throw new Error(
      "Fixed baseline anchor discovery returned duplicate job runs",
    );
  }

  const identityRows: DbRow[] = [];
  for (const anchor of anchors) {
    const providerAccountIds = providerAccountIdsForAnchor(input.args, anchor);
    if (providerAccountIds !== null && providerAccountIds.length === 0) {
      throw new Error(
        `Anchor ${anchor.jobRunId} did not rebind to a requested business selector`,
      );
    }
    identityRows.push(
      ...(await read(
        "identities",
        anchor.jobRunId,
        READ_FIXED_BASELINE_IDENTITIES_SQL,
        [
          anchor.jobRunId,
          anchor.businessId,
          input.args.asOfDate,
          NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION,
          providerAccountIds,
        ],
      )),
    );
  }
  const identities = identityRows.map(fixedBaselineIdentity);
  if (
    new Set(identities.map((identity) => identity.snapshotId)).size !==
    identities.length
  ) {
    throw new Error(
      "Fixed baseline identity discovery returned duplicate snapshots",
    );
  }

  const identitiesByAnchor = new Map<string, FixedBaselineIdentity[]>();
  for (const identity of identities) {
    const rows = identitiesByAnchor.get(identity.jobRunId) ?? [];
    rows.push(identity);
    identitiesByAnchor.set(identity.jobRunId, rows);
  }
  const anchorProofRows: DbRow[] = [];
  for (const anchor of anchors) {
    anchorProofRows.push(
      ...(await read(
        "anchor_proof",
        anchor.jobRunId,
        READ_FIXED_BASELINE_ANCHOR_PROOF_SQL,
        [
          anchor.jobRunId,
          (identitiesByAnchor.get(anchor.jobRunId) ?? []).map(
            (identity) => identity.snapshotId,
          ),
          AD_CALIBRATION_JOB_NAME,
        ],
      )),
    );
  }

  const accountIdentities = [
    ...new Map(
      identities.map((identity) => [
        fixedBaselineAccountKey(identity),
        identity,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.businessId.localeCompare(right.businessId) ||
      left.providerAccountRefId.localeCompare(right.providerAccountRefId) ||
      left.providerAccountId.localeCompare(right.providerAccountId),
  );
  const accountProofRows: DbRow[] = [];
  const payloadRows: DbRow[] = [];
  for (const account of accountIdentities) {
    const proofRows = await read(
      "account_proof",
      `${account.jobRunId}:${account.providerAccountId}`,
      READ_FIXED_BASELINE_ACCOUNT_PROOF_SQL,
      [
        account.jobRunId,
        account.providerAccountRefId,
        account.providerAccountId,
        AD_CALIBRATION_JOB_NAME,
      ],
    );
    if (proofRows.length !== 1) {
      throw new Error(
        `Account proof cardinality changed for ${account.providerAccountId}: ${proofRows.length}`,
      );
    }
    const proof = proofRows[0]!;
    accountProofRows.push(proof);
    const calibrationBatchId = text(
      proof.calibration_batch_id,
      `account_proof.${account.providerAccountId}.calibration_batch_id`,
    );
    const accountSnapshotIds = identities
      .filter(
        (identity) =>
          fixedBaselineAccountKey(identity) ===
          fixedBaselineAccountKey(account),
      )
      .map((identity) => identity.snapshotId)
      .sort();
    for (const [chunkIndex, snapshotIds] of fixedBaselineChunks(
      accountSnapshotIds,
      FIXED_BASELINE_PAYLOAD_CHUNK_SIZE,
    ).entries()) {
      payloadRows.push(
        ...(await read(
          "payload",
          `${account.jobRunId}:${account.providerAccountId}:${chunkIndex + 1}`,
          READ_FIXED_BASELINE_ROW_PAYLOAD_SQL,
          [
            snapshotIds,
            account.jobRunId,
            account.businessId,
            account.providerAccountRefId,
            account.providerAccountId,
            calibrationBatchId,
          ],
        )),
      );
    }
  }

  const rows = rebindFixedBaselineCohortRows({
    anchorRows,
    identityRows,
    anchorProofRows,
    accountProofRows,
    payloadRows,
  });
  const rowsByKind: FixedBaselineReadDiagnostics["rowsByKind"] = {
    anchors: 0,
    identities: 0,
    anchor_proof: 0,
    account_proof: 0,
    payload: 0,
  };
  for (const statement of statements) {
    rowsByKind[statement.kind] += statement.rowCount;
  }
  return {
    rows,
    populationObservation: {
      anchors,
      identities,
    },
    diagnostics: {
      strategy: "same_transaction_bounded_multi_statement_v1",
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      payloadChunkSize: FIXED_BASELINE_PAYLOAD_CHUNK_SIZE,
      statementCount: statements.length,
      totalDurationMs: Date.now() - startedAt,
      anchorCount: anchors.length,
      accountCount: accountIdentities.length,
      identityCount: identities.length,
      reboundRowCount: rows.length,
      exactRebindValidated: true,
      cohortIdentityHash: canonicalSha256(
        identities
          .map((identity) => ({
            jobRunId: identity.jobRunId,
            businessId: identity.businessId,
            snapshotId: identity.snapshotId,
            providerAccountRefId: identity.providerAccountRefId,
            providerAccountId: identity.providerAccountId,
          }))
          .sort((left, right) =>
            left.snapshotId.localeCompare(right.snapshotId),
          ),
      ),
      rowsByKind,
      statements,
    },
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  let asOfDate: string | null = null;
  let jsonOut: string | null = null;
  let compactJsonOut: string | null = null;
  const provenanceExcludePaths: string[] = [];
  let stdoutMode: ParsedArgs["stdoutMode"] = "full";
  const businesses: string[] = [];
  const providerAccounts: ExpectedProviderAccountScope[] = [];
  const auditProviderAccounts: ExpectedProviderAccountScope[] = [];
  const parseProviderAccountScope = (value: string, argument: string) => {
    const separator = value.lastIndexOf(":");
    const businessSelector = value.slice(0, separator).trim();
    const rawProviderAccountId = value.slice(separator + 1).trim();
    if (separator <= 0 || !businessSelector || !rawProviderAccountId) {
      throw new Error(
        `${argument} must be BUSINESS_ID_OR_NAME:PROVIDER_ACCOUNT_ID`,
      );
    }
    return {
      businessSelector,
      providerAccountId: canonicalMetaProviderAccountId(rawProviderAccountId),
    };
  };
  const uniqueSortedProviderAccountScopes = (
    scopes: ExpectedProviderAccountScope[],
  ) =>
    [
      ...new Map(
        scopes.map((scope) => [
          `${scope.businessSelector}\u0000${scope.providerAccountId}`,
          scope,
        ]),
      ).values(),
    ].sort(
      (left, right) =>
        left.businessSelector.localeCompare(right.businessSelector) ||
        left.providerAccountId.localeCompare(right.providerAccountId),
    );
  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      process.stdout.write(
        "Usage: tsx scripts/creative-decision-center/native-ad-account-aov-authority-replay.ts --as-of=YYYY-MM-DD [--business=ID_OR_NAME] [--provider-account=BUSINESS_ID_OR_NAME:PROVIDER_ACCOUNT_ID] [--audit-provider-account=BUSINESS_ID_OR_NAME:PROVIDER_ACCOUNT_ID] [--json-out=FULL_PATH] [--compact-json-out=COMPACT_PATH] [--provenance-exclude=DECLARED_OUTPUT_PATH] [--stdout=full|compact|none]\n",
      );
      process.exit(0);
    }
    if (token.startsWith("--as-of=")) asOfDate = token.slice(8);
    else if (token.startsWith("--asOf=")) asOfDate = token.slice(7);
    else if (token.startsWith("--business=")) {
      businesses.push(
        ...token
          .slice(11)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
    } else if (token.startsWith("--json-out=")) jsonOut = token.slice(11);
    else if (token.startsWith("--jsonOut=")) jsonOut = token.slice(10);
    else if (token.startsWith("--compact-json-out=")) {
      compactJsonOut = token.slice(19);
    } else if (token.startsWith("--compactJsonOut=")) {
      compactJsonOut = token.slice(17);
    } else if (token.startsWith("--provenance-exclude=")) {
      const path = token.slice(21).trim();
      if (!path) {
        throw new Error("--provenance-exclude requires a path");
      }
      provenanceExcludePaths.push(path);
    } else if (token.startsWith("--stdout=")) {
      const value = token.slice(9);
      if (value !== "full" && value !== "compact" && value !== "none") {
        throw new Error("--stdout must be full, compact, or none");
      }
      stdoutMode = value;
    } else if (token.startsWith("--provider-account=")) {
      const value = token.slice(19).trim();
      providerAccounts.push(
        parseProviderAccountScope(value, "--provider-account"),
      );
    } else if (token.startsWith("--audit-provider-account=")) {
      const value = token.slice(25).trim();
      auditProviderAccounts.push(
        parseProviderAccountScope(value, "--audit-provider-account"),
      );
    } else throw new Error(`Unknown argument: ${token}`);
  }
  if (!asOfDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error("--as-of=YYYY-MM-DD is required");
  }
  const parsed = new Date(`${asOfDate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== asOfDate
  ) {
    throw new Error(`Invalid --as-of date: ${asOfDate}`);
  }
  return {
    asOfDate,
    businesses: [...new Set(businesses)].sort(),
    providerAccounts: uniqueSortedProviderAccountScopes(providerAccounts),
    auditProviderAccounts: uniqueSortedProviderAccountScopes(
      auditProviderAccounts,
    ),
    jsonOut: jsonOut?.trim() || null,
    compactJsonOut: compactJsonOut?.trim() || null,
    provenanceExcludePaths: [...new Set(provenanceExcludePaths)].sort(),
    stdoutMode,
  };
}

export function assertReplayOutputPlan(
  args: Pick<ParsedArgs, "jsonOut" | "compactJsonOut" | "stdoutMode">,
  repoRoot: string = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim(),
) {
  if (args.compactJsonOut !== null && args.jsonOut === null) {
    throw new Error(
      "--compact-json-out requires --json-out so the omitted full row evidence is retained outside the git worktree",
    );
  }
  if (
    args.jsonOut !== null &&
    args.compactJsonOut !== null &&
    resolve(args.jsonOut) === resolve(args.compactJsonOut)
  ) {
    throw new Error(
      "--json-out and --compact-json-out must use different files",
    );
  }
  if (args.jsonOut !== null && args.compactJsonOut !== null) {
    const relativeFullPath = relative(resolve(repoRoot), resolve(args.jsonOut));
    const fullArtifactIsInsideWorktree =
      relativeFullPath === "" ||
      (!relativeFullPath.startsWith("..") && !isAbsolute(relativeFullPath));
    if (fullArtifactIsInsideWorktree) {
      throw new Error(
        "When --compact-json-out is used, the full --json-out row artifact must stay outside the git worktree (for example under /tmp)",
      );
    }
  }
  if (
    args.stdoutMode === "none" &&
    args.jsonOut === null &&
    args.compactJsonOut === null
  ) {
    throw new Error("--stdout=none requires --json-out or --compact-json-out");
  }
}

export function assertCurrentUtcReplayDate(
  asOfDate: string,
  now: Date = new Date(),
) {
  const currentUtcDate = now.toISOString().slice(0, 10);
  if (asOfDate !== currentUtcDate) {
    throw new Error(
      `Current-day production parity requires --as-of=${currentUtcDate}; received ${asOfDate}`,
    );
  }
}

function assertTunnelDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    url.port !== TUNNEL_PORT
  ) {
    throw new Error(
      "Native Ad AOV replay requires the existing read-only tunnel at 127.0.0.1:15432",
    );
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function optionalText(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function timestamp(value: unknown, field: string): string {
  const raw = text(value, field);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()))
    throw new TypeError(`${field} is invalid`);
  return parsed.toISOString();
}

function label(value: unknown, field: string): DecisionLabel {
  if (
    value === "scale" ||
    value === "keep" ||
    value === "refresh" ||
    value === "cut" ||
    value === "test_more" ||
    value === "diagnose" ||
    value === "out_of_scope"
  ) {
    return value;
  }
  throw new TypeError(`${field} has invalid label ${String(value)}`);
}

function hardAction(value: unknown): "scale" | "cut" | "refresh" | null {
  return value === "scale" || value === "cut" || value === "refresh"
    ? value
    : null;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${field} must be boolean`);
  return value;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumber(value: unknown, field: string): number {
  const parsed = numberOrNull(value);
  if (parsed === null) throw new TypeError(`${field} must be a finite number`);
  return parsed;
}

function decisionBadges(value: unknown, field: string): DecisionBadge[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((item, index) => {
    const badge = object(item, `${field}[${index}]`);
    if (typeof badge.type !== "string" || !badge.type.trim()) {
      throw new TypeError(`${field}[${index}].type is required`);
    }
    return badge as unknown as DecisionBadge;
  });
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function optionalNonnegativeInteger(
  value: unknown,
  field: string,
): number | null {
  return value === null || value === undefined
    ? null
    : nonnegativeInteger(value, field);
}

function normalizeCampaignContext(value: unknown): CampaignContextProvenance {
  const row = object(value, "campaign_context_json");
  const mode = row.mode;
  const source = row.source;
  if (mode !== "legacy_labels" && mode !== "automatic" && mode !== "unknown") {
    throw new TypeError(`Unsupported campaign context mode ${String(mode)}`);
  }
  if (
    source !== "legacy_label" &&
    source !== "user_override" &&
    source !== "system_inferred" &&
    source !== "unknown"
  ) {
    throw new TypeError(
      `Unsupported campaign context source ${String(source)}`,
    );
  }
  const kind = row.kind;
  const testDimension = row.testDimension;
  return {
    mode,
    source,
    campaignId: optionalText(row.campaignId),
    kind: kind === "main" || kind === "test" || kind === "mixed" ? kind : null,
    testDimension:
      testDimension === "creative" ||
      testDimension === "audience" ||
      testDimension === "bid" ||
      testDimension === "offer" ||
      testDimension === "structure" ||
      testDimension === "other"
        ? testDimension
        : null,
    contextTrust:
      row.contextTrust === "override" ||
      row.contextTrust === "high" ||
      row.contextTrust === "medium" ||
      row.contextTrust === "low" ||
      row.contextTrust === "unknown" ||
      row.contextTrust === "conflict"
        ? row.contextTrust
        : null,
    sourceRecordType:
      row.sourceRecordType === "meta_campaign_label" ||
      row.sourceRecordType === "engine_v3_campaign_context_daily"
        ? row.sourceRecordType
        : null,
    sourceRecordId: optionalText(row.sourceRecordId),
    sourceAsOfDate: optionalText(row.sourceAsOfDate),
    sourceUpdatedAt: optionalText(row.sourceUpdatedAt),
    sourceHash: optionalText(row.sourceHash),
  };
}

function normalizeFlags(value: unknown, businessId: string): EngineV3Flags {
  const row = object(value, "flags_json");
  const preset = row.presetOverride;
  const presetOverride =
    preset === "aggressive" ||
    preset === "balanced" ||
    preset === "conservative"
      ? preset
      : null;
  return {
    businessId,
    enabled: row.enabled !== false,
    surfaceVisible: row.surfaceVisible === true,
    shadowOnly: row.shadowOnly === true,
    presetOverride,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: presetOverride === null ? null : "env",
    },
    envDefaults: {
      enabled: row.enabled !== false,
      surfaceVisible: row.surfaceVisible === true,
      shadowOnly: row.shadowOnly === true,
    },
  };
}

function baselineCohortKey(input: {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  adId: string;
  scopeId: string;
}) {
  return [
    input.businessId,
    input.providerAccountRefId,
    input.providerAccountId,
    "ad",
    input.adId,
    "account",
    input.scopeId,
  ].join("\u0000");
}

export interface NativeSnapshotProjection {
  publishedLabel: DecisionLabel;
  rawLabel: DecisionLabel;
  preAuthorityLabel: DecisionLabel;
  authorityBlocker: string | null;
  blockedActionType: "scale" | "cut" | "refresh" | null;
  authorizedAction: "scale" | "cut" | "refresh" | null;
  confidence: number | null;
  truthSource: string | null;
  effectiveTargetRoas: number | null;
  ratioToTarget: number | null;
  badges: DecisionBadge[];
  reason: string;
  spend: number | null;
  purchases: number | null;
  roas: number | null;
  recent7dRoas: number | null;
  labelTransform: string | null;
  creativeEvidenceLifecycleRowId: string | null;
  computedAt: string;
}

export function nativeSnapshotProjectionProof(input: {
  actual: NativeSnapshotProjection;
  expected: NativeSnapshotProjection;
  decisionMetricsMatchCreativeInput: boolean;
  authorityProjectionValid: boolean;
}) {
  const snapshotProjectionHash = canonicalSha256(input.actual);
  const recomputedSnapshotProjectionHash = canonicalSha256(input.expected);
  return {
    snapshotProjectionHash,
    recomputedSnapshotProjectionHash,
    valid:
      input.decisionMetricsMatchCreativeInput &&
      input.authorityProjectionValid &&
      input.expected.confidence !== null &&
      input.expected.truthSource !== null &&
      input.expected.effectiveTargetRoas !== null &&
      input.expected.spend !== null &&
      input.expected.purchases !== null &&
      snapshotProjectionHash === recomputedSnapshotProjectionHash,
  };
}

function snapshotConfidence(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null
    ? null
    : Math.max(0, Math.min(100, Math.round(parsed)));
}

function expectedSnapshotAuthorizedAction(input: {
  rawLabel: DecisionLabel;
  publishedLabel: DecisionLabel;
  authorityBlocker: string | null;
  confidence: number | null;
  calibrationRowId: string | null;
  hardActionEligibility: Record<string, unknown>;
}): {
  authorizedAction: "scale" | "cut" | "refresh" | null;
  valid: boolean;
} {
  if (input.authorityBlocker !== null) {
    return { authorizedAction: null, valid: true };
  }
  const hardRawLabel = hardAction(input.rawLabel);
  if (input.calibrationRowId === null) {
    return {
      authorizedAction: null,
      valid:
        hardRawLabel === null &&
        (input.publishedLabel === "diagnose" ||
          input.publishedLabel === "out_of_scope" ||
          input.publishedLabel === "keep") &&
        input.confidence !== null &&
        input.confidence <= 40,
    };
  }
  if (hardRawLabel === null || input.publishedLabel !== hardRawLabel) {
    return { authorizedAction: null, valid: true };
  }
  return input.hardActionEligibility[hardRawLabel] === true
    ? { authorizedAction: hardRawLabel, valid: true }
    : { authorizedAction: null, valid: false };
}

export function canonicalContextScopeMatchesAccountProfile(input: {
  contextScope: unknown;
  accountProfile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  expectedScopeId: string;
}) {
  const profileScope = input.accountProfile.scope;
  return (
    profileScope.type === "account" &&
    profileScope.id === input.expectedScopeId &&
    canonicalSha256(input.contextScope) === canonicalSha256(profileScope)
  );
}

function mapBaselineRow(row: DbRow): BaselineRow {
  const businessId = text(row.business_id, "business_id");
  const providerAccountRefId = text(
    row.provider_account_ref_id,
    "provider_account_ref_id",
  );
  const providerAccountId = text(
    row.provider_account_id,
    "provider_account_id",
  );
  const persistedCreativeInput = object(
    row.creative_input_json,
    "creative_input_json",
  );
  const persistedProviderAccountRefId = optionalText(
    persistedCreativeInput.providerAccountRefId,
  );
  if (
    persistedProviderAccountRefId !== null &&
    persistedProviderAccountRefId !== providerAccountRefId
  ) {
    throw new TypeError(
      `Persisted creative input provider-account reference conflicts with immutable evaluation identity for ${text(row.persisted_ad_id, "persisted_ad_id")}`,
    );
  }
  // The canonical Ad input payload intentionally stores the physical account
  // reference in decisionIdentity, not in creativeInput. Rehydrate that field
  // from the joined immutable evaluation identity before invoking production
  // Ad functions; a conflicting legacy copy still fails closed above.
  const creativeInput = {
    ...persistedCreativeInput,
    providerAccountRefId,
  } as unknown as AdDecisionInput;
  const adId = text(creativeInput.adId, "creative_input_json.adId");
  const persistedAdId = text(row.persisted_ad_id, "persisted_ad_id");
  if (
    adId !== persistedAdId ||
    creativeInput.decisionEntityType !== "ad" ||
    creativeInput.decisionEntityId !== persistedAdId ||
    creativeInput.businessId !== businessId ||
    creativeInput.providerAccountRefId !== providerAccountRefId ||
    creativeInput.providerAccountId !== providerAccountId
  ) {
    throw new TypeError(
      `Persisted creative input identity does not match immutable evaluation identity for ${persistedAdId}`,
    );
  }
  const scopeId = text(row.scope_id, "scope_id");
  if (scopeId !== providerAccountId) {
    throw new TypeError(`Non-account native scope for ${adId}`);
  }
  const accountProfile = object(
    row.account_profile_json,
    "account_profile_json",
  ) as unknown as AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  const dataHealth = object(
    row.data_health_json,
    "data_health_json",
  ) as unknown as DataHealth;
  const contextJson = object(row.context_json, "context_json");
  const decisionOutput = object(
    row.decision_output_json,
    "decision_output_json",
  );
  const contextContractVersion = text(
    row.context_contract_version,
    "context_contract_version",
  );
  const evaluationContractVersion = text(
    row.evaluation_contract_version,
    "evaluation_contract_version",
  );
  const contextHash = text(row.context_hash, "context_hash");
  const inputHash = text(row.input_hash, "input_hash");
  const decisionHash = text(row.decision_hash, "decision_hash");
  const creativeId = optionalText(row.persisted_creative_id);
  const rawLabel = label(row.raw_label, "raw_label");
  const publishedLabel = label(row.published_label, "published_label");
  const preAuthorityLabel = label(
    row.pre_authority_label,
    "pre_authority_label",
  );
  const authorityBlocker = optionalText(row.authority_blocker);
  const blockedActionType = hardAction(row.blocked_action_type);
  const authorizedAction = hardAction(row.authorized_action);
  const confidence = finiteNumber(row.confidence, "confidence");
  const reason = text(row.reason, "reason");
  const badges = decisionBadges(row.badges, "badges");
  const hysteresisSuppressed = boolean(
    row.hysteresis_suppressed,
    "hysteresis_suppressed",
  );
  const campaignContextJson = object(
    row.campaign_context_json,
    "campaign_context_json",
  );
  const priorHysteresisJson = object(
    row.prior_hysteresis_json,
    "prior_hysteresis_json",
  );
  const evaluatedAt = timestamp(row.evaluated_at, "evaluated_at");
  const calibrationRowId = optionalText(row.snapshot_calibration_row_id);
  const decisionMetrics = object(
    decisionOutput.metrics,
    "decision_output_json.metrics",
  );
  const creativeEvidence = object(
    persistedCreativeInput.creativeEvidence,
    "creative_input_json.creativeEvidence",
  );
  const hardActionEligibility = object(
    accountProfile.hardActionEligibility,
    "account_profile_json.hardActionEligibility",
  );
  const expectedPublishedLabel = label(
    decisionOutput.label,
    "decision_output_json.label",
  );
  const expectedPreAuthorityLabel = label(
    decisionOutput.preAuthorityLabel,
    "decision_output_json.preAuthorityLabel",
  );
  const expectedAuthorityBlocker = optionalText(
    decisionOutput.authorityBlocker,
  );
  const decisionMetricProjection = {
    spend: numberOrNull(decisionMetrics.spend),
    purchases: numberOrNull(decisionMetrics.purchases),
    roas: numberOrNull(decisionMetrics.roas),
    recent7dRoas: numberOrNull(decisionMetrics.recent7dRoas),
  };
  const creativeMetricProjection = {
    spend: numberOrNull(persistedCreativeInput.spend),
    purchases: numberOrNull(persistedCreativeInput.purchases),
    roas: numberOrNull(persistedCreativeInput.roas),
    recent7dRoas: numberOrNull(persistedCreativeInput.recent7dRoas),
  };
  const expectedConfidence = snapshotConfidence(decisionOutput.confidence);
  const expectedAuthorityProjection = expectedSnapshotAuthorizedAction({
    rawLabel,
    publishedLabel: expectedPublishedLabel,
    authorityBlocker: expectedAuthorityBlocker,
    confidence: expectedConfidence,
    calibrationRowId,
    hardActionEligibility,
  });
  const snapshotProjectionProof = nativeSnapshotProjectionProof({
    actual: {
      publishedLabel,
      rawLabel,
      preAuthorityLabel,
      authorityBlocker,
      blockedActionType,
      authorizedAction,
      confidence: snapshotConfidence(confidence),
      truthSource: optionalText(row.truth_source),
      effectiveTargetRoas: numberOrNull(row.effective_target_roas),
      ratioToTarget: numberOrNull(row.ratio_to_target),
      badges,
      reason,
      spend: numberOrNull(row.snapshot_spend),
      purchases: numberOrNull(row.snapshot_purchases),
      roas: numberOrNull(row.snapshot_roas),
      recent7dRoas: numberOrNull(row.snapshot_recent7d_roas),
      labelTransform: optionalText(row.snapshot_label_transform),
      creativeEvidenceLifecycleRowId: optionalText(
        row.snapshot_creative_evidence_lifecycle_row_id,
      ),
      computedAt: timestamp(row.snapshot_computed_at, "snapshot_computed_at"),
    },
    expected: {
      publishedLabel: expectedPublishedLabel,
      rawLabel,
      preAuthorityLabel: expectedPreAuthorityLabel,
      authorityBlocker: expectedAuthorityBlocker,
      blockedActionType: hardAction(decisionOutput.blockedActionType),
      authorizedAction: expectedAuthorityProjection.authorizedAction,
      confidence: expectedConfidence,
      truthSource: optionalText(decisionOutput.truthSource),
      effectiveTargetRoas: numberOrNull(decisionOutput.effectiveTargetRoas),
      ratioToTarget: numberOrNull(decisionOutput.ratioToTarget),
      badges: decisionBadges(
        decisionOutput.badges,
        "decision_output_json.badges",
      ),
      reason: text(decisionOutput.reason, "decision_output_json.reason"),
      ...creativeMetricProjection,
      labelTransform: optionalText(decisionOutput.labelTransform),
      creativeEvidenceLifecycleRowId: optionalText(
        creativeEvidence.sourceLifecycleRowId,
      ),
      computedAt: evaluatedAt,
    },
    decisionMetricsMatchCreativeInput:
      canonicalSha256(decisionMetricProjection) ===
      canonicalSha256(creativeMetricProjection),
    authorityProjectionValid: expectedAuthorityProjection.valid,
  });
  const recomputedContextHash = canonicalSha256(contextJson);
  const recomputedInputHash = canonicalSha256({
    contractVersion: evaluationContractVersion,
    envelopeType: "input",
    engineVersion: text(row.engine_version, "engine_version"),
    contextHash,
    creativeInput: persistedCreativeInput,
    campaignContext: campaignContextJson,
    priorHysteresis: priorHysteresisJson,
    decisionIdentity: {
      decisionEntityType: "ad",
      decisionEntityId: persistedAdId,
      adId: persistedAdId,
      providerAccountId,
      providerAccountRefId,
      creativeGroupingId: creativeId,
    },
  });
  const recomputedDecisionHash = canonicalSha256({
    contractVersion: evaluationContractVersion,
    envelopeType: "decision",
    engineVersion: text(row.engine_version, "engine_version"),
    inputHash,
    decision: decisionOutput,
    rawLabel,
    publishedLabel,
    hysteresisSuppressed,
  });
  const contextComponentsMatch =
    contextJson.contractVersion === contextContractVersion &&
    contextJson.envelopeType === "context" &&
    contextJson.engineVersion === row.engine_version &&
    canonicalSha256(contextJson.accountProfile) ===
      canonicalSha256(accountProfile) &&
    canonicalSha256(contextJson.dataHealth) === canonicalSha256(dataHealth) &&
    canonicalSha256(contextJson.flags) === canonicalSha256(row.flags_json) &&
    canonicalContextScopeMatchesAccountProfile({
      contextScope: contextJson.scope,
      accountProfile,
      expectedScopeId: scopeId,
    });
  const canonicalEnvelopeValid =
    contextContractVersion === evaluationContractVersion &&
    contextComponentsMatch &&
    expectedPublishedLabel === publishedLabel &&
    recomputedContextHash === contextHash &&
    recomputedInputHash === inputHash &&
    recomputedDecisionHash === decisionHash &&
    snapshotProjectionProof.valid;
  const persistedProfileType =
    "profileType" in accountProfile ? accountProfile.profileType : undefined;
  const persistedProfileStatus =
    persistedProfileType === "native_ad_soft_only" ? "soft_only" : "ready";
  if (
    persistedProfileType !== undefined &&
    persistedProfileType !== "native_ad_soft_only"
  ) {
    throw new TypeError(
      `Unknown persisted native profile type ${String(persistedProfileType)}`,
    );
  }
  return {
    cohortKey: baselineCohortKey({
      businessId,
      providerAccountRefId,
      providerAccountId,
      adId,
      scopeId,
    }),
    businessId,
    businessName: text(row.business_name, "business_name"),
    providerAccountRefId,
    providerAccountId,
    currentProviderAccountName: optionalText(row.current_provider_account_name),
    currentAccountTimezone: optionalText(row.current_account_timezone),
    currentAccountCurrency:
      optionalText(row.current_account_currency)?.toUpperCase() ?? null,
    accountTimezone: optionalText(row.account_timezone),
    accountCurrency: optionalText(row.account_currency)?.toUpperCase() ?? null,
    asOfDate: text(row.as_of_date, "as_of_date"),
    calibrationCutoff: timestamp(row.calibration_cutoff, "calibration_cutoff"),
    calibrationCutoffSource:
      row.calibration_cutoff_source === "persisted_calibration_batch"
        ? "persisted_calibration_batch"
        : "evaluation_fallback",
    snapshotId: text(row.snapshot_id, "snapshot_id"),
    evaluationId: text(row.evaluation_id, "evaluation_id"),
    contextId: text(row.context_id, "context_id"),
    jobRunId: text(row.job_run_id, "job_run_id"),
    anchorDecisionRowCount: nonnegativeInteger(
      row.anchor_decision_row_count,
      "anchor_decision_row_count",
    ),
    anchorActualSnapshotCount: nonnegativeInteger(
      row.anchor_actual_snapshot_count,
      "anchor_actual_snapshot_count",
    ),
    anchorSelectedScopeSnapshotCount: nonnegativeInteger(
      row.anchor_selected_scope_snapshot_count,
      "anchor_selected_scope_snapshot_count",
    ),
    calibrationJobRunId: text(
      row.calibration_job_run_id,
      "calibration_job_run_id",
    ),
    calibrationJobRowCount: nonnegativeInteger(
      row.calibration_job_row_count,
      "calibration_job_row_count",
    ),
    calibrationJobExpectedCellCount: nonnegativeInteger(
      row.calibration_job_expected_cell_count,
      "calibration_job_expected_cell_count",
    ),
    calibrationJobRowsWritten: nonnegativeInteger(
      row.calibration_job_rows_written,
      "calibration_job_rows_written",
    ),
    calibrationJobProviderAccountCount: nonnegativeInteger(
      row.calibration_job_provider_account_count,
      "calibration_job_provider_account_count",
    ),
    calibrationWaveReceiptCount: nonnegativeInteger(
      row.calibration_wave_receipt_count,
      "calibration_wave_receipt_count",
    ),
    calibrationWaveBatchCount: nonnegativeInteger(
      row.calibration_wave_batch_count,
      "calibration_wave_batch_count",
    ),
    calibrationWaveExpectedCellCount: nonnegativeInteger(
      row.calibration_wave_expected_cell_count,
      "calibration_wave_expected_cell_count",
    ),
    calibrationWaveActualCellCount: nonnegativeInteger(
      row.calibration_wave_actual_cell_count,
      "calibration_wave_actual_cell_count",
    ),
    calibrationWaveReceiptContradictions: nonnegativeInteger(
      row.calibration_wave_receipt_contradictions,
      "calibration_wave_receipt_contradictions",
    ),
    calibrationBatchId: text(row.calibration_batch_id, "calibration_batch_id"),
    calibrationBatchJobRunId: text(
      row.calibration_batch_job_run_id,
      "calibration_batch_job_run_id",
    ),
    calibrationBatchExpectedCellCount: nonnegativeInteger(
      row.calibration_batch_expected_cell_count,
      "calibration_batch_expected_cell_count",
    ),
    calibrationBatchActualCellCount: nonnegativeInteger(
      row.calibration_batch_actual_cell_count,
      "calibration_batch_actual_cell_count",
    ),
    calibrationBatchGenerationContentHash: text(
      row.calibration_batch_generation_content_hash,
      "calibration_batch_generation_content_hash",
    ),
    calibrationBatchInputManifestHash: text(
      row.calibration_batch_input_manifest_hash,
      "calibration_batch_input_manifest_hash",
    ),
    calibrationBatchSourceManifestHash: text(
      row.calibration_batch_source_manifest_hash,
      "calibration_batch_source_manifest_hash",
    ),
    calibrationBatchCellSetHash: text(
      row.calibration_batch_cell_set_hash,
      "calibration_batch_cell_set_hash",
    ),
    calibrationReceiptCount: nonnegativeInteger(
      row.calibration_receipt_count,
      "calibration_receipt_count",
    ),
    calibrationReceiptGenerationContentHash: optionalText(
      row.calibration_receipt_generation_content_hash,
    ),
    calibrationReceiptInputManifestHash: optionalText(
      row.calibration_receipt_input_manifest_hash,
    ),
    calibrationReceiptSourceManifestHash: optionalText(
      row.calibration_receipt_source_manifest_hash,
    ),
    calibrationReceiptCellSetHash: optionalText(
      row.calibration_receipt_cell_set_hash,
    ),
    calibrationLineageValid: boolean(
      row.calibration_lineage_valid,
      "calibration_lineage_valid",
    ),
    hydrationReceiptCount: nonnegativeInteger(
      row.hydration_receipt_count,
      "hydration_receipt_count",
    ),
    hydrationExpectedAdCount: optionalNonnegativeInteger(
      row.hydration_expected_ad_count,
      "hydration_expected_ad_count",
    ),
    hydrationExpectedManifestHash: optionalText(
      row.hydration_expected_manifest_hash,
    ),
    hydrationHydratedAdCount: optionalNonnegativeInteger(
      row.hydration_hydrated_ad_count,
      "hydration_hydrated_ad_count",
    ),
    hydrationHydratedManifestHash: optionalText(
      row.hydration_hydrated_manifest_hash,
    ),
    hydrationAuthoritativeForPrune:
      row.hydration_authoritative_for_prune === null
        ? false
        : boolean(
            row.hydration_authoritative_for_prune,
            "hydration_authoritative_for_prune",
          ),
    engineVersion: text(row.engine_version, "engine_version"),
    scopeType: "account",
    scopeId,
    inputHash,
    decisionHash,
    contextHash,
    recomputedContextHash,
    recomputedInputHash,
    recomputedDecisionHash,
    snapshotProjectionHash: snapshotProjectionProof.snapshotProjectionHash,
    recomputedSnapshotProjectionHash:
      snapshotProjectionProof.recomputedSnapshotProjectionHash,
    snapshotProjectionValid: snapshotProjectionProof.valid,
    canonicalEnvelopeValid,
    contextContractVersion,
    evaluationContractVersion,
    contextJson,
    decisionOutput,
    creativeId,
    calibrationRowId,
    persistedProfileStatus,
    evaluatedAt,
    creativeInput,
    campaignContext: normalizeCampaignContext(row.campaign_context_json),
    priorHysteresis: priorHysteresisJson,
    priorHysteresisLineageValid: boolean(
      row.prior_hysteresis_lineage_valid,
      "prior_hysteresis_lineage_valid",
    ),
    priorHysteresisSourceComputedAt:
      row.prior_hysteresis_source_computed_at === null
        ? null
        : timestamp(
            row.prior_hysteresis_source_computed_at,
            "prior_hysteresis_source_computed_at",
          ),
    accountProfile,
    dataHealth,
    flags: normalizeFlags(row.flags_json, businessId),
    baseline: {
      preAuthorityLabel,
      authorityBlocker,
      rawLabel,
      publishedLabel,
      blockedActionType,
      authorizedAction,
      hysteresisSuppressed,
      confidence,
      reason,
      badges,
    },
  };
}

function accountKey(
  row: Pick<
    BaselineRow,
    "businessId" | "providerAccountRefId" | "providerAccountId"
  >,
) {
  return `${row.businessId}\u0000${row.providerAccountRefId}\u0000${row.providerAccountId}`;
}

function groupAccountSlices(rows: readonly BaselineRow[]): AccountSlice[] {
  const grouped = new Map<string, AccountSlice>();
  for (const row of rows) {
    const stableAccountKey = accountKey(row);
    const sliceKey = `${stableAccountKey}\u0000${row.calibrationCutoff}`;
    const existing = grouped.get(sliceKey);
    if (existing) {
      existing.rows.push(row);
      if (row.calibrationCutoffSource === "evaluation_fallback") {
        existing.cutoffSource = "evaluation_fallback";
      }
      continue;
    }
    grouped.set(sliceKey, {
      sliceKey,
      accountKey: stableAccountKey,
      businessId: row.businessId,
      businessName: row.businessName,
      providerAccountRefId: row.providerAccountRefId,
      providerAccountId: row.providerAccountId,
      accountTimezone: row.accountTimezone,
      accountCurrency: row.accountCurrency,
      calibrationCutoff: row.calibrationCutoff,
      cutoffSource: row.calibrationCutoffSource,
      rows: [row],
    });
  }
  return [...grouped.values()]
    .map((slice) => ({
      ...slice,
      rows: slice.rows.sort((left, right) =>
        left.cohortKey.localeCompare(right.cohortKey),
      ),
    }))
    .sort((left, right) => left.sliceKey.localeCompare(right.sliceKey));
}

export function buildWaveCoverageProof(rows: readonly BaselineRow[]) {
  const businessGroups = new Map<string, BaselineRow[]>();
  const accountGroups = new Map<string, BaselineRow[]>();
  for (const row of rows) {
    const businessRows = businessGroups.get(row.businessId) ?? [];
    businessRows.push(row);
    businessGroups.set(row.businessId, businessRows);
    const accountRows = accountGroups.get(accountKey(row)) ?? [];
    accountRows.push(row);
    accountGroups.set(accountKey(row), accountRows);
  }
  const businesses = [...businessGroups.values()].map((businessRows) => {
    const first = businessRows[0]!;
    const decisionJobRunIds = new Set(businessRows.map((row) => row.jobRunId));
    const calibrationJobRunIds = new Set(
      businessRows.map((row) => row.calibrationJobRunId),
    );
    const expectedCounts = new Set(
      businessRows.map((row) => row.anchorDecisionRowCount),
    );
    const waveProofHashes = new Set(
      businessRows.map((row) =>
        canonicalSha256({
          actualSnapshotCount: row.anchorActualSnapshotCount,
          selectedScopeSnapshotCount: row.anchorSelectedScopeSnapshotCount,
          calibrationJobRowCount: row.calibrationJobRowCount,
          calibrationJobExpectedCellCount: row.calibrationJobExpectedCellCount,
          calibrationJobRowsWritten: row.calibrationJobRowsWritten,
          calibrationJobProviderAccountCount:
            row.calibrationJobProviderAccountCount,
          calibrationWaveReceiptCount: row.calibrationWaveReceiptCount,
          calibrationWaveBatchCount: row.calibrationWaveBatchCount,
          calibrationWaveExpectedCellCount:
            row.calibrationWaveExpectedCellCount,
          calibrationWaveActualCellCount: row.calibrationWaveActualCellCount,
          calibrationWaveReceiptContradictions:
            row.calibrationWaveReceiptContradictions,
        }),
      ),
    );
    const valid =
      decisionJobRunIds.size === 1 &&
      calibrationJobRunIds.size === 1 &&
      expectedCounts.size === 1 &&
      waveProofHashes.size === 1 &&
      first.anchorDecisionRowCount === first.anchorActualSnapshotCount &&
      businessRows.length === first.anchorSelectedScopeSnapshotCount &&
      first.calibrationJobRowCount === first.calibrationJobExpectedCellCount &&
      first.calibrationJobRowsWritten ===
        first.calibrationJobExpectedCellCount &&
      first.calibrationJobExpectedCellCount ===
        first.calibrationWaveExpectedCellCount &&
      first.calibrationWaveExpectedCellCount ===
        first.calibrationWaveActualCellCount &&
      first.calibrationJobProviderAccountCount ===
        first.calibrationWaveReceiptCount &&
      first.calibrationWaveReceiptCount === first.calibrationWaveBatchCount &&
      first.calibrationWaveReceiptContradictions === 0;
    return {
      businessId: first.businessId,
      businessName: first.businessName,
      decisionJobRunId: first.jobRunId,
      calibrationJobRunId: first.calibrationJobRunId,
      expectedDecisionRows: first.anchorDecisionRowCount,
      anchoredSnapshotRows: first.anchorActualSnapshotCount,
      selectedScopeSnapshotRows: first.anchorSelectedScopeSnapshotCount,
      selectedFrozenSnapshotRows: businessRows.length,
      calibrationJobRowCount: first.calibrationJobRowCount,
      calibrationJobExpectedCellCount: first.calibrationJobExpectedCellCount,
      calibrationJobRowsWritten: first.calibrationJobRowsWritten,
      calibrationJobProviderAccountCount:
        first.calibrationJobProviderAccountCount,
      calibrationWaveReceiptCount: first.calibrationWaveReceiptCount,
      calibrationWaveBatchCount: first.calibrationWaveBatchCount,
      calibrationWaveExpectedCellCount: first.calibrationWaveExpectedCellCount,
      calibrationWaveActualCellCount: first.calibrationWaveActualCellCount,
      calibrationWaveReceiptContradictions:
        first.calibrationWaveReceiptContradictions,
      valid,
    };
  });
  const accounts = [...accountGroups.values()].map((accountRows) => {
    const first = accountRows[0]!;
    const expectedManifestHash = hashAdDecisionIdentityManifest({
      businessId: first.businessId,
      providerAccountId: first.providerAccountId,
      asOfDate: first.asOfDate,
      adIds: accountRows.map((row) => row.creativeInput.adId),
    });
    const scalarReceiptHashes = new Set(
      accountRows.map((row) =>
        canonicalSha256({
          expectedCount: row.hydrationExpectedAdCount,
          expectedHash: row.hydrationExpectedManifestHash,
          hydratedCount: row.hydrationHydratedAdCount,
          hydratedHash: row.hydrationHydratedManifestHash,
          authoritative: row.hydrationAuthoritativeForPrune,
        }),
      ),
    );
    const calibrationBatchIds = new Set(
      accountRows.map((row) => row.calibrationBatchId),
    );
    const anchoredDimensionHashes = new Set(
      accountRows.map((row) =>
        canonicalSha256({
          accountTimezone: row.accountTimezone,
          accountCurrency: row.accountCurrency,
        }),
      ),
    );
    const exactCalibrationReceipt =
      first.calibrationReceiptCount === 1 &&
      first.calibrationBatchJobRunId === first.calibrationJobRunId &&
      first.calibrationBatchExpectedCellCount ===
        first.calibrationBatchActualCellCount &&
      first.calibrationReceiptGenerationContentHash ===
        first.calibrationBatchGenerationContentHash &&
      first.calibrationReceiptInputManifestHash ===
        first.calibrationBatchInputManifestHash &&
      first.calibrationReceiptSourceManifestHash ===
        first.calibrationBatchSourceManifestHash &&
      first.calibrationReceiptCellSetHash === first.calibrationBatchCellSetHash;
    const exactProfileCalibrationParity = accountRows.every(
      (row) =>
        (row.persistedProfileStatus === "ready" &&
          row.calibrationRowId !== null &&
          row.calibrationLineageValid) ||
        (row.persistedProfileStatus === "soft_only" &&
          row.calibrationRowId === null &&
          row.calibrationLineageValid),
    );
    const valid =
      scalarReceiptHashes.size === 1 &&
      calibrationBatchIds.size === 1 &&
      anchoredDimensionHashes.size === 1 &&
      first.hydrationReceiptCount === 1 &&
      exactCalibrationReceipt &&
      exactProfileCalibrationParity &&
      accountRows.every((row) => row.canonicalEnvelopeValid) &&
      accountRows.every((row) => row.calibrationLineageValid) &&
      accountRows.every(
        (row) => row.accountTimezone !== null && row.accountCurrency !== null,
      ) &&
      first.hydrationAuthoritativeForPrune &&
      first.hydrationExpectedAdCount === accountRows.length &&
      first.hydrationHydratedAdCount === accountRows.length &&
      first.hydrationExpectedManifestHash === expectedManifestHash &&
      first.hydrationHydratedManifestHash === expectedManifestHash;
    return {
      businessId: first.businessId,
      businessName: first.businessName,
      providerAccountRefId: first.providerAccountRefId,
      providerAccountId: first.providerAccountId,
      anchoredAccountTimezone: first.accountTimezone,
      anchoredAccountCurrency: first.accountCurrency,
      calibrationBatchId: first.calibrationBatchId,
      calibrationBatchJobRunId: first.calibrationBatchJobRunId,
      calibrationReceiptCount: first.calibrationReceiptCount,
      hydrationReceiptCount: first.hydrationReceiptCount,
      calibrationBatchExpectedCellCount:
        first.calibrationBatchExpectedCellCount,
      calibrationBatchActualCellCount: first.calibrationBatchActualCellCount,
      calibrationReceiptExact: exactCalibrationReceipt,
      profileCalibrationExact: exactProfileCalibrationParity,
      canonicalEnvelopeExact: accountRows.every(
        (row) => row.canonicalEnvelopeValid,
      ),
      frozenRows: accountRows.length,
      receiptExpectedRows: first.hydrationExpectedAdCount,
      receiptHydratedRows: first.hydrationHydratedAdCount,
      recomputedManifestHash: expectedManifestHash,
      receiptExpectedManifestHash: first.hydrationExpectedManifestHash,
      receiptHydratedManifestHash: first.hydrationHydratedManifestHash,
      authoritativeForPrune: first.hydrationAuthoritativeForPrune,
      calibrationLineageValid: accountRows.every(
        (row) => row.calibrationLineageValid,
      ),
      valid,
    };
  });
  return {
    businesses: businesses.sort((left, right) =>
      left.businessId.localeCompare(right.businessId),
    ),
    accounts: accounts.sort(
      (left, right) =>
        left.businessId.localeCompare(right.businessId) ||
        left.providerAccountId.localeCompare(right.providerAccountId),
    ),
    contradictions:
      businesses.filter((proof) => !proof.valid).length +
      accounts.filter((proof) => !proof.valid).length,
  };
}

function sortedDimensionValues(
  values: ReadonlyArray<string | null>,
): Array<string | null> {
  return [...new Set(values)].sort((left, right) =>
    (left ?? "").localeCompare(right ?? ""),
  );
}

/**
 * Current provider_accounts values are mutable SCD0 observations. They are
 * reported separately from the immutable decision-wave and hydration anchor
 * so a later display/config rewrite cannot restate the frozen cohort.
 */
export function buildCurrentScd0DimensionDriftProof(
  rows: readonly BaselineRow[],
) {
  const accountGroups = new Map<string, BaselineRow[]>();
  for (const row of rows) {
    const grouped = accountGroups.get(accountKey(row)) ?? [];
    grouped.push(row);
    accountGroups.set(accountKey(row), grouped);
  }
  const accounts = [...accountGroups.values()]
    .map((accountRows) => {
      const first = accountRows[0]!;
      const anchoredTimezones = sortedDimensionValues(
        accountRows.map((row) => row.accountTimezone),
      );
      const anchoredCurrencies = sortedDimensionValues(
        accountRows.map((row) => row.accountCurrency),
      );
      const currentTimezones = sortedDimensionValues(
        accountRows.map((row) => row.currentAccountTimezone),
      );
      const currentCurrencies = sortedDimensionValues(
        accountRows.map((row) => row.currentAccountCurrency),
      );
      const timezoneDriftRows = accountRows.filter(
        (row) => row.accountTimezone !== row.currentAccountTimezone,
      ).length;
      const currencyDriftRows = accountRows.filter(
        (row) => row.accountCurrency !== row.currentAccountCurrency,
      ).length;
      const reasons = [
        anchoredTimezones.length !== 1
          ? "anchored_timezone_not_singular"
          : null,
        anchoredCurrencies.length !== 1
          ? "anchored_currency_not_singular"
          : null,
        currentTimezones.length !== 1 ? "current_timezone_not_singular" : null,
        currentCurrencies.length !== 1 ? "current_currency_not_singular" : null,
        timezoneDriftRows > 0 ? "timezone_changed_after_anchor" : null,
        currencyDriftRows > 0 ? "currency_changed_after_anchor" : null,
      ].filter((reason): reason is string => reason !== null);
      return {
        businessId: first.businessId,
        businessName: first.businessName,
        providerAccountRefId: first.providerAccountRefId,
        providerAccountId: first.providerAccountId,
        anchoredTimezones,
        anchoredCurrencies,
        currentTimezones,
        currentCurrencies,
        timezoneDriftRows,
        currencyDriftRows,
        driftRows: accountRows.filter(
          (row) =>
            row.accountTimezone !== row.currentAccountTimezone ||
            row.accountCurrency !== row.currentAccountCurrency,
        ).length,
        reasons,
        drifted: reasons.length > 0,
      };
    })
    .sort(
      (left, right) =>
        left.businessId.localeCompare(right.businessId) ||
        left.providerAccountId.localeCompare(right.providerAccountId),
    );
  return {
    observedAccounts: accounts.length,
    driftAccounts: accounts.filter((account) => account.drifted).length,
    driftRows: accounts.reduce((sum, account) => sum + account.driftRows, 0),
    accounts: accounts.filter((account) => account.drifted),
  };
}

function businessSelectorMatches(
  row: Pick<BaselineRow, "businessId" | "businessName">,
  selector: string,
) {
  return row.businessId === selector || row.businessName === selector;
}

export function buildRequestedScopeCoverage(input: {
  args: Pick<ParsedArgs, "businesses" | "providerAccounts">;
  rows: readonly BaselineRow[];
}) {
  const businessFilters = input.args.businesses.map((selector) => {
    const matchingBusinessIds = [
      ...new Set(
        input.rows
          .filter((row) => businessSelectorMatches(row, selector))
          .map((row) => row.businessId),
      ),
    ].sort();
    return {
      selector,
      matchingBusinessIds,
      valid: matchingBusinessIds.length === 1,
    };
  });
  const providerAccounts = input.args.providerAccounts.map((scope) => {
    const matchingAccountKeys = [
      ...new Set(
        input.rows
          .filter(
            (row) =>
              businessSelectorMatches(row, scope.businessSelector) &&
              row.providerAccountId === scope.providerAccountId,
          )
          .map(accountKey),
      ),
    ].sort();
    return {
      ...scope,
      matchingAccountKeys: matchingAccountKeys.map((key) =>
        canonicalSha256(key),
      ),
      valid: matchingAccountKeys.length === 1,
    };
  });
  const unexpectedProviderAccountRows =
    input.args.providerAccounts.length === 0
      ? 0
      : input.rows.filter(
          (row) =>
            !input.args.providerAccounts.some(
              (scope) =>
                businessSelectorMatches(row, scope.businessSelector) &&
                row.providerAccountId === scope.providerAccountId,
            ),
        ).length;
  return {
    businessFilters,
    providerAccounts,
    unexpectedProviderAccountRows,
    businessContradictions: businessFilters.filter((item) => !item.valid)
      .length,
    providerAccountContradictions:
      providerAccounts.filter((item) => !item.valid).length +
      unexpectedProviderAccountRows,
    contradictions:
      businessFilters.filter((item) => !item.valid).length +
      providerAccounts.filter((item) => !item.valid).length +
      unexpectedProviderAccountRows,
  };
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  const versioned = `${hex.slice(0, 12)}4${hex.slice(13, 16)}8${hex.slice(17)}`;
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20)}`;
}

function authorityProofContradictions(batch: NativeAdCalibrationBatch): number {
  const authority = batch.spendUnitAuthority;
  const evidence = authority.accountAovEvidence;
  let contradictions = 0;
  if (
    evidence.meanAov !== null &&
    !isAccountAovRevenueArithmeticConsistent({
      meanAov: evidence.meanAov,
      purchaseCount: evidence.observedPurchaseCount,
      totalRevenue: evidence.totalRevenue,
    })
  ) {
    contradictions += 1;
  }
  if (
    evidence.status === "ready" &&
    (evidence.observedPurchaseCount < evidence.requiredPurchaseCount ||
      evidence.meanAov === null ||
      evidence.totalRevenue <= 0)
  ) {
    contradictions += 1;
  }
  if (
    authority.basis === "physical_account_purchase_aov_90d" &&
    evidence.status !== "ready"
  ) {
    contradictions += 1;
  }
  if (authority.targetAuthorityHash !== batch.targetAuthority.authorityHash) {
    contradictions += 1;
  }
  return contradictions;
}

export function replayNativeProfileConfig(): DecisionCalibrationProfileConfig | null {
  return null;
}

async function prepareAccountSlice(
  client: Client,
  slice: AccountSlice,
  asOfDate: string,
): Promise<PreparedAccountSlice> {
  const sourceResult = await client.query<DbRow>(
    READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
    [
      slice.businessId,
      asOfDate,
      slice.providerAccountRefId,
      slice.providerAccountId,
      slice.calibrationCutoff,
    ],
  );
  const targetResult = await client.query<DbRow>(
    READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
    [
      slice.businessId,
      slice.providerAccountRefId,
      slice.providerAccountId,
      slice.calibrationCutoff,
    ],
  );
  const mappedSourceRows = sourceResult.rows.map(
    mapNativeAdCalibrationSourceRow,
  );
  const targetAuthority = targetResult.rows[0]
    ? mapNativeAdTargetAuthorityRow(targetResult.rows[0])
    : null;
  const batch = computeNativeAdCalibrationBatch({
    businessId: slice.businessId,
    providerAccountRefId: slice.providerAccountRefId,
    providerAccountId: slice.providerAccountId,
    asOf: asOfDate,
    computationCutoff: slice.calibrationCutoff,
    // Production owns dimension admission. Passing raw cutoff-bound rows here
    // prevents replay from silently maintaining a second timezone/currency
    // resolver that can drift from the scheduled job.
    sourceRows: mappedSourceRows,
    targetAuthority,
  });
  assertNativeAdCalibrationBatchContract(batch);
  const currencyAdmission = batch.sourceProvenance.currencyAdmission;
  const timezoneAdmission = batch.sourceProvenance.timezoneAdmission;
  if (
    currencyAdmission.contractVersion !==
      "engine-v3-native-ad-currency-admission.v1" ||
    currencyAdmission.status !== "ready" ||
    currencyAdmission.keyBasis !== "immutable_source" ||
    currencyAdmission.accountCurrency === null ||
    !/^[0-9a-f]{64}$/.test(currencyAdmission.manifestHash)
  ) {
    throw new Error(
      `${slice.sliceKey}: production currency admission is not immutable-source ready`,
    );
  }
  if (
    timezoneAdmission.contractVersion !==
      "engine-v3-native-ad-timezone-admission.v1" ||
    timezoneAdmission.status !== "ready" ||
    timezoneAdmission.keyBasis !== "immutable_latest_source_date" ||
    timezoneAdmission.accountTimezone === null ||
    timezoneAdmission.latestSourceDate === null ||
    !/^[0-9a-f]{64}$/.test(timezoneAdmission.manifestHash)
  ) {
    throw new Error(
      `${slice.sliceKey}: production timezone admission is not immutable-latest-source-date ready`,
    );
  }
  const sourceDimensions = {
    accountCurrency: currencyAdmission.accountCurrency,
    accountTimezone: timezoneAdmission.accountTimezone,
    sourceTimezoneSelectionDate: timezoneAdmission.latestSourceDate,
  };
  const batchId = deterministicUuid(
    `${CONTRACT_VERSION}\u0000${slice.sliceKey}`,
  );
  const cells = batch.cells.map((cell) => ({
    ...cell,
    batchId,
    batchCompleteness: "complete" as const,
  }));
  // WarehouseNativeAdAccountProfileDataSource deliberately does not implement
  // the optional profile-config reader. Production therefore passes null and
  // the retained resolver applies its canonical defaults. Deriving a config
  // from the rollback epoch's persisted account profile would be a restatement
  // and would not replay the challenger production adapter.
  const profileConfig = replayNativeProfileConfig();
  const first = slice.rows[0];
  if (!first) throw new Error(`${slice.sliceKey}: current-day slice is empty`);
  const persistedTimezoneSet = new Set(
    slice.rows.map((row) => row.accountTimezone),
  );
  const persistedCurrencySet = new Set(
    slice.rows.map((row) => row.accountCurrency),
  );
  const persistedBatchProofSet = new Set(
    slice.rows.map((row) =>
      canonicalSha256({
        batchId: row.calibrationBatchId,
        jobRunId: row.calibrationBatchJobRunId,
        expectedCellCount: row.calibrationBatchExpectedCellCount,
        actualCellCount: row.calibrationBatchActualCellCount,
        generationContentHash: row.calibrationBatchGenerationContentHash,
        inputManifestHash: row.calibrationBatchInputManifestHash,
        sourceManifestHash: row.calibrationBatchSourceManifestHash,
        cellSetHash: row.calibrationBatchCellSetHash,
      }),
    ),
  );
  let dimensionProofContradictions = 0;
  if (
    persistedTimezoneSet.size !== 1 ||
    persistedCurrencySet.size !== 1 ||
    first.accountTimezone === null ||
    first.accountCurrency === null
  ) {
    dimensionProofContradictions += 1;
  }
  if (
    cells.some(
      (cell) =>
        cell.key.accountTimezone !== sourceDimensions.accountTimezone ||
        cell.key.accountCurrency !== sourceDimensions.accountCurrency,
    )
  ) {
    dimensionProofContradictions += 1;
  }
  if (
    persistedBatchProofSet.size !== 1 ||
    first.calibrationBatchExpectedCellCount !==
      first.calibrationBatchActualCellCount
  ) {
    dimensionProofContradictions += 1;
  }
  return {
    ...slice,
    batch,
    cells,
    targetAuthority,
    profileConfig,
    rawSourceRowCount: sourceResult.rows.length,
    rawReceiptHash: canonicalSha256({
      sourceMode: AOV_SOURCE_MODE,
      businessId: slice.businessId,
      providerAccountRefId: slice.providerAccountRefId,
      providerAccountId: slice.providerAccountId,
      asOfDate,
      cutoff: slice.calibrationCutoff,
      sourceRowCount: sourceResult.rows.length,
      sourceManifestHash: batch.sourceManifestHash,
      currencyAdmissionManifestHash: currencyAdmission.manifestHash,
      timezoneAdmissionManifestHash: timezoneAdmission.manifestHash,
      accountAovEvidenceHash:
        batch.spendUnitAuthority.accountAovEvidence.evidenceHash,
      targetAuthorityHash: batch.targetAuthority.authorityHash,
    }),
    authorityProofContradictions: authorityProofContradictions(batch),
    dimensionProofContradictions,
    sourceDimensionProof: {
      sourceAccountCurrency: sourceDimensions.accountCurrency,
      sourceAccountTimezone: sourceDimensions.accountTimezone,
      sourceTimezoneSelectionDate:
        sourceDimensions.sourceTimezoneSelectionDate,
      anchoredAccountCurrency: first.accountCurrency,
      anchoredAccountTimezone: first.accountTimezone,
      currencyDriftedFromAnchor:
        first.accountCurrency !== sourceDimensions.accountCurrency,
      timezoneDriftedFromAnchor:
        first.accountTimezone !== sourceDimensions.accountTimezone,
      driftContradictions:
        Number(first.accountCurrency !== sourceDimensions.accountCurrency) +
        Number(first.accountTimezone !== sourceDimensions.accountTimezone),
    },
  };
}

export function assessReplayAnchorDimensions(input: {
  slice: PreparedAccountSlice;
  frozenAnchorProofValid: boolean;
}): ReplayAnchorDimensionAssessment {
  const { slice } = input;
  const contradictionCodes = new Set<string>();
  try {
    assertNativeAdCalibrationBatchContract(slice.batch);
  } catch {
    contradictionCodes.add("production_batch_contract_invalid");
  }
  const currencyAdmission =
    slice.batch.sourceProvenance.currencyAdmission;
  const timezoneAdmission =
    slice.batch.sourceProvenance.timezoneAdmission;
  if (
    slice.batch.businessId !== slice.businessId ||
    slice.batch.providerAccountRefId !== slice.providerAccountRefId ||
    slice.batch.providerAccountId !== slice.providerAccountId ||
    slice.batch.asOfCutoff !== slice.calibrationCutoff ||
    slice.rows.some(
      (row) =>
        row.businessId !== slice.businessId ||
        row.providerAccountRefId !== slice.providerAccountRefId ||
        row.providerAccountId !== slice.providerAccountId ||
        row.calibrationCutoff !== slice.calibrationCutoff ||
        row.asOfDate !== slice.batch.asOfDate,
    )
  ) {
    contradictionCodes.add("slice_batch_identity_mismatch");
  }
  if (
    currencyAdmission.status !== "ready" ||
    currencyAdmission.keyBasis !== "immutable_source" ||
    currencyAdmission.accountCurrency === null ||
    timezoneAdmission.status !== "ready" ||
    timezoneAdmission.keyBasis !==
      "immutable_latest_source_date" ||
    timezoneAdmission.accountTimezone === null ||
    timezoneAdmission.latestSourceDate === null
  ) {
    contradictionCodes.add("immutable_source_admission_not_ready");
  }
  if (
    slice.sourceDimensionProof.sourceAccountCurrency !==
      currencyAdmission.accountCurrency ||
    slice.sourceDimensionProof.sourceAccountTimezone !==
      timezoneAdmission.accountTimezone ||
    slice.sourceDimensionProof.sourceTimezoneSelectionDate !==
      timezoneAdmission.latestSourceDate
  ) {
    contradictionCodes.add("source_dimension_receipt_mismatch");
  }
  const anchoredCurrencies = [
    ...new Set(slice.rows.map((row) => row.accountCurrency)),
  ];
  const anchoredTimezones = [
    ...new Set(slice.rows.map((row) => row.accountTimezone)),
  ];
  const anchoredCurrency =
    anchoredCurrencies.length === 1 ? anchoredCurrencies[0] : null;
  const anchoredTimezone =
    anchoredTimezones.length === 1 ? anchoredTimezones[0] : null;
  if (
    slice.rows.length === 0 ||
    anchoredCurrency === null ||
    anchoredTimezone === null ||
    slice.sourceDimensionProof.anchoredAccountCurrency !==
      anchoredCurrency ||
    slice.sourceDimensionProof.anchoredAccountTimezone !==
      anchoredTimezone ||
    slice.accountCurrency !== anchoredCurrency ||
    slice.accountTimezone !== anchoredTimezone
  ) {
    contradictionCodes.add("persisted_anchor_not_singular_exact");
  }
  const currencyDrift =
    anchoredCurrency !== null &&
    currencyAdmission.accountCurrency !== null &&
    anchoredCurrency !== currencyAdmission.accountCurrency;
  const timezoneDrift =
    anchoredTimezone !== null &&
    timezoneAdmission.accountTimezone !== null &&
    anchoredTimezone !== timezoneAdmission.accountTimezone;
  const observedDriftDimensions =
    Number(currencyDrift) + Number(timezoneDrift);
  if (
    slice.sourceDimensionProof.currencyDriftedFromAnchor !==
      currencyDrift ||
    slice.sourceDimensionProof.timezoneDriftedFromAnchor !==
      timezoneDrift ||
    slice.sourceDimensionProof.driftContradictions !==
      observedDriftDimensions
  ) {
    contradictionCodes.add("declared_anchor_drift_mismatch");
  }
  if (
    slice.cells.length !== slice.batch.expectedCellCount ||
    computeNativeAdCalibrationCellSetHash(slice.cells) !==
      slice.batch.cellSetHash ||
    slice.cells.some(
      (cell) =>
        cell.key.businessId !== slice.businessId ||
        cell.key.providerAccountRefId !== slice.providerAccountRefId ||
        cell.key.providerAccountId !== slice.providerAccountId ||
        cell.key.accountCurrency !==
          currencyAdmission.accountCurrency ||
        cell.key.accountTimezone !==
          timezoneAdmission.accountTimezone ||
        cell.asOfCutoff !== slice.calibrationCutoff ||
        cell.batchInputManifestHash !==
          slice.batch.inputManifestHash ||
        cell.sourceManifestHash !== slice.batch.sourceManifestHash ||
        cell.batchCellCount !== slice.batch.expectedCellCount ||
        cell.batchCellSetHash !== slice.batch.cellSetHash ||
        recomputeNativeAdCalibrationCellInputManifestHash(cell) !==
          cell.inputManifestHash,
    )
  ) {
    contradictionCodes.add("replay_cell_generation_mismatch");
  }
  if (
    slice.dimensionProofContradictions !== 0 ||
    !input.frozenAnchorProofValid
  ) {
    contradictionCodes.add("frozen_anchor_proof_invalid");
  }
  const sortedContradictions = [...contradictionCodes].sort();
  const status: ReplayAnchorDimensionAssessmentStatus =
    sortedContradictions.length > 0
      ? "unresolved_contradiction"
      : observedDriftDimensions > 0
        ? "authenticated_source_repair"
        : "exact";
  const proofMaterial = {
    contractVersion:
      "native-ad-replay-anchor-dimension-assessment.v1" as const,
    sliceKeyHash: canonicalSha256(slice.sliceKey),
    batchIdentity: {
      businessId: slice.batch.businessId,
      providerAccountRefId: slice.batch.providerAccountRefId,
      providerAccountId: slice.batch.providerAccountId,
      asOfDate: slice.batch.asOfDate,
      asOfCutoff: slice.batch.asOfCutoff,
      inputManifestHash: slice.batch.inputManifestHash,
      sourceManifestHash: slice.batch.sourceManifestHash,
      cellSetHash: slice.batch.cellSetHash,
    },
    sourceDimensionProof: slice.sourceDimensionProof,
    currencyAdmission,
    timezoneAdmission,
    anchoredCurrency,
    anchoredTimezone,
    observedDriftDimensions,
    frozenAnchorProofValid: input.frozenAnchorProofValid,
    contradictionCodes: sortedContradictions,
    status,
  };
  return {
    contractVersion: proofMaterial.contractVersion,
    status,
    observedDriftDimensions,
    authenticatedRepairDimensions:
      status === "authenticated_source_repair"
        ? observedDriftDimensions
        : 0,
    contradictionCodes: sortedContradictions,
    unresolvedContradictions: sortedContradictions.length,
    proofHash: canonicalSha256(proofMaterial),
  };
}

function campaignContextMapFromProvenance(
  context: CampaignContextProvenance,
): CampaignContextLabelMap {
  const campaignId = context.campaignId;
  if (
    !campaignId ||
    (context.source === "unknown" && context.mode !== "automatic")
  ) {
    return new Map();
  }
  return new Map([
    [
      campaignId,
      {
        kind: context.kind,
        testDimension: context.testDimension,
        contextTrust:
          context.source === "unknown" &&
          context.mode === "automatic"
            ? "unknown"
            : (context.contextTrust ?? undefined),
        provenance: context,
      },
    ],
  ]);
}

function campaignContextMap(row: BaselineRow): CampaignContextLabelMap {
  return campaignContextMapFromProvenance(row.campaignContext);
}

export function priorHysteresisMap(row: BaselineRow): {
  map: Map<string, PreviousAdPublishedLabel>;
  replayable: boolean;
  status:
    "none" | "current_epoch_replayed" | "epoch_mismatch" | "incomplete_lineage";
  sourceEngineVersion: string | null;
  rawLabel: DecisionLabel | null;
  publishedLabel: DecisionLabel | null;
} {
  const prior = row.priorHysteresis;
  if (prior.source === "none") {
    return {
      map: new Map(),
      replayable: true,
      status: "none",
      sourceEngineVersion: null,
      rawLabel: null,
      publishedLabel: null,
    };
  }
  const publishedLabel = optionalText(prior.publishedLabel);
  const rawLabel = optionalText(prior.rawLabel);
  const sourceEngineVersion = optionalText(prior.sourceEngineVersion);
  // Production readPreviousPublishedAdLabels is pinned to
  // NATIVE_AD_ENGINE_VERSION. A rollback-epoch prior is therefore absent on
  // the challenger's first epoch day; carrying it across would falsely turn a
  // D036 pending Cut into a confirmed/authorized Cut.
  if (
    sourceEngineVersion !== null &&
    sourceEngineVersion !== NATIVE_AD_ENGINE_VERSION
  ) {
    return {
      map: new Map(),
      replayable: false,
      status: "epoch_mismatch",
      sourceEngineVersion,
      rawLabel: null,
      publishedLabel: null,
    };
  }
  const sourceIdentityMatches =
    prior.source === "persisted_evaluation" &&
    optionalText(prior.sourceBusinessId) === row.businessId &&
    optionalText(prior.sourceProviderAccountId) === row.providerAccountId &&
    prior.sourceDecisionEntityType === "ad" &&
    optionalText(prior.sourceDecisionEntityId) ===
      row.creativeInput.decisionEntityId &&
    optionalText(prior.sourceDecisionEntityId) === row.creativeInput.adId &&
    row.scopeType === "account" &&
    row.scopeId === row.providerAccountId &&
    row.priorHysteresisLineageValid === true;
  const required = {
    sourceSnapshotId: optionalText(prior.sourceSnapshotId),
    sourceEvaluationId: optionalText(prior.sourceEvaluationId),
    sourceEngineVersion,
    sourceAsOfDate: optionalText(prior.sourceAsOfDate),
    sourceInputHash: optionalText(prior.sourceInputHash),
    sourceDecisionHash: optionalText(prior.sourceDecisionHash),
    sourceComputedAt: row.priorHysteresisSourceComputedAt,
  };
  const sourceComputedAtMs = Date.parse(required.sourceComputedAt ?? "");
  const evaluatedAtMs = Date.parse(row.evaluatedAt);
  if (
    !sourceIdentityMatches ||
    !publishedLabel ||
    !rawLabel ||
    !Object.values(required).every((value) => value !== null) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      required.sourceSnapshotId ?? "",
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      required.sourceEvaluationId ?? "",
    ) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(required.sourceAsOfDate ?? "") ||
    (required.sourceAsOfDate ?? "") >= row.asOfDate ||
    !Number.isFinite(sourceComputedAtMs) ||
    !Number.isFinite(evaluatedAtMs) ||
    sourceComputedAtMs >= evaluatedAtMs ||
    !/^[0-9a-f]{64}$/.test(required.sourceInputHash ?? "") ||
    !/^[0-9a-f]{64}$/.test(required.sourceDecisionHash ?? "")
  ) {
    return {
      map: new Map(),
      replayable: false,
      status: "incomplete_lineage",
      sourceEngineVersion,
      rawLabel: null,
      publishedLabel: null,
    };
  }
  const value: PreviousAdPublishedLabel = {
    businessId: row.businessId,
    providerAccountRefId: row.providerAccountRefId,
    providerAccountId: row.providerAccountId,
    decisionEntityType: "ad",
    decisionEntityId: row.creativeInput.adId,
    sourceSnapshotId: required.sourceSnapshotId!,
    sourceEvaluationId: required.sourceEvaluationId!,
    sourceEngineVersion: required.sourceEngineVersion!,
    sourceAsOfDate: required.sourceAsOfDate!,
    sourceComputedAt: required.sourceComputedAt!,
    sourceInputHash: required.sourceInputHash!,
    sourceDecisionHash: required.sourceDecisionHash!,
    publishedLabel: label(publishedLabel, "prior publishedLabel"),
    rawLabel: label(rawLabel, "prior rawLabel"),
  };
  return {
    replayable: true,
    status: "current_epoch_replayed",
    sourceEngineVersion,
    rawLabel: value.rawLabel,
    publishedLabel: value.publishedLabel,
    map: new Map([
      [
        adDecisionStabilityKey({
          businessId: row.businessId,
          providerAccountRefId: row.providerAccountRefId,
          providerAccountId: row.providerAccountId,
          decisionEntityType: "ad",
          decisionEntityId: row.creativeInput.adId,
          scopeType: "account",
          scopeId: row.scopeId,
        }),
        value,
      ],
    ]),
  };
}

function replayInputManifestHash(
  row: BaselineRow,
  slice: PreparedAccountSlice,
  prior: ReturnType<typeof priorHysteresisMap>,
  challengerDataHealth: DataHealth | null = null,
  challengerProfile:
    AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile | null = null,
) {
  const manifestContent = {
    contractVersion: CONTRACT_VERSION,
    cohortKey: row.cohortKey,
    cohortSource: {
      mode: PERSISTED_INPUT_SOURCE_MODE,
      snapshotId: row.snapshotId,
      evaluationId: row.evaluationId,
      contextId: row.contextId,
      baselineEngineVersion: row.engineVersion,
      inputHash: row.inputHash,
      decisionHash: row.decisionHash,
      contextHash: row.contextHash,
      persistedScaleRefreshProfileHash: scaleRefreshProfileHash(
        row.accountProfile,
      ),
      challengerScaleRefreshProfileHash:
        challengerProfile === null
          ? null
          : scaleRefreshProfileHash(challengerProfile),
      persistedDataHealthHash: canonicalSha256(row.dataHealth),
      challengerDataHealthHash:
        challengerDataHealth === null
          ? null
          : canonicalSha256(challengerDataHealth),
      campaignContext: row.campaignContext,
      priorHysteresis: row.priorHysteresis,
      challengerPriorHysteresis: {
        requiredEngineVersion: NATIVE_AD_ENGINE_VERSION,
        status: prior.status,
        sourceEngineVersion: prior.sourceEngineVersion,
      },
    },
    aovSource: {
      mode: AOV_SOURCE_MODE,
      cutoff: slice.calibrationCutoff,
      cutoffSource: slice.cutoffSource,
      batchInputManifestHash: slice.batch.inputManifestHash,
      sourceManifestHash: slice.batch.sourceManifestHash,
      accountAovEvidenceHash:
        slice.batch.spendUnitAuthority.accountAovEvidence.evidenceHash,
      targetAuthorityHash: slice.batch.targetAuthority.authorityHash,
    },
  };
  return canonicalSha256(manifestContent);
}

export function scaleRefreshProfileProjection(
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile,
) {
  const scope = {
    ...profile.scope,
    fallbackReason: profile.scope.fallbackReason ?? null,
  };
  const hardActionEligibility = {
    scale: profile.hardActionEligibility.scale,
    refresh: profile.hardActionEligibility.refresh,
    scaleReason:
      profile.hardActionEligibility.reasons?.scale ??
      (profile.hardActionEligibility.scale
        ? null
        : profile.hardActionEligibility.reason),
    refreshReason:
      profile.hardActionEligibility.reasons?.refresh ??
      (profile.hardActionEligibility.refresh
        ? null
        : profile.hardActionEligibility.reason),
  };
  if ("profileType" in profile) {
    return { ...profile, scope, hardActionEligibility };
  }
  const {
    commercialStopLossCanonicalHardActionEligibility:
      _commercialStopLossCanonicalHardActionEligibility,
    expandedEconomicCutAuthority: _expandedEconomicCutAuthority,
    commercialStopLossSpendUnit: _commercialStopLossSpendUnit,
    commercialStopLossThresholds: _commercialStopLossThresholds,
    hardActionEligibility: _hardActionEligibility,
    ...nonCutProfile
  } = profile;
  return { ...nonCutProfile, scope, hardActionEligibility };
}

export function scaleRefreshProfileHash(
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile,
) {
  return canonicalSha256(scaleRefreshProfileProjection(profile));
}

function replayLeafDiffPaths(
  baseline: unknown,
  challenger: unknown,
  path = "",
): string[] {
  if (baseline === undefined || challenger === undefined) {
    return baseline === challenger ? [] : [path || "$"];
  }
  if (canonicalSha256(baseline) === canonicalSha256(challenger)) return [];
  if (
    baseline === null ||
    challenger === null ||
    typeof baseline !== "object" ||
    typeof challenger !== "object" ||
    Array.isArray(baseline) ||
    Array.isArray(challenger)
  ) {
    return [path || "$"];
  }
  const baselineRecord = baseline as Record<string, unknown>;
  const challengerRecord = challenger as Record<string, unknown>;
  const keys = [...new Set([
    ...Object.keys(baselineRecord),
    ...Object.keys(challengerRecord),
  ])].sort();
  return keys.flatMap((key) =>
    replayLeafDiffPaths(
      baselineRecord[key],
      challengerRecord[key],
      path ? `${path}.${key}` : key,
    ),
  );
}

function canonicalReplayArtifactValue<T>(value: T): T {
  return JSON.parse(stableCanonicalJson(value)) as T;
}

function replayCalibrationContextMaterial(input: {
  persistedProfile:
    | AccountDecisionProfile
    | NativeAdSoftOnlyDecisionProfile;
  challengerProfile:
    | AccountDecisionProfile
    | NativeAdSoftOnlyDecisionProfile;
  persistedDataHealth: DataHealth;
  challengerDataHealth: DataHealth;
  persistedCampaignContext: CampaignContextProvenance;
  challengerCampaignContext: CampaignContextProvenance;
  profileDiffPaths: string[];
  dataHealthDiffPaths: string[];
  inputDiffPaths: string[];
}) {
  return {
    persistedProfile: input.persistedProfile,
    challengerProfile: input.challengerProfile,
    persistedDataHealth: input.persistedDataHealth,
    challengerDataHealth: input.challengerDataHealth,
    persistedCampaignContext: input.persistedCampaignContext,
    challengerCampaignContext: input.challengerCampaignContext,
    profileDiffPaths: input.profileDiffPaths,
    dataHealthDiffPaths: input.dataHealthDiffPaths,
    inputDiffPaths: input.inputDiffPaths,
  };
}

function replayCalibrationProofHashMaterial(
  proof: Omit<ReplayCalibrationContextProof, "proofHash">,
) {
  return {
    contractVersion: proof.contractVersion,
    cohortKey: proof.cohortKey,
    accountKey: proof.accountKey,
    inputManifestHash: proof.inputManifestHash,
    persistedInput: proof.persistedInput,
    challengerInput: proof.challengerInput,
    inputDiffPaths: proof.inputDiffPaths,
    persistedProjection: proof.persistedProjection,
    challengerProjection: proof.challengerProjection,
    contextMaterialHash: proof.contextMaterialHash,
  };
}

export function buildReplayCalibrationContextProof(input: {
  cohortKey: string;
  accountKey: string;
  inputManifestHash: string;
  persistedInput: AdDecisionInput;
  challengerInput: AdDecisionInput;
  persistedProjection: ReplayDecisionProjection;
  challengerProjection: ReplayDecisionProjection;
  persistedProfile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  challengerProfile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  persistedDataHealth: DataHealth;
  challengerDataHealth: DataHealth;
  persistedCampaignContext: CampaignContextProvenance;
  challengerCampaignContext: CampaignContextProvenance;
}): ReplayCalibrationContextProof {
  const canonicalInput = canonicalReplayArtifactValue(input);
  const profileDiffPaths = replayLeafDiffPaths(
    scaleRefreshProfileProjection(canonicalInput.persistedProfile),
    scaleRefreshProfileProjection(canonicalInput.challengerProfile),
  );
  const dataHealthDiffPaths = replayLeafDiffPaths(
    canonicalInput.persistedDataHealth,
    canonicalInput.challengerDataHealth,
  );
  const inputDiffPaths = replayLeafDiffPaths(
    canonicalInput.persistedInput,
    canonicalInput.challengerInput,
  );
  const contextMaterial = replayCalibrationContextMaterial({
    persistedProfile: canonicalInput.persistedProfile,
    challengerProfile: canonicalInput.challengerProfile,
    persistedDataHealth: canonicalInput.persistedDataHealth,
    challengerDataHealth: canonicalInput.challengerDataHealth,
    persistedCampaignContext: canonicalInput.persistedCampaignContext,
    challengerCampaignContext: canonicalInput.challengerCampaignContext,
    profileDiffPaths,
    dataHealthDiffPaths,
    inputDiffPaths,
  });
  const contextMaterialHash = canonicalSha256(contextMaterial);
  const proofWithoutHash: Omit<
    ReplayCalibrationContextProof,
    "proofHash"
  > = {
    contractVersion: REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION,
    ...canonicalInput,
    inputDiffPaths,
    profileDiffPaths,
    dataHealthDiffPaths,
    contextMaterialHash,
  };
  return {
    ...proofWithoutHash,
    proofHash: canonicalSha256(
      replayCalibrationProofHashMaterial(proofWithoutHash),
    ),
  };
}

export interface ReplayCalibrationContextMaterialRecord {
  contextMaterialHash: string;
  persistedProfile:
    | AccountDecisionProfile
    | NativeAdSoftOnlyDecisionProfile;
  challengerProfile:
    | AccountDecisionProfile
    | NativeAdSoftOnlyDecisionProfile;
  persistedDataHealth: DataHealth;
  challengerDataHealth: DataHealth;
  persistedCampaignContext: CampaignContextProvenance;
  challengerCampaignContext: CampaignContextProvenance;
  profileDiffPaths: string[];
  dataHealthDiffPaths: string[];
  inputDiffPaths: string[];
  persistedScaleRefreshProfileHash: string;
  challengerScaleRefreshProfileHash: string;
  persistedDataHealthHash: string;
  challengerDataHealthHash: string;
}

export interface ReplayCalibrationContextProofAssociation {
  cohortKey: string;
  cohortKeyHash: string;
  accountKey: string;
  accountKeyHash: string;
  inputManifestHash: string;
  persistedInput: AdDecisionInput;
  challengerInput: AdDecisionInput;
  persistedProjection: ReplayDecisionProjection;
  challengerProjection: ReplayDecisionProjection;
  contextMaterialHash: string;
  proofHash: string;
}

export interface ReplayCalibrationContextProofSet {
  contractVersion:
    typeof REPLAY_CALIBRATION_CONTEXT_PROOF_SET_CONTRACT_VERSION;
  proofContractVersion:
    typeof REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION;
  contextCount: number;
  associationCount: number;
  contexts: ReplayCalibrationContextMaterialRecord[];
  associations: ReplayCalibrationContextProofAssociation[];
  proofSetHash: string;
}

function replayCalibrationProofSetHashMaterial(
  set: Omit<ReplayCalibrationContextProofSet, "proofSetHash">,
) {
  return {
    contractVersion: set.contractVersion,
    proofContractVersion: set.proofContractVersion,
    contextCount: set.contextCount,
    associationCount: set.associationCount,
    contexts: set.contexts,
    associations: set.associations,
  };
}

function computedChallengerProjection(
  row: ChallengerRow,
): ReplayDecisionProjection {
  if (
    row.status !== "computed" ||
    row.preAuthorityLabel === null ||
    row.rawLabel === null ||
    row.publishedLabel === null ||
    row.hysteresisSuppressed === null ||
    row.confidence === null ||
    row.reason === null ||
    row.badges === null
  ) {
    throw new Error(
      `${row.cohortKey}: computed challenger projection is incomplete`,
    );
  }
  return {
    preAuthorityLabel: row.preAuthorityLabel,
    authorityBlocker: row.authorityBlocker,
    rawLabel: row.rawLabel,
    publishedLabel: row.publishedLabel,
    blockedActionType: row.blockedActionType,
    authorizedAction: row.simulatedAuthorizedAction,
    hysteresisSuppressed: row.hysteresisSuppressed,
    confidence: row.confidence,
    reason: row.reason,
    badges: row.badges,
  };
}

export function assertReplayCalibrationContextProofSet(
  set: ReplayCalibrationContextProofSet,
) {
  const failures: string[] = [];
  if (
    set.contractVersion !==
      REPLAY_CALIBRATION_CONTEXT_PROOF_SET_CONTRACT_VERSION ||
    set.proofContractVersion !==
      REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION
  ) {
    failures.push("contract_version");
  }
  if (
    !Number.isSafeInteger(set.contextCount) ||
    set.contextCount < 0 ||
    !Number.isSafeInteger(set.associationCount) ||
    set.associationCount < 0 ||
    set.contextCount !== set.contexts.length ||
    set.associationCount !== set.associations.length
  ) {
    failures.push("cardinality");
  }
  const contextByHash = new Map<
    string,
    ReplayCalibrationContextMaterialRecord
  >();
  for (const context of set.contexts) {
    if (contextByHash.has(context.contextMaterialHash)) {
      failures.push("duplicate_context");
      continue;
    }
    contextByHash.set(context.contextMaterialHash, context);
    const material = replayCalibrationContextMaterial(context);
    if (
      canonicalSha256(material) !== context.contextMaterialHash ||
      scaleRefreshProfileHash(context.persistedProfile) !==
        context.persistedScaleRefreshProfileHash ||
      scaleRefreshProfileHash(context.challengerProfile) !==
        context.challengerScaleRefreshProfileHash ||
      canonicalSha256(context.persistedDataHealth) !==
        context.persistedDataHealthHash ||
      canonicalSha256(context.challengerDataHealth) !==
        context.challengerDataHealthHash
    ) {
      failures.push("context_material");
    }
  }
  const associationKeys = new Set<string>();
  for (const association of set.associations) {
    const associationKey = `${association.cohortKey}\u0000${association.proofHash}`;
    if (associationKeys.has(associationKey)) {
      failures.push("duplicate_association");
      continue;
    }
    associationKeys.add(associationKey);
    const context = contextByHash.get(
      association.contextMaterialHash,
    );
    if (
      context === undefined ||
      association.cohortKeyHash !==
        canonicalSha256(association.cohortKey) ||
      association.accountKeyHash !==
        canonicalSha256(association.accountKey)
    ) {
      failures.push("association_identity");
      continue;
    }
    const rebuilt = buildReplayCalibrationContextProof({
      cohortKey: association.cohortKey,
      accountKey: association.accountKey,
      inputManifestHash: association.inputManifestHash,
      persistedInput: association.persistedInput,
      challengerInput: association.challengerInput,
      persistedProjection: association.persistedProjection,
      challengerProjection: association.challengerProjection,
      persistedProfile: context.persistedProfile,
      challengerProfile: context.challengerProfile,
      persistedDataHealth: context.persistedDataHealth,
      challengerDataHealth: context.challengerDataHealth,
      persistedCampaignContext: context.persistedCampaignContext,
      challengerCampaignContext: context.challengerCampaignContext,
    });
    if (
      rebuilt.contextMaterialHash !==
        association.contextMaterialHash ||
      rebuilt.proofHash !== association.proofHash ||
      canonicalSha256(rebuilt.profileDiffPaths) !==
        canonicalSha256(context.profileDiffPaths) ||
      canonicalSha256(rebuilt.dataHealthDiffPaths) !==
        canonicalSha256(context.dataHealthDiffPaths) ||
      canonicalSha256(rebuilt.inputDiffPaths) !==
        canonicalSha256(context.inputDiffPaths)
    ) {
      failures.push("association_proof");
    }
  }
  const setWithoutHash = {
    contractVersion: set.contractVersion,
    proofContractVersion: set.proofContractVersion,
    contextCount: set.contextCount,
    associationCount: set.associationCount,
    contexts: set.contexts,
    associations: set.associations,
  };
  if (
    !/^[0-9a-f]{64}$/.test(set.proofSetHash) ||
    canonicalSha256(
      replayCalibrationProofSetHashMaterial(setWithoutHash),
    ) !== set.proofSetHash
  ) {
    failures.push("proof_set_hash");
  }
  if (failures.length > 0) {
    throw new Error(
      `Replay calibration context proof set is invalid: ${[
        ...new Set(failures),
      ]
        .sort()
        .join(",")}`,
    );
  }
}

export function buildReplayCalibrationContextProofSet(
  pairedRows: ReadonlyArray<{
    baseline: BaselineRow;
    challenger: ChallengerRow | null;
  }>,
): ReplayCalibrationContextProofSet {
  const contextByHash = new Map<
    string,
    ReplayCalibrationContextMaterialRecord
  >();
  const associations: ReplayCalibrationContextProofAssociation[] = [];
  const cohortKeys = new Set<string>();
  for (const { baseline, challenger } of pairedRows) {
    if (challenger === null || challenger.status === "failed") {
      if (challenger?.calibrationContextProof != null) {
        throw new Error(
          `${baseline.cohortKey}: failed challenger cannot carry calibration proof`,
        );
      }
      continue;
    }
    if (
      cohortKeys.has(baseline.cohortKey) ||
      challenger.cohortKey !== baseline.cohortKey ||
      challenger.accountKey !== accountKey(baseline) ||
      challenger.calibrationContextProof === null
    ) {
      throw new Error(
        `${baseline.cohortKey}: computed challenger proof identity is incomplete`,
      );
    }
    cohortKeys.add(baseline.cohortKey);
    const proof = challenger.calibrationContextProof;
    const rebuilt = buildReplayCalibrationContextProof({
      cohortKey: proof.cohortKey,
      accountKey: proof.accountKey,
      inputManifestHash: proof.inputManifestHash,
      persistedInput: proof.persistedInput,
      challengerInput: proof.challengerInput,
      persistedProjection: proof.persistedProjection,
      challengerProjection: proof.challengerProjection,
      persistedProfile: proof.persistedProfile,
      challengerProfile: proof.challengerProfile,
      persistedDataHealth: proof.persistedDataHealth,
      challengerDataHealth: proof.challengerDataHealth,
      persistedCampaignContext: proof.persistedCampaignContext,
      challengerCampaignContext: proof.challengerCampaignContext,
    });
    const challengerProjection =
      computedChallengerProjection(challenger);
    if (
      canonicalSha256(rebuilt) !== canonicalSha256(proof) ||
      proof.inputManifestHash !== challenger.inputManifestHash ||
      canonicalSha256(proof.persistedInput) !==
        canonicalSha256(baseline.creativeInput) ||
      canonicalSha256(proof.persistedProjection) !==
        canonicalSha256(baseline.baseline) ||
      canonicalSha256(proof.challengerProjection) !==
        canonicalSha256(challengerProjection) ||
      canonicalSha256(proof.persistedCampaignContext) !==
        canonicalSha256(baseline.campaignContext) ||
      scaleRefreshProfileHash(proof.persistedProfile) !==
        challenger.persistedScaleRefreshProfileHash ||
      scaleRefreshProfileHash(proof.challengerProfile) !==
        challenger.challengerScaleRefreshProfileHash ||
      canonicalSha256(proof.persistedDataHealth) !==
        challenger.persistedDataHealthHash ||
      canonicalSha256(proof.challengerDataHealth) !==
        challenger.challengerDataHealthHash
    ) {
      throw new Error(
        `${baseline.cohortKey}: computed challenger proof contradicts its replay row`,
      );
    }
    const context = canonicalReplayArtifactValue({
      contextMaterialHash: proof.contextMaterialHash,
      ...replayCalibrationContextMaterial(proof),
      persistedScaleRefreshProfileHash:
        challenger.persistedScaleRefreshProfileHash,
      challengerScaleRefreshProfileHash:
        challenger.challengerScaleRefreshProfileHash,
      persistedDataHealthHash: challenger.persistedDataHealthHash,
      challengerDataHealthHash: challenger.challengerDataHealthHash,
    });
    const existing = contextByHash.get(context.contextMaterialHash);
    if (
      existing !== undefined &&
      canonicalSha256(existing) !== canonicalSha256(context)
    ) {
      throw new Error(
        `${baseline.cohortKey}: calibration context hash collision`,
      );
    }
    contextByHash.set(context.contextMaterialHash, context);
    associations.push(
      canonicalReplayArtifactValue({
        cohortKey: proof.cohortKey,
        cohortKeyHash: canonicalSha256(proof.cohortKey),
        accountKey: proof.accountKey,
        accountKeyHash: canonicalSha256(proof.accountKey),
        inputManifestHash: proof.inputManifestHash,
        persistedInput: proof.persistedInput,
        challengerInput: proof.challengerInput,
        persistedProjection: proof.persistedProjection,
        challengerProjection: proof.challengerProjection,
        contextMaterialHash: proof.contextMaterialHash,
        proofHash: proof.proofHash,
      }),
    );
  }
  const contexts = [...contextByHash.values()].sort((left, right) =>
    left.contextMaterialHash.localeCompare(right.contextMaterialHash),
  );
  associations.sort(
    (left, right) =>
      left.cohortKey.localeCompare(right.cohortKey) ||
      left.accountKey.localeCompare(right.accountKey) ||
      left.proofHash.localeCompare(right.proofHash),
  );
  const setWithoutHash = {
    contractVersion:
      REPLAY_CALIBRATION_CONTEXT_PROOF_SET_CONTRACT_VERSION,
    proofContractVersion:
      REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION,
    contextCount: contexts.length,
    associationCount: associations.length,
    contexts,
    associations,
  };
  const set: ReplayCalibrationContextProofSet = {
    ...setWithoutHash,
    proofSetHash: canonicalSha256(
      replayCalibrationProofSetHashMaterial(setWithoutHash),
    ),
  };
  assertReplayCalibrationContextProofSet(set);
  return set;
}

function mediaBuyerBoundaryValues(
  thresholds: AccountDecisionProfile["thresholds"],
): MediaBuyerProfileBoundaryValues {
  return {
    bottomQuartileRatio: thresholds.bottomQuartileRatio,
    commercialMaturitySpend: thresholds.commercialMaturitySpend,
    hardCutSpend: thresholds.hardCutSpend,
    recentSampleMinSpend: thresholds.recentSampleMinSpend,
  };
}

/** Exact projection only; this helper never resolves or recomputes a boundary. */
export function mediaBuyerProfileBoundaryProjection(
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile,
): MediaBuyerProfileBoundaryProjection {
  if ("profileType" in profile) {
    return {
      profileKind: "native_ad_soft_only",
      boundarySemantics:
        "canonical_ratio_boundary; commercial_stop-loss overlay is Cut spend-depth only",
      canonical: null,
      commercialStopLossOverlay: null,
    };
  }
  const commercialStopLossThresholds =
    profile.commercialStopLossThresholds ?? null;
  return {
    profileKind: "account_decision_profile",
    boundarySemantics:
      "canonical_ratio_boundary; commercial_stop-loss overlay is Cut spend-depth only",
    canonical: mediaBuyerBoundaryValues(profile.thresholds),
    commercialStopLossOverlay:
      commercialStopLossThresholds === null
        ? null
        : mediaBuyerBoundaryValues(commercialStopLossThresholds),
  };
}

/** Exact persisted-input projection only; no metric is derived here. */
export function mediaBuyerExactInputMetrics(input: AdDecisionInput) {
  return {
    spend: input.spend,
    purchases: input.purchases,
    purchaseValue: input.purchaseValue ?? null,
    roas: input.roas ?? null,
    recent7dSpend: input.recent7dSpend ?? null,
    recent7dPurchases: input.recent7dPurchases ?? null,
    recent7dRoas: input.recent7dRoas ?? null,
    ageDays: input.ageDays ?? null,
    effectiveStatus: input.effectiveStatus ?? null,
    dataFreshnessHours: input.dataFreshnessHours ?? null,
  };
}

function boundedReplayError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1_000 ? message : `${message.slice(0, 997)}...`;
}

function failedChallengerRow(input: {
  row: BaselineRow;
  slice: PreparedAccountSlice | AccountSlice;
  error: unknown;
  prior?: ReturnType<typeof priorHysteresisMap>;
  inputManifestHash?: string;
}): ChallengerRow {
  let prior = input.prior;
  if (!prior) {
    try {
      prior = priorHysteresisMap(input.row);
    } catch {
      prior = {
        map: new Map(),
        replayable: false,
        status: "incomplete_lineage" as const,
        sourceEngineVersion: optionalText(
          input.row.priorHysteresis.sourceEngineVersion,
        ),
        rawLabel: null,
        publishedLabel: null,
      };
    }
  }
  let inputManifestHash = input.inputManifestHash;
  if (!inputManifestHash) {
    try {
      if (!("batch" in input.slice)) {
        throw new Error("calibration slice preparation failed");
      }
      inputManifestHash = replayInputManifestHash(input.row, input.slice, prior);
    } catch {
      inputManifestHash = canonicalSha256({
        contractVersion: CONTRACT_VERSION,
        cohortKey: input.row.cohortKey,
        snapshotId: input.row.snapshotId,
        evaluationId: input.row.evaluationId,
        contextId: input.row.contextId,
        baselineInputHash: input.row.inputHash,
        baselineDecisionHash: input.row.decisionHash,
        batchInputManifestHash:
          "batch" in input.slice
            ? input.slice.batch.inputManifestHash
            : null,
      });
    }
  }
  return {
    cohortKey: input.row.cohortKey,
    accountKey: input.slice.accountKey,
    status: "failed",
    error: boundedReplayError(input.error),
    inputManifestHash,
    priorHysteresisReplayable: prior.replayable,
    priorHysteresisStatus: prior.status,
    priorHysteresisSourceEngineVersion: prior.sourceEngineVersion,
    priorRawLabel: prior.rawLabel,
    priorPublishedLabel: prior.publishedLabel,
    profileStatus: "not_computed",
    profileReason: null,
    persistedScaleRefreshProfileHash: scaleRefreshProfileHash(
      input.row.accountProfile,
    ),
    challengerScaleRefreshProfileHash: null,
    persistedDataHealthHash: canonicalSha256(input.row.dataHealth),
    challengerDataHealthHash: null,
    calibrationContextProof: null,
    profileBoundaryProjection: null,
    selectedCellCutAuthorityBasis: null,
    selectedCellMetaAovPurchaseCount: null,
    selectedCellMetaAovQuality: null,
    selectedCellRoasRatioP25: null,
    selectedCellMatureAdCount: null,
    repairAuthoritySelected: null,
    spendUnitAuthorityBasis: null,
    spendUnitAuthorityStatus: null,
    accountAovEvidenceStatus: null,
    calibrationRowId: null,
    calibrationInputManifestHash: null,
    calibrationSourceManifestHash: null,
    preAuthorityLabel: null,
    authorityBlocker: null,
    rawLabel: null,
    publishedLabel: null,
    blockedActionType: null,
    hysteresisSuppressed: null,
    simulatedAuthorizedAction: null,
    confidence: null,
    reason: null,
    badges: null,
    roas: numberOrNull(input.row.creativeInput.roas),
    breakEvenRoas: numberOrNull(input.row.creativeInput.breakevenRoas),
    effectiveTargetRoas: null,
    ratioToTarget: null,
    policyAudit: null,
  };
}

function assertConsistentSliceFlags(slice: PreparedAccountSlice) {
  const first = slice.rows[0];
  if (!first) throw new Error(`${slice.sliceKey}: fixed slice has no rows`);
  const expectedHash = canonicalSha256(first.flags);
  const mismatched = slice.rows.filter(
    (row) => canonicalSha256(row.flags) !== expectedHash,
  );
  if (mismatched.length > 0) {
    throw new Error(
      `${slice.sliceKey}: persisted flags differ within one production account/cutoff slice (${mismatched.length} mismatches)`,
    );
  }
  return first.flags;
}

interface ProductionReplayProfileResolution {
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  calibrationCell: NativeAdCalibrationCell | null;
  calibrationRowId: string | null;
  blocker: string | null;
}

class PreparedSliceNativeProfileDataSource implements NativeAdProfileRuntimeDataSource {
  constructor(private readonly slice: PreparedAccountSlice) {}

  async getNativeAdCalibrationCell(input: NativeAdCalibrationCellQuery) {
    return (
      this.slice.cells.find(
        (cell) =>
          cell.key.businessId === input.businessId &&
          cell.key.providerAccountId === input.providerAccountId &&
          cell.key.accountTimezone === input.accountTimezone &&
          cell.key.accountCurrency === input.accountCurrency &&
          cell.key.cellScope === input.cellScope &&
          cell.key.objective === input.objective &&
          cell.key.cohort === input.cohort &&
          cell.key.optimizationContext === input.optimizationContext &&
          cell.asOfDate === input.asOfDate &&
          cell.engineVersion === input.engineVersion &&
          cell.policyVersion === input.policyVersion,
      ) ?? null
    );
  }

  async getNativeTargetAuthorityAsOf(input: {
    businessId: string;
    providerAccountRefId: string;
    providerAccountId: string;
    asOfCutoff: string;
  }) {
    if (
      input.businessId !== this.slice.businessId ||
      input.providerAccountRefId !== this.slice.providerAccountRefId ||
      input.providerAccountId !== this.slice.providerAccountId ||
      input.asOfCutoff !== this.slice.calibrationCutoff
    ) {
      throw new Error(
        `${this.slice.sliceKey}: production profile target lookup escaped the fixed account/cutoff slice`,
      );
    }
    return this.slice.targetAuthority;
  }

  async getNativeDecisionCalibrationProfileAsOf(input: {
    businessId: string;
    asOfCutoff: string;
    channel: "meta";
    objectiveFamily: "sales";
  }) {
    if (
      input.businessId !== this.slice.businessId ||
      input.asOfCutoff !== this.slice.calibrationCutoff ||
      input.channel !== "meta" ||
      input.objectiveFamily !== "sales"
    ) {
      throw new Error(
        `${this.slice.sliceKey}: production profile config lookup escaped the fixed account/cutoff slice`,
      );
    }
    return this.slice.profileConfig;
  }

  async getNativeCalibrationRowId(cell: NativeAdCalibrationCell) {
    if (!this.slice.cells.includes(cell)) {
      throw new Error(
        `${this.slice.sliceKey}: production profile resolver escaped the fixed calibration generation`,
      );
    }
    return deterministicUuid(
      `${CONTRACT_VERSION}\u0000calibration-row\u0000${cell.inputManifestHash}`,
    );
  }
}

function replayProfileIdentity(input: AdDecisionInput) {
  return [
    input.providerAccountRefId,
    input.providerAccountId,
    input.decisionEntityId,
    input.adId,
  ].join("\u0000");
}

export function resolveReplayProfileDimensions(input: {
  sliceKey: string;
  cells: ReadonlyArray<{
    key: {
      accountTimezone: string;
      accountCurrency: string;
    };
  }>;
  sourceDimensionProof: {
    sourceAccountTimezone: string;
    sourceAccountCurrency: string;
  };
}) {
  const accountTimezone =
    input.sourceDimensionProof.sourceAccountTimezone.trim();
  const accountCurrency =
    input.sourceDimensionProof.sourceAccountCurrency.trim().toUpperCase();
  if (!accountTimezone || !accountCurrency) {
    throw new Error(
      `${input.sliceKey}: challenger source dimensions are missing`,
    );
  }
  const mismatchedCells = input.cells.filter(
    (cell) =>
      cell.key.accountTimezone !== accountTimezone ||
      cell.key.accountCurrency !== accountCurrency,
  );
  if (mismatchedCells.length > 0) {
    throw new Error(
      `${input.sliceKey}: challenger calibration cells contradict the immutable source dimensions`,
    );
  }
  return { accountTimezone, accountCurrency };
}

/**
 * Rebuilds the challenger profile through the same production grouping and
 * native-account resolver used by the scheduled job. Persisted decision
 * metrics remain frozen. The challenger dimensions come only from cutoff-bound
 * immutable facts; mutable provider SCD0 values are audit evidence and cannot
 * enter this grouping.
 */
async function resolveProductionReplayProfiles(
  slice: PreparedAccountSlice,
  flags: EngineV3Flags,
): Promise<Map<string, ProductionReplayProfileResolution>> {
  const {
    accountTimezone: currentTimezone,
    accountCurrency: currentCurrency,
  } = resolveReplayProfileDimensions(slice);
  const profileInputs = slice.rows.map((row) => ({
    ...row.creativeInput,
    accountTimezone: currentTimezone,
    accountCurrency: currentCurrency,
  }));
  const groups = await resolveNativeAdDecisionProfileGroups({
    businessId: slice.businessId,
    asOf: slice.rows[0]!.asOfDate,
    adInputs: profileInputs,
    flags,
    dataSource: new PreparedSliceNativeProfileDataSource(slice),
  });
  const resolutions = new Map<string, ProductionReplayProfileResolution>();
  for (const group of groups) {
    for (const adInput of group.adInputs) {
      const identity = replayProfileIdentity(adInput);
      if (resolutions.has(identity)) {
        throw new Error(
          `${slice.sliceKey}: production profile grouping duplicated ${identity}`,
        );
      }
      resolutions.set(identity, {
        profile: group.profile,
        calibrationCell: group.calibrationCell,
        calibrationRowId: group.calibrationRowId,
        blocker: group.blocker,
      });
    }
  }
  if (resolutions.size !== slice.rows.length) {
    throw new Error(
      `${slice.sliceKey}: production profile grouping returned ${resolutions.size}/${slice.rows.length} fixed identities`,
    );
  }
  return resolutions;
}

function replayDecisionProjection(input: {
  computation: AdDecisionComputation;
  payload: NativeSnapshotPayloadRow;
}): ReplayDecisionProjection {
  return {
    preAuthorityLabel: input.computation.decision.preAuthorityLabel,
    authorityBlocker: input.computation.decision.authorityBlocker,
    rawLabel: input.computation.rawLabel,
    publishedLabel: input.computation.decision.label,
    blockedActionType: hardAction(input.computation.decision.blockedActionType),
    authorizedAction: input.payload.authorized_action,
    hysteresisSuppressed: input.computation.hysteresisSuppressed,
    confidence: input.computation.decision.confidence,
    reason: input.computation.decision.reason,
    badges: input.computation.decision.badges,
  };
}

function nativeResolverInputForPolicy(input: AdDecisionInput): CreativeInput {
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
    creativeId: creativeId ?? `native-ad:${input.adId}`,
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

function d063PolicyGateContext(input: {
  row: BaselineRow;
  profile: AccountDecisionProfile;
  computation: AdDecisionComputation;
}): GateContext {
  return {
    input: nativeResolverInputForPolicy(input.row.creativeInput),
    profile: input.profile,
    dataHealth: input.row.dataHealth,
    effectiveTargetRoas: input.computation.decision.effectiveTargetRoas,
    truthSource: input.computation.decision.truthSource,
    ratioToTarget: input.computation.decision.ratioToTarget,
    badges: [],
    confidenceBase: 75,
    confidenceDeltas: [],
    blockers: [],
    generatedAt: input.row.evaluatedAt,
  };
}

/**
 * Counterfactual compatibility control for D063 only. The lower legacy Cut
 * boundary stays unchanged while an economic upper bound above that boundary
 * is collapsed onto it, making the new bounded strip unreachable. This is not
 * a historical engine replay and is never used as a production decision.
 */
function preD063CompatibleProfile(input: {
  rootProfile: AccountDecisionProfile;
  decisionKindSource: DecisionKindSource;
  context: GateContext;
}): AccountDecisionProfile {
  const boundary = resolveCutBoundary(input.context);
  if (
    boundary.economicUpperRatio === null ||
    boundary.economicUpperRatio <= boundary.legacyRatio ||
    input.context.effectiveTargetRoas <= 0
  ) {
    return input.rootProfile;
  }
  const breakEvenRoas =
    boundary.legacyRatio * input.context.effectiveTargetRoas;
  if (input.decisionKindSource === "all_fallback") {
    return {
      ...input.rootProfile,
      spendUnitEvidence: {
        ...input.rootProfile.spendUnitEvidence,
        breakEvenRoas,
      },
    };
  }
  const campaignKind = input.decisionKindSource.slice(5) as
    "main" | "test" | "mixed";
  const spendUnitByKind = input.rootProfile.spendUnitByKind;
  const selectedSpendUnit = spendUnitByKind?.[campaignKind];
  if (spendUnitByKind == null || selectedSpendUnit == null) {
    throw new Error(
      `D063 compatibility control cannot locate ${input.decisionKindSource} spend-unit profile`,
    );
  }
  return {
    ...input.rootProfile,
    spendUnitByKind: {
      ...spendUnitByKind,
      [campaignKind]: {
        ...selectedSpendUnit,
        spendUnitEvidence: {
          ...selectedSpendUnit.spendUnitEvidence,
          breakEvenRoas,
        },
      },
    },
  };
}

function accountAovOverlayInstalled(profile: AccountDecisionProfile) {
  return (
    profile.commercialStopLossSpendUnit != null ||
    profile.commercialStopLossThresholds != null ||
    profile.commercialStopLossCanonicalHardActionEligibility != null
  );
}

function buildD063PolicyAuditProjection(input: {
  row: BaselineRow;
  profile: AccountDecisionProfile;
  computation: AdDecisionComputation;
  currentProjection: ReplayDecisionProjection;
  preD063CompatibleProjection: ReplayDecisionProjection;
}): D063PolicyAuditProjection {
  const context = d063PolicyGateContext(input);
  const zone = resolveCanonicalCutZone(context);
  const boundary = resolveCutBoundary(context);
  const recentEvidence =
    zone === "expanded_economic_loss"
      ? resolveExpandedEconomicRecentEvidence(context)
      : null;
  const overlayActivated = shouldActivateCommercialStopLossCutRepair(context);
  const thresholds = overlayActivated
    ? effectiveCommercialStopLossThresholds(context)
    : input.profile.thresholds;
  const matureForCut =
    zone !== null &&
    resolveRatioZoneCutMaturityMatch(context, thresholds) !== null;
  return {
    zone,
    legacyRatio: boundary.legacyRatio,
    safeLegacyRatio: boundary.ratio,
    economicUpperRatio: boundary.economicUpperRatio,
    recentEvidenceStatus: recentEvidence?.status ?? null,
    matureForCut,
    accountAovOverlayInstalled: accountAovOverlayInstalled(input.profile),
    accountAovOverlayActivated: overlayActivated,
    canonicalBottomQuartileRatio: input.profile.thresholds.bottomQuartileRatio,
    currentProjection: input.currentProjection,
    preD063CompatibleProjection: input.preD063CompatibleProjection,
    legacySafeZoneProjectionDrift:
      zone === "legacy_safe_loss" &&
      canonicalSha256(input.currentProjection) !==
        canonicalSha256(input.preD063CompatibleProjection),
  };
}

async function replayChallengerRow(input: {
  row: BaselineRow;
  slice: PreparedAccountSlice;
  profileResolution: ProductionReplayProfileResolution;
  prior: ReturnType<typeof priorHysteresisMap>;
  campaignContextMode: CampaignContextProvenance["mode"];
  campaignContextById: CampaignContextLabelMap;
  previousLabels: Map<string, PreviousAdPublishedLabel>;
}): Promise<ChallengerRow> {
  const { row, slice, prior } = input;
  try {
    const challengerProfile = input.profileResolution.profile;
    const selectedExactCell = input.profileResolution.calibrationCell;
    const isSoftOnlyProfile = "profileType" in challengerProfile;
    if (
      (!isSoftOnlyProfile &&
        (selectedExactCell === null ||
          input.profileResolution.calibrationRowId === null ||
          input.profileResolution.blocker !== null)) ||
      (isSoftOnlyProfile &&
        (input.profileResolution.calibrationRowId !== null ||
          input.profileResolution.blocker === null))
    ) {
      throw new Error(
        `${row.cohortKey}: production profile grouping returned inconsistent ready/soft lineage`,
      );
    }
    const inputManifestHash = replayInputManifestHash(
      row,
      slice,
      prior,
      row.dataHealth,
      challengerProfile,
    );
    const computeReady = (profile: AccountDecisionProfile) =>
      computeNativeAdDecisions({
        businessId: row.businessId,
        profile,
        dataHealth: row.dataHealth,
        adInputs: [row.creativeInput],
        campaignContextMode: input.campaignContextMode,
        campaignContextById: input.campaignContextById,
        previousLabels: input.previousLabels,
      })[0];
    const computation = isSoftOnlyProfile
      ? computeSoftOnlyNativeAdDecisions({
          businessId: row.businessId,
          blocker: challengerProfile.blocker,
          profile: challengerProfile,
          adInputs: [row.creativeInput],
          campaignContextMode: input.campaignContextMode,
          campaignContextById: input.campaignContextById,
          previousLabels: input.previousLabels,
          evaluatedAt: row.evaluatedAt,
        })[0]
      : computeReady(challengerProfile);
    if (!computation)
      throw new Error("production compute omitted cohort identity");
    const fakeEvaluationId = deterministicUuid(
      `evaluation\u0000${row.cohortKey}`,
    );
    const snapshotPayload = (
      profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile,
      computed: AdDecisionComputation,
    ) =>
      toNativeSnapshotPayload({
        businessId: row.businessId,
        asOf: row.asOfDate,
        jobRunId: deterministicUuid(`job\u0000${row.cohortKey}`),
        scope: profile.scope,
        computation: computed,
        stored: {
          evaluationId: fakeEvaluationId,
          providerAccountRefId: row.providerAccountRefId,
          providerAccountId: row.providerAccountId,
          decisionEntityId: row.creativeInput.adId,
          inputHash: "a".repeat(64),
          decisionHash: "b".repeat(64),
        },
        calibrationRowId: input.profileResolution.calibrationRowId,
        hardActionEligibility: profile.hardActionEligibility,
        computedAt: row.evaluatedAt,
      });
    const payload = snapshotPayload(challengerProfile, computation);
    const currentProjection = replayDecisionProjection({
      computation,
      payload,
    });
    let policyAudit: D063PolicyAuditProjection | null = null;
    if (!isSoftOnlyProfile) {
      const effectiveSelection = selectKindAwareDecisionProfile(
        nativeResolverInputForPolicy(row.creativeInput),
        challengerProfile,
      );
      if (
        computation.decision.decisionKindSource !== undefined &&
        computation.decision.decisionKindSource !==
          effectiveSelection.decisionKindSource
      ) {
        throw new Error(
          `D063 policy-audit kind selection drift: decision=${computation.decision.decisionKindSource}, replay=${effectiveSelection.decisionKindSource}`,
        );
      }
      const currentContext = d063PolicyGateContext({
        row,
        profile: effectiveSelection.profile,
        computation,
      });
      const compatibleProfile = preD063CompatibleProfile({
        rootProfile: challengerProfile,
        decisionKindSource: effectiveSelection.decisionKindSource,
        context: currentContext,
      });
      const compatibleComputation = computeReady(compatibleProfile);
      if (!compatibleComputation) {
        throw new Error(
          "pre-D063 compatibility control omitted cohort identity",
        );
      }
      const compatibleProjection = replayDecisionProjection({
        computation: compatibleComputation,
        payload: snapshotPayload(compatibleProfile, compatibleComputation),
      });
      policyAudit = buildD063PolicyAuditProjection({
        row,
        profile: effectiveSelection.profile,
        computation,
        currentProjection,
        preD063CompatibleProjection: compatibleProjection,
      });
    }
    return {
      cohortKey: row.cohortKey,
      accountKey: slice.accountKey,
      status: "computed",
      error: null,
      inputManifestHash,
      priorHysteresisReplayable: prior.replayable,
      priorHysteresisStatus: prior.status,
      priorHysteresisSourceEngineVersion: prior.sourceEngineVersion,
      priorRawLabel: prior.rawLabel,
      priorPublishedLabel: prior.publishedLabel,
      profileStatus: isSoftOnlyProfile ? "soft_only" : "ready",
      profileReason: input.profileResolution.blocker,
      persistedScaleRefreshProfileHash: scaleRefreshProfileHash(
        row.accountProfile,
      ),
      challengerScaleRefreshProfileHash:
        scaleRefreshProfileHash(challengerProfile),
      persistedDataHealthHash: canonicalSha256(row.dataHealth),
      challengerDataHealthHash: canonicalSha256(row.dataHealth),
      calibrationContextProof: buildReplayCalibrationContextProof({
        cohortKey: row.cohortKey,
        accountKey: slice.accountKey,
        inputManifestHash,
        persistedInput: row.creativeInput,
        challengerInput: computation.input,
        persistedProjection: row.baseline,
        challengerProjection: currentProjection,
        persistedProfile: row.accountProfile,
        challengerProfile,
        persistedDataHealth: row.dataHealth,
        challengerDataHealth: row.dataHealth,
        persistedCampaignContext: row.campaignContext,
        challengerCampaignContext: computation.campaignContext,
      }),
      profileBoundaryProjection:
        mediaBuyerProfileBoundaryProjection(challengerProfile),
      selectedCellCutAuthorityBasis:
        selectedExactCell?.actionReadiness.cut.authorityBasis ?? null,
      selectedCellMetaAovPurchaseCount:
        selectedExactCell?.accountCalibration
          .metaAttributedAovPurchaseCount90d ?? null,
      selectedCellMetaAovQuality:
        selectedExactCell?.accountCalibration.metaAovQuality ?? null,
      selectedCellRoasRatioP25:
        selectedExactCell?.accountCalibration.roasRatioP25 ?? null,
      selectedCellMatureAdCount: selectedExactCell?.matureAdCount ?? null,
      repairAuthoritySelected: isSoftOnlyProfile
        ? false
        : accountAovOverlayInstalled(challengerProfile),
      spendUnitAuthorityBasis: slice.batch.spendUnitAuthority.basis,
      spendUnitAuthorityStatus: slice.batch.spendUnitAuthority.status,
      accountAovEvidenceStatus:
        slice.batch.spendUnitAuthority.accountAovEvidence.status,
      calibrationRowId: input.profileResolution.calibrationRowId,
      calibrationInputManifestHash: slice.batch.inputManifestHash,
      calibrationSourceManifestHash: slice.batch.sourceManifestHash,
      preAuthorityLabel: computation.decision.preAuthorityLabel,
      authorityBlocker: computation.decision.authorityBlocker,
      rawLabel: computation.rawLabel,
      publishedLabel: computation.decision.label,
      blockedActionType: hardAction(computation.decision.blockedActionType),
      hysteresisSuppressed: computation.hysteresisSuppressed,
      simulatedAuthorizedAction: payload.authorized_action,
      confidence: computation.decision.confidence,
      reason: computation.decision.reason,
      badges: computation.decision.badges,
      roas: numberOrNull(row.creativeInput.roas),
      breakEvenRoas:
        "profileType" in challengerProfile
          ? numberOrNull(row.creativeInput.breakevenRoas)
          : challengerProfile.spendUnitEvidence.breakEvenRoas,
      effectiveTargetRoas: computation.decision.effectiveTargetRoas,
      ratioToTarget: computation.decision.ratioToTarget,
      policyAudit,
    };
  } catch (error) {
    return failedChallengerRow({ row, slice, error, prior });
  }
}

export async function replayPreparedAccountSlice(
  slice: PreparedAccountSlice,
): Promise<ChallengerRow[]> {
  let priorByCohortKey: Map<string, ReturnType<typeof priorHysteresisMap>>;
  let previousLabels: Map<string, PreviousAdPublishedLabel>;
  let campaignContextById: Map<string, CampaignContextEntryWithProvenance>;
  let campaignContextMode: CampaignContextProvenance["mode"];
  let profileResolutions: Map<string, ProductionReplayProfileResolution>;
  try {
    const flags = assertConsistentSliceFlags(slice);
    const evaluatedAtValues = new Set(slice.rows.map((row) => row.evaluatedAt));
    if (evaluatedAtValues.size !== 1) {
      throw new Error(
        `${slice.sliceKey}: persisted evaluatedAt differs within one production wave`,
      );
    }
    const campaignModes = new Set(
      slice.rows.map((row) => row.campaignContext.mode),
    );
    if (campaignModes.size !== 1) {
      throw new Error(
        `${slice.sliceKey}: persisted campaign-context mode differs within one production wave`,
      );
    }
    campaignContextMode = slice.rows[0]!.campaignContext.mode;
    priorByCohortKey = new Map();
    previousLabels = new Map();
    campaignContextById = new Map();
    for (const row of slice.rows) {
      const prior = priorHysteresisMap(row);
      priorByCohortKey.set(row.cohortKey, prior);
      for (const [key, value] of prior.map) {
        if (previousLabels.has(key)) {
          throw new Error(
            `${slice.sliceKey}: duplicate persisted hysteresis identity`,
          );
        }
        previousLabels.set(key, value);
      }
      for (const [campaignId, value] of campaignContextMap(row)) {
        const existing = campaignContextById.get(campaignId);
        if (existing && canonicalSha256(existing) !== canonicalSha256(value)) {
          throw new Error(
            `${slice.sliceKey}: conflicting persisted campaign context for ${campaignId}`,
          );
        }
        campaignContextById.set(campaignId, value);
      }
    }
    profileResolutions = await resolveProductionReplayProfiles(slice, flags);
  } catch (error) {
    return slice.rows.map((row) => failedChallengerRow({ row, slice, error }));
  }

  const challengers: ChallengerRow[] = [];
  for (const row of slice.rows) {
    const prior = priorByCohortKey.get(row.cohortKey);
    const profileResolution = profileResolutions.get(
      replayProfileIdentity(row.creativeInput),
    );
    if (!prior || !profileResolution) {
      challengers.push(
        failedChallengerRow({
          row,
          slice,
          error: !prior
            ? "production replay omitted prior-hysteresis classification"
            : "production replay omitted exact profile resolution",
        }),
      );
      continue;
    }
    challengers.push(
      await replayChallengerRow({
        row,
        slice,
        profileResolution,
        prior,
        campaignContextMode,
        campaignContextById,
        previousLabels,
      }),
    );
  }
  return challengers.sort((left, right) =>
    left.cohortKey.localeCompare(right.cohortKey),
  );
}

function countLabels(
  values: Array<DecisionLabel | null>,
): Record<DecisionLabel, number> {
  const counts: Record<DecisionLabel, number> = {
    scale: 0,
    keep: 0,
    refresh: 0,
    cut: 0,
    test_more: 0,
    diagnose: 0,
    out_of_scope: 0,
  };
  for (const value of values) if (value !== null) counts[value] += 1;
  return counts;
}

export function aboveBreakEvenCutProjectionViolation(input: {
  roas: number | null;
  breakEvenRoas: number | null;
  labels: Array<DecisionLabel | null>;
  blockedActionType: "scale" | "cut" | "refresh" | null;
  authorizedAction: "scale" | "cut" | "refresh" | null;
  badges: DecisionBadge[] | null;
}) {
  return (
    input.roas !== null &&
    input.breakEvenRoas !== null &&
    input.roas + 1e-9 >= input.breakEvenRoas &&
    (input.labels.some((item) => item === "cut") ||
      input.blockedActionType === "cut" ||
      input.authorizedAction === "cut" ||
      input.badges?.some((badge) => badge.type === "cut_candidate") === true)
  );
}

function decisionProjectionTuple(input: {
  preAuthorityLabel: DecisionLabel | null;
  authorityBlocker: string | null;
  rawLabel: DecisionLabel | null;
  publishedLabel: DecisionLabel | null;
  blockedActionType: "scale" | "cut" | "refresh" | null;
  authorizedAction: "scale" | "cut" | "refresh" | null;
  hysteresisSuppressed: boolean | null;
  confidence: number | null;
  reason: string | null;
  badges: DecisionBadge[] | null;
}) {
  return {
    preAuthorityLabel: input.preAuthorityLabel,
    authorityBlocker: input.authorityBlocker,
    rawLabel: input.rawLabel,
    publishedLabel: input.publishedLabel,
    blockedActionType: input.blockedActionType,
    authorizedAction: input.authorizedAction,
    hysteresisSuppressed: input.hysteresisSuppressed,
    confidence: input.confidence,
    reason: input.reason,
    badges: input.badges,
  };
}

function projectionTouchesScaleOrRefresh(
  tuple: ReturnType<typeof decisionProjectionTuple>,
) {
  return (
    [
      tuple.preAuthorityLabel,
      tuple.rawLabel,
      tuple.publishedLabel,
      tuple.blockedActionType,
      tuple.authorizedAction,
    ].some((value) => value === "scale" || value === "refresh") ||
    (tuple.reason ?? "").includes("[near scale]") ||
    tuple.badges?.some(
      (badge) =>
        badge.type === "scale_readiness_blocked" ||
        badge.type === "scale_calibration_thin",
    ) === true
  );
}

function isDeterministicEpochResetPendingWrapper(input: {
  baseline: ReturnType<typeof decisionProjectionTuple>;
  challenger: ReturnType<typeof decisionProjectionTuple>;
  challengerRow: ChallengerRow;
}) {
  const hardLabel =
    input.baseline.rawLabel === "scale" || input.baseline.rawLabel === "refresh"
      ? input.baseline.rawLabel
      : null;
  const baselineWasAuthorized =
    hardLabel !== null &&
    input.baseline.authorityBlocker === null &&
    input.baseline.blockedActionType === null &&
    input.baseline.authorizedAction === hardLabel;
  const baselineWasAlreadyAuthorityBlocked =
    hardLabel !== null &&
    input.baseline.authorityBlocker !== null &&
    input.baseline.blockedActionType === hardLabel &&
    input.baseline.authorizedAction === null;
  if (
    hardLabel === null ||
    input.challengerRow.priorHysteresisStatus !== "epoch_mismatch" ||
    input.baseline.preAuthorityLabel !== input.challenger.preAuthorityLabel ||
    input.baseline.authorityBlocker !== input.challenger.authorityBlocker ||
    input.baseline.rawLabel !== input.challenger.rawLabel ||
    input.baseline.publishedLabel !== hardLabel ||
    (!baselineWasAuthorized && !baselineWasAlreadyAuthorityBlocked) ||
    input.baseline.hysteresisSuppressed !== false ||
    input.challenger.publishedLabel !== "keep" ||
    input.challenger.blockedActionType !== hardLabel ||
    input.challenger.authorizedAction !== null ||
    input.challenger.hysteresisSuppressed !== true ||
    input.baseline.confidence !== input.challenger.confidence
  ) {
    return false;
  }
  const expectedReason = `[Pending hard action: ${hardLabel}] No hard action is published until this signal repeats on the next evaluation. Current evidence: ${input.baseline.reason}`;
  return (
    input.challenger.reason === expectedReason &&
    canonicalSha256(input.challenger.badges) ===
      canonicalSha256([
        ...(input.baseline.badges ?? []),
        PENDING_TRANSITION_BADGE,
      ])
  );
}

function decisionActionSemanticTuple(
  tuple: ReturnType<typeof decisionProjectionTuple>,
) {
  return {
    preAuthorityLabel: tuple.preAuthorityLabel,
    authorityBlocker: tuple.authorityBlocker,
    rawLabel: tuple.rawLabel,
    publishedLabel: tuple.publishedLabel,
    blockedActionType: tuple.blockedActionType,
    authorizedAction: tuple.authorizedAction,
    hysteresisSuppressed: tuple.hysteresisSuppressed,
  };
}

function projectionHasPendingTransitionArtifacts(
  tuple: ReturnType<typeof decisionProjectionTuple>,
) {
  return (
    tuple.hysteresisSuppressed === true ||
    tuple.badges?.some((badge) => badge.type === "pending_transition") ===
      true ||
    tuple.reason?.startsWith("[Pending hard action:") === true
  );
}

function replayProfileIdentityMatchesInput(input: {
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  exactInput: AdDecisionInput;
}) {
  const scope = input.profile.scope;
  return (
    input.profile.businessId === input.exactInput.businessId &&
    input.profile.channel === "meta" &&
    input.profile.objectiveFamily === "sales" &&
    scope.type === "account" &&
    scope.id === input.exactInput.providerAccountId &&
    input.exactInput.decisionEntityType === "ad" &&
    input.exactInput.decisionEntityId === input.exactInput.adId
  );
}

function replayCampaignContextMatchesInput(input: {
  campaignContext: CampaignContextProvenance;
  exactInput: AdDecisionInput;
}) {
  return input.campaignContext.campaignId === input.exactInput.campaignId;
}

function hasProvenScaleRefreshContextRestatement(input: {
  row: ChallengerRow;
  baseline: ReturnType<typeof decisionProjectionTuple>;
  challenger: ReturnType<typeof decisionProjectionTuple>;
}) {
  const row = input.row;
  const validHash = (value: string | null) =>
    value !== null && /^[0-9a-f]{64}$/.test(value);
  const proof = row.calibrationContextProof;
  if (
    proof == null ||
    proof.contractVersion !==
      REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION ||
    proof.persistedInput == null ||
    typeof proof.persistedInput !== "object" ||
    proof.challengerInput == null ||
    typeof proof.challengerInput !== "object" ||
    proof.persistedProfile == null ||
    typeof proof.persistedProfile !== "object" ||
    proof.challengerProfile == null ||
    typeof proof.challengerProfile !== "object" ||
    proof.persistedDataHealth == null ||
    typeof proof.persistedDataHealth !== "object" ||
    proof.challengerDataHealth == null ||
    typeof proof.challengerDataHealth !== "object" ||
    proof.persistedCampaignContext == null ||
    typeof proof.persistedCampaignContext !== "object" ||
    proof.challengerCampaignContext == null ||
    typeof proof.challengerCampaignContext !== "object" ||
    !Array.isArray(proof.inputDiffPaths) ||
    !Array.isArray(proof.profileDiffPaths) ||
    !Array.isArray(proof.dataHealthDiffPaths)
  ) {
    return false;
  }
  const persistedProfileHash = scaleRefreshProfileHash(
    proof.persistedProfile,
  );
  const challengerProfileHash = scaleRefreshProfileHash(
    proof.challengerProfile,
  );
  const persistedDataHealthHash = canonicalSha256(
    proof.persistedDataHealth,
  );
  const challengerDataHealthHash = canonicalSha256(
    proof.challengerDataHealth,
  );
  const profileDiffPaths = replayLeafDiffPaths(
    scaleRefreshProfileProjection(proof.persistedProfile),
    scaleRefreshProfileProjection(proof.challengerProfile),
  );
  const dataHealthDiffPaths = replayLeafDiffPaths(
    proof.persistedDataHealth,
    proof.challengerDataHealth,
  );
  const inputDiffPaths = replayLeafDiffPaths(
    proof.persistedInput,
    proof.challengerInput,
  );
  const contextMaterialHash = canonicalSha256(
    replayCalibrationContextMaterial({
    persistedProfile: proof.persistedProfile,
    challengerProfile: proof.challengerProfile,
    persistedDataHealth: proof.persistedDataHealth,
    challengerDataHealth: proof.challengerDataHealth,
    persistedCampaignContext: proof.persistedCampaignContext,
    challengerCampaignContext: proof.challengerCampaignContext,
    profileDiffPaths,
    dataHealthDiffPaths,
    inputDiffPaths,
    }),
  );
  const proofHash = canonicalSha256(
    replayCalibrationProofHashMaterial({
      ...proof,
      inputDiffPaths,
      profileDiffPaths,
      dataHealthDiffPaths,
      contextMaterialHash,
    }),
  );
  return (
    proof.cohortKey === row.cohortKey &&
    proof.accountKey === row.accountKey &&
    proof.inputManifestHash === row.inputManifestHash &&
    canonicalSha256(decisionProjectionTuple(proof.persistedProjection)) ===
      canonicalSha256(input.baseline) &&
    canonicalSha256(decisionProjectionTuple(proof.challengerProjection)) ===
      canonicalSha256(input.challenger) &&
    numberOrNull(proof.challengerInput.roas) === row.roas &&
    numberOrNull(proof.challengerInput.breakevenRoas) ===
      row.breakEvenRoas &&
    canonicalSha256(proof.inputDiffPaths) ===
      canonicalSha256(inputDiffPaths) &&
    inputDiffPaths.length === 0 &&
    canonicalSha256(proof.profileDiffPaths) ===
      canonicalSha256(profileDiffPaths) &&
    canonicalSha256(proof.dataHealthDiffPaths) ===
      canonicalSha256(dataHealthDiffPaths) &&
    canonicalSha256(proof.persistedCampaignContext) ===
      canonicalSha256(proof.challengerCampaignContext) &&
    replayCampaignContextMatchesInput({
      campaignContext: proof.persistedCampaignContext,
      exactInput: proof.persistedInput,
    }) &&
    replayCampaignContextMatchesInput({
      campaignContext: proof.challengerCampaignContext,
      exactInput: proof.challengerInput,
    }) &&
    replayProfileIdentityMatchesInput({
      profile: proof.persistedProfile,
      exactInput: proof.persistedInput,
    }) &&
    replayProfileIdentityMatchesInput({
      profile: proof.challengerProfile,
      exactInput: proof.challengerInput,
    }) &&
    proof.contextMaterialHash === contextMaterialHash &&
    proof.proofHash === proofHash &&
    validHash(row.persistedScaleRefreshProfileHash) &&
    validHash(row.challengerScaleRefreshProfileHash) &&
    validHash(row.persistedDataHealthHash) &&
    validHash(row.challengerDataHealthHash) &&
    row.persistedScaleRefreshProfileHash === persistedProfileHash &&
    row.challengerScaleRefreshProfileHash === challengerProfileHash &&
    row.persistedDataHealthHash === persistedDataHealthHash &&
    row.challengerDataHealthHash === challengerDataHealthHash &&
    (row.persistedScaleRefreshProfileHash !==
      row.challengerScaleRefreshProfileHash ||
      row.persistedDataHealthHash !== row.challengerDataHealthHash)
  );
}

type ScaleRefreshProjectionComparison =
  | "unrelated"
  | "identical"
  | "epoch_reset_pending_wrapper"
  | "calibration_restatement"
  | "profile_availability_restatement"
  | "semantic_drift";

function compareScaleRefreshProjection(input: {
  baseline: BaselineRow["baseline"];
  challenger: ChallengerRow | null;
}): ScaleRefreshProjectionComparison {
  if (input.challenger === null) return "semantic_drift";
  const baseline = decisionProjectionTuple(input.baseline);
  const challenger = decisionProjectionTuple({
    ...input.challenger,
    authorizedAction: input.challenger.simulatedAuthorizedAction,
  });
  if (canonicalSha256(baseline) === canonicalSha256(challenger)) {
    return "identical";
  }
  const baselineUnavailable =
    isNativeProfileUnavailableProjection(baseline);
  const challengerUnavailable =
    isNativeProfileUnavailableProjection(challenger);
  if (baselineUnavailable || challengerUnavailable) {
    const availabilityRestatement =
      classifySafeNonHardCalibrationRestatement({
        baseline,
        challenger,
        challengerRow: input.challenger,
      });
    return availabilityRestatement ?? "semantic_drift";
  }
  if (
    !projectionTouchesScaleOrRefresh(baseline) &&
    !projectionTouchesScaleOrRefresh(challenger)
  ) {
    return "unrelated";
  }
  if (
    isDeterministicEpochResetPendingWrapper({
      baseline,
      challenger,
      challengerRow: input.challenger,
    })
  ) {
    return "epoch_reset_pending_wrapper";
  }
  const nonHardRestatement = classifySafeNonHardCalibrationRestatement({
    baseline,
    challenger,
    challengerRow: input.challenger,
  });
  if (nonHardRestatement !== null) {
    return nonHardRestatement;
  }
  return "semantic_drift";
}

export function scaleRefreshProjectionDrift(input: {
  baseline: BaselineRow["baseline"];
  challenger: ChallengerRow | null;
}) {
  return compareScaleRefreshProjection(input) === "semantic_drift";
}

export function scaleRefreshCalibrationRestatement(input: {
  baseline: BaselineRow["baseline"];
  challenger: ChallengerRow | null;
}) {
  return compareScaleRefreshProjection(input) === "calibration_restatement";
}

export function scaleRefreshProfileAvailabilityRestatement(input: {
  baseline: BaselineRow["baseline"];
  challenger: ChallengerRow | null;
}) {
  return (
    compareScaleRefreshProjection(input) ===
    "profile_availability_restatement"
  );
}

type AboveBreakEvenProjectionComparison =
  | "unrelated"
  | "identical"
  | "epoch_reset_pending_wrapper"
  | "safety_repair"
  | "calibration_restatement"
  | "profile_availability_restatement"
  | "semantic_drift";

export function isOrdinaryNonHardProjection(
  projection: ReturnType<typeof decisionProjectionTuple>,
) {
  const allowed = new Set<DecisionLabel>(["keep", "test_more"]);
  return (
    [
      projection.preAuthorityLabel,
      projection.rawLabel,
      projection.publishedLabel,
    ].every((label) => label !== null && allowed.has(label)) &&
    projection.authorityBlocker === null &&
    projection.blockedActionType === null &&
    projection.authorizedAction === null &&
    projection.hysteresisSuppressed === false &&
    projection.badges?.every(
      (badge) => badge.type !== "cut_candidate",
    ) !== false &&
    !projectionHasPendingTransitionArtifacts(projection)
  );
}

function isNativeProfileUnavailableProjection(
  projection: ReturnType<typeof decisionProjectionTuple>,
) {
  return (
    projection.preAuthorityLabel === "diagnose" &&
    projection.rawLabel === "diagnose" &&
    projection.publishedLabel === "diagnose" &&
    projection.authorityBlocker === "native_profile_unavailable" &&
    projection.blockedActionType === null &&
    projection.authorizedAction === null &&
    projection.hysteresisSuppressed === false &&
    projection.confidence === 0 &&
    projection.reason?.startsWith(
      "[Native calibration unavailable - hard actions blocked]",
    ) === true &&
    projection.badges?.some(
      (badge) => badge.type === "native_calibration_unavailable",
    ) === true &&
    !projectionHasPendingTransitionArtifacts(projection)
  );
}

function profileDiffPathsAreCalibrationOnly(paths: readonly string[]) {
  if (paths.length === 0) return false;
  return paths.every((path) =>
    /^(?:accountBaselines|accountBaselinesByKind\.[^.]+|funnelCalibration|funnelCalibrationByKind\.[^.]+|thresholds|thresholdsByKind\.[^.]+|spendUnitByKind\.[^.]+|quality|spendUnit(?:Source|Confidence|Evidence)?)(?:\.|$)/.test(
      path,
    ),
  );
}

function replayCampaignContextMap(
  context: CampaignContextProvenance,
): CampaignContextLabelMap {
  return campaignContextMapFromProvenance(context);
}

export function replayOrdinaryProductionProjection(input: {
  exactInput: AdDecisionInput;
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  dataHealth: DataHealth;
  campaignContext: CampaignContextProvenance;
}) {
  return replayOrdinaryProductionEnvelope(input)?.projection ?? null;
}

function replayOrdinaryProductionEnvelope(input: {
  exactInput: AdDecisionInput;
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  dataHealth: DataHealth;
  campaignContext: CampaignContextProvenance;
}) {
  const campaignContextById = replayCampaignContextMap(
    input.campaignContext,
  );
  const computation =
    "profileType" in input.profile
      ? computeSoftOnlyNativeAdDecisions({
          businessId: input.exactInput.businessId,
          blocker: input.profile.blocker,
          profile: input.profile,
          adInputs: [input.exactInput],
          campaignContextMode: input.campaignContext.mode,
          campaignContextById,
          previousLabels: new Map(),
          evaluatedAt: "1970-01-01T00:00:00.000Z",
        })[0]
      : computeNativeAdDecisions({
          businessId: input.exactInput.businessId,
          profile: input.profile,
          dataHealth: input.dataHealth,
          adInputs: [input.exactInput],
          campaignContextMode: input.campaignContext.mode,
          campaignContextById,
          previousLabels: new Map(),
        })[0];
  if (!computation) return null;
  return {
    projection: decisionProjectionTuple({
      preAuthorityLabel: computation.decision.preAuthorityLabel,
      authorityBlocker: computation.decision.authorityBlocker,
      rawLabel: computation.rawLabel,
      publishedLabel: computation.decision.label,
      blockedActionType: hardAction(
        computation.decision.blockedActionType,
      ),
      authorizedAction: null,
      hysteresisSuppressed: computation.hysteresisSuppressed,
      confidence: computation.decision.confidence,
      reason: computation.decision.reason,
      badges: computation.decision.badges,
    }),
    resolvedInput: computation.input,
    resolvedCampaignContext: computation.campaignContext,
  };
}

function ordinaryProjectionMatchesProduction(input: {
  projection: ReturnType<typeof decisionProjectionTuple>;
  exactInput: AdDecisionInput;
  profile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  dataHealth: DataHealth;
  campaignContext: CampaignContextProvenance;
}) {
  let output: ReturnType<typeof replayOrdinaryProductionEnvelope>;
  try {
    output = replayOrdinaryProductionEnvelope(input);
  } catch {
    return false;
  }
  if (output === null) return false;
  return (
    canonicalSha256(input.projection) ===
      canonicalSha256(output.projection) &&
    canonicalSha256(input.exactInput) ===
      canonicalSha256(output.resolvedInput) &&
    canonicalSha256(input.campaignContext) ===
      canonicalSha256(output.resolvedCampaignContext)
  );
}

function sameActionCalibrationEvidenceRestatement(input: {
  baseline: ReturnType<typeof decisionProjectionTuple>;
  challenger: ReturnType<typeof decisionProjectionTuple>;
  challengerRow: ChallengerRow;
}) {
  const proof = input.challengerRow.calibrationContextProof;
  if (
    proof == null ||
    !profileDiffPathsAreCalibrationOnly(proof.profileDiffPaths) ||
    proof.dataHealthDiffPaths.length !== 0
  ) {
    return false;
  }
  if (
    canonicalSha256(decisionActionSemanticTuple(input.baseline)) !==
      canonicalSha256(decisionActionSemanticTuple(input.challenger)) ||
    !ordinaryProjectionMatchesProduction({
      projection: input.baseline,
      exactInput: proof.persistedInput,
      profile: proof.persistedProfile,
      dataHealth: proof.persistedDataHealth,
      campaignContext: proof.persistedCampaignContext,
    }) ||
    !ordinaryProjectionMatchesProduction({
      projection: input.challenger,
      exactInput: proof.challengerInput,
      profile: proof.challengerProfile,
      dataHealth: proof.challengerDataHealth,
      campaignContext: proof.challengerCampaignContext,
    })
  ) {
    return false;
  }
  return true;
}

function exactSoftOnlyToNonHardAvailabilityProfileTransition(input: {
  persistedProfile:
    | AccountDecisionProfile
    | NativeAdSoftOnlyDecisionProfile;
  challengerProfile:
    | AccountDecisionProfile
    | NativeAdSoftOnlyDecisionProfile;
  profileDiffPaths: readonly string[];
}) {
  const persisted = input.persistedProfile;
  const challenger = input.challengerProfile;
  if (
    !("profileType" in persisted) ||
    "profileType" in challenger ||
    "blocker" in challenger ||
    "calibrationSource" in challenger ||
    "selectedCell" in challenger ||
    persisted.profileType !== "native_ad_soft_only" ||
    persisted.blocker !==
      "native_ad_profile_unready:native_calibration_missing" ||
    persisted.calibrationSource !== null ||
    persisted.selectedCell !== null ||
    persisted.businessId !== challenger.businessId ||
    persisted.asOfDate !== challenger.asOfDate ||
    persisted.channel !== challenger.channel ||
    persisted.objectiveFamily !== challenger.objectiveFamily ||
    canonicalSha256({
      ...persisted.scope,
      fallbackReason: persisted.scope.fallbackReason ?? null,
    }) !==
      canonicalSha256({
        ...challenger.scope,
        fallbackReason: challenger.scope.fallbackReason ?? null,
      }) ||
    persisted.hardActionEligibility.scale !== false ||
    persisted.hardActionEligibility.cut !== false ||
    persisted.hardActionEligibility.refresh !== false ||
    challenger.hardActionEligibility.scale !== false ||
    challenger.hardActionEligibility.cut !== false ||
    challenger.hardActionEligibility.refresh !== false ||
    challenger.quality.calibrationReady !== false ||
    challenger.quality.commercialTruthReady !== false ||
    challenger.quality.thresholdQuality !== "insufficient" ||
    challenger.spendUnit !== null ||
    challenger.spendUnitSource !== "insufficient" ||
    challenger.spendUnitConfidence !== "insufficient" ||
    challenger.hardActionEligibilityByKind !== null ||
    challenger.commercialStopLossSpendUnit !== null ||
    challenger.commercialStopLossThresholds !== null ||
    challenger.commercialStopLossCanonicalHardActionEligibility !== null ||
    challenger.expandedEconomicCutAuthority?.eligible !== false ||
    challenger.expandedEconomicCutAuthority.authorityBasis !== null ||
    typeof challenger.expandedEconomicCutAuthority.reason !== "string" ||
    challenger.expandedEconomicCutAuthority.reason.trim().length === 0
  ) {
    return false;
  }
  const allowedRoots = new Set([
    "accountBaselines",
    "accountBaselinesByKind",
    "blocker",
    "calibrationSource",
    "funnelCalibration",
    "funnelCalibrationByKind",
    "hardActionEligibility",
    "hardActionEligibilityByKind",
    "multipliers",
    "preset",
    "presetSource",
    "profileType",
    "quality",
    "selectedCell",
    "spendUnit",
    "spendUnitByKind",
    "spendUnitConfidence",
    "spendUnitEvidence",
    "spendUnitSource",
    "thresholds",
    "thresholdsByKind",
  ]);
  const roots = input.profileDiffPaths.map((path) => path.split(".")[0]!);
  return (
    roots.includes("profileType") &&
    roots.includes("blocker") &&
    roots.includes("calibrationSource") &&
    roots.includes("selectedCell") &&
    roots.every((root) => allowedRoots.has(root))
  );
}

function knownForwardProfileAvailabilityRestatement(input: {
  baseline: ReturnType<typeof decisionProjectionTuple>;
  challenger: ReturnType<typeof decisionProjectionTuple>;
  challengerRow: ChallengerRow;
}) {
  const proof = input.challengerRow.calibrationContextProof;
  if (
    proof == null ||
    proof.dataHealthDiffPaths.length !== 0
  ) {
    return false;
  }
  const exactSoftOnlyAvailability =
    exactSoftOnlyToNonHardAvailabilityProfileTransition({
      persistedProfile: proof.persistedProfile,
      challengerProfile: proof.challengerProfile,
      profileDiffPaths: proof.profileDiffPaths,
    });
  if (
    !profileDiffPathsAreCalibrationOnly(proof.profileDiffPaths) &&
    !exactSoftOnlyAvailability
  ) {
    return false;
  }
  const baselineCollecting =
    input.baseline.preAuthorityLabel === "test_more" &&
    input.baseline.rawLabel === "test_more" &&
    input.baseline.publishedLabel === "test_more";
  const challengerKeep =
    input.challenger.preAuthorityLabel === "keep" &&
    input.challenger.rawLabel === "keep" &&
    input.challenger.publishedLabel === "keep";
  const baselineUnavailable =
    isNativeProfileUnavailableProjection(input.baseline);
  const challengerOrdinary =
    isOrdinaryNonHardProjection(input.challenger);
  if (
    !(
      (baselineCollecting && challengerKeep) ||
      (baselineUnavailable &&
        challengerOrdinary &&
        exactSoftOnlyAvailability)
    ) ||
    !ordinaryProjectionMatchesProduction({
      projection: input.baseline,
      exactInput: proof.persistedInput,
      profile: proof.persistedProfile,
      dataHealth: proof.persistedDataHealth,
      campaignContext: proof.persistedCampaignContext,
    }) ||
    !ordinaryProjectionMatchesProduction({
      projection: input.challenger,
      exactInput: proof.challengerInput,
      profile: proof.challengerProfile,
      dataHealth: proof.challengerDataHealth,
      campaignContext: proof.challengerCampaignContext,
    })
  ) {
    return false;
  }
  return true;
}

function classifySafeNonHardCalibrationRestatement(input: {
  baseline: ReturnType<typeof decisionProjectionTuple>;
  challenger: ReturnType<typeof decisionProjectionTuple>;
  challengerRow: ChallengerRow;
}): "calibration_restatement" | "profile_availability_restatement" | null {
  if (
    !hasProvenScaleRefreshContextRestatement({
      row: input.challengerRow,
      baseline: input.baseline,
      challenger: input.challenger,
    })
  ) {
    return null;
  }
  const baselineNonHard = isOrdinaryNonHardProjection(input.baseline);
  const challengerNonHard = isOrdinaryNonHardProjection(input.challenger);
  if (baselineNonHard && challengerNonHard) {
    if (
      sameActionCalibrationEvidenceRestatement({
        baseline: input.baseline,
        challenger: input.challenger,
        challengerRow: input.challengerRow,
      })
    ) {
      return "calibration_restatement";
    }
    if (knownForwardProfileAvailabilityRestatement(input)) {
      return "profile_availability_restatement";
    }
    return null;
  }
  const baselineUnavailable = isNativeProfileUnavailableProjection(
    input.baseline,
  );
  const challengerUnavailable = isNativeProfileUnavailableProjection(
    input.challenger,
  );
  if (
    baselineUnavailable &&
    challengerNonHard &&
    knownForwardProfileAvailabilityRestatement(input)
  ) {
    return "profile_availability_restatement";
  }
  if (baselineUnavailable || challengerUnavailable) return null;
  return null;
}

function compareAboveBreakEvenProjection(input: {
  baseline: BaselineRow["baseline"];
  baselineRoas: number | null;
  baselineBreakEvenRoas: number | null;
  challenger: ChallengerRow | null;
}): AboveBreakEvenProjectionComparison {
  if (input.challenger === null) return "semantic_drift";
  const baselineAboveBreakEven =
    input.baselineRoas !== null &&
    input.baselineBreakEvenRoas !== null &&
    input.baselineRoas + 1e-9 >= input.baselineBreakEvenRoas;
  const challengerAboveBreakEven =
    input.challenger.roas !== null &&
    input.challenger.breakEvenRoas !== null &&
    input.challenger.roas + 1e-9 >= input.challenger.breakEvenRoas;
  if (!baselineAboveBreakEven && !challengerAboveBreakEven) return "unrelated";
  const hasBaselineCutProjection = aboveBreakEvenCutProjectionViolation({
    roas: input.baselineRoas,
    breakEvenRoas: input.baselineBreakEvenRoas,
    labels: [
      input.baseline.preAuthorityLabel,
      input.baseline.rawLabel,
      input.baseline.publishedLabel,
    ],
    blockedActionType: input.baseline.blockedActionType,
    authorizedAction: input.baseline.authorizedAction,
    badges: input.baseline.badges,
  });
  const hasChallengerCutProjection = aboveBreakEvenCutProjectionViolation({
    roas: input.challenger.roas,
    breakEvenRoas: input.challenger.breakEvenRoas,
    labels: [
      input.challenger.preAuthorityLabel,
      input.challenger.rawLabel,
      input.challenger.publishedLabel,
    ],
    blockedActionType: input.challenger.blockedActionType,
    authorizedAction: input.challenger.simulatedAuthorizedAction,
    badges: input.challenger.badges,
  });
  if (hasBaselineCutProjection && !hasChallengerCutProjection) {
    return "safety_repair";
  }
  if (hasChallengerCutProjection) {
    return "semantic_drift";
  }
  const baselineTuple = decisionProjectionTuple(input.baseline);
  const challengerTuple = decisionProjectionTuple({
    ...input.challenger,
    authorizedAction: input.challenger.simulatedAuthorizedAction,
  });
  if (canonicalSha256(baselineTuple) === canonicalSha256(challengerTuple)) {
    return "identical";
  }
  if (
    isDeterministicEpochResetPendingWrapper({
      baseline: baselineTuple,
      challenger: challengerTuple,
      challengerRow: input.challenger,
    })
  ) {
    return "epoch_reset_pending_wrapper";
  }
  const nonHardRestatement = classifySafeNonHardCalibrationRestatement({
    baseline: baselineTuple,
    challenger: challengerTuple,
    challengerRow: input.challenger,
  });
  if (nonHardRestatement !== null) {
    return nonHardRestatement;
  }
  if (
    canonicalSha256(decisionActionSemanticTuple(baselineTuple)) !==
    canonicalSha256(decisionActionSemanticTuple(challengerTuple))
  ) {
    return "semantic_drift";
  }
  return "semantic_drift";
}

export function aboveBreakEvenProjectionDrift(input: {
  baseline: BaselineRow["baseline"];
  baselineRoas: number | null;
  baselineBreakEvenRoas: number | null;
  challenger: ChallengerRow | null;
}) {
  return compareAboveBreakEvenProjection(input) === "semantic_drift";
}

export function aboveBreakEvenCalibrationRestatement(input: {
  baseline: BaselineRow["baseline"];
  baselineRoas: number | null;
  baselineBreakEvenRoas: number | null;
  challenger: ChallengerRow | null;
}) {
  return compareAboveBreakEvenProjection(input) === "calibration_restatement";
}

export function aboveBreakEvenProfileAvailabilityRestatement(input: {
  baseline: BaselineRow["baseline"];
  baselineRoas: number | null;
  baselineBreakEvenRoas: number | null;
  challenger: ChallengerRow | null;
}) {
  return (
    compareAboveBreakEvenProjection(input) ===
    "profile_availability_restatement"
  );
}

export function aboveBreakEvenSafetyRepair(input: {
  baseline: BaselineRow["baseline"];
  baselineRoas: number | null;
  baselineBreakEvenRoas: number | null;
  challenger: ChallengerRow | null;
}) {
  return compareAboveBreakEvenProjection(input) === "safety_repair";
}

const HARD_ACTION_LABELS = new Set<DecisionLabel>(["scale", "cut", "refresh"]);

function isHardActionLabel(
  label: DecisionLabel | null,
): label is "scale" | "cut" | "refresh" {
  return label !== null && HARD_ACTION_LABELS.has(label);
}

export function d036HardActionTupleValid(row: ChallengerRow) {
  if (row.rawLabel === null || row.publishedLabel === null) return false;
  const pendingBadges =
    row.badges?.filter((badge) => badge.type === "pending_transition") ?? [];
  const hasCanonicalPendingBadge =
    pendingBadges.length === 1 &&
    canonicalSha256(pendingBadges[0]) ===
      canonicalSha256(PENDING_TRANSITION_BADGE);
  const hasAnyPendingReason =
    row.reason?.startsWith("[Pending hard action:") === true;
  if (!isHardActionLabel(row.rawLabel)) {
    return (
      row.publishedLabel === row.rawLabel &&
      row.hysteresisSuppressed === false &&
      row.simulatedAuthorizedAction === null &&
      pendingBadges.length === 0 &&
      !hasAnyPendingReason
    );
  }
  const hardLabel = row.rawLabel;
  const hasMatchingSameEngineRawPrior =
    row.priorHysteresisStatus === "current_epoch_replayed" &&
    row.priorHysteresisSourceEngineVersion === NATIVE_AD_ENGINE_VERSION &&
    row.priorRawLabel === hardLabel;
  const pendingReasonPrefix = `[Pending hard action: ${hardLabel}] No hard action is published until this signal repeats on the next evaluation. Current evidence: `;
  if (!hasMatchingSameEngineRawPrior) {
    return (
      row.publishedLabel === "keep" &&
      row.hysteresisSuppressed === true &&
      row.blockedActionType === hardLabel &&
      row.simulatedAuthorizedAction === null &&
      hasCanonicalPendingBadge &&
      row.reason?.startsWith(pendingReasonPrefix) === true &&
      row.reason.length > pendingReasonPrefix.length
    );
  }
  const authorityBlocked = row.authorityBlocker !== null;
  return (
    row.publishedLabel === hardLabel &&
    row.hysteresisSuppressed === false &&
    row.blockedActionType === (authorityBlocked ? hardLabel : null) &&
    row.simulatedAuthorizedAction === (authorityBlocked ? null : hardLabel) &&
    pendingBadges.length === 0 &&
    !hasAnyPendingReason
  );
}

export function d036PendingCutTupleValid(row: ChallengerRow) {
  return d036HardActionTupleValid(row);
}

function hasPendingTransition(row: ChallengerRow) {
  return (
    row.hysteresisSuppressed === true ||
    row.badges?.some((badge) => badge.type === "pending_transition") === true
  );
}

export function d063ExpandedStripSemanticViolation(row: ChallengerRow) {
  const audit = row.policyAudit;
  if (audit?.zone !== "expanded_economic_loss" || !audit.matureForCut) {
    return false;
  }
  if (audit.recentEvidenceStatus === "confirmed_loss") {
    if (row.preAuthorityLabel !== "cut") {
      return true;
    }
    const diagnosticHold =
      row.rawLabel === "diagnose" &&
      row.publishedLabel === "diagnose" &&
      row.authorityBlocker !== null &&
      row.authorityBlocker !== "recent_recovery_unverifiable" &&
      row.blockedActionType === "cut" &&
      row.simulatedAuthorizedAction === null &&
      !hasPendingTransition(row);
    if (diagnosticHold) return false;
    if (row.rawLabel !== "cut") return true;
    // D063 owns the economic verdict, not pre-existing authority gates. A
    // confirmed loss may still be held by campaign context, source freshness,
    // or another canonical blocker. Those rows must remain non-executable and
    // retain Cut provenance; only an unblocked row is judged by the exact D036
    // pending/confirmed tuple.
    if (row.authorityBlocker !== null) {
      return !(
        row.authorityBlocker !== "recent_recovery_unverifiable" &&
        row.blockedActionType === "cut" &&
        row.simulatedAuthorizedAction === null
      );
    }
    return !d036PendingCutTupleValid(row);
  }
  if (audit.recentEvidenceStatus === "recovery") {
    return !(
      row.preAuthorityLabel === "keep" &&
      row.authorityBlocker === null &&
      row.rawLabel === "keep" &&
      row.publishedLabel === "keep" &&
      row.blockedActionType === null &&
      row.simulatedAuthorizedAction === null &&
      !hasPendingTransition(row)
    );
  }
  if (
    audit.recentEvidenceStatus === "thin" ||
    audit.recentEvidenceStatus === "unverifiable"
  ) {
    return !(
      row.preAuthorityLabel === "cut" &&
      row.authorityBlocker === "recent_recovery_unverifiable" &&
      row.rawLabel === "test_more" &&
      row.publishedLabel === "test_more" &&
      row.blockedActionType === "cut" &&
      row.simulatedAuthorizedAction === null &&
      !hasPendingTransition(row)
    );
  }
  return true;
}

export function buildD063ReplayPolicyAudit(
  challengers: readonly ChallengerRow[],
) {
  const expanded = challengers.filter(
    (row) => row.policyAudit?.zone === "expanded_economic_loss",
  );
  const matureExpanded = expanded.filter(
    (row) => row.policyAudit?.matureForCut === true,
  );
  const expandedByRecentStatus = (
    status: ExpandedEconomicRecentEvidence["status"],
  ) =>
    matureExpanded.filter(
      (row) => row.policyAudit?.recentEvidenceStatus === status,
    );
  const confirmedLoss = expandedByRecentStatus("confirmed_loss");
  const recovery = expandedByRecentStatus("recovery");
  const thin = expandedByRecentStatus("thin");
  const unverifiable = expandedByRecentStatus("unverifiable");
  const held = [...thin, ...unverifiable];
  const p25NullOverlayInstalled = challengers.filter(
    (row) =>
      row.policyAudit?.canonicalBottomQuartileRatio === null &&
      row.policyAudit.accountAovOverlayInstalled,
  );
  const p25NullOverlayActivated = p25NullOverlayInstalled.filter(
    (row) => row.policyAudit?.accountAovOverlayActivated === true,
  );
  const p25BackedOverlayInstalled = challengers.filter(
    (row) =>
      row.policyAudit?.canonicalBottomQuartileRatio !== null &&
      row.policyAudit?.canonicalBottomQuartileRatio !== undefined &&
      row.policyAudit.accountAovOverlayInstalled,
  );
  return {
    compatibilityControl: {
      mode: "current_engine_with_D063_expanded_strip_collapsed_to_legacy_boundary",
      historicalEngineReplay: false,
      legacySafeZoneRows: challengers.filter(
        (row) => row.policyAudit?.zone === "legacy_safe_loss",
      ).length,
      legacySafeZoneProjectionDriftRows: challengers.filter(
        (row) => row.policyAudit?.legacySafeZoneProjectionDrift === true,
      ).length,
    },
    expandedStrip: {
      rows: expanded.length,
      immatureRows: expanded.length - matureExpanded.length,
      matureRows: matureExpanded.length,
      confirmedLoss: {
        rows: confirmedLoss.length,
        rawCutRows: confirmedLoss.filter((row) => row.rawLabel === "cut")
          .length,
        d036PendingRows: confirmedLoss.filter(
          (row) =>
            row.rawLabel === "cut" &&
            row.publishedLabel === "keep" &&
            row.hysteresisSuppressed === true,
        ).length,
        d036ConfirmedRows: confirmedLoss.filter(
          (row) =>
            row.rawLabel === "cut" &&
            row.publishedLabel === "cut" &&
            row.hysteresisSuppressed === false,
        ).length,
      },
      recovery: {
        rows: recovery.length,
        keepRows: recovery.filter(
          (row) => row.rawLabel === "keep" && row.publishedLabel === "keep",
        ).length,
      },
      thin: { rows: thin.length },
      unverifiable: { rows: unverifiable.length },
      held: {
        rows: held.length,
        authorizedCutRows: held.filter(
          (row) => row.simulatedAuthorizedAction === "cut",
        ).length,
        pendingRows: held.filter(hasPendingTransition).length,
      },
      semanticViolationRows: matureExpanded.filter(
        d063ExpandedStripSemanticViolation,
      ).length,
    },
    accountAovOverlay: {
      p25NullInstalledRows: p25NullOverlayInstalled.length,
      p25NullActivatedRows: p25NullOverlayActivated.length,
      p25BackedInstalledRows: p25BackedOverlayInstalled.length,
      // Installation proves the live profile path is reachable. A fixed live
      // cohort is not required to manufacture a losing active ad merely to
      // activate it; the frozen production-function fixture proves the Cut
      // transition when a qualifying opportunity exists.
      p25NullReachabilityFailure: p25NullOverlayInstalled.length === 0 ? 1 : 0,
    },
  };
}

export function exactMediaBuyerScopeRequested(
  args: Pick<ParsedArgs, "auditProviderAccounts">,
) {
  const requested = new Set(
    args.auditProviderAccounts.map((scope) =>
      canonicalMetaProviderAccountId(scope.providerAccountId),
    ),
  );
  const expected = Object.values(EXACT_MEDIA_BUYER_PROVIDER_ACCOUNT_IDS);
  return expected.every((id) => requested.has(id));
}

function canonicalMetaProviderAccountId(value: string) {
  const trimmed = value.trim();
  const numeric = /^(?:act_)?(\d+)$/i.exec(trimmed);
  return numeric ? `act_${numeric[1]}` : trimmed;
}

function focusedEconomicProjectionAudit(
  pair:
    | {
        baseline: BaselineRow;
        challenger: ChallengerRow | null;
      }
    | null,
) {
  if (!pair?.challenger) {
    return {
      evidenceState: "missing_challenger" as const,
      projectionValid: false,
      roas: pair?.baseline.creativeInput.roas ?? null,
      breakEvenRoas: pair?.baseline.creativeInput.breakevenRoas ?? null,
    };
  }
  const { baseline, challenger } = pair;
  const roas = baseline.creativeInput.roas;
  const breakEvenRoas = baseline.creativeInput.breakevenRoas;
  if (baseline.creativeInput.effectiveStatus !== "ACTIVE") {
    return {
      evidenceState: "non_active" as const,
      projectionValid: challenger.simulatedAuthorizedAction === null,
      roas,
      breakEvenRoas,
    };
  }
  if (
    roas !== null &&
    Number.isFinite(roas) &&
    breakEvenRoas !== null &&
    Number.isFinite(breakEvenRoas) &&
    roas + 1e-9 >= breakEvenRoas
  ) {
    return {
      evidenceState: "at_or_above_breakeven" as const,
      projectionValid: !aboveBreakEvenCutProjectionViolation({
        roas,
        breakEvenRoas,
        labels: [
          challenger.preAuthorityLabel,
          challenger.rawLabel,
          challenger.publishedLabel,
        ],
        blockedActionType: challenger.blockedActionType,
        authorizedAction: challenger.simulatedAuthorizedAction,
        badges: challenger.badges,
      }),
      roas,
      breakEvenRoas,
    };
  }
  const policyAudit = challenger.policyAudit;
  if (
    policyAudit?.zone === "expanded_economic_loss" &&
    policyAudit.matureForCut
  ) {
    return {
      evidenceState: `expanded_${policyAudit.recentEvidenceStatus}` as const,
      projectionValid: !d063ExpandedStripSemanticViolation(challenger),
      roas,
      breakEvenRoas,
    };
  }
  if (policyAudit?.zone === "expanded_economic_loss") {
    return {
      evidenceState: "expanded_immature" as const,
      projectionValid: challenger.simulatedAuthorizedAction !== "cut",
      roas,
      breakEvenRoas,
    };
  }
  return {
    evidenceState: "other_canonical" as const,
    projectionValid: true,
    roas,
    breakEvenRoas,
  };
}

export function buildD063ExactMediaBuyerAudit(input: {
  args: Pick<ParsedArgs, "auditProviderAccounts">;
  requireAudit?: boolean;
  pairedRows: ReadonlyArray<{
    baseline: BaselineRow;
    challenger: ChallengerRow | null;
  }>;
}) {
  const declaredScopeComplete = exactMediaBuyerScopeRequested(input.args);
  const required = input.requireAudit === true || declaredScopeComplete;
  const expectedProviderAccountIdSet = new Set<string>(
    Object.values(EXACT_MEDIA_BUYER_PROVIDER_ACCOUNT_IDS),
  );
  const requestedProviderAccountIds = [
    ...new Set(
      input.args.auditProviderAccounts.map((scope) =>
        canonicalMetaProviderAccountId(scope.providerAccountId),
      ),
    ),
  ].sort();
  const unexpectedRequestedProviderAccountIds =
    requestedProviderAccountIds.filter(
      (providerAccountId) =>
        !expectedProviderAccountIdSet.has(providerAccountId),
    );
  const providerAccountCoverage = Object.fromEntries(
    Object.entries(EXACT_MEDIA_BUYER_PROVIDER_ACCOUNT_IDS).map(
      ([name, providerAccountId]) => [
        name,
        input.pairedRows.filter(
          ({ baseline }) =>
            canonicalMetaProviderAccountId(baseline.providerAccountId) ===
            providerAccountId,
        ).length,
      ],
    ),
  ) as Record<keyof typeof EXACT_MEDIA_BUYER_PROVIDER_ACCOUNT_IDS, number>;
  const auditProviderAccounts = input.args.auditProviderAccounts.map((scope) => {
    const matchingAccountKeys = [
      ...new Set(
        input.pairedRows
          .filter(
            ({ baseline }) =>
              businessSelectorMatches(baseline, scope.businessSelector) &&
              canonicalMetaProviderAccountId(baseline.providerAccountId) ===
                canonicalMetaProviderAccountId(scope.providerAccountId),
          )
          .map(({ baseline }) => accountKey(baseline)),
      ),
    ].sort();
    return {
      ...scope,
      matchingAccountKeys: matchingAccountKeys.map((key) =>
        canonicalSha256(key),
      ),
      valid: matchingAccountKeys.length === 1,
    };
  });
  const grandmixRows = input.pairedRows.filter(
    ({ baseline }) =>
      canonicalMetaProviderAccountId(baseline.providerAccountId) ===
      EXACT_MEDIA_BUYER_PROVIDER_ACCOUNT_IDS.grandmix,
  );
  const claudeRows = grandmixRows.filter(
    ({ baseline }) =>
      baseline.creativeInput.adId === EXACT_GRANDMIX_AD_IDS.claudeBathroomMeta,
  );
  const shippingRows = grandmixRows.filter(
    ({ baseline }) =>
      baseline.creativeInput.adId ===
      EXACT_GRANDMIX_AD_IDS.bathroomMetaShipping,
  );
  const claude = claudeRows[0] ?? null;
  const shipping = shippingRows[0] ?? null;
  const claudeEconomicProjection = focusedEconomicProjectionAudit(claude);
  const shippingEconomicProjection = focusedEconomicProjectionAudit(shipping);
  const theSwafRows = input.pairedRows.filter(
    ({ baseline }) =>
      canonicalMetaProviderAccountId(baseline.providerAccountId) ===
      EXACT_MEDIA_BUYER_PROVIDER_ACCOUNT_IDS.theSwafMain,
  );
  const theSwafActiveRows = theSwafRows.filter(
    ({ baseline }) => baseline.creativeInput.effectiveStatus === "ACTIVE",
  ).length;
  const theSwafPausedRows = theSwafRows.filter(
    ({ baseline }) => baseline.creativeInput.effectiveStatus === "PAUSED",
  ).length;
  const theSwafActionableRows = theSwafRows.filter(
    ({ challenger }) =>
      challenger !== null && challenger.simulatedAuthorizedAction !== null,
  ).length;
  const theSwafNonActiveActionableRows = theSwafRows.filter(
    ({ baseline, challenger }) =>
      baseline.creativeInput.effectiveStatus !== "ACTIVE" &&
      challenger !== null &&
      challenger.simulatedAuthorizedAction !== null,
  ).length;
  const exactActivePreAuthorityCutRows = input.pairedRows.filter(
    ({ baseline, challenger }) =>
      expectedProviderAccountIdSet.has(
        canonicalMetaProviderAccountId(baseline.providerAccountId),
      ) &&
      baseline.creativeInput.effectiveStatus === "ACTIVE" &&
      challenger?.preAuthorityLabel === "cut",
  );
  const exactActivePhysicalAccountReadyPreAuthorityCutRows =
    exactActivePreAuthorityCutRows.filter(
      ({ challenger }) =>
        challenger?.selectedCellMetaAovQuality === "ready" &&
        (challenger.selectedCellMetaAovPurchaseCount ?? 0) >= 20 &&
        (challenger.selectedCellMatureAdCount ?? 0) >= 10 &&
        challenger.spendUnitAuthorityBasis ===
          "physical_account_purchase_aov_90d" &&
        challenger.spendUnitAuthorityStatus === "ready" &&
        challenger.accountAovEvidenceStatus === "ready",
    );
  const exactActiveCutReadyRows =
    exactActivePhysicalAccountReadyPreAuthorityCutRows.filter(
      ({ challenger }) => challenger?.selectedCellCutAuthorityBasis !== null,
    );
  const exactActiveCutReadyProfileBlockedRows =
    exactActivePhysicalAccountReadyPreAuthorityCutRows.filter(
      ({ challenger }) =>
        challenger?.authorityBlocker === "profile_hard_action_ineligible",
    );
  const exactActiveCutAuthorityBasisMissingRows =
    exactActivePhysicalAccountReadyPreAuthorityCutRows.filter(
      ({ challenger }) => challenger?.selectedCellCutAuthorityBasis === null,
    );
  const violations = required
    ? [
        !declaredScopeComplete
          ? "exact_media_buyer_audit_scope_incomplete"
          : null,
        unexpectedRequestedProviderAccountIds.length > 0
          ? `unexpected_exact_scope_provider_accounts:${unexpectedRequestedProviderAccountIds.join(",")}`
          : null,
        ...auditProviderAccounts
          .filter((scope) => !scope.valid)
          .map(
            (scope) =>
              `invalid_exact_audit_scope:${scope.businessSelector}:${scope.providerAccountId}`,
          ),
        ...Object.entries(providerAccountCoverage)
          .filter(([, rowCount]) => rowCount === 0)
          .map(([name]) => `missing_exact_account:${name}`),
        claudeRows.length !== 1
          ? `grandmix_claude_identity_count:${claudeRows.length}`
          : null,
        claudeRows.length === 1 &&
        !claudeEconomicProjection.projectionValid
          ? `grandmix_focus_ad_projection_contradiction:${EXACT_GRANDMIX_AD_IDS.claudeBathroomMeta}`
          : null,
        shippingRows.length !== 1
          ? `grandmix_shipping_identity_count:${shippingRows.length}`
          : null,
        shippingRows.length === 1 &&
        !shippingEconomicProjection.projectionValid
          ? `grandmix_focus_ad_projection_contradiction:${EXACT_GRANDMIX_AD_IDS.bathroomMetaShipping}`
          : null,
        theSwafRows.length === 0 ? "theswaf_main_missing_rows" : null,
        theSwafNonActiveActionableRows > 0
          ? `theswaf_main_non_active_actionable_rows:${theSwafNonActiveActionableRows}`
          : null,
        exactActiveCutReadyProfileBlockedRows.length > 0
          ? `exact_active_cut_ready_profile_blocked_rows:${exactActiveCutReadyProfileBlockedRows.length}`
          : null,
        exactActiveCutAuthorityBasisMissingRows.length > 0
          ? `exact_active_physical_account_ready_cut_authority_basis_missing_rows:${exactActiveCutAuthorityBasisMissingRows.length}`
          : null,
      ].filter((value): value is string => value !== null)
    : [];
  return {
    required,
    auditScopeMode: "independent_cli_audit_scope" as const,
    declaredScopeComplete,
    auditProviderAccounts,
    expectedProviderAccountIds: EXACT_MEDIA_BUYER_PROVIDER_ACCOUNT_IDS,
    requestedProviderAccountIds,
    unexpectedRequestedProviderAccountIds,
    providerAccountCoverage,
    grandmix: {
      claudeBathroomMeta: {
        adId: EXACT_GRANDMIX_AD_IDS.claudeBathroomMeta,
        identityRows: claudeRows.length,
        ...claudeEconomicProjection,
      },
      bathroomMetaShipping: {
        adId: EXACT_GRANDMIX_AD_IDS.bathroomMetaShipping,
        identityRows: shippingRows.length,
        ...shippingEconomicProjection,
      },
    },
    theSwafMain: {
      rows: theSwafRows.length,
      activeRows: theSwafActiveRows,
      pausedRows: theSwafPausedRows,
      otherStatusRows:
        theSwafRows.length - theSwafActiveRows - theSwafPausedRows,
      actionableRows: theSwafActionableRows,
      nonActiveActionableRows: theSwafNonActiveActionableRows,
    },
    activeCutReachability: {
      activePreAuthorityCutRows: exactActivePreAuthorityCutRows.length,
      physicalAccountReadyPreAuthorityCutRows:
        exactActivePhysicalAccountReadyPreAuthorityCutRows.length,
      cutReadyPreAuthorityRows: exactActiveCutReadyRows.length,
      profileBlockedRows: exactActiveCutReadyProfileBlockedRows.length,
      profileBlockedAdIds: exactActiveCutReadyProfileBlockedRows
        .map(({ baseline }) => baseline.creativeInput.adId)
        .sort(),
      missingCutAuthorityBasisRows:
        exactActiveCutAuthorityBasisMissingRows.length,
      missingCutAuthorityBasisAdIds: exactActiveCutAuthorityBasisMissingRows
        .map(({ baseline }) => baseline.creativeInput.adId)
        .sort(),
    },
    contradictions: violations.length,
    violations,
  };
}

export function aovPositiveControlFailure(
  qualifyingOpportunities: number,
  qualifyingRawCutTransitions: number,
) {
  for (const [field, value] of [
    ["qualifyingOpportunities", qualifyingOpportunities],
    ["qualifyingRawCutTransitions", qualifyingRawCutTransitions],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${field} must be a non-negative integer`);
    }
  }
  return qualifyingOpportunities > 0 && qualifyingRawCutTransitions === 0
    ? 1
    : 0;
}

function summarizeAccount(
  rows: BaselineRow[],
  challengers: ChallengerRow[],
  slices: PreparedAccountSlice[],
) {
  const baselineRaw = countLabels(rows.map((row) => row.baseline.rawLabel));
  const baselinePublished = countLabels(
    rows.map((row) => row.baseline.publishedLabel),
  );
  const challengerRaw = countLabels(challengers.map((row) => row.rawLabel));
  const challengerPublished = countLabels(
    challengers.map((row) => row.publishedLabel),
  );
  const baselineAuthorityContradictions = rows.filter(
    (row) =>
      (row.baseline.authorityBlocker !== null &&
        row.baseline.authorizedAction !== null) ||
      (row.baseline.authorizedAction !== null &&
        (row.baseline.authorizedAction !== row.baseline.rawLabel ||
          row.baseline.authorizedAction !== row.baseline.publishedLabel)),
  ).length;
  const challengerAuthorityContradictions = challengers.filter(
    (row) =>
      (row.authorityBlocker !== null &&
        row.simulatedAuthorizedAction !== null) ||
      (row.hysteresisSuppressed === true &&
        row.simulatedAuthorizedAction !== null) ||
      (row.simulatedAuthorizedAction !== null &&
        (row.simulatedAuthorizedAction !== row.rawLabel ||
          row.simulatedAuthorizedAction !== row.publishedLabel)),
  ).length;
  return {
    cohortRows: rows.length,
    baseline: {
      preAuthorityCut: rows.filter(
        (row) => row.baseline.preAuthorityLabel === "cut",
      ).length,
      blocked: rows.filter(
        (row) =>
          row.baseline.authorityBlocker !== null ||
          row.baseline.blockedActionType !== null,
      ).length,
      rawLabels: baselineRaw,
      publishedLabels: baselinePublished,
    },
    challenger: {
      computed: challengers.filter((row) => row.status === "computed").length,
      failed: challengers.filter((row) => row.status === "failed").length,
      ready: challengers.filter((row) => row.profileStatus === "ready").length,
      softOnly: challengers.filter((row) => row.profileStatus === "soft_only")
        .length,
      priorHysteresisStatus: {
        none: challengers.filter((row) => row.priorHysteresisStatus === "none")
          .length,
        currentEpochReplayed: challengers.filter(
          (row) => row.priorHysteresisStatus === "current_epoch_replayed",
        ).length,
        epochMismatch: challengers.filter(
          (row) => row.priorHysteresisStatus === "epoch_mismatch",
        ).length,
        incompleteLineage: challengers.filter(
          (row) => row.priorHysteresisStatus === "incomplete_lineage",
        ).length,
      },
      preAuthorityCut: challengers.filter(
        (row) => row.preAuthorityLabel === "cut",
      ).length,
      rawCut: challengerRaw.cut,
      publishedCut: challengerPublished.cut,
      d036ConfirmedCut: challengers.filter(
        (row) =>
          row.rawLabel === "cut" &&
          row.publishedLabel === "cut" &&
          row.hysteresisSuppressed === false,
      ).length,
      d036PendingCut: challengers.filter(
        (row) =>
          row.rawLabel === "cut" &&
          row.publishedLabel !== "cut" &&
          row.hysteresisSuppressed === true,
      ).length,
      blocked: challengers.filter(
        (row) =>
          row.authorityBlocker !== null || row.blockedActionType !== null,
      ).length,
      rawLabels: challengerRaw,
      publishedLabels: challengerPublished,
    },
    authorityContradictions: {
      baseline: baselineAuthorityContradictions,
      challenger: challengerAuthorityContradictions,
      accountAovProof: slices.reduce(
        (sum, slice) => sum + slice.authorityProofContradictions,
        0,
      ),
      total:
        baselineAuthorityContradictions +
        challengerAuthorityContradictions +
        slices.reduce(
          (sum, slice) => sum + slice.authorityProofContradictions,
          0,
        ),
    },
    scaleRefreshDeltas: {
      scale: {
        baselineRaw: baselineRaw.scale,
        challengerRaw: challengerRaw.scale,
        rawDelta: challengerRaw.scale - baselineRaw.scale,
        baselinePublished: baselinePublished.scale,
        challengerPublished: challengerPublished.scale,
        publishedDelta: challengerPublished.scale - baselinePublished.scale,
      },
      refresh: {
        baselineRaw: baselineRaw.refresh,
        challengerRaw: challengerRaw.refresh,
        rawDelta: challengerRaw.refresh - baselineRaw.refresh,
        baselinePublished: baselinePublished.refresh,
        challengerPublished: challengerPublished.refresh,
        publishedDelta: challengerPublished.refresh - baselinePublished.refresh,
      },
    },
    aboveBreakEvenCutProjectionViolations: {
      baseline: rows.filter((row) =>
        aboveBreakEvenCutProjectionViolation({
          roas: numberOrNull(row.creativeInput.roas),
          breakEvenRoas: numberOrNull(row.creativeInput.breakevenRoas),
          labels: [
            row.baseline.preAuthorityLabel,
            row.baseline.rawLabel,
            row.baseline.publishedLabel,
          ],
          blockedActionType: row.baseline.blockedActionType,
          authorizedAction: row.baseline.authorizedAction,
          badges: row.baseline.badges,
        }),
      ).length,
      challenger: challengers.filter((row) =>
        aboveBreakEvenCutProjectionViolation({
          roas: row.roas,
          breakEvenRoas: row.breakEvenRoas,
          labels: [row.preAuthorityLabel, row.rawLabel, row.publishedLabel],
          blockedActionType: row.blockedActionType,
          authorizedAction: row.simulatedAuthorizedAction,
          badges: row.badges,
        }),
      ).length,
    },
  };
}

export interface ReplayReleaseGateChecks {
  executionFailures: number;
  schedulerPopulationContradictions: number;
  authorityProofOrLineageContradictions: number;
  canonicalEnvelopeContradictions: number;
  currentDayRestatementContradictions: number;
  unresolvedSourceDimensionContradictions: number;
  profileCalibrationParityContradictions: number;
  requestedScopeCoverageContradictions: number;
  aboveBreakEvenCutProjectionViolations: number;
  aboveBreakEvenProjectionDriftRows: number;
  scaleRefreshIdentityDriftRows: number;
  calibrationCutoffFallbackSlices: number;
  waveOrHydrationCoverageContradictions: number;
  aovPositiveControlFailures: number;
  d036PerRowTransitionViolations: number;
  d063LegacySafeZoneProjectionDriftRows: number;
  d063ExpandedStripSemanticViolationRows: number;
  d063ExpandedHeldAuthorizedCutRows: number;
  d063ExpandedHeldPendingRows: number;
  d063AccountAovP25NullReachabilityFailures: number;
  d063AccountAovP25BackedOverlayRows: number;
  d063ExactMediaBuyerContradictions: number;
}

export function evaluateReplayReleaseGate(checks: ReplayReleaseGateChecks) {
  for (const [name, value] of Object.entries(checks)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`releaseGate.${name} must be a non-negative integer`);
    }
  }
  const failures = [
    checks.executionFailures > 0
      ? `execution_failures:${checks.executionFailures}`
      : null,
    checks.schedulerPopulationContradictions > 0
      ? `scheduler_population_contradictions:${checks.schedulerPopulationContradictions}`
      : null,
    checks.authorityProofOrLineageContradictions > 0
      ? `authority_proof_or_lineage_contradictions:${checks.authorityProofOrLineageContradictions}`
      : null,
    checks.canonicalEnvelopeContradictions > 0
      ? `canonical_envelope_contradictions:${checks.canonicalEnvelopeContradictions}`
      : null,
    checks.currentDayRestatementContradictions > 0
      ? `current_day_restatement_contradictions:${checks.currentDayRestatementContradictions}`
      : null,
    checks.unresolvedSourceDimensionContradictions > 0
      ? `unresolved_source_dimension_contradictions:${checks.unresolvedSourceDimensionContradictions}`
      : null,
    checks.profileCalibrationParityContradictions > 0
      ? `profile_calibration_parity_contradictions:${checks.profileCalibrationParityContradictions}`
      : null,
    checks.requestedScopeCoverageContradictions > 0
      ? `requested_scope_coverage_contradictions:${checks.requestedScopeCoverageContradictions}`
      : null,
    checks.aboveBreakEvenCutProjectionViolations > 0
      ? `above_break_even_cut_projection_violations:${checks.aboveBreakEvenCutProjectionViolations}`
      : null,
    checks.aboveBreakEvenProjectionDriftRows > 0
      ? `above_break_even_projection_drift_rows:${checks.aboveBreakEvenProjectionDriftRows}`
      : null,
    checks.scaleRefreshIdentityDriftRows > 0
      ? `scale_refresh_identity_drift_rows:${checks.scaleRefreshIdentityDriftRows}`
      : null,
    checks.calibrationCutoffFallbackSlices > 0
      ? `calibration_cutoff_fallback_slices:${checks.calibrationCutoffFallbackSlices}`
      : null,
    checks.waveOrHydrationCoverageContradictions > 0
      ? `wave_or_hydration_coverage_contradictions:${checks.waveOrHydrationCoverageContradictions}`
      : null,
    checks.aovPositiveControlFailures > 0
      ? `aov_positive_control_failures:${checks.aovPositiveControlFailures}`
      : null,
    checks.d036PerRowTransitionViolations > 0
      ? `d036_per_row_transition_violations:${checks.d036PerRowTransitionViolations}`
      : null,
    checks.d063LegacySafeZoneProjectionDriftRows > 0
      ? `d063_legacy_safe_zone_projection_drift_rows:${checks.d063LegacySafeZoneProjectionDriftRows}`
      : null,
    checks.d063ExpandedStripSemanticViolationRows > 0
      ? `d063_expanded_strip_semantic_violation_rows:${checks.d063ExpandedStripSemanticViolationRows}`
      : null,
    checks.d063ExpandedHeldAuthorizedCutRows > 0
      ? `d063_expanded_held_authorized_cut_rows:${checks.d063ExpandedHeldAuthorizedCutRows}`
      : null,
    checks.d063ExpandedHeldPendingRows > 0
      ? `d063_expanded_held_pending_rows:${checks.d063ExpandedHeldPendingRows}`
      : null,
    checks.d063AccountAovP25NullReachabilityFailures > 0
      ? `d063_account_aov_p25_null_reachability_failures:${checks.d063AccountAovP25NullReachabilityFailures}`
      : null,
    checks.d063AccountAovP25BackedOverlayRows > 0
      ? `d063_account_aov_p25_backed_overlay_rows:${checks.d063AccountAovP25BackedOverlayRows}`
      : null,
    checks.d063ExactMediaBuyerContradictions > 0
      ? `d063_exact_media_buyer_contradictions:${checks.d063ExactMediaBuyerContradictions}`
      : null,
  ].filter((reason): reason is string => reason !== null);
  return {
    passed: failures.length === 0,
    exitCode: failures.length === 0 ? 0 : 2,
    checks,
    failures,
  };
}

function sha256Text(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

interface RepositoryContentManifestEntry {
  path: string;
  tracking: "tracked" | "untracked";
  kind: "file" | "symlink" | "missing";
  bytes: number;
  sha256: string | null;
}

function parseNullDelimitedPaths(value: string) {
  return value
    .split("\0")
    .filter((path) => path.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeRepositoryPath(path: string) {
  return path.split(sep).join("/");
}

export function resolveReplayRepositoryOutputExclusions(
  repoRoot: string,
  args: Pick<
    ParsedArgs,
    "jsonOut" | "compactJsonOut" | "provenanceExcludePaths"
  >,
) {
  const outputPaths = [args.jsonOut, args.compactJsonOut].filter(
    (path): path is string => path !== null,
  );
  const explicitPaths = args.provenanceExcludePaths;
  const checksumSibling = (path: string) =>
    path.toLowerCase().endsWith(".json")
      ? `${path.slice(0, -5)}.sha256`
      : `${path}.sha256`;
  const temporarySibling = (path: string) => `${path}.tmp`;
  const toRepositoryPath = (path: string, required: boolean) => {
      const relativePath = relative(repoRoot, resolve(path));
      if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        if (!required) return null;
        throw new Error(
          `Replay provenance exclusions must be files inside the repository: ${path}`,
        );
      }
      return normalizeRepositoryPath(relativePath);
  };
  const repositoryOutputPaths = outputPaths.flatMap((path) => {
    const repositoryPath = toRepositoryPath(path, false);
    return repositoryPath
      ? [
          repositoryPath,
          checksumSibling(repositoryPath),
          temporarySibling(repositoryPath),
        ]
      : [];
  });
  const repositoryExplicitPaths = explicitPaths.flatMap((path) => {
    const repositoryPath = toRepositoryPath(path, true);
    if (
      !/^docs\/creative-decision-center\/generated\/native-ad-account-aov-authority-replay-[^/]+\.json$/.test(
        repositoryPath!,
      )
    ) {
      throw new Error(
        `Replay provenance exclusions may name only sibling replay JSON outputs: ${path}`,
      );
    }
    return [
      repositoryPath!,
      checksumSibling(repositoryPath!),
      temporarySibling(repositoryPath!),
    ];
  });
  return [...new Set([...repositoryOutputPaths, ...repositoryExplicitPaths])]
    .map(normalizeRepositoryPath)
    .sort((left, right) => left.localeCompare(right));
}

export function buildRepositoryContentManifest(
  repoRoot: string,
  excludedRepositoryPaths: readonly string[],
) {
  const excluded = new Set(excludedRepositoryPaths);
  const trackedPaths = parseNullDelimitedPaths(
    execFileSync("git", ["ls-files", "--cached", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );
  const tracked = new Set(trackedPaths);
  const repositoryPaths = parseNullDelimitedPaths(
    execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: repoRoot, encoding: "utf8" },
    ),
  ).filter((path) => !excluded.has(path));
  const entries: RepositoryContentManifestEntry[] = repositoryPaths.map(
    (path) => {
      const absolutePath = resolve(repoRoot, path);
      let stats;
      try {
        stats = lstatSync(absolutePath);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT" &&
          tracked.has(path)
        ) {
          return {
            path,
            tracking: "tracked",
            kind: "missing",
            bytes: 0,
            sha256: null,
          };
        }
        throw error;
      }
      const tracking = tracked.has(path) ? "tracked" : "untracked";
      if (stats.isSymbolicLink()) {
        const linkTarget = Buffer.from(readlinkSync(absolutePath), "utf8");
        return {
          path,
          tracking,
          kind: "symlink",
          bytes: linkTarget.byteLength,
          sha256: sha256Text(linkTarget),
        };
      }
      if (!stats.isFile()) {
        throw new Error(
          `Repository provenance cannot bind non-file path: ${path}`,
        );
      }
      const content = readFileSync(absolutePath);
      return {
        path,
        tracking,
        kind: "file",
        bytes: content.byteLength,
        sha256: sha256Text(content),
      };
    },
  );
  return {
    scope:
      "current_tracked_and_untracked_non_ignored_repository_content_excluding_declared_outputs" as const,
    excludedRepositoryPaths: [...excluded].sort((left, right) =>
      left.localeCompare(right),
    ),
    fileCount: entries.length,
    trackedFileCount: entries.filter((entry) => entry.tracking === "tracked")
      .length,
    untrackedFileCount: entries.filter(
      (entry) => entry.tracking === "untracked",
    ).length,
    missingTrackedFileCount: entries.filter((entry) => entry.kind === "missing")
      .length,
    contentBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    manifestSha256: canonicalSha256(entries),
  };
}

export function readReplayCodeProvenance(
  args: Pick<
    ParsedArgs,
    "jsonOut" | "compactJsonOut" | "provenanceExcludePaths"
  >,
  repoRootOverride?: string,
) {
  const repoRoot =
    repoRootOverride ??
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const gitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const excludedOutputPaths = resolveReplayRepositoryOutputExclusions(
    repoRoot,
    args,
  );
  const repositoryContentManifest = buildRepositoryContentManifest(
    repoRoot,
    excludedOutputPaths,
  );
  const sourceFiles = [
    "scripts/creative-decision-center/native-ad-account-aov-authority-replay.ts",
    "scripts/_operational-runtime.ts",
    "lib/creative-decision-engine/jobs/ad-decisions-job.ts",
    "lib/creative-decision-engine/jobs/ad-calibration-job.ts",
    "lib/creative-decision-engine/jobs/ad-operator-response-job.ts",
    "lib/creative-decision-engine/jobs/native-ad-scheduled.ts",
    "lib/creative-decision-engine/ad-account-decision-profile.ts",
    "lib/creative-decision-engine/account-decision-profile.ts",
    "lib/creative-decision-engine/canonical-evaluation.ts",
    "lib/creative-decision-engine/data-source.ts",
    "lib/creative-decision-engine/decision-stability.ts",
    "lib/creative-decision-engine/feature-flags.ts",
    "lib/creative-decision-engine/gates/cut-policy.ts",
    "lib/creative-decision-engine/gates/types.ts",
    "lib/creative-decision-engine/kind-aware-profile.ts",
    "lib/creative-decision-engine/types.ts",
    "lib/sync/active-businesses.ts",
    "lib/creative-decision-engine/__tests__/jobs/native-ad-frozen-exact-replay.test.ts",
    "lib/creative-decision-engine/__tests__/fixtures/native-ad-frozen-exact-replay.v1.json",
  ];
  return {
    gitHead,
    gitBranch,
    captureMode: "pre_output_repository_content_manifest" as const,
    repositoryContentManifest,
    sourceFiles: Object.fromEntries(
      sourceFiles.map((relativePath) => [
        relativePath,
        sha256Text(readFileSync(resolve(repoRoot, relativePath))),
      ]),
    ),
  };
}

export function assertReplayCodeProvenanceStable(
  before: ReturnType<typeof readReplayCodeProvenance>,
  args: Pick<
    ParsedArgs,
    "jsonOut" | "compactJsonOut" | "provenanceExcludePaths"
  >,
) {
  const after = readReplayCodeProvenance(args);
  const beforeHash = canonicalSha256(before);
  const afterHash = canonicalSha256(after);
  if (beforeHash !== afterHash) {
    throw new Error(
      `Replay source provenance changed while the artifact was generated: before=${beforeHash}, after=${afterHash}`,
    );
  }
}

function buildReport(input: {
  args: ParsedArgs;
  baselineRows: readonly BaselineRow[];
  baselineReadDiagnostics: FixedBaselineReadDiagnostics;
  schedulerPopulationCoverage: ReturnType<
    typeof buildSchedulerPopulationCoverage
  >;
  slices: PreparedAccountSlice[];
  slicePreparationFailures: ReplaySlicePreparationFailure[];
  challengers: ChallengerRow[];
  transaction: Record<string, string>;
}) {
  const accountRows = new Map<string, BaselineRow[]>();
  for (const row of input.baselineRows) {
    const key = accountKey(row);
    const rows = accountRows.get(key) ?? [];
    rows.push(row);
    accountRows.set(key, rows);
  }
  const waveCoverageProof = buildWaveCoverageProof(input.baselineRows);
  const frozenAnchorValidityByAccount = new Map(
    waveCoverageProof.accounts.map((proof) => [
      [
        proof.businessId,
        proof.providerAccountRefId,
        proof.providerAccountId,
      ].join("\u0000"),
      proof.valid,
    ]),
  );
  const anchorDimensionAssessmentBySlice = new Map(
    input.slices.map((slice) => [
      slice.sliceKey,
      assessReplayAnchorDimensions({
        slice,
        frozenAnchorProofValid:
          frozenAnchorValidityByAccount.get(slice.accountKey) === true,
      }),
    ]),
  );
  const summaries = [...accountRows.entries()]
    .map(([key, rows]) => {
      const first = rows[0]!;
      const challengers = input.challengers.filter(
        (row) => row.accountKey === key,
      );
      const slices = input.slices.filter((slice) => slice.accountKey === key);
      return {
        businessId: first.businessId,
        businessName: first.businessName,
        providerAccountRefId: first.providerAccountRefId,
        providerAccountId: first.providerAccountId,
        currentProviderAccountName: first.currentProviderAccountName,
        accountTimezone: first.accountTimezone,
        accountCurrency: first.accountCurrency,
        sourceReceipts: slices.map((slice) => ({
          cutoff: slice.calibrationCutoff,
          cutoffSource: slice.cutoffSource,
          rawSourceRowCount: slice.rawSourceRowCount,
          rawReceiptHash: slice.rawReceiptHash,
          sourceDimensionProof: slice.sourceDimensionProof,
          anchorDimensionAssessment:
            anchorDimensionAssessmentBySlice.get(slice.sliceKey) ??
            null,
          calibrationAdmission: {
            currency: slice.batch.sourceProvenance.currencyAdmission,
            timezone: slice.batch.sourceProvenance.timezoneAdmission,
          },
          batchInputManifestHash: slice.batch.inputManifestHash,
          sourceManifestHash: slice.batch.sourceManifestHash,
          calibrationBatch: {
            expectedCellCount: slice.batch.expectedCellCount,
            observationCount: slice.batch.observations.length,
            qualityCounts: slice.batch.qualityCounts,
          },
          calibrationCells: slice.cells.map((cell) => ({
            key: cell.key,
            matureAdCount: cell.matureAdCount,
            inputManifestHash: cell.inputManifestHash,
            sourceManifestHash: cell.sourceManifestHash,
            actionReadiness: cell.actionReadiness,
          })),
          accountAovEvidence: slice.batch.spendUnitAuthority.accountAovEvidence,
          spendUnitAuthority: {
            status: slice.batch.spendUnitAuthority.status,
            basis: slice.batch.spendUnitAuthority.basis,
            authorityHash: slice.batch.spendUnitAuthority.authorityHash,
          },
          profileConfig: {
            sourceMode: PROFILE_CONFIG_SOURCE_MODE,
            value: null,
          },
        })),
        ...summarizeAccount(rows, challengers, slices),
      };
    })
    .sort(
      (left, right) =>
        left.businessName.localeCompare(right.businessName) ||
        left.providerAccountId.localeCompare(right.providerAccountId),
    );
  const cohortKeys = input.baselineRows.map((row) => row.cohortKey).sort();
  const manifestHashes = input.challengers
    .map((row) => row.inputManifestHash)
    .sort();
  const challengerByCohortKey = new Map(
    input.challengers.map((row) => [row.cohortKey, row]),
  );
  const pairedRows = input.baselineRows.map((baseline) => ({
    baseline,
    challenger: challengerByCohortKey.get(baseline.cohortKey) ?? null,
  }));
  const calibrationContextProofSet =
    buildReplayCalibrationContextProofSet(pairedRows);
  const calibrationContextProofRefByCohort = new Map(
    calibrationContextProofSet.associations.map((association) => [
      association.cohortKey,
      {
        proofHash: association.proofHash,
        contextMaterialHash: association.contextMaterialHash,
      },
    ]),
  );
  const d063PolicyAudit = buildD063ReplayPolicyAudit(input.challengers);
  const exactMediaBuyerAudit = buildD063ExactMediaBuyerAudit({
    args: input.args,
    requireAudit: input.schedulerPopulationCoverage.required,
    pairedRows,
  });
  const currentScd0DimensionDriftProof = buildCurrentScd0DimensionDriftProof(
    input.baselineRows,
  );
  const requestedScopeCoverage = buildRequestedScopeCoverage({
    args: input.args,
    rows: input.baselineRows,
  });
  const scaleRefreshIdentityDriftRows = pairedRows.filter(
    ({ baseline, challenger }) =>
      scaleRefreshProjectionDrift({
        baseline: baseline.baseline,
        challenger,
      }),
  ).length;
  const scaleRefreshCalibrationRestatementRows = pairedRows.filter(
    ({ baseline, challenger }) =>
      scaleRefreshCalibrationRestatement({
        baseline: baseline.baseline,
        challenger,
      }),
  ).length;
  const scaleRefreshProfileAvailabilityRestatementRows = pairedRows.filter(
    ({ baseline, challenger }) =>
      scaleRefreshProfileAvailabilityRestatement({
        baseline: baseline.baseline,
        challenger,
      }),
  ).length;
  const aboveBreakEvenProjectionDriftRows = pairedRows.filter(
    ({ baseline, challenger }) =>
      aboveBreakEvenProjectionDrift({
        baseline: baseline.baseline,
        baselineRoas: numberOrNull(baseline.creativeInput.roas),
        baselineBreakEvenRoas: numberOrNull(
          baseline.creativeInput.breakevenRoas,
        ),
        challenger,
      }),
  ).length;
  const aboveBreakEvenCalibrationRestatementRows = pairedRows.filter(
    ({ baseline, challenger }) =>
      aboveBreakEvenCalibrationRestatement({
        baseline: baseline.baseline,
        baselineRoas: numberOrNull(baseline.creativeInput.roas),
        baselineBreakEvenRoas: numberOrNull(
          baseline.creativeInput.breakevenRoas,
        ),
        challenger,
      }),
  ).length;
  const aboveBreakEvenProfileAvailabilityRestatementRows = pairedRows.filter(
    ({ baseline, challenger }) =>
      aboveBreakEvenProfileAvailabilityRestatement({
        baseline: baseline.baseline,
        baselineRoas: numberOrNull(baseline.creativeInput.roas),
        baselineBreakEvenRoas: numberOrNull(
          baseline.creativeInput.breakevenRoas,
        ),
        challenger,
      }),
  ).length;
  const aboveBreakEvenSafetyRepairRows = pairedRows.filter(
    ({ baseline, challenger }) =>
      aboveBreakEvenSafetyRepair({
        baseline: baseline.baseline,
        baselineRoas: numberOrNull(baseline.creativeInput.roas),
        baselineBreakEvenRoas: numberOrNull(
          baseline.creativeInput.breakevenRoas,
        ),
        challenger,
      }),
  ).length;
  const aovOpportunities = pairedRows.filter(
    ({ baseline, challenger }) =>
      !(
        baseline.baseline.publishedLabel === "cut" &&
        baseline.baseline.authorizedAction === "cut"
      ) &&
      challenger?.policyAudit?.canonicalBottomQuartileRatio === null &&
      challenger.policyAudit.accountAovOverlayInstalled === true &&
      challenger.policyAudit.accountAovOverlayActivated === true &&
      challenger?.spendUnitAuthorityBasis ===
        "physical_account_purchase_aov_90d" &&
      challenger.spendUnitAuthorityStatus === "ready" &&
      challenger.accountAovEvidenceStatus === "ready" &&
      challenger.roas !== null &&
      challenger.breakEvenRoas !== null &&
      challenger.roas + 1e-9 < challenger.breakEvenRoas &&
      challenger.preAuthorityLabel === "cut",
  );
  const aovBackedRawCuts = aovOpportunities.filter(
    ({ challenger }) => challenger?.rawLabel === "cut",
  );
  const d036PerRowTransitionViolations = input.challengers.filter(
    (row) => !d036HardActionTupleValid(row),
  ).length;
  const positiveControl = {
    qualifyingPhysicalAccountAovOpportunities: aovOpportunities.length,
    aovBackedRawCuts: aovBackedRawCuts.length,
    qualifyingTransitions: aovBackedRawCuts.length,
    zeroOpportunityObserved: aovOpportunities.length === 0,
    d036PerRowTransitionViolations,
  };
  const anchorDimensionAssessments = [
    ...anchorDimensionAssessmentBySlice.values(),
  ];
  const coverage = {
    businesses: new Set(input.baselineRows.map((row) => row.businessId)).size,
    accounts: new Set(input.baselineRows.map(accountKey)).size,
    accountCutoffSlices:
      input.slices.length + input.slicePreparationFailures.length,
    preparedAccountCutoffSlices: input.slices.length,
    failedAccountCutoffSlices: input.slicePreparationFailures.length,
    baselineRows: input.baselineRows.length,
    challengerComputedRows: input.challengers.filter(
      (row) => row.status === "computed",
    ).length,
    challengerFailedRows: input.challengers.filter(
      (row) => row.status === "failed",
    ).length,
    challengerReadyRows: input.challengers.filter(
      (row) => row.profileStatus === "ready",
    ).length,
    challengerSoftOnlyRows: input.challengers.filter(
      (row) => row.profileStatus === "soft_only",
    ).length,
    priorHysteresisUnreplayableRows: input.challengers.filter(
      (row) => !row.priorHysteresisReplayable,
    ).length,
    priorHysteresisEpochMismatchRows: input.challengers.filter(
      (row) => row.priorHysteresisStatus === "epoch_mismatch",
    ).length,
    priorHysteresisIncompleteLineageRows: input.challengers.filter(
      (row) => row.priorHysteresisStatus === "incomplete_lineage",
    ).length,
    priorHysteresisCurrentEpochRows: input.challengers.filter(
      (row) => row.priorHysteresisStatus === "current_epoch_replayed",
    ).length,
    priorHysteresisNoneRows: input.challengers.filter(
      (row) => row.priorHysteresisStatus === "none",
    ).length,
    evaluationFallbackCutoffSlices: input.slices.filter(
      (slice) => slice.cutoffSource === "evaluation_fallback",
    ).length,
    waveOrHydrationCoverageContradictions: waveCoverageProof.contradictions,
    currentScd0DimensionDriftAccounts:
      currentScd0DimensionDriftProof.driftAccounts,
    currentScd0DimensionDriftRows: currentScd0DimensionDriftProof.driftRows,
    anchoredSourceDimensionDriftSlices: input.slices.filter(
      (slice) => slice.sourceDimensionProof.driftContradictions > 0,
    ).length,
    anchoredSourceDimensionDriftContradictions: input.slices.reduce(
      (sum, slice) =>
        sum + slice.sourceDimensionProof.driftContradictions,
      0,
    ),
    authenticatedAnchorDimensionRepairSlices:
      anchorDimensionAssessments.filter(
        (assessment) =>
          assessment.status === "authenticated_source_repair",
      ).length,
    authenticatedAnchorDimensionRepairDimensions:
      anchorDimensionAssessments.reduce(
        (sum, assessment) =>
          sum + assessment.authenticatedRepairDimensions,
        0,
      ),
    unresolvedSourceDimensionContradictionSlices:
      anchorDimensionAssessments.filter(
        (assessment) =>
          assessment.status === "unresolved_contradiction",
      ).length,
    unresolvedSourceDimensionContradictions:
      anchorDimensionAssessments.reduce(
        (sum, assessment) =>
          sum + assessment.unresolvedContradictions,
        0,
      ),
    scaleRefreshIdentityDriftRows,
    scaleRefreshCalibrationRestatementRows,
    scaleRefreshProfileAvailabilityRestatementRows,
    aboveBreakEvenProjectionDriftRows,
    aboveBreakEvenCalibrationRestatementRows,
    aboveBreakEvenProfileAvailabilityRestatementRows,
    aboveBreakEvenSafetyRepairRows,
    canonicalEnvelopeContradictions: input.baselineRows.filter(
      (row) => !row.canonicalEnvelopeValid,
    ).length,
    currentDayRestatementContradictions: input.slices.reduce(
      (sum, slice) => sum + slice.dimensionProofContradictions,
      0,
    ),
  };
  if (
    calibrationContextProofSet.associationCount !==
    coverage.challengerComputedRows
  ) {
    throw new Error(
      `Calibration context proof cardinality mismatch: associations=${calibrationContextProofSet.associationCount}, computed=${coverage.challengerComputedRows}`,
    );
  }
  const authorityProofContradictions = summaries.reduce(
    (sum, summary) => sum + summary.authorityContradictions.total,
    0,
  );
  const canonicalEnvelopeContradictions = input.baselineRows.filter(
    (row) => !row.canonicalEnvelopeValid,
  ).length;
  const currentDayRestatementContradictions = input.slices.reduce(
    (sum, slice) => sum + slice.dimensionProofContradictions,
    0,
  );
  const profileCalibrationParityContradictions =
    input.baselineRows.filter(
      (row) =>
        !(
          (row.persistedProfileStatus === "ready" &&
            row.calibrationRowId !== null &&
            row.calibrationLineageValid) ||
          (row.persistedProfileStatus === "soft_only" &&
            row.calibrationRowId === null &&
            row.calibrationLineageValid)
        ),
    ).length +
    input.challengers.filter(
      (row) =>
        row.status === "computed" &&
        !(
          (row.profileStatus === "ready" && row.calibrationRowId !== null) ||
          (row.profileStatus === "soft_only" && row.calibrationRowId === null)
        ),
    ).length;
  const aboveBreakEvenCutProjectionViolations = summaries.reduce(
    (sum, summary) =>
      sum + summary.aboveBreakEvenCutProjectionViolations.challenger,
    0,
  );
  const releaseGate = evaluateReplayReleaseGate({
    executionFailures: coverage.challengerFailedRows,
    schedulerPopulationContradictions:
      input.schedulerPopulationCoverage.contradictions,
    authorityProofOrLineageContradictions:
      authorityProofContradictions +
      coverage.priorHysteresisIncompleteLineageRows,
    canonicalEnvelopeContradictions,
    currentDayRestatementContradictions,
    unresolvedSourceDimensionContradictions:
      coverage.unresolvedSourceDimensionContradictions,
    profileCalibrationParityContradictions,
    requestedScopeCoverageContradictions: requestedScopeCoverage.contradictions,
    aboveBreakEvenCutProjectionViolations,
    aboveBreakEvenProjectionDriftRows,
    scaleRefreshIdentityDriftRows,
    calibrationCutoffFallbackSlices: coverage.evaluationFallbackCutoffSlices,
    waveOrHydrationCoverageContradictions: waveCoverageProof.contradictions,
    aovPositiveControlFailures: aovPositiveControlFailure(
      aovOpportunities.length,
      aovBackedRawCuts.length,
    ),
    d036PerRowTransitionViolations,
    d063LegacySafeZoneProjectionDriftRows:
      d063PolicyAudit.compatibilityControl.legacySafeZoneProjectionDriftRows,
    d063ExpandedStripSemanticViolationRows:
      d063PolicyAudit.expandedStrip.semanticViolationRows,
    d063ExpandedHeldAuthorizedCutRows:
      d063PolicyAudit.expandedStrip.held.authorizedCutRows,
    d063ExpandedHeldPendingRows: d063PolicyAudit.expandedStrip.held.pendingRows,
    d063AccountAovP25NullReachabilityFailures: exactMediaBuyerAudit.required
      ? d063PolicyAudit.accountAovOverlay.p25NullReachabilityFailure
      : 0,
    d063AccountAovP25BackedOverlayRows:
      d063PolicyAudit.accountAovOverlay.p25BackedInstalledRows,
    d063ExactMediaBuyerContradictions: exactMediaBuyerAudit.contradictions,
  });
  const mediaBuyerRows = pairedRows
    .map(({ baseline, challenger }) => ({
      cohortKeyHash: canonicalSha256(baseline.cohortKey),
      identityHash: canonicalSha256({
        businessId: baseline.businessId,
        providerAccountRefId: baseline.providerAccountRefId,
        providerAccountId: baseline.providerAccountId,
        adId: baseline.creativeInput.adId,
      }),
      businessId: baseline.businessId,
      businessName: baseline.businessName,
      providerAccountRefId: baseline.providerAccountRefId,
      providerAccountId: baseline.providerAccountId,
      currentProviderAccountName: baseline.currentProviderAccountName,
      adId: baseline.creativeInput.adId,
      creativeId: baseline.creativeId,
      creativeName: baseline.creativeInput.creativeName,
      campaignId: baseline.creativeInput.campaignId,
      accountCurrency: baseline.accountCurrency,
      identity: {
        snapshotId: baseline.snapshotId,
        evaluationId: baseline.evaluationId,
        contextId: baseline.contextId,
        decisionEntityType: baseline.creativeInput.decisionEntityType,
        decisionEntityId: baseline.creativeInput.decisionEntityId,
        adId: baseline.creativeInput.adId,
        creativeGroupingId: baseline.creativeId,
        scopeType: baseline.scopeType,
        scopeId: baseline.scopeId,
      },
      source: {
        mode: PERSISTED_INPUT_SOURCE_MODE,
        jobRunId: baseline.jobRunId,
        calibrationJobRunId: baseline.calibrationJobRunId,
        engineVersion: baseline.engineVersion,
        contextContractVersion: baseline.contextContractVersion,
        evaluationContractVersion: baseline.evaluationContractVersion,
        inputHash: baseline.inputHash,
        recomputedInputHash: baseline.recomputedInputHash,
        decisionHash: baseline.decisionHash,
        recomputedDecisionHash: baseline.recomputedDecisionHash,
        contextHash: baseline.contextHash,
        recomputedContextHash: baseline.recomputedContextHash,
        snapshotProjectionHash: baseline.snapshotProjectionHash,
        recomputedSnapshotProjectionHash:
          baseline.recomputedSnapshotProjectionHash,
        snapshotProjectionValid: baseline.snapshotProjectionValid,
        canonicalEnvelopeValid: baseline.canonicalEnvelopeValid,
        evaluatedAt: baseline.evaluatedAt,
        accountTimezone: baseline.accountTimezone,
        accountCurrency: baseline.accountCurrency,
        currentAccountTimezone: baseline.currentAccountTimezone,
        currentAccountCurrency: baseline.currentAccountCurrency,
      },
      target: {
        targetRoas: baseline.creativeInput.targetRoas,
        breakEvenRoas:
          challenger?.breakEvenRoas ?? baseline.creativeInput.breakevenRoas,
        challengerSpendUnitAuthorityBasis:
          challenger?.spendUnitAuthorityBasis ?? null,
        challengerSpendUnitAuthorityStatus:
          challenger?.spendUnitAuthorityStatus ?? null,
        challengerAccountAovEvidenceStatus:
          challenger?.accountAovEvidenceStatus ?? null,
      },
      config: {
        persistedProfileStatus: baseline.persistedProfileStatus,
        persistedProfileHash: canonicalSha256(baseline.accountProfile),
        persistedProfileBoundaries: mediaBuyerProfileBoundaryProjection(
          baseline.accountProfile,
        ),
        persistedFlagsHash: canonicalSha256(baseline.flags),
        challengerProfileStatus: challenger?.profileStatus ?? null,
        challengerProfileReason: challenger?.profileReason ?? null,
        challengerProfileBoundaries:
          challenger?.profileBoundaryProjection ?? null,
      },
      calibration: {
        baselineCalibrationRowId: baseline.calibrationRowId,
        baselineCalibrationBatchId: baseline.calibrationBatchId,
        baselineCalibrationLineageValid: baseline.calibrationLineageValid,
        batchJobRunId: baseline.calibrationBatchJobRunId,
        batchExpectedCellCount: baseline.calibrationBatchExpectedCellCount,
        batchActualCellCount: baseline.calibrationBatchActualCellCount,
        generationContentHash: baseline.calibrationBatchGenerationContentHash,
        inputManifestHash: baseline.calibrationBatchInputManifestHash,
        sourceManifestHash: baseline.calibrationBatchSourceManifestHash,
        cellSetHash: baseline.calibrationBatchCellSetHash,
        challengerCalibrationRowId: challenger?.calibrationRowId ?? null,
        challengerInputManifestHash:
          challenger?.calibrationInputManifestHash ?? null,
        challengerSourceManifestHash:
          challenger?.calibrationSourceManifestHash ?? null,
        challengerExactCell: {
          cutAuthorityBasis: challenger?.selectedCellCutAuthorityBasis ?? null,
          metaAovPurchaseCount:
            challenger?.selectedCellMetaAovPurchaseCount ?? null,
          metaAovQuality: challenger?.selectedCellMetaAovQuality ?? null,
          roasRatioP25: challenger?.selectedCellRoasRatioP25 ?? null,
          matureAdCount: challenger?.selectedCellMatureAdCount ?? null,
          accountAovRepairOverlayInstalled:
            challenger?.repairAuthoritySelected ?? null,
        },
      },
      inputManifestHash: challenger?.inputManifestHash ?? null,
      metrics: {
        source: "persisted_exact_creative_input_shared_by_both_variants",
        ...mediaBuyerExactInputMetrics(baseline.creativeInput),
        targetRoas: baseline.creativeInput.targetRoas,
        breakEvenRoas:
          challenger?.breakEvenRoas ?? baseline.creativeInput.breakevenRoas,
      },
      baseline: {
        preAuthorityLabel: baseline.baseline.preAuthorityLabel,
        authorityBlocker: baseline.baseline.authorityBlocker,
        rawLabel: baseline.baseline.rawLabel,
        publishedLabel: baseline.baseline.publishedLabel,
        blockedActionType: baseline.baseline.blockedActionType,
        authorizedAction: baseline.baseline.authorizedAction,
        hysteresisSuppressed: baseline.baseline.hysteresisSuppressed,
        confidence: baseline.baseline.confidence,
        reason: baseline.baseline.reason,
        badges: baseline.baseline.badges,
      },
      challenger: challenger
        ? {
            status: challenger.status,
            profileStatus: challenger.profileStatus,
            profileReason: challenger.profileReason,
            spendUnitAuthorityBasis: challenger.spendUnitAuthorityBasis,
            preAuthorityLabel: challenger.preAuthorityLabel,
            authorityBlocker: challenger.authorityBlocker,
            rawLabel: challenger.rawLabel,
            publishedLabel: challenger.publishedLabel,
            blockedActionType: challenger.blockedActionType,
            authorizedAction: challenger.simulatedAuthorizedAction,
            hysteresisSuppressed: challenger.hysteresisSuppressed,
            confidence: challenger.confidence,
            reason: challenger.reason,
            badges: challenger.badges,
            priorHysteresisStatus: challenger.priorHysteresisStatus,
            priorRawLabel: challenger.priorRawLabel,
            priorPublishedLabel: challenger.priorPublishedLabel,
            persistedScaleRefreshProfileHash:
              challenger.persistedScaleRefreshProfileHash,
            challengerScaleRefreshProfileHash:
              challenger.challengerScaleRefreshProfileHash,
            persistedDataHealthHash: challenger.persistedDataHealthHash,
            challengerDataHealthHash: challenger.challengerDataHealthHash,
            calibrationContextProofRef:
              calibrationContextProofRefByCohort.get(
                baseline.cohortKey,
              ) ?? null,
            effectiveTargetRoas: challenger.effectiveTargetRoas,
            ratioToTarget: challenger.ratioToTarget,
            policyAudit: challenger.policyAudit,
            error: challenger.error,
          }
        : null,
      projectionComparison: {
        scaleRefresh: compareScaleRefreshProjection({
          baseline: baseline.baseline,
          challenger,
        }),
        aboveBreakEven: compareAboveBreakEvenProjection({
          baseline: baseline.baseline,
          baselineRoas: numberOrNull(baseline.creativeInput.roas),
          baselineBreakEvenRoas: numberOrNull(
            baseline.creativeInput.breakevenRoas,
          ),
          challenger,
        }),
      },
      transition:
        challenger === null
          ? "missing_challenger"
          : `${baseline.baseline.rawLabel}->${challenger.rawLabel ?? "failed"}/${baseline.baseline.publishedLabel}->${challenger.publishedLabel ?? "failed"}`,
    }))
    .sort(
      (left, right) =>
        left.businessName.localeCompare(right.businessName) ||
        left.providerAccountId.localeCompare(right.providerAccountId) ||
        left.adId.localeCompare(right.adId),
    );
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    codeProvenance: readReplayCodeProvenance(input.args),
    parameters: {
      asOfDate: input.args.asOfDate,
      businessFilter: input.args.businesses,
      providerAccountFilter: input.args.providerAccounts,
      exactMediaBuyerAuditScope: input.args.auditProviderAccounts,
      baselineEngineVersion: NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION,
      challengerEngineVersion: NATIVE_AD_ENGINE_VERSION,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    },
    safety: {
      databaseAccess: "existing_local_ssh_tunnel_only",
      transaction: input.transaction,
      providerWrites: false,
      databaseWrites: false,
      manualCron: false,
      defaultOutput: "json_stdout_only",
      optionalArtifact: input.args.jsonOut,
      optionalCompactArtifact: input.args.compactJsonOut,
      stdoutMode: input.args.stdoutMode,
    },
    protocol: {
      decision:
        "D063_current_day_production_parity_fixed_cohort_baseline_vs_economic_stop_loss_challenger",
      cohortFrozenBeforeVariants: true,
      variantsMayCreateCohortRows: false,
      fixedCohortRows: input.baselineRows.length,
      fixedCohortHash: canonicalSha256({
        sourceMode: PERSISTED_INPUT_SOURCE_MODE,
        baselineEngineVersion: NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION,
        asOfDate: input.args.asOfDate,
        cohortKeys,
      }),
      baselineRead: input.baselineReadDiagnostics,
      profileConfig: {
        sourceMode: PROFILE_CONFIG_SOURCE_MODE,
        value: null,
      },
      inputManifestSetHash: canonicalSha256(manifestHashes),
      challengerHysteresisMemory:
        "production_epoch_scoped; only persisted prior rows whose sourceEngineVersion equals challengerEngineVersion are admitted",
      projectionDriftClassification:
        "Hard-action semantic tuple changes always fail. A baseline above-break-even Cut projection removed entirely by the challenger is reported separately as a safety repair; any challenger above-break-even Cut projection fails. Deterministic epoch-reset wrappers, hash-proven non-hard Keep/Test More restatements, and exact native-profile unavailable-to-non-hard availability changes are reported separately only when canonical non-Cut profile/data-health hashes prove the current production-profile rebuild. Availability restatements permit no hard label, blocker, authorization, pending wrapper, or candidate badge; same-context differences still fail.",
      sourceModes: {
        aovAuthority: {
          mode: AOV_SOURCE_MODE,
          exactness:
            "The authority is bound to the exact business, physical provider-account reference/id, persisted cutoff and cutoff-safe finalized canonical ad facts. Currency must be complete and singular across the immutable source population; timezone must be complete and singular on its latest source date.",
        },
        decisionInputs: {
          mode: PERSISTED_INPUT_SOURCE_MODE,
          exactness:
            "Persisted immutable native evaluation metrics, campaign-context, prior-hysteresis, data-health and lineage come from one anchored baseline decision wave. Challenger profile groups are rebuilt through the scheduled job's production native profile resolver against cutoff-bound recomputed exact cells, so stale ready/soft profile state is not reused. A separate deterministic compatibility control collapses only D063's expanded strip onto the legacy boundary; it is not historical-engine reconstruction.",
        },
        providerDimensions: {
          mode:
            "cutoff_bound_immutable_source_dimensions_plus_anchor_and_current_scd0_drift_observation",
          exactness:
            "Immutable decision metrics retain their anchor. Challenger calibration/profile dimensions come from fact-row authority at the cutoff, never current provider_accounts. Anchor-to-source and current-SCD0 drift are reported separately; missing or conflicting source dimensions fail the bounded slice.",
        },
        profileConfig: {
          mode: PROFILE_CONFIG_SOURCE_MODE,
          exactness:
            "Production-adapter parity: WarehouseNativeAdAccountProfileDataSource has no profile-config reader, so the rebuilt challenger profile uses canonical resolver defaults. Persisted multipliers and thresholds remain baseline evidence only.",
        },
      },
    },
    coverage,
    schedulerPopulationCoverage: input.schedulerPopulationCoverage,
    waveCoverageProof,
    currentScd0DimensionDriftProof,
    requestedScopeCoverage,
    positiveControl,
    d063PolicyAudit,
    exactMediaBuyerAudit,
    releaseGate,
    calibrationContextProofSet,
    summaries,
    mediaBuyerRowAudit: {
      selection:
        input.args.providerAccounts.length === 0
          ? "all fixed-cohort account rows for the requested businesses"
          : "only explicitly requested business/provider-account scopes",
      rowCount: mediaBuyerRows.length,
      rows: mediaBuyerRows,
    },
    failures: input.challengers
      .filter((row) => row.status === "failed")
      .map((row) => ({
        cohortKeyHash: canonicalSha256(row.cohortKey),
        error: row.error,
        profileStatus: row.profileStatus,
        profileReason: row.profileReason,
        priorHysteresisStatus: row.priorHysteresisStatus,
        priorHysteresisSourceEngineVersion:
          row.priorHysteresisSourceEngineVersion,
        inputManifestHash: row.inputManifestHash,
      })),
    slicePreparationFailures: input.slicePreparationFailures,
    evidenceLimits: [
      "This is a fixed-cohort deterministic formula/authority replay, not a causal outcome study and not evidence of counterfactual revenue or savings.",
      "This lane is current-day production parity with a frozen persisted decision wave and cutoff-bound immutable fact authority. --as-of must equal the current UTC date.",
      "AOV and challenger dimensions use exact physical-account facts available at the persisted cutoff. Currency is singular across the complete source population; timezone is singular on the latest source date. Missing/conflicting source dimensions become bounded failed slices.",
      "This paired replay preserves persisted decision metrics, campaign context, data health, identity lineage and exact epoch-scoped prior lineage. It rebuilds challenger ready/soft profile state through the same production profile grouping and native resolver used by the scheduled job against cutoff-bound recomputed cells; stale rollback-epoch profile eligibility is baseline evidence only.",
      "The D063 compatibility control is a current-engine counterfactual that collapses only the new expanded economic strip onto the legacy boundary. It proves legacy-region projection stability for the frozen inputs but is not a claim that an old binary was rerun.",
      "Scale/Refresh comparisons never waive a hard-action semantic tuple change. A baseline above-break-even Cut projection that the challenger removes entirely is counted as a safety repair, not release drift; the challenger must have zero above-break-even Cut projections. Deterministic epoch wrappers, hash-proven non-hard Keep/Test More restatements, and exact native-profile unavailable-to-non-hard availability changes caused by the production-profile rebuild are counted separately from same-context release drift. Availability restatements cannot contain any hard-action or pending-transition artifact.",
      "Current provider SCD0 dimensions and persisted anchor dimensions are explicit drift observations only. Neither can rewrite cutoff-bound source currency/timezone; persisted campaign/status/lifecycle payloads remain anchored inputs.",
      "The challenger rebuilds profile multipliers, peer thresholds, maturity, eligibility and ready/soft state from the cutoff-bound current calibration generation through production code. It does not restate frozen ad metrics, campaign context, data health or lineage.",
      "Challenger hysteresis mirrors production epoch scoping: only prior rows from the challenger engine version are admitted. Rollback-epoch priors remain in the frozen cohort, are reported as epoch_mismatch, and yield an empty challenger prior map.",
      "Rows whose current-epoch persisted prior-hysteresis lineage is incomplete remain in the frozen cohort and are reported as incomplete_lineage rather than removed; the release gate fails.",
      "The frozen cohort is anchored to one latest successful native decision job per business, that job's dependency calibration run, its recorded batch receipt, and exact hydration expected/hydrated identity manifests. No latest-batch or evaluatedAt cutoff lookahead is used.",
      "No provider action, live database mutation, cron invocation, treatment assignment, causal estimate, or outcome-lift claim is made.",
    ],
  };
}

export function buildCompactReplayProof(
  report: ReturnType<typeof buildReport>,
  fullArtifactJson: string,
) {
  const {
    mediaBuyerRowAudit,
    calibrationContextProofSet,
    ...compactReport
  } = report;
  if (mediaBuyerRowAudit.rowCount !== mediaBuyerRowAudit.rows.length) {
    throw new Error(
      `Media-buyer row audit cardinality mismatch: declared=${mediaBuyerRowAudit.rowCount}, actual=${mediaBuyerRowAudit.rows.length}`,
    );
  }
  const cohortKeyHashes = mediaBuyerRowAudit.rows
    .map((row) => row.cohortKeyHash)
    .sort();
  const identityHashes = mediaBuyerRowAudit.rows
    .map((row) => row.identityHash)
    .sort();
  return {
    ...compactReport,
    artifactProjection: {
      contractVersion: COMPACT_REPLAY_PROOF_CONTRACT_VERSION,
      projectionMode:
        "full_release_proof_with_media_buyer_rows_omitted_and_hash_bound",
      fullArtifactSha256: sha256Text(fullArtifactJson),
      fullArtifactBytes: Buffer.byteLength(fullArtifactJson, "utf8"),
      omittedMediaBuyerRowCount: mediaBuyerRowAudit.rows.length,
      omittedMediaBuyerRowsCanonicalSha256: canonicalSha256(
        mediaBuyerRowAudit.rows,
      ),
      cohortKeyHashSetSha256: canonicalSha256(cohortKeyHashes),
      identityHashSetSha256: canonicalSha256(identityHashes),
      calibrationContextProofSetCommitment: {
        contractVersion:
          calibrationContextProofSet.contractVersion,
        proofContractVersion:
          calibrationContextProofSet.proofContractVersion,
        contextCount: calibrationContextProofSet.contextCount,
        associationCount:
          calibrationContextProofSet.associationCount,
        proofSetHash: calibrationContextProofSet.proofSetHash,
        fullMaterialOmitted: true,
      },
      schedulerPopulationManifestHash:
        report.schedulerPopulationCoverage.manifestHash,
      schedulerPopulationExpectedBusinessCount:
        report.schedulerPopulationCoverage.expectedBusinessCount,
      schedulerPopulationExpectedProviderAccountCount:
        report.schedulerPopulationCoverage.expectedProviderAccountCount,
      schedulerPopulationContradictions:
        report.schedulerPopulationCoverage.contradictions,
      fullRowsRequiredForDrilldown: true,
    },
    mediaBuyerRowAudit: {
      selection: mediaBuyerRowAudit.selection,
      rowCount: mediaBuyerRowAudit.rowCount,
      rowsOmitted: true,
    },
  };
}

export async function runReplay(args: ParsedArgs) {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  assertCurrentUtcReplayDate(args.asOfDate);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  assertTunnelDatabase(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "adsecute-native-ad-aov-authority-replay-readonly",
    options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  let transactionStarted = false;
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    transactionStarted = true;
    await client.query(
      `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`,
    );
    const settings = await client.query<{
      transaction_read_only: string;
      default_transaction_read_only: string;
      transaction_isolation: string;
      application_name: string;
    }>(`
      SELECT
        current_setting('transaction_read_only') AS transaction_read_only,
        current_setting('default_transaction_read_only') AS default_transaction_read_only,
        current_setting('transaction_isolation') AS transaction_isolation,
        current_setting('application_name') AS application_name
    `);
    const transaction = settings.rows[0];
    if (
      transaction?.transaction_read_only !== "on" ||
      transaction.default_transaction_read_only !== "on" ||
      transaction.transaction_isolation.toLowerCase() !== "repeatable read"
    ) {
      throw new Error(
        "Replay transaction did not enter the required read-only snapshot",
      );
    }
    const unfiltered =
      args.businesses.length === 0 && args.providerAccounts.length === 0;
    const envDefaultEnabled = readEnvDefaults().enabled;
    const schedulerPopulationRows = unfiltered
      ? (
          await client.query<DbRow>(
            READ_SCHEDULER_POPULATION_MANIFEST_SQL,
            [envDefaultEnabled],
          )
        ).rows.map(schedulerPopulationManifestRow)
      : [];
    const baselineRead = await loadFixedBaselineCohort({ client, args });
    const schedulerPopulationCoverage = buildSchedulerPopulationCoverage({
      required: unfiltered,
      envDefaultEnabled,
      manifestRows: schedulerPopulationRows,
      observedAnchors: baselineRead.populationObservation.anchors,
      observedIdentities: baselineRead.populationObservation.identities,
    });
    const schedulerAccountKeys = new Set(
      schedulerPopulationRows.map(schedulerAccountIdentityKey),
    );
    const boundedBaselineRows = unfiltered
      ? baselineRead.rows.filter((row) =>
          schedulerAccountKeys.has(
            schedulerAccountIdentityKey(fixedBaselineIdentity(row)),
          ),
        )
      : baselineRead.rows;
    const baselineRows = Object.freeze(
      boundedBaselineRows
        .map(mapBaselineRow)
        .sort((left, right) => left.cohortKey.localeCompare(right.cohortKey)),
    );
    if (baselineRows.length === 0 && !unfiltered) {
      throw new Error(
        `No persisted baseline rows found for ${args.asOfDate} at ${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}`,
      );
    }
    const duplicateCohortKeys =
      baselineRows.length -
      new Set(baselineRows.map((row) => row.cohortKey)).size;
    if (duplicateCohortKeys !== 0) {
      throw new Error(
        `Frozen cohort contains ${duplicateCohortKeys} duplicate identities`,
      );
    }

    // D047: cohort membership is now frozen. No challenger result may add or
    // remove an identity below this point.
    const accountSlices = groupAccountSlices(baselineRows);
    const preparedSlices: PreparedAccountSlice[] = [];
    const preparationFailures: ChallengerRow[] = [];
    const slicePreparationFailures: ReplaySlicePreparationFailure[] = [];
    for (const slice of accountSlices) {
      try {
        preparedSlices.push(
          await prepareAccountSlice(client, slice, args.asOfDate),
        );
      } catch (error) {
        const message = boundedReplayError(error);
        slicePreparationFailures.push({
          sliceKeyHash: canonicalSha256(slice.sliceKey),
          accountKeyHash: canonicalSha256(slice.accountKey),
          businessId: slice.businessId,
          providerAccountRefId: slice.providerAccountRefId,
          providerAccountId: slice.providerAccountId,
          rowCount: slice.rows.length,
          error: message,
        });
        preparationFailures.push(
          ...slice.rows.map((row) =>
            failedChallengerRow({ row, slice, error }),
          ),
        );
      }
    }
    const challengers: ChallengerRow[] = [...preparationFailures];
    for (const slice of preparedSlices) {
      challengers.push(...(await replayPreparedAccountSlice(slice)));
    }
    challengers.sort((left, right) =>
      left.cohortKey.localeCompare(right.cohortKey),
    );
    if (challengers.length !== baselineRows.length) {
      throw new Error(
        `Fixed cohort cardinality changed: baseline=${baselineRows.length}, challenger=${challengers.length}`,
      );
    }
    return buildReport({
      args,
      baselineRows,
      baselineReadDiagnostics: baselineRead.diagnostics,
      schedulerPopulationCoverage,
      slices: preparedSlices,
      slicePreparationFailures,
      challengers,
      transaction: {
        transactionReadOnly: transaction.transaction_read_only,
        defaultTransactionReadOnly: transaction.default_transaction_read_only,
        transactionIsolation: transaction.transaction_isolation,
        statementTimeout: `${STATEMENT_TIMEOUT_MS}ms`,
        applicationName: transaction.application_name,
      },
    });
  } finally {
    if (transactionStarted)
      await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertReplayOutputPlan(args);
  const report = await withOperationalStartupLogsSilenced(() =>
    runReplay(args),
  );
  const fullJson = `${JSON.stringify(report, null, 2)}\n`;
  const needsCompactOutput =
    args.compactJsonOut !== null || args.stdoutMode === "compact";
  const compactJson = needsCompactOutput
    ? `${JSON.stringify(buildCompactReplayProof(report, fullJson), null, 2)}\n`
    : null;
  const outputs = [
    args.jsonOut === null
      ? null
      : { outputPath: resolve(args.jsonOut), content: fullJson },
    args.compactJsonOut === null || compactJson === null
      ? null
      : { outputPath: resolve(args.compactJsonOut), content: compactJson },
  ].filter(
    (
      output,
    ): output is {
      outputPath: string;
      content: string;
    } => output !== null,
  );
  const stagedOutputs = outputs.map((output) => ({
    ...output,
    temporaryPath: `${output.outputPath}.tmp`,
  }));
  try {
    for (const output of stagedOutputs) {
      mkdirSync(dirname(output.outputPath), { recursive: true });
      writeFileSync(output.temporaryPath, output.content, "utf8");
    }
    assertReplayCodeProvenanceStable(report.codeProvenance, args);
    for (const output of stagedOutputs) {
      renameSync(output.temporaryPath, output.outputPath);
    }
  } finally {
    for (const output of stagedOutputs) {
      rmSync(output.temporaryPath, { force: true });
    }
  }
  if (args.stdoutMode === "full") {
    process.stdout.write(fullJson);
  } else if (args.stdoutMode === "compact" && compactJson !== null) {
    process.stdout.write(compactJson);
  }
  if (!report.releaseGate.passed) {
    process.exitCode = report.releaseGate.exitCode;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
