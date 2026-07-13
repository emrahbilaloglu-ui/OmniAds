import {
  resolveMetaFunnelCohort,
  type MetaFunnelCohort,
} from "@/lib/meta/funnel-cohort";
import { getDb, runDbTransaction, type DbClient } from "@/lib/db";
import { canonicalSha256 } from "../canonical-evaluation";
import {
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  SAMPLE_WINDOW_DAYS,
} from "../config-values";
import { resolveEngineV3Flags, type EngineV3Flags } from "../feature-flags";
import {
  NATIVE_AD_ENGINE_VERSION,
  type AccountCalibration,
  type AccountFunnelCalibration,
  type FormatFunnelBaseline,
  type MetaAovQuality,
} from "../types";
import { getBusinessGuardFailure } from "./business-guard";
import { hashAdvisoryLock } from "./calibration-job";
import { ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS } from "./job-runtime";

export const NATIVE_AD_CALIBRATION_TABLE =
  "engine_v3_ad_account_calibration_daily" as const;
export const NATIVE_AD_CALIBRATION_BATCH_TABLE =
  "engine_v3_ad_account_calibration_batches" as const;
export const NATIVE_AD_CALIBRATION_CONTRACT_VERSION =
  "engine-v3-native-ad-calibration.v1" as const;
export const NATIVE_AD_CALIBRATION_POLICY_VERSION =
  `retained-account-calibration.${NATIVE_AD_ENGINE_VERSION}` as const;
export const NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT = "*" as const;
export const NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR = 20;
export const AD_CALIBRATION_JOB_NAME =
  "engine_v3_native_ad_calibration_shadow_job" as const;

export interface NativeAdCalibrationSourceProvenance {
  mode: "current_transaction_snapshot";
  providerAccountRefId: string;
  providerAccountId: string;
  transactionCutoff: string;
  transactionIsolation: "repeatable read";
}

export type NativeAdCalibrationAction = "scale" | "cut" | "refresh";

export type NativeAdCalibrationActionBlockReason =
  | "pooled_optimization_context_soft_only"
  | "unsupported_cohort"
  | "target_roas_authority_missing"
  | "break_even_roas_authority_missing"
  | "scale_calibration_sample_low"
  | "scale_winner_benchmark_missing"
  | "cut_calibration_sample_low"
  | "refresh_calibration_sample_low";

export interface NativeAdCalibrationActionReadinessEntry {
  ready: boolean;
  reason: NativeAdCalibrationActionBlockReason | null;
  observedSampleCount: number;
  requiredSampleCount: number;
}

export type NativeAdCalibrationActionReadiness = Record<
  NativeAdCalibrationAction,
  NativeAdCalibrationActionReadinessEntry
>;

export type NativeAdCalibrationCellScope =
  "objective_cohort_context" | "account_objective_cohort";

export type NativeAdCalibrationQualityStatus =
  | "ready"
  | "low_sample"
  | "insufficient"
  | "blocked_commercial"
  | "unsupported_cohort";

export type NativeAdTargetAuthorityStatus =
  "fresh" | "stale" | "missing" | "cutoff_unsafe";

export interface NativeAdTargetAuthorityInput {
  sourceRowId: string | null;
  operation: "upsert" | "delete";
  targetCpa: number | null;
  targetRoas: number | null;
  breakEvenCpa: number | null;
  breakEvenRoas: number | null;
  operatorAovAssumption: number | null;
  defaultRiskPosture: "aggressive" | "balanced" | "conservative" | null;
  effectiveAt: string | null;
  recordedAt: string | null;
}

export interface ResolvedNativeAdTargetAuthority {
  status: NativeAdTargetAuthorityStatus;
  sourceRowId: string | null;
  targetCpa: number | null;
  targetRoas: number | null;
  breakEvenCpa: number | null;
  breakEvenRoas: number | null;
  operatorAovAssumption: number | null;
  defaultRiskPosture: "aggressive" | "balanced" | "conservative" | null;
  effectiveAt: string | null;
  recordedAt: string | null;
  targetRoasAuthority: boolean;
  breakEvenRoasAuthority: boolean;
  authorityHash: string;
}

/**
 * One warehouse fact plus the exact same-day campaign/ad-set context. Creative
 * and lifecycle fields are optional overlays only and are intentionally not
 * used by identity, aggregation, cell selection, or manifests.
 */
export interface NativeAdCalibrationSourceRow {
  sourceRowId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  date: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string;
  accountTimezone: string | null;
  accountCurrency: string | null;
  objective: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  conversions: number;
  revenue: number;
  landingPageViews?: number | null;
  addToCart?: number | null;
  initiateCheckout?: number | null;
  thumbstop?: number | null;
  truthState: string | null;
  validationStatus: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  campaignSourceRowId: string | null;
  campaignTruthState: string | null;
  campaignValidationStatus: string | null;
  campaignCreatedAt: string | null;
  campaignUpdatedAt: string | null;
  adsetSourceRowId: string | null;
  adsetTruthState: string | null;
  adsetValidationStatus: string | null;
  adsetCreatedAt: string | null;
  adsetUpdatedAt: string | null;
  creativeId?: string | null;
  stateOverlay?: unknown;
  lifecycleOverlay?: unknown;
}

export interface NativeAdCalibrationObservation {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  adId: string;
  accountTimezone: string;
  accountCurrency: string;
  campaignId: string;
  adsetId: string;
  objective: string;
  optimizationGoal: string | null;
  customEventType: string | null;
  cohort: MetaFunnelCohort;
  sourceRowIds: string[];
  sourceDayCount: number;
  sourceMinDate: string;
  sourceMaxDate: string;
  sourceMaxUpdatedAt: string;
  totalSpend: number;
  totalConversions: number;
  totalRevenue: number;
  totalImpressions: number;
  totalClicks: number;
  totalLinkClicks: number;
  totalLandingPageViews: number | null;
  totalAddToCart: number | null;
  totalInitiateCheckout: number | null;
  aggregateRoas: number | null;
  aggregateCpa: number | null;
  ctrRate: number | null;
  cpm: number | null;
  thumbstopRate: number | null;
  linkToLpvRate: number | null;
  linkToAtcRate: number | null;
  lpvToAtcRate: number | null;
  atcToIcRate: number | null;
  icToPurchaseRate: number | null;
  clickToPurchaseRate: number | null;
  cumulative28dRoas: number | null;
  cumulative28dCtr: number | null;
  recent7dRoas: number | null;
  recentTotalRatio: number | null;
}

export interface NativeAdCalibrationQualityCounts {
  candidateSourceRowCount: number;
  cutoffSafeSourceRowCount: number;
  candidateAdCount: number;
  eligibleAdObservationCount: number;
  identitySourceRowExclusionCount: number;
  duplicateSourceRowExclusionCount: number;
  duplicateConflictAdExclusionCount: number;
  missingContextAdExclusionCount: number;
  mixedContextAdExclusionCount: number;
  mixedCurrencyAdExclusionCount: number;
  mixedObjectiveAdExclusionCount: number;
  mixedCohortAdExclusionCount: number;
  censoredSourceRowExclusionCount: number;
  censoredAdExclusionCount: number;
  freshnessSourceRowExclusionCount: number;
  freshnessAdExclusionCount: number;
  commercialAuthorityAdExclusionCount: number;
}

export interface NativeAdCalibrationMetricSampleCounts {
  roas: number;
  roasRatio: number;
  cpa: number;
  winner: number;
  refreshRatio: number;
  lowCtr: number;
  ctr: number;
  cpm: number;
  thumbstop: number;
  linkToLpv: number;
  linkToAtc: number;
  lpvToAtc: number;
  atcToIc: number;
  icToPurchase: number;
  clickToPurchase: number;
}

export interface NativeAdCalibrationCellKey {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountTimezone: string;
  accountCurrency: string;
  cellScope: NativeAdCalibrationCellScope;
  objective: string;
  cohort: MetaFunnelCohort;
  optimizationContext: string;
}

export interface NativeAdCalibrationCell {
  batchId: string | null;
  batchCompleteness: "computed" | "complete";
  batchCellCount: number;
  batchCellSetHash: string;
  key: NativeAdCalibrationCellKey;
  asOfDate: string;
  asOfCutoff: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  sampleWindowDays: number;
  computedAt: string;
  engineVersion: string;
  policyVersion: string;
  qualityStatus: NativeAdCalibrationQualityStatus;
  sourceAdCount: number;
  sourceDayCount: number;
  eligibleAdCount: number;
  matureAdCount: number;
  zeroConversionAdCount: number;
  metricSampleCounts: NativeAdCalibrationMetricSampleCounts;
  actionReadiness: NativeAdCalibrationActionReadiness;
  sourceMinDate: string | null;
  sourceMaxDate: string | null;
  sourceMaxUpdatedAt: string | null;
  targetAuthority: ResolvedNativeAdTargetAuthority;
  accountCalibration: AccountCalibration;
  funnelCalibration: AccountFunnelCalibration;
  batchInputManifestHash: string;
  inputManifestHash: string;
  sourceManifestHash: string;
  qualityCounts: NativeAdCalibrationQualityCounts;
}

export interface NativeAdCalibrationBatch {
  contractVersion: typeof NATIVE_AD_CALIBRATION_CONTRACT_VERSION;
  policyVersion: typeof NATIVE_AD_CALIBRATION_POLICY_VERSION;
  engineVersion: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  sourceProvenance: NativeAdCalibrationSourceProvenance;
  asOfDate: string;
  asOfCutoff: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  sampleWindowDays: number;
  computedAt: string;
  targetAuthority: ResolvedNativeAdTargetAuthority;
  observations: NativeAdCalibrationObservation[];
  qualityCounts: NativeAdCalibrationQualityCounts;
  generationContentHash: string;
  inputManifestHash: string;
  sourceManifestHash: string;
  expectedCellCount: number;
  cellSetHash: string;
  cells: NativeAdCalibrationCell[];
}

export interface ComputeNativeAdCalibrationInput {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  asOf: string;
  computationCutoff: string;
  sourceRows: NativeAdCalibrationSourceRow[];
  targetAuthority: NativeAdTargetAuthorityInput | null;
}

export interface AdCalibrationJobInput {
  businessId: string;
  asOf: string;
}

export interface AdCalibrationJobResult {
  jobRunId: string;
  status: "success" | "failed" | "skipped";
  rowsWritten: number;
  expectedCellCount: number;
  idempotentReplay: boolean;
  inputManifestHash: string | null;
  sourceManifestHash: string | null;
  cellSetHash: string | null;
  batches: NativeAdCalibrationJobBatchResult[];
  durationMs: number;
  reason?:
    | "invalid_business_id"
    | "business_not_found"
    | "engine_v3_disabled"
    | "advisory_lock_not_acquired"
    | "schema_not_ready"
    | "historical_as_of_unsafe";
  errorMessage?: string;
}

export interface NativeAdCalibrationJobBatchResult {
  providerAccountRefId: string;
  providerAccountId: string;
  batchId: string;
  rowsWritten: number;
  expectedCellCount: number;
  idempotentReplay: boolean;
  generationContentHash: string;
  inputManifestHash: string;
  sourceManifestHash: string;
  cellSetHash: string;
}

export interface NativeAdCalibrationReplacementResult {
  batchId: string;
  rowsWritten: number;
  expectedCellCount: number;
  idempotentReplay: boolean;
  generationContentHash: string;
  inputManifestHash: string;
  sourceManifestHash: string;
  cellSetHash: string;
}

export interface AdCalibrationJobRuntimeOptions {
  db?: DbClient;
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  businessGuard?: typeof getBusinessGuardFailure;
  resolveFlags?: (businessId: string) => Promise<EngineV3Flags>;
}

export class NativeAdHistoricalCalibrationUnsafeError extends Error {
  readonly code = "native_ad_historical_calibration_unsafe";

  constructor(message: string) {
    super(message);
    this.name = "NativeAdHistoricalCalibrationUnsafeError";
  }
}

class NativeAdCalibrationSchemaNotReadyError extends Error {
  readonly code = "native_ad_calibration_schema_not_ready";

  constructor(readonly missing: string[]) {
    super(`Native ad calibration schema is not ready: ${missing.join(", ")}`);
    this.name = "NativeAdCalibrationSchemaNotReadyError";
  }
}

export const READ_NATIVE_AD_CALIBRATION_SOURCE_SQL = `
/* native-ad-calibration-source: one physical account inside the transaction snapshot */
SELECT
  d.id::text AS source_row_id,
  d.business_ref_id::text AS business_id,
  d.provider_account_ref_id::text AS provider_account_ref_id,
  d.provider_account_id,
  d.date::text AS date,
  d.campaign_id,
  d.adset_id,
  d.ad_id,
  d.account_timezone,
  d.account_currency,
  campaign.objective,
  COALESCE(adset.optimization_goal, campaign.optimization_goal) AS optimization_goal,
  COALESCE(adset.custom_event_type, campaign.custom_event_type) AS custom_event_type,
  d.spend,
  d.impressions,
  d.clicks,
  d.link_clicks,
  d.conversions,
  d.revenue,
  (NULLIF(d.payload_json->>'landing_page_views', ''))::double precision AS landing_page_views,
  (NULLIF(d.payload_json->>'add_to_cart', ''))::double precision AS add_to_cart,
  (NULLIF(d.payload_json->>'initiate_checkout', ''))::double precision AS initiate_checkout,
  (NULLIF(d.payload_json->>'thumbstop', ''))::double precision AS thumbstop,
  d.truth_state,
  d.validation_status,
  d.finalized_at,
  d.created_at,
  d.updated_at,
  campaign.id::text AS campaign_source_row_id,
  campaign.truth_state AS campaign_truth_state,
  campaign.validation_status AS campaign_validation_status,
  campaign.created_at AS campaign_created_at,
  campaign.updated_at AS campaign_updated_at,
  adset.id::text AS adset_source_row_id,
  adset.truth_state AS adset_truth_state,
  adset.validation_status AS adset_validation_status,
  adset.created_at AS adset_created_at,
  adset.updated_at AS adset_updated_at
FROM meta_ad_daily d
JOIN business_provider_accounts binding
 ON binding.business_id = d.business_ref_id::text
 AND binding.provider = 'meta'
 AND binding.provider_account_id = d.provider_account_id
 AND binding.provider_account_ref_id = d.provider_account_ref_id
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.external_account_id = binding.provider_account_id
LEFT JOIN meta_campaign_daily campaign
  ON campaign.business_ref_id = d.business_ref_id
 AND campaign.provider_account_id = d.provider_account_id
 AND campaign.provider_account_ref_id = d.provider_account_ref_id
 AND campaign.campaign_id = d.campaign_id
 AND campaign.date = d.date
 AND campaign.created_at <= $5::timestamptz
 AND campaign.updated_at <= $5::timestamptz
LEFT JOIN meta_adset_daily adset
  ON adset.business_ref_id = d.business_ref_id
 AND adset.provider_account_id = d.provider_account_id
 AND adset.provider_account_ref_id = d.provider_account_ref_id
 AND adset.adset_id = d.adset_id
 AND adset.date = d.date
 AND adset.created_at <= $5::timestamptz
 AND adset.updated_at <= $5::timestamptz
WHERE d.business_ref_id = $1::uuid
  AND d.date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date
  AND d.provider_account_ref_id = $3::uuid
  AND d.provider_account_id = $4
  AND d.created_at <= $5::timestamptz
  AND d.updated_at <= $5::timestamptz
ORDER BY d.ad_id, d.date, d.id
`;

export const READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL = `
/* native-ad-calibration-target-account: exact tenant/account binding plus bitemporal authority */
SELECT
  history.id::text AS source_row_id,
  history.operation,
  history.target_cpa,
  history.target_roas,
  history.break_even_cpa,
  history.break_even_roas,
  history.aov_assumption AS operator_aov_assumption,
  history.default_risk_posture,
  history.effective_at,
  history.recorded_at
FROM business_target_pack_history history
JOIN business_provider_accounts binding
  ON binding.business_id = history.business_id::text
 AND binding.provider = 'meta'
 AND binding.provider_account_ref_id = $2::uuid
 AND binding.provider_account_id = $3
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.external_account_id = binding.provider_account_id
WHERE history.business_id = $1::uuid
  AND history.effective_at <= $4::timestamptz
  AND history.recorded_at <= $4::timestamptz
ORDER BY history.effective_at DESC, history.recorded_at DESC, history.id DESC
LIMIT 1
`;

export const READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL = `
SELECT
  transaction_timestamp() AS computation_cutoff,
  lower(current_setting('transaction_isolation')) AS transaction_isolation
`;

export const CREATE_NATIVE_AD_CALIBRATION_BATCH_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS engine_v3_ad_account_calibration_batches (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  business_ref_id UUID NOT NULL,
  business_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  as_of_date DATE NOT NULL,
  as_of_cutoff TIMESTAMPTZ NOT NULL,
  transaction_isolation TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  source_provenance_json JSONB NOT NULL,
  expected_cell_count INTEGER NOT NULL,
  generation_content_hash CHAR(64) NOT NULL,
  input_manifest_hash CHAR(64) NOT NULL,
  source_manifest_hash CHAR(64) NOT NULL,
  cell_set_hash CHAR(64) NOT NULL,
  completeness_status TEXT NOT NULL,
  job_run_id UUID NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_account_calibration_batches_pkey PRIMARY KEY (id),
  CONSTRAINT engine_v3_ad_calibration_batches_business_fk
    FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_batches_account_fk
    FOREIGN KEY (provider_account_ref_id, provider, provider_account_id)
    REFERENCES provider_accounts(id, provider, external_account_id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_batches_binding_fk
    FOREIGN KEY (business_id, provider, provider_account_ref_id, provider_account_id)
    REFERENCES business_provider_accounts(
      business_id, provider, provider_account_ref_id, provider_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_batches_job_fk
    FOREIGN KEY (job_run_id, business_ref_id, business_id, engine_version)
    REFERENCES engine_v3_job_runs(id, business_ref_id, business_id, engine_version)
    ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_batches_business_identity_check
    CHECK (business_id = business_ref_id::text),
  CONSTRAINT engine_v3_ad_calibration_batches_provider_check
    CHECK (provider = 'meta'),
  CONSTRAINT engine_v3_ad_calibration_batches_source_mode_check
    CHECK (source_mode = 'current_transaction_snapshot'),
  CONSTRAINT engine_v3_ad_calibration_batches_isolation_check
    CHECK (transaction_isolation = 'repeatable read'),
  CONSTRAINT engine_v3_ad_calibration_batches_provenance_check
    CHECK (
      jsonb_typeof(source_provenance_json) = 'object' AND
      source_provenance_json->>'mode' = source_mode AND
      source_provenance_json->>'providerAccountRefId' = provider_account_ref_id::text AND
      source_provenance_json->>'providerAccountId' = provider_account_id AND
      (source_provenance_json->>'transactionCutoff')::timestamptz = as_of_cutoff AND
      source_provenance_json->>'transactionIsolation' = transaction_isolation
    ),
  CONSTRAINT engine_v3_ad_calibration_batches_cutoff_date_check
    CHECK ((as_of_cutoff AT TIME ZONE 'UTC')::date = as_of_date),
  CONSTRAINT engine_v3_ad_calibration_batches_computed_cutoff_check
    CHECK (computed_at = as_of_cutoff),
  CONSTRAINT engine_v3_ad_calibration_batches_expected_count_check
    CHECK (expected_cell_count >= 0),
  CONSTRAINT engine_v3_ad_calibration_batches_generation_hash_check
    CHECK (generation_content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT engine_v3_ad_calibration_batches_input_hash_check
    CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT engine_v3_ad_calibration_batches_source_hash_check
    CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT engine_v3_ad_calibration_batches_cell_hash_check
    CHECK (cell_set_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT engine_v3_ad_calibration_batches_completeness_check
    CHECK (
      (completeness_status = 'writing' AND completed_at IS NULL) OR
      (completeness_status = 'complete' AND completed_at IS NOT NULL)
    ),
  CONSTRAINT engine_v3_ad_calibration_batches_content_unique UNIQUE (
    business_ref_id, provider_account_ref_id, provider_account_id,
    as_of_date, engine_version, policy_version, generation_content_hash
  ),
  CONSTRAINT engine_v3_ad_calibration_batches_cutoff_unique UNIQUE (
    business_ref_id, provider_account_ref_id, provider_account_id,
    as_of_cutoff, engine_version, policy_version
  ),
  CONSTRAINT engine_v3_ad_calibration_batches_lineage_unique UNIQUE (
    id, business_ref_id, business_id, provider, provider_account_ref_id,
    provider_account_id, as_of_date, as_of_cutoff, engine_version,
    policy_version, input_manifest_hash, source_manifest_hash
  )
)
`;

export const CREATE_NATIVE_AD_CALIBRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS engine_v3_ad_account_calibration_daily (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL,
  business_ref_id UUID NOT NULL,
  business_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_timezone TEXT NOT NULL,
  account_currency TEXT NOT NULL,
  cell_scope TEXT NOT NULL,
  objective TEXT NOT NULL,
  funnel_cohort TEXT NOT NULL,
  optimization_context TEXT NOT NULL,
  as_of_date DATE NOT NULL,
  as_of_cutoff TIMESTAMPTZ NOT NULL,
  engine_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  sample_window_start DATE NOT NULL,
  sample_window_end DATE NOT NULL,
  sample_window_days INTEGER NOT NULL,
  source_ad_count INTEGER NOT NULL,
  source_day_count INTEGER NOT NULL,
  eligible_ad_count INTEGER NOT NULL,
  mature_ad_count INTEGER NOT NULL,
  zero_conversion_ad_count INTEGER NOT NULL,
  roas_p75 DOUBLE PRECISION,
  roas_p60 DOUBLE PRECISION,
  refresh_ratio_p10 DOUBLE PRECISION,
  low_ctr_p10 DOUBLE PRECISION,
  account_cpa_p50 DOUBLE PRECISION,
  account_cpa_sample_count INTEGER NOT NULL,
  meta_attributed_aov_mean_90d DOUBLE PRECISION,
  meta_attributed_aov_purchase_count_90d INTEGER NOT NULL,
  meta_attributed_revenue_90d DOUBLE PRECISION NOT NULL DEFAULT 0,
  meta_aov_quality TEXT NOT NULL,
  mature_spend_p50 DOUBLE PRECISION,
  mature_spend_p75 DOUBLE PRECISION,
  winner_spend_p25 DOUBLE PRECISION,
  winner_spend_p50 DOUBLE PRECISION,
  winner_purchase_p50 DOUBLE PRECISION,
  roas_ratio_p10 DOUBLE PRECISION,
  roas_ratio_p25 DOUBLE PRECISION,
  roas_ratio_p50 DOUBLE PRECISION,
  roas_ratio_p75 DOUBLE PRECISION,
  funnel_calibration_json JSONB NOT NULL,
  metric_sample_counts_json JSONB NOT NULL,
  action_readiness_json JSONB NOT NULL,
  quality_counts_json JSONB NOT NULL,
  quality_status TEXT NOT NULL,
  target_authority_status TEXT NOT NULL,
  target_roas DOUBLE PRECISION,
  break_even_roas DOUBLE PRECISION,
  target_effective_at TIMESTAMPTZ,
  target_recorded_at TIMESTAMPTZ,
  target_authority_hash CHAR(64) NOT NULL,
  source_min_date DATE,
  source_max_date DATE,
  source_max_updated_at TIMESTAMPTZ,
  batch_input_manifest_hash CHAR(64) NOT NULL,
  input_manifest_hash CHAR(64) NOT NULL,
  source_manifest_hash CHAR(64) NOT NULL,
  job_run_id UUID NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_account_calibration_daily_pkey PRIMARY KEY (id),
  CONSTRAINT engine_v3_ad_calibration_daily_business_fk
    FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_daily_account_fk
    FOREIGN KEY (provider_account_ref_id, provider, provider_account_id)
    REFERENCES provider_accounts(id, provider, external_account_id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_daily_binding_fk
    FOREIGN KEY (business_id, provider, provider_account_ref_id, provider_account_id)
    REFERENCES business_provider_accounts(
      business_id, provider, provider_account_ref_id, provider_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_daily_job_fk
    FOREIGN KEY (job_run_id, business_ref_id, business_id, engine_version)
    REFERENCES engine_v3_job_runs(id, business_ref_id, business_id, engine_version)
    ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_daily_batch_fk FOREIGN KEY (
    batch_id, business_ref_id, business_id, provider, provider_account_ref_id,
    provider_account_id, as_of_date, as_of_cutoff, engine_version,
    policy_version, batch_input_manifest_hash, source_manifest_hash
  ) REFERENCES engine_v3_ad_account_calibration_batches (
    id, business_ref_id, business_id, provider, provider_account_ref_id,
    provider_account_id, as_of_date, as_of_cutoff, engine_version,
    policy_version, input_manifest_hash, source_manifest_hash
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_daily_business_identity_check
    CHECK (business_id = business_ref_id::text),
  CONSTRAINT engine_v3_ad_calibration_daily_provider_check
    CHECK (provider = 'meta'),
  CONSTRAINT engine_v3_ad_calibration_daily_scope_check
    CHECK (cell_scope IN ('objective_cohort_context', 'account_objective_cohort')),
  CONSTRAINT engine_v3_ad_calibration_daily_cohort_check
    CHECK (funnel_cohort IN ('purchase', 'mid_funnel', 'lead', 'traffic', 'upper_funnel', 'engagement', 'unknown')),
  CONSTRAINT engine_v3_ad_calibration_daily_window_check
    CHECK (sample_window_days > 0 AND sample_window_start <= sample_window_end),
  CONSTRAINT engine_v3_ad_calibration_daily_counts_check CHECK (
    source_ad_count >= 0 AND source_day_count >= 0 AND
    eligible_ad_count >= 0 AND mature_ad_count >= 0 AND
    zero_conversion_ad_count >= 0 AND account_cpa_sample_count >= 0 AND
    meta_attributed_aov_purchase_count_90d >= 0
  ),
  CONSTRAINT engine_v3_ad_calibration_daily_action_readiness_check
    CHECK (jsonb_typeof(action_readiness_json) = 'object'),
  CONSTRAINT engine_v3_ad_calibration_daily_meta_aov_quality_check
    CHECK (meta_aov_quality IN ('unavailable', 'unstable', 'low_sample', 'ready')),
  CONSTRAINT engine_v3_ad_calibration_daily_quality_status_check
    CHECK (quality_status IN ('ready', 'low_sample', 'insufficient', 'blocked_commercial', 'unsupported_cohort')),
  CONSTRAINT engine_v3_ad_calibration_daily_target_status_check
    CHECK (target_authority_status IN ('fresh', 'stale', 'missing', 'cutoff_unsafe')),
  CONSTRAINT engine_v3_ad_calibration_daily_hashes_check CHECK (
    target_authority_hash ~ '^[0-9a-f]{64}$' AND
    batch_input_manifest_hash ~ '^[0-9a-f]{64}$' AND
    input_manifest_hash ~ '^[0-9a-f]{64}$' AND
    source_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT engine_v3_ad_calibration_daily_computed_cutoff_check
    CHECK (computed_at = as_of_cutoff),
  CONSTRAINT engine_v3_ad_calibration_daily_cell_unique UNIQUE (
    batch_id,
    account_currency,
    account_timezone,
    cell_scope,
    objective,
    funnel_cohort,
    optimization_context
  )
)
`;

export const CREATE_NATIVE_AD_CALIBRATION_DEPENDENCY_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_physical_identity
ON provider_accounts (id, provider, external_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_provider_accounts_physical_binding
ON business_provider_accounts (
  business_id, provider, provider_account_ref_id, provider_account_id
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_engine_v3_job_runs_native_lineage
ON engine_v3_job_runs (id, business_ref_id, business_id, engine_version)
`;

export const CREATE_NATIVE_AD_CALIBRATION_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_calibration_batch_lookup
ON engine_v3_ad_account_calibration_batches (
  business_ref_id,
  provider_account_ref_id,
  provider_account_id,
  as_of_date,
  engine_version,
  policy_version,
  completeness_status,
  as_of_cutoff DESC,
  id DESC
);
CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_account_calibration_lookup
ON engine_v3_ad_account_calibration_daily (
  batch_id,
  account_currency,
  account_timezone,
  funnel_cohort,
  objective,
  optimization_context
)
`;

export const CREATE_NATIVE_AD_CALIBRATION_IMMUTABILITY_SQL = `
CREATE OR REPLACE FUNCTION engine_v3_native_ad_calibration_batch_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'completed native ad calibration batches are append-only';
  END IF;
  IF OLD.completeness_status <> 'writing'
     OR NEW.completeness_status <> 'complete'
     OR NEW.completed_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['completeness_status', 'completed_at']::text[])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['completeness_status', 'completed_at']::text[])
  THEN
    RAISE EXCEPTION 'native ad calibration batch mutation is forbidden';
  END IF;
  IF (
    SELECT count(*)
    FROM engine_v3_ad_account_calibration_daily cell
    WHERE cell.batch_id = OLD.id
  ) <> NEW.expected_cell_count THEN
    RAISE EXCEPTION 'native ad calibration batch cardinality proof failed';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS engine_v3_native_ad_calibration_batch_immutable_trigger
  ON engine_v3_ad_account_calibration_batches;
CREATE TRIGGER engine_v3_native_ad_calibration_batch_immutable_trigger
BEFORE UPDATE OR DELETE ON engine_v3_ad_account_calibration_batches
FOR EACH ROW EXECUTE FUNCTION engine_v3_native_ad_calibration_batch_immutable();

CREATE OR REPLACE FUNCTION engine_v3_native_ad_calibration_cell_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM engine_v3_ad_account_calibration_batches batch
      WHERE batch.id = NEW.batch_id
        AND batch.completeness_status = 'writing'
    ) THEN
      RAISE EXCEPTION 'native ad calibration cells require a writing batch';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'native ad calibration cells are immutable';
END
$$;
DROP TRIGGER IF EXISTS engine_v3_native_ad_calibration_cell_immutable_trigger
  ON engine_v3_ad_account_calibration_daily;
CREATE TRIGGER engine_v3_native_ad_calibration_cell_immutable_trigger
BEFORE INSERT OR UPDATE OR DELETE ON engine_v3_ad_account_calibration_daily
FOR EACH ROW EXECUTE FUNCTION engine_v3_native_ad_calibration_cell_immutable()
`;

export const NATIVE_AD_CALIBRATION_MIGRATION_SQL = [
  CREATE_NATIVE_AD_CALIBRATION_DEPENDENCY_INDEX_SQL,
  CREATE_NATIVE_AD_CALIBRATION_BATCH_TABLE_SQL,
  CREATE_NATIVE_AD_CALIBRATION_TABLE_SQL,
  CREATE_NATIVE_AD_CALIBRATION_INDEX_SQL,
  CREATE_NATIVE_AD_CALIBRATION_IMMUTABILITY_SQL,
].join(";\n");

export const INSERT_NATIVE_AD_CALIBRATION_SQL = `
INSERT INTO engine_v3_ad_account_calibration_daily (
  batch_id,
  business_ref_id,
  business_id,
  provider,
  provider_account_ref_id,
  provider_account_id,
  account_timezone,
  account_currency,
  cell_scope,
  objective,
  funnel_cohort,
  optimization_context,
  as_of_date,
  as_of_cutoff,
  engine_version,
  policy_version,
  sample_window_start,
  sample_window_end,
  sample_window_days,
  source_ad_count,
  source_day_count,
  eligible_ad_count,
  mature_ad_count,
  zero_conversion_ad_count,
  roas_p75,
  roas_p60,
  refresh_ratio_p10,
  low_ctr_p10,
  account_cpa_p50,
  account_cpa_sample_count,
  meta_attributed_aov_mean_90d,
  meta_attributed_aov_purchase_count_90d,
  meta_attributed_revenue_90d,
  meta_aov_quality,
  mature_spend_p50,
  mature_spend_p75,
  winner_spend_p25,
  winner_spend_p50,
  winner_purchase_p50,
  roas_ratio_p10,
  roas_ratio_p25,
  roas_ratio_p50,
  roas_ratio_p75,
  funnel_calibration_json,
  metric_sample_counts_json,
  action_readiness_json,
  quality_counts_json,
  quality_status,
  target_authority_status,
  target_roas,
  break_even_roas,
  target_effective_at,
  target_recorded_at,
  target_authority_hash,
  source_min_date,
  source_max_date,
  source_max_updated_at,
  batch_input_manifest_hash,
  input_manifest_hash,
  source_manifest_hash,
  job_run_id,
  computed_at
)
SELECT
  row.batch_id,
  row.business_ref_id,
  row.business_id,
  row.provider,
  row.provider_account_ref_id,
  row.provider_account_id,
  row.account_timezone,
  row.account_currency,
  row.cell_scope,
  row.objective,
  row.funnel_cohort,
  row.optimization_context,
  row.as_of_date,
  row.as_of_cutoff,
  row.engine_version,
  row.policy_version,
  row.sample_window_start,
  row.sample_window_end,
  row.sample_window_days,
  row.source_ad_count,
  row.source_day_count,
  row.eligible_ad_count,
  row.mature_ad_count,
  row.zero_conversion_ad_count,
  row.roas_p75,
  row.roas_p60,
  row.refresh_ratio_p10,
  row.low_ctr_p10,
  row.account_cpa_p50,
  row.account_cpa_sample_count,
  row.meta_attributed_aov_mean_90d,
  row.meta_attributed_aov_purchase_count_90d,
  row.meta_attributed_revenue_90d,
  row.meta_aov_quality,
  row.mature_spend_p50,
  row.mature_spend_p75,
  row.winner_spend_p25,
  row.winner_spend_p50,
  row.winner_purchase_p50,
  row.roas_ratio_p10,
  row.roas_ratio_p25,
  row.roas_ratio_p50,
  row.roas_ratio_p75,
  row.funnel_calibration_json,
  row.metric_sample_counts_json,
  row.action_readiness_json,
  row.quality_counts_json,
  row.quality_status,
  row.target_authority_status,
  row.target_roas,
  row.break_even_roas,
  row.target_effective_at,
  row.target_recorded_at,
  row.target_authority_hash,
  row.source_min_date,
  row.source_max_date,
  row.source_max_updated_at,
  row.batch_input_manifest_hash,
  row.input_manifest_hash,
  row.source_manifest_hash,
  row.job_run_id,
  row.computed_at
FROM jsonb_to_recordset($1::jsonb) AS row(
  batch_id uuid,
  business_ref_id uuid,
  business_id text,
  provider text,
  provider_account_ref_id uuid,
  provider_account_id text,
  account_timezone text,
  account_currency text,
  cell_scope text,
  objective text,
  funnel_cohort text,
  optimization_context text,
  as_of_date date,
  as_of_cutoff timestamptz,
  engine_version text,
  policy_version text,
  sample_window_start date,
  sample_window_end date,
  sample_window_days integer,
  source_ad_count integer,
  source_day_count integer,
  eligible_ad_count integer,
  mature_ad_count integer,
  zero_conversion_ad_count integer,
  roas_p75 double precision,
  roas_p60 double precision,
  refresh_ratio_p10 double precision,
  low_ctr_p10 double precision,
  account_cpa_p50 double precision,
  account_cpa_sample_count integer,
  meta_attributed_aov_mean_90d double precision,
  meta_attributed_aov_purchase_count_90d integer,
  meta_attributed_revenue_90d double precision,
  meta_aov_quality text,
  mature_spend_p50 double precision,
  mature_spend_p75 double precision,
  winner_spend_p25 double precision,
  winner_spend_p50 double precision,
  winner_purchase_p50 double precision,
  roas_ratio_p10 double precision,
  roas_ratio_p25 double precision,
  roas_ratio_p50 double precision,
  roas_ratio_p75 double precision,
  funnel_calibration_json jsonb,
  metric_sample_counts_json jsonb,
  action_readiness_json jsonb,
  quality_counts_json jsonb,
  quality_status text,
  target_authority_status text,
  target_roas double precision,
  break_even_roas double precision,
  target_effective_at timestamptz,
  target_recorded_at timestamptz,
  target_authority_hash char(64),
  source_min_date date,
  source_max_date date,
  source_max_updated_at timestamptz,
  batch_input_manifest_hash char(64),
  input_manifest_hash char(64),
  source_manifest_hash char(64),
  job_run_id uuid,
  computed_at timestamptz
)
`;

export const LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL = `
SELECT DISTINCT
  binding.provider_account_ref_id::text AS provider_account_ref_id,
  binding.provider_account_id
FROM business_provider_accounts binding
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.external_account_id = binding.provider_account_id
WHERE binding.business_id = $1
  AND binding.provider = 'meta'
ORDER BY binding.provider_account_ref_id, binding.provider_account_id
`;

export const ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL = `
SELECT
  binding.provider_account_ref_id::text AS provider_account_ref_id,
  binding.provider_account_id
FROM business_provider_accounts binding
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.external_account_id = binding.provider_account_id
WHERE binding.business_id = $1
  AND binding.provider = 'meta'
  AND binding.provider_account_ref_id = $2::uuid
  AND binding.provider_account_id = $3
`;

export const READ_EXISTING_NATIVE_AD_CALIBRATION_BATCH_BY_CONTENT_SQL = `
SELECT
  id::text AS id,
  as_of_cutoff,
  generation_content_hash,
  input_manifest_hash,
  source_manifest_hash,
  cell_set_hash,
  expected_cell_count
FROM engine_v3_ad_account_calibration_batches
WHERE business_ref_id = $1::uuid
  AND provider_account_ref_id = $2::uuid
  AND provider_account_id = $3
  AND as_of_date = $4::date
  AND engine_version = $5
  AND policy_version = $6
  AND generation_content_hash = $7
  AND completeness_status = 'complete'
ORDER BY as_of_cutoff DESC, id DESC
LIMIT 2
`;

export const READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL = `
SELECT id::text AS id, completeness_status, generation_content_hash
FROM engine_v3_ad_account_calibration_batches
WHERE business_ref_id = $1::uuid
  AND provider_account_ref_id = $2::uuid
  AND provider_account_id = $3
  AND as_of_cutoff = $4::timestamptz
  AND engine_version = $5
  AND policy_version = $6
LIMIT 2
`;

export const INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL = `
INSERT INTO engine_v3_ad_account_calibration_batches (
  business_ref_id,
  business_id,
  provider,
  provider_account_ref_id,
  provider_account_id,
  as_of_date,
  as_of_cutoff,
  transaction_isolation,
  engine_version,
  policy_version,
  source_mode,
  source_provenance_json,
  expected_cell_count,
  generation_content_hash,
  input_manifest_hash,
  source_manifest_hash,
  cell_set_hash,
  completeness_status,
  job_run_id,
  computed_at
) VALUES (
  $1::uuid, $2, 'meta', $3::uuid, $4, $5::date, $6::timestamptz, $7,
  $8, $9, $10, $11::jsonb, $12::integer, $13, $14, $15, $16,
  'writing', $17::uuid, $18::timestamptz
)
RETURNING id::text AS id
`;

export const READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL = `
SELECT
  business_ref_id::text AS business_id,
  provider_account_ref_id::text AS provider_account_ref_id,
  provider_account_id,
  account_timezone,
  account_currency,
  cell_scope,
  objective,
  funnel_cohort,
  optimization_context,
  input_manifest_hash,
  source_manifest_hash
FROM engine_v3_ad_account_calibration_daily
WHERE batch_id = $1::uuid
ORDER BY
  provider_account_id,
  account_timezone,
  account_currency,
  cell_scope,
  objective,
  funnel_cohort,
  optimization_context
`;

export const COMPLETE_NATIVE_AD_CALIBRATION_BATCH_SQL = `
UPDATE engine_v3_ad_account_calibration_batches
SET completeness_status = 'complete', completed_at = transaction_timestamp()
WHERE id = $1::uuid
  AND completeness_status = 'writing'
  AND expected_cell_count = $2::integer
  AND input_manifest_hash = $3
  AND source_manifest_hash = $4
  AND cell_set_hash = $5
RETURNING id::text AS id
`;

interface NormalizedSourceRow extends NativeAdCalibrationSourceRow {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  date: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string;
  accountTimezone: string | null;
  accountCurrency: string | null;
  objective: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  campaignCreatedAt: string | null;
  campaignUpdatedAt: string | null;
  adsetCreatedAt: string | null;
  adsetUpdatedAt: string | null;
}

interface ObservationBuildResult {
  observations: NativeAdCalibrationObservation[];
  qualityCounts: NativeAdCalibrationQualityCounts;
  eligibleSourceRows: NormalizedSourceRow[];
}

export function resolveNativeAdCalibrationDate(asOf: string): {
  asOfDate: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
} {
  const trimmed = asOf.trim();
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (
    !isDateOnly(trimmed) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== trimmed
  ) {
    throw new NativeAdHistoricalCalibrationUnsafeError(
      "Native ad calibration is current-only and requires a valid date-only asOf.",
    );
  }
  return {
    asOfDate: trimmed,
    sampleWindowStart: addUtcDays(trimmed, -(SAMPLE_WINDOW_DAYS - 1)),
    sampleWindowEnd: trimmed,
  };
}

export function resolveNativeAdCalibrationCutoff(
  asOf: string,
  computationCutoff: string,
): {
  asOfDate: string;
  asOfCutoff: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
} {
  const window = resolveNativeAdCalibrationDate(asOf);
  const asOfCutoff = normalizeRequiredTimestamp(
    computationCutoff,
    "computationCutoff",
  );
  if (asOfCutoff.slice(0, 10) !== window.asOfDate) {
    throw new NativeAdHistoricalCalibrationUnsafeError(
      "Native ad calibration is current-only: asOf must equal the database transaction cutoff UTC date.",
    );
  }
  return {
    ...window,
    asOfCutoff,
  };
}

function assertNativeAdSourceBindings(input: {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  rows: NormalizedSourceRow[];
}) {
  for (const row of input.rows) {
    if (row.businessId !== input.businessId) {
      throw new Error(
        `Native ad calibration source business binding mismatch for ${row.sourceRowId || "unknown source row"}.`,
      );
    }
    if (
      row.providerAccountRefId !== input.providerAccountRefId ||
      row.providerAccountId !== input.providerAccountId
    ) {
      throw new Error(
        `Native ad calibration source provider binding mismatch for ${row.sourceRowId || "unknown source row"}.`,
      );
    }
  }
}

export function resolveNativeAdTargetAuthority(
  input: NativeAdTargetAuthorityInput | null,
  asOfCutoff: string,
): ResolvedNativeAdTargetAuthority {
  const cutoffMs = requireTimestamp(asOfCutoff, "asOfCutoff");
  const normalized = normalizeTargetAuthorityInput(input);
  const effectiveMs = timestampOrNull(normalized?.effectiveAt ?? null);
  const recordedMs = timestampOrNull(normalized?.recordedAt ?? null);
  const cutoffSafe =
    normalized !== null &&
    normalized.operation === "upsert" &&
    effectiveMs !== null &&
    recordedMs !== null &&
    effectiveMs <= recordedMs &&
    effectiveMs <= cutoffMs &&
    recordedMs <= cutoffMs;

  let status: NativeAdTargetAuthorityStatus;
  if (normalized === null || normalized.operation === "delete") {
    status = "missing";
  } else if (!cutoffSafe) {
    status = "cutoff_unsafe";
  } else {
    const ageHours = (cutoffMs - effectiveMs) / 3_600_000;
    status = ageHours > 24 * 30 ? "stale" : "fresh";
  }

  const targetRoas = normalized?.targetRoas ?? null;
  const breakEvenRoas = normalized?.breakEvenRoas ?? null;
  const authorityHash = canonicalSha256({
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    authority: normalized,
    status,
  });

  return {
    status,
    sourceRowId: normalized?.sourceRowId ?? null,
    targetCpa: normalized?.targetCpa ?? null,
    targetRoas,
    breakEvenCpa: normalized?.breakEvenCpa ?? null,
    breakEvenRoas,
    operatorAovAssumption: normalized?.operatorAovAssumption ?? null,
    defaultRiskPosture: normalized?.defaultRiskPosture ?? null,
    effectiveAt: normalized?.effectiveAt ?? null,
    recordedAt: normalized?.recordedAt ?? null,
    targetRoasAuthority: status === "fresh" && positiveFinite(targetRoas),
    breakEvenRoasAuthority: status === "fresh" && positiveFinite(breakEvenRoas),
    authorityHash,
  };
}

export function computeNativeAdCalibrationBatch(
  input: ComputeNativeAdCalibrationInput,
): NativeAdCalibrationBatch {
  const businessId = requiredText(input.businessId, "businessId");
  const providerAccountRefId = requiredUuid(
    input.providerAccountRefId,
    "providerAccountRefId",
  );
  const providerAccountId = requiredText(
    input.providerAccountId,
    "providerAccountId",
  );
  const cutoff = resolveNativeAdCalibrationCutoff(
    input.asOf,
    input.computationCutoff,
  );
  const computedAt = cutoff.asOfCutoff;
  const sourceProvenance: NativeAdCalibrationSourceProvenance = {
    mode: "current_transaction_snapshot",
    providerAccountRefId,
    providerAccountId,
    transactionCutoff: cutoff.asOfCutoff,
    transactionIsolation: "repeatable read",
  };
  const targetAuthority = resolveNativeAdTargetAuthority(
    input.targetAuthority,
    cutoff.asOfCutoff,
  );
  const normalizedRows = input.sourceRows.map(normalizeSourceRow);
  assertNativeAdSourceBindings({
    businessId,
    providerAccountRefId,
    providerAccountId,
    rows: normalizedRows,
  });
  const built = buildObservations({
    businessId,
    asOfCutoff: cutoff.asOfCutoff,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    rows: normalizedRows,
  });
  const sourceManifestHash = canonicalSha256({
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    businessId,
    providerAccountRefId,
    providerAccountId,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    rows: built.eligibleSourceRows
      .map(sourceManifestEntry)
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey)),
  });
  built.qualityCounts.commercialAuthorityAdExclusionCount =
    targetAuthority.targetRoasAuthority &&
    targetAuthority.breakEvenRoasAuthority
      ? 0
      : built.observations.filter((row) => row.cohort === "purchase").length;

  const generationContentHash = canonicalSha256({
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    businessId,
    providerAccountRefId,
    providerAccountId,
    asOfDate: cutoff.asOfDate,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    sourceManifestHash,
    targetAuthority,
    qualityCounts: built.qualityCounts,
    observations: built.observations.map(observationManifestEntry),
  });
  const inputManifestHash = canonicalSha256({
    generationContentHash,
    sourceProvenance,
    asOfCutoff: cutoff.asOfCutoff,
  });

  const batchBase = {
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    businessId,
    providerAccountRefId,
    providerAccountId,
    sourceProvenance,
    asOfDate: cutoff.asOfDate,
    asOfCutoff: cutoff.asOfCutoff,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    sampleWindowDays: SAMPLE_WINDOW_DAYS,
    computedAt,
    targetAuthority,
    observations: built.observations,
    qualityCounts: built.qualityCounts,
    generationContentHash,
    inputManifestHash,
    sourceManifestHash,
  } satisfies Omit<
    NativeAdCalibrationBatch,
    "cells" | "expectedCellCount" | "cellSetHash"
  >;
  const provisionalCells = buildCells(batchBase);
  const cellSetHash = computeNativeAdCalibrationCellSetHash(provisionalCells);
  const cells = provisionalCells.map((cell) => ({
    ...cell,
    batchCellCount: provisionalCells.length,
    batchCellSetHash: cellSetHash,
  }));

  return {
    ...batchBase,
    expectedCellCount: cells.length,
    cellSetHash,
    cells,
  };
}

export function buildNativeAdCalibrationPersistencePayload(
  batch: NativeAdCalibrationBatch,
  input: { batchId: string; jobRunId: string },
): Array<Record<string, unknown>> {
  return batch.cells.map((cell) => ({
    batch_id: input.batchId,
    business_ref_id: cell.key.businessId,
    business_id: cell.key.businessId,
    provider: "meta",
    provider_account_ref_id: cell.key.providerAccountRefId,
    provider_account_id: cell.key.providerAccountId,
    account_timezone: cell.key.accountTimezone,
    account_currency: cell.key.accountCurrency,
    cell_scope: cell.key.cellScope,
    objective: cell.key.objective,
    funnel_cohort: cell.key.cohort,
    optimization_context: cell.key.optimizationContext,
    as_of_date: cell.asOfDate,
    as_of_cutoff: cell.asOfCutoff,
    engine_version: cell.engineVersion,
    policy_version: cell.policyVersion,
    sample_window_start: cell.sampleWindowStart,
    sample_window_end: cell.sampleWindowEnd,
    sample_window_days: cell.sampleWindowDays,
    source_ad_count: cell.sourceAdCount,
    source_day_count: cell.sourceDayCount,
    eligible_ad_count: cell.eligibleAdCount,
    mature_ad_count: cell.matureAdCount,
    zero_conversion_ad_count: cell.zeroConversionAdCount,
    roas_p75: cell.accountCalibration.roasP75,
    roas_p60: cell.accountCalibration.roasP60,
    refresh_ratio_p10: cell.accountCalibration.refreshRatioP10,
    low_ctr_p10: cell.accountCalibration.lowCtrP10,
    account_cpa_p50: cell.accountCalibration.accountCpaP50,
    account_cpa_sample_count: cell.accountCalibration.accountCpaSampleCount,
    meta_attributed_aov_mean_90d:
      cell.accountCalibration.metaAttributedAovMean90d,
    meta_attributed_aov_purchase_count_90d:
      cell.accountCalibration.metaAttributedAovPurchaseCount90d,
    meta_attributed_revenue_90d:
      cell.accountCalibration.metaAttributedRevenue90d,
    meta_aov_quality: cell.accountCalibration.metaAovQuality,
    mature_spend_p50: cell.accountCalibration.matureSpendP50,
    mature_spend_p75: cell.accountCalibration.matureSpendP75,
    winner_spend_p25: cell.accountCalibration.winnerSpendP25,
    winner_spend_p50: cell.accountCalibration.winnerSpendP50,
    winner_purchase_p50: cell.accountCalibration.winnerPurchaseP50,
    roas_ratio_p10: cell.accountCalibration.roasRatioP10,
    roas_ratio_p25: cell.accountCalibration.roasRatioP25,
    roas_ratio_p50: cell.accountCalibration.roasRatioP50,
    roas_ratio_p75: cell.accountCalibration.roasRatioP75,
    funnel_calibration_json: cell.funnelCalibration,
    metric_sample_counts_json: cell.metricSampleCounts,
    action_readiness_json: cell.actionReadiness,
    quality_counts_json: cell.qualityCounts,
    quality_status: cell.qualityStatus,
    target_authority_status: cell.targetAuthority.status,
    target_roas: cell.targetAuthority.targetRoas,
    break_even_roas: cell.targetAuthority.breakEvenRoas,
    target_effective_at: cell.targetAuthority.effectiveAt,
    target_recorded_at: cell.targetAuthority.recordedAt,
    target_authority_hash: cell.targetAuthority.authorityHash,
    source_min_date: cell.sourceMinDate,
    source_max_date: cell.sourceMaxDate,
    source_max_updated_at: cell.sourceMaxUpdatedAt,
    batch_input_manifest_hash: cell.batchInputManifestHash,
    input_manifest_hash: cell.inputManifestHash,
    source_manifest_hash: cell.sourceManifestHash,
    job_run_id: input.jobRunId,
    computed_at: cell.computedAt,
  }));
}

export function computeNativeAdCalibrationCellSetHash(
  cells: Array<
    Pick<
      NativeAdCalibrationCell,
      "key" | "inputManifestHash" | "sourceManifestHash"
    >
  >,
): string {
  return canonicalSha256({
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    cells: cells
      .map((cell) => ({
        identity: cellIdentity(cell.key),
        inputManifestHash: cell.inputManifestHash,
        sourceManifestHash: cell.sourceManifestHash,
      }))
      .sort((left, right) => left.identity.localeCompare(right.identity)),
  });
}

export interface NativeAdCalibrationSchemaCapability {
  ready: boolean;
  missing: string[];
  mismatched: string[];
}

interface NativeAdCalibrationColumnContract {
  type: string;
  notNull: boolean;
  default: string | null;
}

const BATCH_COLUMN_CONTRACT: Record<string, NativeAdCalibrationColumnContract> =
  {
    id: { type: "uuid", notNull: true, default: "gen_random_uuid()" },
    business_ref_id: { type: "uuid", notNull: true, default: null },
    business_id: { type: "text", notNull: true, default: null },
    provider: { type: "text", notNull: true, default: null },
    provider_account_ref_id: { type: "uuid", notNull: true, default: null },
    provider_account_id: { type: "text", notNull: true, default: null },
    as_of_date: { type: "date", notNull: true, default: null },
    as_of_cutoff: {
      type: "timestamp with time zone",
      notNull: true,
      default: null,
    },
    transaction_isolation: { type: "text", notNull: true, default: null },
    engine_version: { type: "text", notNull: true, default: null },
    policy_version: { type: "text", notNull: true, default: null },
    source_mode: { type: "text", notNull: true, default: null },
    source_provenance_json: { type: "jsonb", notNull: true, default: null },
    expected_cell_count: { type: "integer", notNull: true, default: null },
    generation_content_hash: {
      type: "character(64)",
      notNull: true,
      default: null,
    },
    input_manifest_hash: {
      type: "character(64)",
      notNull: true,
      default: null,
    },
    source_manifest_hash: {
      type: "character(64)",
      notNull: true,
      default: null,
    },
    cell_set_hash: {
      type: "character(64)",
      notNull: true,
      default: null,
    },
    completeness_status: { type: "text", notNull: true, default: null },
    job_run_id: { type: "uuid", notNull: true, default: null },
    computed_at: {
      type: "timestamp with time zone",
      notNull: true,
      default: null,
    },
    completed_at: {
      type: "timestamp with time zone",
      notNull: false,
      default: null,
    },
    created_at: {
      type: "timestamp with time zone",
      notNull: true,
      default: "now()",
    },
  };

const CELL_COLUMN_CONTRACT: Record<string, NativeAdCalibrationColumnContract> =
  Object.fromEntries(
    [
      ["id", "uuid", true, "gen_random_uuid()"],
      ["batch_id", "uuid", true, null],
      ["business_ref_id", "uuid", true, null],
      ["business_id", "text", true, null],
      ["provider", "text", true, null],
      ["provider_account_ref_id", "uuid", true, null],
      ["provider_account_id", "text", true, null],
      ["account_timezone", "text", true, null],
      ["account_currency", "text", true, null],
      ["cell_scope", "text", true, null],
      ["objective", "text", true, null],
      ["funnel_cohort", "text", true, null],
      ["optimization_context", "text", true, null],
      ["as_of_date", "date", true, null],
      ["as_of_cutoff", "timestamp with time zone", true, null],
      ["engine_version", "text", true, null],
      ["policy_version", "text", true, null],
      ["sample_window_start", "date", true, null],
      ["sample_window_end", "date", true, null],
      ["sample_window_days", "integer", true, null],
      ["source_ad_count", "integer", true, null],
      ["source_day_count", "integer", true, null],
      ["eligible_ad_count", "integer", true, null],
      ["mature_ad_count", "integer", true, null],
      ["zero_conversion_ad_count", "integer", true, null],
      ["roas_p75", "double precision", false, null],
      ["roas_p60", "double precision", false, null],
      ["refresh_ratio_p10", "double precision", false, null],
      ["low_ctr_p10", "double precision", false, null],
      ["account_cpa_p50", "double precision", false, null],
      ["account_cpa_sample_count", "integer", true, null],
      ["meta_attributed_aov_mean_90d", "double precision", false, null],
      ["meta_attributed_aov_purchase_count_90d", "integer", true, null],
      ["meta_attributed_revenue_90d", "double precision", true, "0"],
      ["meta_aov_quality", "text", true, null],
      ["mature_spend_p50", "double precision", false, null],
      ["mature_spend_p75", "double precision", false, null],
      ["winner_spend_p25", "double precision", false, null],
      ["winner_spend_p50", "double precision", false, null],
      ["winner_purchase_p50", "double precision", false, null],
      ["roas_ratio_p10", "double precision", false, null],
      ["roas_ratio_p25", "double precision", false, null],
      ["roas_ratio_p50", "double precision", false, null],
      ["roas_ratio_p75", "double precision", false, null],
      ["funnel_calibration_json", "jsonb", true, null],
      ["metric_sample_counts_json", "jsonb", true, null],
      ["action_readiness_json", "jsonb", true, null],
      ["quality_counts_json", "jsonb", true, null],
      ["quality_status", "text", true, null],
      ["target_authority_status", "text", true, null],
      ["target_roas", "double precision", false, null],
      ["break_even_roas", "double precision", false, null],
      ["target_effective_at", "timestamp with time zone", false, null],
      ["target_recorded_at", "timestamp with time zone", false, null],
      ["target_authority_hash", "character(64)", true, null],
      ["source_min_date", "date", false, null],
      ["source_max_date", "date", false, null],
      ["source_max_updated_at", "timestamp with time zone", false, null],
      ["batch_input_manifest_hash", "character(64)", true, null],
      ["input_manifest_hash", "character(64)", true, null],
      ["source_manifest_hash", "character(64)", true, null],
      ["job_run_id", "uuid", true, null],
      ["computed_at", "timestamp with time zone", true, null],
      ["created_at", "timestamp with time zone", true, "now()"],
    ].map(([name, type, notNull, defaultValue]) => [
      name,
      { type, notNull, default: defaultValue },
    ]),
  ) as Record<string, NativeAdCalibrationColumnContract>;

export const NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA = {
  columns: {
    [NATIVE_AD_CALIBRATION_BATCH_TABLE]: BATCH_COLUMN_CONTRACT,
    [NATIVE_AD_CALIBRATION_TABLE]: CELL_COLUMN_CONTRACT,
  },
  constraints: {
    engine_v3_ad_account_calibration_batches_pkey: "PRIMARY KEY (id)",
    engine_v3_ad_calibration_batches_business_fk:
      "FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_batches_account_fk:
      "FOREIGN KEY (provider_account_ref_id, provider, provider_account_id) REFERENCES provider_accounts(id, provider, external_account_id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_batches_binding_fk:
      "FOREIGN KEY (business_id, provider, provider_account_ref_id, provider_account_id) REFERENCES business_provider_accounts(business_id, provider, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_batches_job_fk:
      "FOREIGN KEY (job_run_id, business_ref_id, business_id, engine_version) REFERENCES engine_v3_job_runs(id, business_ref_id, business_id, engine_version) ON DELETE RESTRICT",
    engine_v3_ad_calibration_batches_business_identity_check:
      "CHECK (business_id = business_ref_id::text)",
    engine_v3_ad_calibration_batches_provider_check:
      "CHECK (provider = 'meta')",
    engine_v3_ad_calibration_batches_source_mode_check:
      "CHECK (source_mode = 'current_transaction_snapshot')",
    engine_v3_ad_calibration_batches_isolation_check:
      "CHECK (transaction_isolation = 'repeatable read')",
    engine_v3_ad_calibration_batches_provenance_check:
      "CHECK (jsonb_typeof(source_provenance_json) = 'object' AND source_provenance_json->>'mode' = source_mode AND source_provenance_json->>'providerAccountRefId' = provider_account_ref_id::text AND source_provenance_json->>'providerAccountId' = provider_account_id AND (source_provenance_json->>'transactionCutoff')::timestamptz = as_of_cutoff AND source_provenance_json->>'transactionIsolation' = transaction_isolation)",
    engine_v3_ad_calibration_batches_cutoff_date_check:
      "CHECK ((as_of_cutoff AT TIME ZONE 'UTC')::date = as_of_date)",
    engine_v3_ad_calibration_batches_computed_cutoff_check:
      "CHECK (computed_at = as_of_cutoff)",
    engine_v3_ad_calibration_batches_expected_count_check:
      "CHECK (expected_cell_count >= 0)",
    engine_v3_ad_calibration_batches_generation_hash_check:
      "CHECK (generation_content_hash ~ '^[0-9a-f]{64}$')",
    engine_v3_ad_calibration_batches_input_hash_check:
      "CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$')",
    engine_v3_ad_calibration_batches_source_hash_check:
      "CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$')",
    engine_v3_ad_calibration_batches_cell_hash_check:
      "CHECK (cell_set_hash ~ '^[0-9a-f]{64}$')",
    engine_v3_ad_calibration_batches_completeness_check:
      "CHECK ((completeness_status = 'writing' AND completed_at IS NULL) OR (completeness_status = 'complete' AND completed_at IS NOT NULL))",
    engine_v3_ad_calibration_batches_content_unique:
      "UNIQUE (business_ref_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, policy_version, generation_content_hash)",
    engine_v3_ad_calibration_batches_cutoff_unique:
      "UNIQUE (business_ref_id, provider_account_ref_id, provider_account_id, as_of_cutoff, engine_version, policy_version)",
    engine_v3_ad_calibration_batches_lineage_unique:
      "UNIQUE (id, business_ref_id, business_id, provider, provider_account_ref_id, provider_account_id, as_of_date, as_of_cutoff, engine_version, policy_version, input_manifest_hash, source_manifest_hash)",
    engine_v3_ad_account_calibration_daily_pkey: "PRIMARY KEY (id)",
    engine_v3_ad_calibration_daily_business_fk:
      "FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_daily_account_fk:
      "FOREIGN KEY (provider_account_ref_id, provider, provider_account_id) REFERENCES provider_accounts(id, provider, external_account_id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_daily_binding_fk:
      "FOREIGN KEY (business_id, provider, provider_account_ref_id, provider_account_id) REFERENCES business_provider_accounts(business_id, provider, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_daily_job_fk:
      "FOREIGN KEY (job_run_id, business_ref_id, business_id, engine_version) REFERENCES engine_v3_job_runs(id, business_ref_id, business_id, engine_version) ON DELETE RESTRICT",
    engine_v3_ad_calibration_daily_batch_fk:
      "FOREIGN KEY (batch_id, business_ref_id, business_id, provider, provider_account_ref_id, provider_account_id, as_of_date, as_of_cutoff, engine_version, policy_version, batch_input_manifest_hash, source_manifest_hash) REFERENCES engine_v3_ad_account_calibration_batches(id, business_ref_id, business_id, provider, provider_account_ref_id, provider_account_id, as_of_date, as_of_cutoff, engine_version, policy_version, input_manifest_hash, source_manifest_hash) ON DELETE RESTRICT",
    engine_v3_ad_calibration_daily_business_identity_check:
      "CHECK (business_id = business_ref_id::text)",
    engine_v3_ad_calibration_daily_provider_check: "CHECK (provider = 'meta')",
    engine_v3_ad_calibration_daily_scope_check:
      "CHECK (cell_scope = ANY (ARRAY['objective_cohort_context', 'account_objective_cohort']))",
    engine_v3_ad_calibration_daily_cohort_check:
      "CHECK (funnel_cohort = ANY (ARRAY['purchase', 'mid_funnel', 'lead', 'traffic', 'upper_funnel', 'engagement', 'unknown']))",
    engine_v3_ad_calibration_daily_window_check:
      "CHECK (sample_window_days > 0 AND sample_window_start <= sample_window_end)",
    engine_v3_ad_calibration_daily_counts_check:
      "CHECK (source_ad_count >= 0 AND source_day_count >= 0 AND eligible_ad_count >= 0 AND mature_ad_count >= 0 AND zero_conversion_ad_count >= 0 AND account_cpa_sample_count >= 0 AND meta_attributed_aov_purchase_count_90d >= 0)",
    engine_v3_ad_calibration_daily_action_readiness_check:
      "CHECK (jsonb_typeof(action_readiness_json) = 'object')",
    engine_v3_ad_calibration_daily_meta_aov_quality_check:
      "CHECK (meta_aov_quality = ANY (ARRAY['unavailable', 'unstable', 'low_sample', 'ready']))",
    engine_v3_ad_calibration_daily_quality_status_check:
      "CHECK (quality_status = ANY (ARRAY['ready', 'low_sample', 'insufficient', 'blocked_commercial', 'unsupported_cohort']))",
    engine_v3_ad_calibration_daily_target_status_check:
      "CHECK (target_authority_status = ANY (ARRAY['fresh', 'stale', 'missing', 'cutoff_unsafe']))",
    engine_v3_ad_calibration_daily_hashes_check:
      "CHECK (target_authority_hash ~ '^[0-9a-f]{64}$' AND batch_input_manifest_hash ~ '^[0-9a-f]{64}$' AND input_manifest_hash ~ '^[0-9a-f]{64}$' AND source_manifest_hash ~ '^[0-9a-f]{64}$')",
    engine_v3_ad_calibration_daily_computed_cutoff_check:
      "CHECK (computed_at = as_of_cutoff)",
    engine_v3_ad_calibration_daily_cell_unique:
      "UNIQUE (batch_id, account_currency, account_timezone, cell_scope, objective, funnel_cohort, optimization_context)",
  },
  indexes: {
    idx_provider_accounts_physical_identity:
      "CREATE UNIQUE INDEX idx_provider_accounts_physical_identity ON provider_accounts (id, provider, external_account_id)",
    idx_business_provider_accounts_physical_binding:
      "CREATE UNIQUE INDEX idx_business_provider_accounts_physical_binding ON business_provider_accounts (business_id, provider, provider_account_ref_id, provider_account_id)",
    idx_engine_v3_job_runs_native_lineage:
      "CREATE UNIQUE INDEX idx_engine_v3_job_runs_native_lineage ON engine_v3_job_runs (id, business_ref_id, business_id, engine_version)",
    idx_engine_v3_ad_calibration_batch_lookup:
      "CREATE INDEX idx_engine_v3_ad_calibration_batch_lookup ON engine_v3_ad_account_calibration_batches (business_ref_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, policy_version, completeness_status, as_of_cutoff DESC, id DESC)",
    idx_engine_v3_ad_account_calibration_lookup:
      "CREATE INDEX idx_engine_v3_ad_account_calibration_lookup ON engine_v3_ad_account_calibration_daily (batch_id, account_currency, account_timezone, funnel_cohort, objective, optimization_context)",
  },
  triggers: {
    engine_v3_native_ad_calibration_batch_immutable_trigger:
      "CREATE TRIGGER engine_v3_native_ad_calibration_batch_immutable_trigger BEFORE DELETE OR UPDATE ON engine_v3_ad_account_calibration_batches FOR EACH ROW EXECUTE FUNCTION engine_v3_native_ad_calibration_batch_immutable()",
    engine_v3_native_ad_calibration_cell_immutable_trigger:
      "CREATE TRIGGER engine_v3_native_ad_calibration_cell_immutable_trigger BEFORE INSERT OR DELETE OR UPDATE ON engine_v3_ad_account_calibration_daily FOR EACH ROW EXECUTE FUNCTION engine_v3_native_ad_calibration_cell_immutable()",
  },
} as const;

export async function inspectNativeAdCalibrationSchemaCapability(
  db: DbClient = getDb(),
): Promise<NativeAdCalibrationSchemaCapability> {
  const tableNames = Object.keys(NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.columns);
  const columns = await db.query<Record<string, unknown>>(
    `
    SELECT c.relname AS table_name, a.attname AS column_name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null,
      pg_get_expr(ad.adbin, ad.adrelid) AS column_default
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
      AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    WHERE n.nspname = current_schema()
      AND c.relkind = 'r'
      AND c.relname = ANY($1::text[])
    `,
    [tableNames],
  );
  const constraints = await db.query<Record<string, unknown>>(
    `
    SELECT con.conname AS name, pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])
    `,
    [tableNames],
  );
  const indexes = await db.query<Record<string, unknown>>(
    `
    SELECT index_class.relname AS name, pg_get_indexdef(index_class.oid) AS definition
    FROM pg_index index_row
    JOIN pg_class table_class ON table_class.oid = index_row.indrelid
    JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
    JOIN pg_namespace n ON n.oid = table_class.relnamespace
    WHERE n.nspname = current_schema() AND table_class.relname = ANY($1::text[])
    `,
    [
      [
        ...tableNames,
        "provider_accounts",
        "business_provider_accounts",
        "engine_v3_job_runs",
      ],
    ],
  );
  const triggers = await db.query<Record<string, unknown>>(
    `
    SELECT trigger_row.tgname AS name,
      pg_get_triggerdef(trigger_row.oid, true) AS definition
    FROM pg_trigger trigger_row
    JOIN pg_class c ON c.oid = trigger_row.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = ANY($1::text[])
      AND NOT trigger_row.tgisinternal
    `,
    [tableNames],
  );

  const missing: string[] = [];
  const mismatched: string[] = [];
  const availableColumns = new Map(
    columns.map((row) => [
      `${dbRequiredText(row.table_name, "table_name")}.${dbRequiredText(row.column_name, "column_name")}`,
      row,
    ]),
  );
  for (const [tableName, contract] of Object.entries(
    NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.columns,
  )) {
    for (const [columnName, expected] of Object.entries(contract)) {
      const key = `${tableName}.${columnName}`;
      const actual = availableColumns.get(key);
      if (!actual) {
        missing.push(key);
        continue;
      }
      if (
        dbRequiredText(actual.data_type, `${key}.type`) !== expected.type ||
        actual.not_null !== expected.notNull ||
        normalizeSchemaDefinition(actual.column_default) !==
          normalizeSchemaDefinition(expected.default)
      ) {
        mismatched.push(`${key}:column_contract`);
      }
    }
  }
  compareNamedSchemaDefinitions({
    kind: "constraint",
    expected: NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.constraints,
    actual: constraints,
    missing,
    mismatched,
  });
  compareNamedSchemaDefinitions({
    kind: "index",
    expected: NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.indexes,
    actual: indexes,
    missing,
    mismatched,
  });
  compareNamedSchemaDefinitions({
    kind: "trigger",
    expected: NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.triggers,
    actual: triggers,
    missing,
    mismatched,
  });
  return {
    ready: missing.length === 0 && mismatched.length === 0,
    missing,
    mismatched,
  };
}

export async function replaceNativeAdCalibrationBatch(
  input: { batch: NativeAdCalibrationBatch; jobRunId: string },
  options: {
    db?: DbClient;
    transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<NativeAdCalibrationReplacementResult> {
  assertNativeAdCalibrationBatchContract(input.batch);
  const transaction = options.transaction ?? runDbTransaction;
  return transaction(async () => {
    const db = options.db ?? getDb();
    await assertNativeCalibrationTransactionReceipt(input.batch, db);
    await assertPersistedProviderBindings(input.batch, db);

    const cutoffRows = await db.query<Record<string, unknown>>(
      READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL,
      [
        input.batch.businessId,
        input.batch.providerAccountRefId,
        input.batch.providerAccountId,
        input.batch.asOfCutoff,
        NATIVE_AD_ENGINE_VERSION,
        NATIVE_AD_CALIBRATION_POLICY_VERSION,
      ],
    );
    if (cutoffRows.length > 1) {
      throw new Error("Native ad calibration cutoff scope is not unique.");
    }
    const cutoffRow = cutoffRows[0];
    if (cutoffRow) {
      const persistedGenerationHash = requiredHash(
        cutoffRow.generation_content_hash,
        "cutoff generation_content_hash",
      );
      if (persistedGenerationHash !== input.batch.generationContentHash) {
        throw new Error(
          "Native ad calibration same_cutoff_generation_conflict: the persisted cutoff already represents different source content.",
        );
      }
      if (cutoffRow.completeness_status !== "complete") {
        throw new Error(
          "Native ad calibration same_cutoff_generation_conflict: an incomplete batch already owns the cutoff.",
        );
      }
    }

    const existingRows = await db.query<Record<string, unknown>>(
      READ_EXISTING_NATIVE_AD_CALIBRATION_BATCH_BY_CONTENT_SQL,
      [
        input.batch.businessId,
        input.batch.providerAccountRefId,
        input.batch.providerAccountId,
        input.batch.asOfDate,
        NATIVE_AD_ENGINE_VERSION,
        NATIVE_AD_CALIBRATION_POLICY_VERSION,
        input.batch.generationContentHash,
      ],
    );
    if (existingRows.length > 1) {
      throw new Error(
        "Native ad calibration generation content scope is not unique.",
      );
    }
    const existing = existingRows[0];
    if (existing) {
      return verifiedExistingCalibrationBatch(existing, db);
    }

    const [insertedBatch] = await db.query<Record<string, unknown>>(
      INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL,
      [
        input.batch.businessId,
        input.batch.businessId,
        input.batch.providerAccountRefId,
        input.batch.providerAccountId,
        input.batch.asOfDate,
        input.batch.asOfCutoff,
        input.batch.sourceProvenance.transactionIsolation,
        NATIVE_AD_ENGINE_VERSION,
        NATIVE_AD_CALIBRATION_POLICY_VERSION,
        input.batch.sourceProvenance.mode,
        JSON.stringify(input.batch.sourceProvenance),
        input.batch.expectedCellCount,
        input.batch.generationContentHash,
        input.batch.inputManifestHash,
        input.batch.sourceManifestHash,
        input.batch.cellSetHash,
        input.jobRunId,
        input.batch.computedAt,
      ],
    );
    const batchId = requiredUuid(insertedBatch?.id, "calibration batch id");
    const payload = buildNativeAdCalibrationPersistencePayload(input.batch, {
      batchId,
      jobRunId: input.jobRunId,
    });
    if (payload.length > 0) {
      await db.query(INSERT_NATIVE_AD_CALIBRATION_SQL, [
        JSON.stringify(payload),
      ]);
    }
    await assertPersistedCellSetProof(input.batch, batchId, db);
    const completed = await db.query<Record<string, unknown>>(
      COMPLETE_NATIVE_AD_CALIBRATION_BATCH_SQL,
      [
        batchId,
        input.batch.expectedCellCount,
        input.batch.inputManifestHash,
        input.batch.sourceManifestHash,
        input.batch.cellSetHash,
      ],
    );
    if (
      completed.length !== 1 ||
      requiredUuid(completed[0]?.id, "completed calibration batch id") !==
        batchId
    ) {
      throw new Error("Native ad calibration batch completion proof failed.");
    }
    return {
      batchId,
      rowsWritten: payload.length,
      expectedCellCount: input.batch.expectedCellCount,
      idempotentReplay: false,
      generationContentHash: input.batch.generationContentHash,
      inputManifestHash: input.batch.inputManifestHash,
      sourceManifestHash: input.batch.sourceManifestHash,
      cellSetHash: input.batch.cellSetHash,
    };
  });
}

async function assertNativeCalibrationTransactionReceipt(
  batch: NativeAdCalibrationBatch,
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL,
  );
  if (rows.length !== 1) {
    throw new Error(
      "Native ad calibration transaction receipt must resolve exactly once.",
    );
  }
  const cutoff = dbRequiredTimestamp(
    rows[0]?.computation_cutoff,
    "transaction computation_cutoff",
  );
  const isolation = dbRequiredText(
    rows[0]?.transaction_isolation,
    "transaction_isolation",
  ).toLowerCase();
  if (
    cutoff !== batch.asOfCutoff ||
    isolation !== "repeatable read" ||
    batch.sourceProvenance.transactionCutoff !== cutoff ||
    batch.sourceProvenance.transactionIsolation !== isolation
  ) {
    throw new Error(
      "Native ad calibration transaction receipt does not match its persisted cutoff or REPEATABLE READ isolation.",
    );
  }
}

async function verifiedExistingCalibrationBatch(
  existing: Record<string, unknown>,
  db: DbClient,
): Promise<NativeAdCalibrationReplacementResult> {
  const batchId = requiredUuid(existing.id, "existing calibration batch id");
  const expectedCellCount = requiredInteger(
    existing.expected_cell_count,
    "existing expected_cell_count",
  );
  const cellSetHash = requiredHash(
    existing.cell_set_hash,
    "existing cell_set_hash",
  );
  await assertPersistedCellSetProofValues(
    { expectedCellCount, cellSetHash },
    batchId,
    db,
  );
  return {
    batchId,
    rowsWritten: 0,
    expectedCellCount,
    idempotentReplay: true,
    generationContentHash: requiredHash(
      existing.generation_content_hash,
      "existing generation_content_hash",
    ),
    inputManifestHash: requiredHash(
      existing.input_manifest_hash,
      "existing input_manifest_hash",
    ),
    sourceManifestHash: requiredHash(
      existing.source_manifest_hash,
      "existing source_manifest_hash",
    ),
    cellSetHash,
  };
}

async function assertPersistedProviderBindings(
  batch: NativeAdCalibrationBatch,
  db: DbClient,
) {
  const requestedRows = await db.query<Record<string, unknown>>(
    ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL,
    [batch.businessId, batch.providerAccountRefId, batch.providerAccountId],
  );
  if (
    requestedRows.length !== 1 ||
    dbRequiredText(
      requestedRows[0]?.provider_account_ref_id,
      "provider_account_ref_id",
    ) !== batch.providerAccountRefId ||
    dbRequiredText(
      requestedRows[0]?.provider_account_id,
      "provider_account_id",
    ) !== batch.providerAccountId
  ) {
    throw new Error(
      "Native ad calibration provider account is not the exact physical business binding.",
    );
  }
}

async function assertPersistedCellSetProof(
  batch: NativeAdCalibrationBatch,
  batchId: string,
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL,
    [batchId],
  );
  return assertPersistedCellSetProofRows(
    {
      expectedCellCount: batch.expectedCellCount,
      cellSetHash: batch.cellSetHash,
    },
    rows,
  );
}

async function assertPersistedCellSetProofValues(
  expected: { expectedCellCount: number; cellSetHash: string },
  batchId: string,
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL,
    [batchId],
  );
  return assertPersistedCellSetProofRows(expected, rows);
}

function assertPersistedCellSetProofRows(
  expected: { expectedCellCount: number; cellSetHash: string },
  rows: Record<string, unknown>[],
) {
  if (rows.length !== expected.expectedCellCount) {
    throw new Error(
      `Native ad calibration generation cardinality mismatch: expected ${expected.expectedCellCount}, persisted ${rows.length}.`,
    );
  }
  const hash = computePersistedCellSetHash(rows);
  if (hash !== expected.cellSetHash) {
    throw new Error(
      `Native ad calibration generation hash mismatch: expected ${expected.cellSetHash}, persisted ${hash}.`,
    );
  }
}

function assertNativeAdCalibrationBatchContract(
  batch: NativeAdCalibrationBatch,
) {
  requiredHash(batch.generationContentHash, "generationContentHash");
  requiredHash(batch.inputManifestHash, "inputManifestHash");
  requiredHash(batch.sourceManifestHash, "sourceManifestHash");
  requiredHash(batch.cellSetHash, "cellSetHash");
  requiredUuid(batch.providerAccountRefId, "providerAccountRefId");
  const window = resolveNativeAdCalibrationCutoff(
    batch.asOfDate,
    batch.asOfCutoff,
  );
  if (
    batch.engineVersion !== NATIVE_AD_ENGINE_VERSION ||
    batch.policyVersion !== NATIVE_AD_CALIBRATION_POLICY_VERSION ||
    batch.providerAccountRefId !==
      batch.sourceProvenance.providerAccountRefId ||
    batch.providerAccountId !== batch.sourceProvenance.providerAccountId ||
    batch.asOfCutoff !== batch.sourceProvenance.transactionCutoff ||
    batch.sourceProvenance.mode !== "current_transaction_snapshot" ||
    batch.sourceProvenance.transactionIsolation !== "repeatable read" ||
    batch.computedAt !== batch.asOfCutoff ||
    batch.sampleWindowStart !== window.sampleWindowStart ||
    batch.sampleWindowEnd !== window.sampleWindowEnd
  ) {
    throw new Error(
      "Native ad calibration batch uses a non-native engine epoch.",
    );
  }
  if (
    batch.cells.length !== batch.expectedCellCount ||
    computeNativeAdCalibrationCellSetHash(batch.cells) !== batch.cellSetHash
  ) {
    throw new Error(
      "Native ad calibration batch completeness proof is invalid.",
    );
  }
  for (const cell of batch.cells) {
    if (
      cell.key.businessId !== batch.businessId ||
      cell.key.providerAccountRefId !== batch.providerAccountRefId ||
      cell.key.providerAccountId !== batch.providerAccountId ||
      cell.asOfCutoff !== batch.asOfCutoff ||
      cell.engineVersion !== NATIVE_AD_ENGINE_VERSION ||
      cell.batchCellCount !== batch.expectedCellCount ||
      cell.batchCellSetHash !== batch.cellSetHash ||
      cell.batchCompleteness !== "computed"
    ) {
      throw new Error(
        "Native ad calibration cell is outside its batch contract.",
      );
    }
  }
}

function providerBindingsFromRows(rows: Record<string, unknown>[]) {
  return rows
    .map((row) => ({
      providerAccountRefId: requiredUuid(
        row.provider_account_ref_id,
        "provider_account_ref_id",
      ),
      providerAccountId: dbRequiredText(
        row.provider_account_id,
        "provider_account_id",
      ),
    }))
    .sort((left, right) =>
      `${left.providerAccountRefId}\u0000${left.providerAccountId}`.localeCompare(
        `${right.providerAccountRefId}\u0000${right.providerAccountId}`,
      ),
    );
}

function computePersistedCellSetHash(rows: Record<string, unknown>[]) {
  return canonicalSha256({
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    cells: rows
      .map((row) => ({
        identity: [
          requiredText(String(row.business_id ?? ""), "business_id"),
          requiredText(
            String(row.provider_account_ref_id ?? ""),
            "provider_account_ref_id",
          ),
          requiredText(
            String(row.provider_account_id ?? ""),
            "provider_account_id",
          ),
          requiredText(String(row.account_timezone ?? ""), "account_timezone"),
          requiredText(String(row.account_currency ?? ""), "account_currency"),
          requiredText(String(row.cell_scope ?? ""), "cell_scope"),
          requiredText(String(row.objective ?? ""), "objective"),
          requiredText(String(row.funnel_cohort ?? ""), "funnel_cohort"),
          requiredText(
            String(row.optimization_context ?? ""),
            "optimization_context",
          ),
        ].join("\u0000"),
        inputManifestHash: requiredHash(
          row.input_manifest_hash,
          "input_manifest_hash",
        ),
        sourceManifestHash: requiredHash(
          row.source_manifest_hash,
          "source_manifest_hash",
        ),
      }))
      .sort((left, right) => left.identity.localeCompare(right.identity)),
  });
}

export function adCalibrationJobAdvisoryLockKey(
  input: AdCalibrationJobInput,
): bigint {
  return hashAdvisoryLock(
    `${AD_CALIBRATION_JOB_NAME}:${input.businessId}:${input.asOf}:${NATIVE_AD_ENGINE_VERSION}`,
  );
}

export async function runAdCalibrationJob(
  input: AdCalibrationJobInput,
  options: AdCalibrationJobRuntimeOptions = {},
): Promise<AdCalibrationJobResult> {
  const startedAt = Date.now();
  let requestedDate: ReturnType<typeof resolveNativeAdCalibrationDate>;
  try {
    requestedDate = resolveNativeAdCalibrationDate(input.asOf);
  } catch (error) {
    return failedAdCalibrationWithoutRun({
      startedAt,
      reason: "historical_as_of_unsafe",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  const businessGuard = options.businessGuard ?? getBusinessGuardFailure;
  const guardFailure = await businessGuard(input.businessId);
  if (guardFailure) {
    return failedAdCalibrationWithoutRun({
      startedAt,
      reason: guardFailure.reason,
      errorMessage: guardFailure.message,
    });
  }
  const flags = await (options.resolveFlags ?? resolveEngineV3Flags)(
    input.businessId,
  );
  if (!flags.enabled) {
    return {
      jobRunId: "",
      status: "skipped",
      rowsWritten: 0,
      expectedCellCount: 0,
      idempotentReplay: false,
      inputManifestHash: null,
      sourceManifestHash: null,
      cellSetHash: null,
      batches: [],
      durationMs: Date.now() - startedAt,
      reason: "engine_v3_disabled",
    };
  }

  const transaction =
    options.transaction ??
    (<T>(fn: () => Promise<T>) =>
      runDbTransaction(fn, {
        timeoutMs: ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS,
      }));
  return transaction(async () => {
    const db = options.db ?? getDb();
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const [lock] = await db.query<Record<string, unknown>>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [adCalibrationJobAdvisoryLockKey(input).toString()],
    );
    if (lock?.acquired !== true) {
      const durationMs = Date.now() - startedAt;
      const errorMessage =
        "Advisory lock not acquired (native ad calibration may already be running)";
      const jobRunId = await insertAdCalibrationJobRun(
        {
          ...input,
          status: "skipped",
          durationMs,
          errorMessage,
        },
        db,
      );
      return {
        jobRunId,
        status: "skipped" as const,
        rowsWritten: 0,
        expectedCellCount: 0,
        idempotentReplay: false,
        inputManifestHash: null,
        sourceManifestHash: null,
        cellSetHash: null,
        batches: [],
        durationMs,
        reason: "advisory_lock_not_acquired" as const,
        errorMessage,
      };
    }

    const jobRunId = await insertAdCalibrationJobRun(
      { ...input, status: "running" },
      db,
    );
    await db.query("SAVEPOINT engine_v3_ad_calibration_job_work");
    try {
      const capability = await inspectNativeAdCalibrationSchemaCapability(db);
      if (!capability.ready) {
        throw new NativeAdCalibrationSchemaNotReadyError([
          ...capability.missing,
          ...capability.mismatched,
        ]);
      }
      const receiptRows = await db.query<Record<string, unknown>>(
        READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL,
      );
      if (receiptRows.length !== 1) {
        throw new Error(
          "Native ad calibration transaction receipt must resolve exactly once.",
        );
      }
      const computationCutoff = dbRequiredTimestamp(
        receiptRows[0]?.computation_cutoff,
        "computation_cutoff",
      );
      const transactionIsolation = dbRequiredText(
        receiptRows[0]?.transaction_isolation,
        "transaction_isolation",
      ).toLowerCase();
      if (transactionIsolation !== "repeatable read") {
        throw new Error(
          "Native ad calibration requires a REPEATABLE READ transaction snapshot.",
        );
      }
      resolveNativeAdCalibrationCutoff(
        requestedDate.asOfDate,
        computationCutoff,
      );
      const providerRows = await db.query<Record<string, unknown>>(
        LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL,
        [input.businessId],
      );
      const bindings = providerBindingsFromRows(providerRows);
      const completed: Array<{
        batch: NativeAdCalibrationBatch;
        replacement: NativeAdCalibrationReplacementResult;
      }> = [];
      for (const binding of bindings) {
        const sourceRows = await db.query<Record<string, unknown>>(
          READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
          [
            input.businessId,
            requestedDate.asOfDate,
            binding.providerAccountRefId,
            binding.providerAccountId,
            computationCutoff,
          ],
        );
        const [targetRow] = await db.query<Record<string, unknown>>(
          READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
          [
            input.businessId,
            binding.providerAccountRefId,
            binding.providerAccountId,
            computationCutoff,
          ],
        );
        const batch = computeNativeAdCalibrationBatch({
          businessId: input.businessId,
          providerAccountRefId: binding.providerAccountRefId,
          providerAccountId: binding.providerAccountId,
          asOf: requestedDate.asOfDate,
          computationCutoff,
          sourceRows: sourceRows.map(mapNativeAdCalibrationSourceRow),
          targetAuthority: targetRow
            ? mapNativeAdTargetAuthorityRow(targetRow)
            : null,
        });
        const replacement = await replaceNativeAdCalibrationBatch(
          { batch, jobRunId },
          { db, transaction: async (fn) => fn() },
        );
        completed.push({ batch, replacement });
      }
      const durationMs = Date.now() - startedAt;
      await markAdCalibrationJobSuccess(
        { jobRunId, durationMs, completed },
        db,
      );
      const batches = completed.map(({ batch, replacement }) => ({
        providerAccountRefId: batch.providerAccountRefId,
        providerAccountId: batch.providerAccountId,
        batchId: replacement.batchId,
        rowsWritten: replacement.rowsWritten,
        expectedCellCount: replacement.expectedCellCount,
        idempotentReplay: replacement.idempotentReplay,
        generationContentHash: replacement.generationContentHash,
        inputManifestHash: replacement.inputManifestHash,
        sourceManifestHash: replacement.sourceManifestHash,
        cellSetHash: replacement.cellSetHash,
      }));
      const proof = aggregateCalibrationJobProof(batches);
      return {
        jobRunId,
        status: "success" as const,
        rowsWritten: sum(batches, (batch) => batch.rowsWritten),
        expectedCellCount: sum(batches, (batch) => batch.expectedCellCount),
        idempotentReplay:
          batches.length > 0 &&
          batches.every((batch) => batch.idempotentReplay),
        inputManifestHash: proof.inputManifestHash,
        sourceManifestHash: proof.sourceManifestHash,
        cellSetHash: proof.cellSetHash,
        batches,
        durationMs,
      };
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT engine_v3_ad_calibration_job_work");
      const durationMs = Date.now() - startedAt;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await markAdCalibrationJobFailed(
        { jobRunId, durationMs, error, errorMessage },
        db,
      );
      return {
        jobRunId,
        status: "failed" as const,
        rowsWritten: 0,
        expectedCellCount: 0,
        idempotentReplay: false,
        inputManifestHash: null,
        sourceManifestHash: null,
        cellSetHash: null,
        batches: [],
        durationMs,
        ...(error instanceof NativeAdCalibrationSchemaNotReadyError
          ? { reason: "schema_not_ready" as const }
          : error instanceof NativeAdHistoricalCalibrationUnsafeError
            ? { reason: "historical_as_of_unsafe" as const }
            : {}),
        errorMessage,
      };
    }
  });
}

async function insertAdCalibrationJobRun(
  input: AdCalibrationJobInput & {
    status: AdCalibrationJobResult["status"] | "running";
    durationMs?: number;
    errorMessage?: string;
  },
  db: DbClient,
) {
  const [row] = await db.query<Record<string, unknown>>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version, status,
      finished_at, duration_ms, row_count, error_message
    ) VALUES (
      $1, $2::uuid, $3, $4::date, $5, $6,
      CASE WHEN $6 = 'running' THEN NULL ELSE now() END,
      $7::integer, CASE WHEN $6 = 'running' THEN NULL ELSE 0 END, $8
    )
    RETURNING id::text AS id
    `,
    [
      AD_CALIBRATION_JOB_NAME,
      input.businessId,
      input.businessId,
      input.asOf,
      NATIVE_AD_ENGINE_VERSION,
      input.status,
      input.durationMs ?? null,
      input.errorMessage ?? null,
    ],
  );
  return requiredUuid(row?.id, "native ad calibration job run id");
}

async function markAdCalibrationJobSuccess(
  input: {
    jobRunId: string;
    durationMs: number;
    completed: Array<{
      batch: NativeAdCalibrationBatch;
      replacement: NativeAdCalibrationReplacementResult;
    }>;
  },
  db: DbClient,
) {
  const observations = input.completed.flatMap(
    ({ batch }) => batch.observations,
  );
  const rows = await db.query<Record<string, unknown>>(
    `
    UPDATE engine_v3_job_runs
    SET status = 'success', finished_at = now(), duration_ms = $1::integer,
      row_count = $2::integer, source_min_date = $3::date,
      source_max_date = $4::date, source_max_updated_at = $5::timestamptz,
      error_json = $6::jsonb, updated_at = now()
    WHERE id = $7::uuid AND status = 'running'
    RETURNING id::text AS id
    `,
    [
      input.durationMs,
      sum(input.completed, ({ replacement }) => replacement.expectedCellCount),
      minText(observations.map((row) => row.sourceMinDate)),
      maxText(observations.map((row) => row.sourceMaxDate)),
      maxText(observations.map((row) => row.sourceMaxUpdatedAt)),
      JSON.stringify({
        metadata: {
          native_ad_grain: true,
          shadow_only: true,
          source_mode: "current_transaction_snapshot",
          provider_account_count: input.completed.length,
          expected_cell_count: sum(
            input.completed,
            ({ replacement }) => replacement.expectedCellCount,
          ),
          rows_written: sum(
            input.completed,
            ({ replacement }) => replacement.rowsWritten,
          ),
          idempotent_replay:
            input.completed.length > 0 &&
            input.completed.every(
              ({ replacement }) => replacement.idempotentReplay,
            ),
          batches: input.completed.map(({ batch, replacement }) => ({
            provider_account_ref_id: batch.providerAccountRefId,
            provider_account_id: batch.providerAccountId,
            batch_id: replacement.batchId,
            generation_content_hash: replacement.generationContentHash,
            input_manifest_hash: replacement.inputManifestHash,
            source_manifest_hash: replacement.sourceManifestHash,
            cell_set_hash: replacement.cellSetHash,
          })),
        },
      }),
      input.jobRunId,
    ],
  );
  assertTerminalJobRunUpdate(rows, input.jobRunId, "success");
}

async function markAdCalibrationJobFailed(
  input: {
    jobRunId: string;
    durationMs: number;
    error: unknown;
    errorMessage: string;
  },
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    `
    UPDATE engine_v3_job_runs
    SET status = 'failed', finished_at = now(), duration_ms = $1::integer,
      row_count = 0, error_message = $2, error_json = $3::jsonb,
      updated_at = now()
    WHERE id = $4::uuid AND status = 'running'
    RETURNING id::text AS id
    `,
    [
      input.durationMs,
      input.errorMessage,
      JSON.stringify(errorToJson(input.error)),
      input.jobRunId,
    ],
  );
  assertTerminalJobRunUpdate(rows, input.jobRunId, "failed");
}

function assertTerminalJobRunUpdate(
  rows: Record<string, unknown>[],
  jobRunId: string,
  status: "success" | "failed",
) {
  if (
    rows.length !== 1 ||
    requiredUuid(rows[0]?.id, `${status} native calibration job run id`) !==
      jobRunId
  ) {
    throw new Error(
      `Native ad calibration ${status} terminal update did not affect exactly its running job row.`,
    );
  }
}

function aggregateCalibrationJobProof(
  batches: NativeAdCalibrationJobBatchResult[],
): Pick<
  AdCalibrationJobResult,
  "inputManifestHash" | "sourceManifestHash" | "cellSetHash"
> {
  if (batches.length === 0) {
    return {
      inputManifestHash: null,
      sourceManifestHash: null,
      cellSetHash: null,
    };
  }
  if (batches.length === 1) {
    return {
      inputManifestHash: batches[0]?.inputManifestHash ?? null,
      sourceManifestHash: batches[0]?.sourceManifestHash ?? null,
      cellSetHash: batches[0]?.cellSetHash ?? null,
    };
  }
  const ordered = [...batches].sort((left, right) =>
    `${left.providerAccountRefId}\u0000${left.providerAccountId}`.localeCompare(
      `${right.providerAccountRefId}\u0000${right.providerAccountId}`,
    ),
  );
  return {
    inputManifestHash: canonicalSha256(
      ordered.map((batch) => batch.inputManifestHash),
    ),
    sourceManifestHash: canonicalSha256(
      ordered.map((batch) => batch.sourceManifestHash),
    ),
    cellSetHash: canonicalSha256(ordered.map((batch) => batch.cellSetHash)),
  };
}

function failedAdCalibrationWithoutRun(input: {
  startedAt: number;
  reason:
    "invalid_business_id" | "business_not_found" | "historical_as_of_unsafe";
  errorMessage: string;
}): AdCalibrationJobResult {
  return {
    jobRunId: "",
    status: "failed",
    rowsWritten: 0,
    expectedCellCount: 0,
    idempotentReplay: false,
    inputManifestHash: null,
    sourceManifestHash: null,
    cellSetHash: null,
    batches: [],
    durationMs: Date.now() - input.startedAt,
    reason: input.reason,
    errorMessage: input.errorMessage,
  };
}

function buildObservations(input: {
  businessId: string;
  asOfCutoff: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  rows: NormalizedSourceRow[];
}): ObservationBuildResult {
  const qualityCounts = emptyQualityCounts(input.rows.length);
  const grouped = new Map<string, NormalizedSourceRow[]>();
  const eligibleSourceRows: NormalizedSourceRow[] = [];

  for (const row of input.rows) {
    if (
      row.businessId !== input.businessId ||
      !row.providerAccountRefId ||
      !row.providerAccountId ||
      !row.adId ||
      !isDateOnly(row.date) ||
      row.date < input.sampleWindowStart ||
      row.date > input.sampleWindowEnd
    ) {
      qualityCounts.identitySourceRowExclusionCount += 1;
      continue;
    }
    const key = `${row.businessId}\u0000${row.providerAccountRefId}\u0000${row.providerAccountId}\u0000${row.adId}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }

  qualityCounts.candidateAdCount = grouped.size;
  const observations: NativeAdCalibrationObservation[] = [];
  const sortedAdGroups = [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );

  for (const [, rows] of sortedAdGroups) {
    const censoredRows = rows.filter((row) => !hasFinalizedTruth(row));
    if (censoredRows.length > 0) {
      qualityCounts.censoredSourceRowExclusionCount += censoredRows.length;
      qualityCounts.censoredAdExclusionCount += 1;
      continue;
    }

    const freshnessRows = rows.filter(
      (row) => !isRowAvailableAtCutoff(row, input.asOfCutoff),
    );
    if (freshnessRows.length > 0) {
      qualityCounts.freshnessSourceRowExclusionCount += freshnessRows.length;
      qualityCounts.freshnessAdExclusionCount += 1;
      continue;
    }
    qualityCounts.cutoffSafeSourceRowCount += rows.length;

    const dayGroups = groupBy(rows, (row) => row.date);
    const deduplicated: NormalizedSourceRow[] = [];
    let duplicateConflict = false;
    for (const dayRows of [...dayGroups.values()]) {
      const signatures = new Set(dayRows.map(sourceContentSignature));
      if (signatures.size > 1) {
        qualityCounts.duplicateSourceRowExclusionCount += dayRows.length;
        duplicateConflict = true;
        break;
      }
      const sorted = [...dayRows].sort((left, right) =>
        left.sourceRowId.localeCompare(right.sourceRowId),
      );
      const first = sorted[0];
      if (first) deduplicated.push(first);
      qualityCounts.duplicateSourceRowExclusionCount += Math.max(
        0,
        dayRows.length - 1,
      );
    }
    if (duplicateConflict) {
      qualityCounts.duplicateConflictAdExclusionCount += 1;
      continue;
    }

    const totalSpend = sum(deduplicated, (row) => row.spend);
    if (totalSpend <= 0 || deduplicated.some(hasInvalidMetric)) {
      qualityCounts.censoredSourceRowExclusionCount += deduplicated.length;
      qualityCounts.censoredAdExclusionCount += 1;
      continue;
    }

    const positiveSpendRows = deduplicated.filter((row) => row.spend > 0);
    const contexts = positiveSpendRows.map(normalizedExactContext);
    if (contexts.some((context) => context === null)) {
      qualityCounts.missingContextAdExclusionCount += 1;
      continue;
    }
    const exactContexts = contexts.filter(
      (context): context is NonNullable<typeof context> => context !== null,
    );
    const cardinality = contextCardinality(exactContexts);
    if (cardinality.mixed) {
      qualityCounts.mixedContextAdExclusionCount += 1;
      if (cardinality.currency > 1) {
        qualityCounts.mixedCurrencyAdExclusionCount += 1;
      }
      if (cardinality.objective > 1) {
        qualityCounts.mixedObjectiveAdExclusionCount += 1;
      }
      if (cardinality.cohort > 1) {
        qualityCounts.mixedCohortAdExclusionCount += 1;
      }
      continue;
    }

    const context = exactContexts[0];
    if (!context) {
      qualityCounts.missingContextAdExclusionCount += 1;
      continue;
    }
    const acceptedSourceRowIds = deduplicated
      .map((row) => row.sourceRowId)
      .sort((left, right) => left.localeCompare(right));
    eligibleSourceRows.push(...deduplicated);
    observations.push(
      aggregateObservation({
        rows: deduplicated.sort((left, right) =>
          left.date.localeCompare(right.date),
        ),
        sourceRowIds: acceptedSourceRowIds,
        context,
        sampleWindowEnd: input.sampleWindowEnd,
      }),
    );
  }

  observations.sort((left, right) =>
    observationIdentity(left).localeCompare(observationIdentity(right)),
  );
  qualityCounts.eligibleAdObservationCount = observations.length;
  eligibleSourceRows.sort((left, right) =>
    sourceManifestEntry(left).sortKey.localeCompare(
      sourceManifestEntry(right).sortKey,
    ),
  );
  return { observations, qualityCounts, eligibleSourceRows };
}

function buildCells(
  batch: Omit<
    NativeAdCalibrationBatch,
    "cells" | "expectedCellCount" | "cellSetHash"
  >,
): NativeAdCalibrationCell[] {
  const grouped = new Map<
    string,
    { key: NativeAdCalibrationCellKey; rows: NativeAdCalibrationObservation[] }
  >();

  for (const observation of batch.observations) {
    const optimizationContext = buildNativeAdOptimizationContext(
      observation.optimizationGoal,
      observation.customEventType,
    );
    if (optimizationContext === null) {
      throw new Error("Native ad observation is missing optimization context.");
    }
    const exactKey: NativeAdCalibrationCellKey = {
      businessId: observation.businessId,
      providerAccountRefId: observation.providerAccountRefId,
      providerAccountId: observation.providerAccountId,
      accountTimezone: observation.accountTimezone,
      accountCurrency: observation.accountCurrency,
      cellScope: "objective_cohort_context",
      objective: observation.objective,
      cohort: observation.cohort,
      optimizationContext,
    };
    const fallbackKey: NativeAdCalibrationCellKey = {
      ...exactKey,
      cellScope: "account_objective_cohort",
      optimizationContext: NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT,
    };
    addCellObservation(grouped, exactKey, observation);
    addCellObservation(grouped, fallbackKey, observation);
  }

  return [...grouped.values()]
    .sort((left, right) =>
      cellIdentity(left.key).localeCompare(cellIdentity(right.key)),
    )
    .map(({ key, rows }) => computeCell(batch, key, rows));
}

function computeCell(
  batch: Omit<
    NativeAdCalibrationBatch,
    "cells" | "expectedCellCount" | "cellSetHash"
  >,
  key: NativeAdCalibrationCellKey,
  observations: NativeAdCalibrationObservation[],
): NativeAdCalibrationCell {
  const purchase = key.cohort === "purchase";
  const converterPopulation = purchase
    ? observations.filter(
        (row) =>
          row.totalConversions >= 1 &&
          row.totalRevenue > 0 &&
          row.totalSpend > 0,
      )
    : [];
  const targetRoas = batch.targetAuthority.targetRoasAuthority
    ? batch.targetAuthority.targetRoas
    : null;
  const winnerPopulation =
    purchase && positiveFinite(targetRoas)
      ? converterPopulation.filter(
          (row) =>
            row.aggregateRoas !== null && row.aggregateRoas >= targetRoas,
        )
      : [];
  const cpaValues = converterPopulation
    .map((row) => row.aggregateCpa)
    .filter(isFiniteNumber);
  const roasValues = converterPopulation
    .map((row) => row.aggregateRoas)
    .filter(isFiniteNumber);
  const roasRatios =
    purchase && positiveFinite(targetRoas)
      ? converterPopulation
          .map((row) =>
            row.aggregateRoas === null ? null : row.aggregateRoas / targetRoas,
          )
          .filter(isFiniteNumber)
      : [];
  const refreshRatios = purchase
    ? observations.map((row) => row.recentTotalRatio).filter(isFiniteNumber)
    : [];
  const lowCtrValues = observations
    .map((row) => row.cumulative28dCtr)
    .filter(isFiniteNumber);
  const purchaseCount = purchase
    ? sum(observations, (row) => row.totalConversions)
    : 0;
  const purchaseRevenue = purchase
    ? sum(observations, (row) => row.totalRevenue)
    : 0;
  const metaAovQuality = classifyMetaAovQuality(purchaseCount);
  const funnelCalibration = buildFunnelCalibration(observations);
  const baseline = funnelCalibration.byFormat.overall;
  if (!baseline) {
    throw new Error("Native ad overall funnel baseline was not built.");
  }
  const metricSampleCounts = buildMetricSampleCounts({
    observations,
    roasValues,
    roasRatios,
    cpaValues,
    winnerPopulation,
    refreshRatios,
  });
  const accountCalibration: AccountCalibration = {
    businessId: key.businessId,
    computedAt: batch.computedAt,
    matureCreativeCount: converterPopulation.length,
    roasP75:
      purchase && converterPopulation.length >= 30
        ? percentile(roasValues, 0.75)
        : null,
    roasP60:
      purchase && converterPopulation.length >= 10
        ? percentile(roasValues, 0.6)
        : null,
    refreshRatioP10:
      purchase && refreshRatios.length >= 20
        ? percentile(refreshRatios, 0.1)
        : null,
    lowCtrP10: lowCtrValues.length >= 20 ? percentile(lowCtrValues, 0.1) : null,
    accountCpaP50:
      purchase && cpaValues.length >= 20 ? percentile(cpaValues, 0.5) : null,
    accountCpaSampleCount: purchase ? cpaValues.length : 0,
    metaAttributedAovMean90d:
      purchase && purchaseCount > 0 ? purchaseRevenue / purchaseCount : null,
    metaAttributedAovPurchaseCount90d: purchase ? purchaseCount : 0,
    metaAttributedRevenue90d: purchase ? purchaseRevenue : 0,
    matureSpendP50: purchase
      ? percentile(
          converterPopulation.map((row) => row.totalSpend),
          0.5,
        )
      : null,
    matureSpendP75: purchase
      ? percentile(
          converterPopulation.map((row) => row.totalSpend),
          0.75,
        )
      : null,
    winnerSpendP25: purchase
      ? percentile(
          winnerPopulation.map((row) => row.totalSpend),
          0.25,
        )
      : null,
    winnerSpendP50: purchase
      ? percentile(
          winnerPopulation.map((row) => row.totalSpend),
          0.5,
        )
      : null,
    winnerPurchaseP50: purchase
      ? percentile(
          winnerPopulation.map((row) => row.totalConversions),
          0.5,
        )
      : null,
    roasRatioP10:
      purchase && roasRatios.length >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
        ? percentile(roasRatios, 0.1)
        : null,
    roasRatioP25:
      purchase && roasRatios.length >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
        ? percentile(roasRatios, 0.25)
        : null,
    roasRatioP50:
      purchase && roasRatios.length >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
        ? percentile(roasRatios, 0.5)
        : null,
    roasRatioP75:
      purchase && roasRatios.length >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
        ? percentile(roasRatios, 0.75)
        : null,
    metaAovQuality,
  };
  const actionReadiness = resolveNativeAdCalibrationActionReadiness({
    key,
    matureAdCount: converterPopulation.length,
    metricSampleCounts,
    targetAuthority: batch.targetAuthority,
    accountCalibration,
  });
  const sourceMinDate = minText(observations.map((row) => row.sourceMinDate));
  const sourceMaxDate = maxText(observations.map((row) => row.sourceMaxDate));
  const sourceMaxUpdatedAt = maxText(
    observations.map((row) => row.sourceMaxUpdatedAt),
  );
  const sourceDayCount = sum(observations, (row) => row.sourceDayCount);
  const qualityStatus = resolveCellQualityStatus({
    cohort: key.cohort,
    matureAdCount: converterPopulation.length,
    targetAuthority: batch.targetAuthority,
  });
  const cellInput = {
    contractVersion: batch.contractVersion,
    policyVersion: batch.policyVersion,
    engineVersion: batch.engineVersion,
    key,
    asOfDate: batch.asOfDate,
    asOfCutoff: batch.asOfCutoff,
    sampleWindowStart: batch.sampleWindowStart,
    sampleWindowEnd: batch.sampleWindowEnd,
    targetAuthority: purchase ? batch.targetAuthority : null,
    qualityStatus,
    metricSampleCounts,
    actionReadiness,
    observations: observations.map(observationManifestEntry),
  };

  return {
    batchId: null,
    batchCompleteness: "computed",
    batchCellCount: 0,
    batchCellSetHash: "0".repeat(64),
    key,
    asOfDate: batch.asOfDate,
    asOfCutoff: batch.asOfCutoff,
    sampleWindowStart: batch.sampleWindowStart,
    sampleWindowEnd: batch.sampleWindowEnd,
    sampleWindowDays: batch.sampleWindowDays,
    computedAt: batch.computedAt,
    engineVersion: batch.engineVersion,
    policyVersion: batch.policyVersion,
    qualityStatus,
    sourceAdCount: observations.length,
    sourceDayCount,
    eligibleAdCount: observations.length,
    matureAdCount: converterPopulation.length,
    zeroConversionAdCount: observations.filter(
      (row) => row.totalConversions === 0,
    ).length,
    metricSampleCounts,
    actionReadiness,
    sourceMinDate,
    sourceMaxDate,
    sourceMaxUpdatedAt,
    targetAuthority: batch.targetAuthority,
    accountCalibration,
    funnelCalibration,
    batchInputManifestHash: batch.inputManifestHash,
    inputManifestHash: canonicalSha256(cellInput),
    sourceManifestHash: batch.sourceManifestHash,
    qualityCounts: batch.qualityCounts,
  };
}

function buildFunnelCalibration(
  observations: NativeAdCalibrationObservation[],
): AccountFunnelCalibration {
  const sampleSize = observations.filter((row) =>
    [
      row.ctrRate,
      row.cpm,
      row.thumbstopRate,
      row.linkToLpvRate,
      row.linkToAtcRate,
      row.lpvToAtcRate,
      row.atcToIcRate,
      row.icToPurchaseRate,
      row.clickToPurchaseRate,
    ].some(isFiniteNumber),
  ).length;
  const baseline: FormatFunnelBaseline = {
    creativeFormat: "overall",
    ctrP25: gatedPercentile(observations, "ctrRate", 0.25),
    ctrP50: gatedPercentile(observations, "ctrRate", 0.5),
    cpmP50: gatedPercentile(observations, "cpm", 0.5),
    cpmP75: gatedPercentile(observations, "cpm", 0.75),
    thumbstopP25: gatedPercentile(observations, "thumbstopRate", 0.25),
    thumbstopP50: gatedPercentile(observations, "thumbstopRate", 0.5),
    linkToLpvP25: gatedPercentile(observations, "linkToLpvRate", 0.25),
    linkToLpvP50: gatedPercentile(observations, "linkToLpvRate", 0.5),
    linkToAtcP25: gatedPercentile(observations, "linkToAtcRate", 0.25),
    linkToAtcP50: gatedPercentile(observations, "linkToAtcRate", 0.5),
    lpvToAtcP25: gatedPercentile(observations, "lpvToAtcRate", 0.25),
    lpvToAtcP50: gatedPercentile(observations, "lpvToAtcRate", 0.5),
    atcToIcP25: gatedPercentile(observations, "atcToIcRate", 0.25),
    atcToIcP50: gatedPercentile(observations, "atcToIcRate", 0.5),
    icToPurchaseP25: gatedPercentile(observations, "icToPurchaseRate", 0.25),
    icToPurchaseP50: gatedPercentile(observations, "icToPurchaseRate", 0.5),
    clickToPurchaseP25: gatedPercentile(
      observations,
      "clickToPurchaseRate",
      0.25,
    ),
    clickToPurchaseP50: gatedPercentile(
      observations,
      "clickToPurchaseRate",
      0.5,
    ),
    sampleSize,
    qualityStatus:
      sampleSize >= 30
        ? "ready"
        : sampleSize >= 10
          ? "low_sample"
          : "insufficient",
  };
  return { byFormat: { overall: baseline } };
}

function buildMetricSampleCounts(input: {
  observations: NativeAdCalibrationObservation[];
  roasValues: number[];
  roasRatios: number[];
  cpaValues: number[];
  winnerPopulation: NativeAdCalibrationObservation[];
  refreshRatios: number[];
}): NativeAdCalibrationMetricSampleCounts {
  return {
    roas: input.roasValues.length,
    roasRatio: input.roasRatios.length,
    cpa: input.cpaValues.length,
    winner: input.winnerPopulation.length,
    refreshRatio: input.refreshRatios.length,
    lowCtr: metricCount(input.observations, "cumulative28dCtr"),
    ctr: metricCount(input.observations, "ctrRate"),
    cpm: metricCount(input.observations, "cpm"),
    thumbstop: metricCount(input.observations, "thumbstopRate"),
    linkToLpv: metricCount(input.observations, "linkToLpvRate"),
    linkToAtc: metricCount(input.observations, "linkToAtcRate"),
    lpvToAtc: metricCount(input.observations, "lpvToAtcRate"),
    atcToIc: metricCount(input.observations, "atcToIcRate"),
    icToPurchase: metricCount(input.observations, "icToPurchaseRate"),
    clickToPurchase: metricCount(input.observations, "clickToPurchaseRate"),
  };
}

function aggregateObservation(input: {
  rows: NormalizedSourceRow[];
  sourceRowIds: string[];
  context: ExactContext;
  sampleWindowEnd: string;
}): NativeAdCalibrationObservation {
  const first = input.rows[0];
  if (!first) throw new Error("Cannot aggregate an empty ad-day set.");
  const cumulative28Start = addUtcDays(input.sampleWindowEnd, -27);
  const recent7Start = addUtcDays(input.sampleWindowEnd, -6);
  const cumulative28Rows = input.rows.filter(
    (row) => row.date >= cumulative28Start,
  );
  const recent7Rows = input.rows.filter((row) => row.date >= recent7Start);
  const totalSpend = sum(input.rows, (row) => row.spend);
  const totalConversions = sum(input.rows, (row) => row.conversions);
  const totalRevenue = sum(input.rows, (row) => row.revenue);
  const totalImpressions = sum(input.rows, (row) => row.impressions);
  const totalClicks = sum(input.rows, (row) => row.clicks);
  const totalLinkClicks = sum(input.rows, (row) => row.linkClicks);
  const totalLandingPageViews = sumOptionalComplete(
    input.rows,
    (row) => row.landingPageViews,
  );
  const totalAddToCart = sumOptionalComplete(
    input.rows,
    (row) => row.addToCart,
  );
  const totalInitiateCheckout = sumOptionalComplete(
    input.rows,
    (row) => row.initiateCheckout,
  );
  const cumulative28Spend = sum(cumulative28Rows, (row) => row.spend);
  const cumulative28Revenue = sum(cumulative28Rows, (row) => row.revenue);
  const cumulative28Impressions = sum(
    cumulative28Rows,
    (row) => row.impressions,
  );
  const cumulative28Clicks = sum(cumulative28Rows, (row) => row.clicks);
  const recent7Spend = sum(recent7Rows, (row) => row.spend);
  const recent7Revenue = sum(recent7Rows, (row) => row.revenue);
  const cumulative28dRoas = ratio(cumulative28Revenue, cumulative28Spend);
  const recent7dRoas = ratio(recent7Revenue, recent7Spend);
  const thumbstopWeighted = input.rows.every((row) => row.thumbstop != null)
    ? sum(input.rows, (row) => (row.thumbstop as number) * row.impressions)
    : null;

  return {
    businessId: first.businessId,
    providerAccountRefId: first.providerAccountRefId,
    providerAccountId: first.providerAccountId,
    adId: first.adId,
    accountTimezone: input.context.accountTimezone,
    accountCurrency: input.context.accountCurrency,
    campaignId: input.context.campaignId,
    adsetId: input.context.adsetId,
    objective: input.context.objective,
    optimizationGoal: input.context.optimizationGoal,
    customEventType: input.context.customEventType,
    cohort: input.context.cohort,
    sourceRowIds: input.sourceRowIds,
    sourceDayCount: input.rows.length,
    sourceMinDate: input.rows[0]?.date ?? input.sampleWindowEnd,
    sourceMaxDate:
      input.rows[input.rows.length - 1]?.date ?? input.sampleWindowEnd,
    sourceMaxUpdatedAt:
      maxText(input.rows.map((row) => row.updatedAt)) ?? first.updatedAt,
    totalSpend,
    totalConversions,
    totalRevenue,
    totalImpressions,
    totalClicks,
    totalLinkClicks,
    totalLandingPageViews,
    totalAddToCart,
    totalInitiateCheckout,
    aggregateRoas: ratio(totalRevenue, totalSpend),
    aggregateCpa: ratio(totalSpend, totalConversions),
    ctrRate:
      totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null,
    cpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : null,
    thumbstopRate:
      totalImpressions > 0 && thumbstopWeighted !== null
        ? thumbstopWeighted / totalImpressions
        : null,
    linkToLpvRate:
      totalLinkClicks > 0 && totalLandingPageViews !== null
        ? (totalLandingPageViews / totalLinkClicks) * 100
        : null,
    linkToAtcRate:
      totalLinkClicks > 0 && totalAddToCart !== null
        ? (totalAddToCart / totalLinkClicks) * 100
        : null,
    lpvToAtcRate:
      totalLandingPageViews !== null &&
      totalLandingPageViews > 0 &&
      totalAddToCart !== null
        ? (totalAddToCart / totalLandingPageViews) * 100
        : null,
    atcToIcRate:
      totalAddToCart !== null &&
      totalAddToCart > 0 &&
      totalInitiateCheckout !== null
        ? (totalInitiateCheckout / totalAddToCart) * 100
        : null,
    icToPurchaseRate:
      totalInitiateCheckout !== null && totalInitiateCheckout > 0
        ? (totalConversions / totalInitiateCheckout) * 100
        : null,
    clickToPurchaseRate:
      totalLinkClicks > 0 ? (totalConversions / totalLinkClicks) * 100 : null,
    cumulative28dRoas,
    cumulative28dCtr:
      cumulative28Impressions > 0
        ? (cumulative28Clicks / cumulative28Impressions) * 100
        : null,
    recent7dRoas,
    recentTotalRatio:
      positiveFinite(recent7dRoas) && positiveFinite(cumulative28dRoas)
        ? recent7dRoas / cumulative28dRoas
        : null,
  };
}

interface ExactContext {
  accountTimezone: string;
  accountCurrency: string;
  campaignId: string;
  adsetId: string;
  objective: string;
  optimizationGoal: string | null;
  customEventType: string | null;
  optimizationContext: string;
  cohort: MetaFunnelCohort;
}

function normalizedExactContext(row: NormalizedSourceRow): ExactContext | null {
  if (
    !row.accountTimezone ||
    !row.accountCurrency ||
    !row.campaignId ||
    !row.adsetId ||
    !row.objective ||
    (!row.optimizationGoal && !row.customEventType)
  ) {
    return null;
  }
  const cohort = resolveMetaFunnelCohort({
    objective: row.objective,
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
  });
  const optimizationContext = buildNativeAdOptimizationContext(
    row.optimizationGoal,
    row.customEventType,
  );
  if (optimizationContext === null) return null;
  return {
    accountTimezone: row.accountTimezone,
    accountCurrency: row.accountCurrency,
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    objective: row.objective,
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
    optimizationContext,
    cohort,
  };
}

export function buildNativeAdOptimizationContext(
  optimizationGoal: string | null | undefined,
  customEventType: string | null | undefined,
): string | null {
  const goal = normalizeGoal(optimizationGoal);
  const event = normalizeGoal(customEventType);
  if (!goal && !event) return null;
  return `goal=${goal ?? ""}|event=${event ?? ""}`;
}

function contextCardinality(contexts: ExactContext[]) {
  const cardinality = {
    timezone: distinctCount(contexts.map((row) => row.accountTimezone)),
    currency: distinctCount(contexts.map((row) => row.accountCurrency)),
    campaign: distinctCount(contexts.map((row) => row.campaignId)),
    adset: distinctCount(contexts.map((row) => row.adsetId)),
    objective: distinctCount(contexts.map((row) => row.objective)),
    optimizationContext: distinctCount(
      contexts.map((row) => row.optimizationContext),
    ),
    cohort: distinctCount(contexts.map((row) => row.cohort)),
  };
  return {
    ...cardinality,
    mixed: Object.values(cardinality).some((count) => count !== 1),
  };
}

function normalizeSourceRow(
  row: NativeAdCalibrationSourceRow,
): NormalizedSourceRow {
  return {
    ...row,
    sourceRowId: normalizeText(row.sourceRowId) ?? "",
    businessId: normalizeText(row.businessId) ?? "",
    providerAccountRefId: normalizeText(row.providerAccountRefId) ?? "",
    providerAccountId: normalizeText(row.providerAccountId) ?? "",
    date: normalizeDate(row.date) ?? "",
    campaignId: normalizeText(row.campaignId),
    adsetId: normalizeText(row.adsetId),
    adId: normalizeText(row.adId) ?? "",
    accountTimezone: normalizeText(row.accountTimezone),
    accountCurrency: normalizeGoal(row.accountCurrency),
    objective: normalizeGoal(row.objective),
    optimizationGoal: normalizeGoal(row.optimizationGoal),
    customEventType: normalizeGoal(row.customEventType),
    truthState: normalizeGoal(row.truthState),
    validationStatus: normalizeGoal(row.validationStatus),
    finalizedAt: normalizeTimestamp(row.finalizedAt),
    createdAt: normalizeTimestamp(row.createdAt) ?? "",
    updatedAt: normalizeTimestamp(row.updatedAt) ?? "",
    campaignSourceRowId: normalizeText(row.campaignSourceRowId),
    campaignTruthState: normalizeGoal(row.campaignTruthState),
    campaignValidationStatus: normalizeGoal(row.campaignValidationStatus),
    campaignCreatedAt: normalizeTimestamp(row.campaignCreatedAt),
    campaignUpdatedAt: normalizeTimestamp(row.campaignUpdatedAt),
    adsetSourceRowId: normalizeText(row.adsetSourceRowId),
    adsetTruthState: normalizeGoal(row.adsetTruthState),
    adsetValidationStatus: normalizeGoal(row.adsetValidationStatus),
    adsetCreatedAt: normalizeTimestamp(row.adsetCreatedAt),
    adsetUpdatedAt: normalizeTimestamp(row.adsetUpdatedAt),
  };
}

function hasFinalizedTruth(row: NormalizedSourceRow) {
  return (
    row.truthState === "FINALIZED" &&
    row.validationStatus === "PASSED" &&
    row.campaignSourceRowId !== null &&
    row.campaignTruthState === "FINALIZED" &&
    row.campaignValidationStatus === "PASSED" &&
    row.adsetSourceRowId !== null &&
    row.adsetTruthState === "FINALIZED" &&
    row.adsetValidationStatus === "PASSED"
  );
}

function isRowAvailableAtCutoff(row: NormalizedSourceRow, asOfCutoff: string) {
  const cutoffMs = requireTimestamp(asOfCutoff, "asOfCutoff");
  const timestamps = [
    row.createdAt,
    row.updatedAt,
    row.campaignCreatedAt,
    row.campaignUpdatedAt,
    row.adsetCreatedAt,
    row.adsetUpdatedAt,
  ];
  if (row.finalizedAt !== null) timestamps.push(row.finalizedAt);
  return timestamps.every((timestamp) => {
    const parsed = timestampOrNull(timestamp);
    return parsed !== null && parsed <= cutoffMs;
  });
}

function hasInvalidMetric(row: NormalizedSourceRow) {
  const required = [
    row.spend,
    row.impressions,
    row.clicks,
    row.linkClicks,
    row.conversions,
    row.revenue,
  ];
  const optional = [
    row.landingPageViews,
    row.addToCart,
    row.initiateCheckout,
    row.thumbstop,
  ];
  return (
    required.some((value) => !Number.isFinite(value) || value < 0) ||
    optional.some(
      (value) => value != null && (!Number.isFinite(value) || value < 0),
    )
  );
}

function sourceContentSignature(row: NormalizedSourceRow) {
  return canonicalSha256({
    businessId: row.businessId,
    providerAccountRefId: row.providerAccountRefId,
    providerAccountId: row.providerAccountId,
    date: row.date,
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    adId: row.adId,
    accountTimezone: row.accountTimezone,
    accountCurrency: row.accountCurrency,
    objective: row.objective,
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
    spend: manifestNumber(row.spend),
    impressions: manifestNumber(row.impressions),
    clicks: manifestNumber(row.clicks),
    linkClicks: manifestNumber(row.linkClicks),
    conversions: manifestNumber(row.conversions),
    revenue: manifestNumber(row.revenue),
    landingPageViews: manifestNumber(row.landingPageViews ?? null),
    addToCart: manifestNumber(row.addToCart ?? null),
    initiateCheckout: manifestNumber(row.initiateCheckout ?? null),
    thumbstop: manifestNumber(row.thumbstop ?? null),
  });
}

function sourceManifestEntry(row: NormalizedSourceRow) {
  const sortKey = [
    row.businessId,
    row.providerAccountRefId,
    row.providerAccountId,
    row.adId,
    row.date,
    row.sourceRowId,
  ].join("\u0000");
  return {
    sortKey,
    sourceRowId: row.sourceRowId,
    businessId: row.businessId,
    providerAccountRefId: row.providerAccountRefId,
    providerAccountId: row.providerAccountId,
    adId: row.adId,
    date: row.date,
    campaignSourceRowId: row.campaignSourceRowId,
    adsetSourceRowId: row.adsetSourceRowId,
    truthState: row.truthState,
    validationStatus: row.validationStatus,
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    campaignTruthState: row.campaignTruthState,
    campaignValidationStatus: row.campaignValidationStatus,
    campaignCreatedAt: row.campaignCreatedAt,
    campaignUpdatedAt: row.campaignUpdatedAt,
    adsetTruthState: row.adsetTruthState,
    adsetValidationStatus: row.adsetValidationStatus,
    adsetCreatedAt: row.adsetCreatedAt,
    adsetUpdatedAt: row.adsetUpdatedAt,
    contentHash: sourceContentSignature(row),
  };
}

function observationManifestEntry(row: NativeAdCalibrationObservation) {
  return {
    businessId: row.businessId,
    providerAccountRefId: row.providerAccountRefId,
    providerAccountId: row.providerAccountId,
    adId: row.adId,
    accountTimezone: row.accountTimezone,
    accountCurrency: row.accountCurrency,
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    objective: row.objective,
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
    cohort: row.cohort,
    sourceRowIds: row.sourceRowIds,
    sourceDayCount: row.sourceDayCount,
    sourceMinDate: row.sourceMinDate,
    sourceMaxDate: row.sourceMaxDate,
    totalSpend: row.totalSpend,
    totalConversions: row.totalConversions,
    totalRevenue: row.totalRevenue,
    totalImpressions: row.totalImpressions,
    totalClicks: row.totalClicks,
    totalLinkClicks: row.totalLinkClicks,
    totalLandingPageViews: row.totalLandingPageViews,
    totalAddToCart: row.totalAddToCart,
    totalInitiateCheckout: row.totalInitiateCheckout,
    aggregateRoas: row.aggregateRoas,
    aggregateCpa: row.aggregateCpa,
    ctrRate: row.ctrRate,
    cpm: row.cpm,
    thumbstopRate: row.thumbstopRate,
    linkToLpvRate: row.linkToLpvRate,
    linkToAtcRate: row.linkToAtcRate,
    lpvToAtcRate: row.lpvToAtcRate,
    atcToIcRate: row.atcToIcRate,
    icToPurchaseRate: row.icToPurchaseRate,
    clickToPurchaseRate: row.clickToPurchaseRate,
    cumulative28dRoas: row.cumulative28dRoas,
    cumulative28dCtr: row.cumulative28dCtr,
    recent7dRoas: row.recent7dRoas,
    recentTotalRatio: row.recentTotalRatio,
  };
}

function normalizeTargetAuthorityInput(
  input: NativeAdTargetAuthorityInput | null,
): NativeAdTargetAuthorityInput | null {
  if (input === null) return null;
  return {
    sourceRowId: normalizeText(input.sourceRowId),
    operation: input.operation,
    targetCpa: finiteOrNull(input.targetCpa),
    targetRoas: finiteOrNull(input.targetRoas),
    breakEvenCpa: finiteOrNull(input.breakEvenCpa),
    breakEvenRoas: finiteOrNull(input.breakEvenRoas),
    operatorAovAssumption: finiteOrNull(input.operatorAovAssumption),
    defaultRiskPosture: input.defaultRiskPosture,
    effectiveAt: normalizeTimestamp(input.effectiveAt),
    recordedAt: normalizeTimestamp(input.recordedAt),
  };
}

function resolveCellQualityStatus(input: {
  cohort: MetaFunnelCohort;
  matureAdCount: number;
  targetAuthority: ResolvedNativeAdTargetAuthority;
}): NativeAdCalibrationQualityStatus {
  if (input.cohort !== "purchase") return "unsupported_cohort";
  if (
    !input.targetAuthority.targetRoasAuthority ||
    !input.targetAuthority.breakEvenRoasAuthority
  ) {
    return "blocked_commercial";
  }
  if (input.matureAdCount >= MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE) {
    return "ready";
  }
  if (input.matureAdCount >= 10) return "low_sample";
  return "insufficient";
}

export function resolveNativeAdCalibrationActionReadiness(input: {
  key: NativeAdCalibrationCellKey;
  matureAdCount: number;
  metricSampleCounts: NativeAdCalibrationMetricSampleCounts;
  targetAuthority: ResolvedNativeAdTargetAuthority;
  accountCalibration: AccountCalibration;
}): NativeAdCalibrationActionReadiness {
  const scaleObserved = Math.min(
    input.matureAdCount,
    input.metricSampleCounts.roasRatio,
  );
  const cutObserved = input.metricSampleCounts.roasRatio;
  const refreshObserved = input.metricSampleCounts.refreshRatio;

  if (input.key.cellScope === "account_objective_cohort") {
    return blockedActionReadiness("pooled_optimization_context_soft_only", {
      scale: scaleObserved,
      cut: cutObserved,
      refresh: refreshObserved,
    });
  }
  if (input.key.cohort !== "purchase") {
    return blockedActionReadiness("unsupported_cohort", {
      scale: scaleObserved,
      cut: cutObserved,
      refresh: refreshObserved,
    });
  }

  const scaleReason: NativeAdCalibrationActionBlockReason | null = !input
    .targetAuthority.targetRoasAuthority
    ? "target_roas_authority_missing"
    : scaleObserved < MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE
      ? "scale_calibration_sample_low"
      : !positiveFinite(input.accountCalibration.winnerPurchaseP50)
        ? "scale_winner_benchmark_missing"
        : null;
  const cutReason: NativeAdCalibrationActionBlockReason | null = !input
    .targetAuthority.targetRoasAuthority
    ? "target_roas_authority_missing"
    : !input.targetAuthority.breakEvenRoasAuthority
      ? "break_even_roas_authority_missing"
      : cutObserved < NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR ||
          !positiveFinite(input.accountCalibration.roasRatioP25)
        ? "cut_calibration_sample_low"
        : null;
  const refreshReason: NativeAdCalibrationActionBlockReason | null =
    refreshObserved < NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR ||
    !positiveFinite(input.accountCalibration.refreshRatioP10)
      ? "refresh_calibration_sample_low"
      : null;

  return {
    scale: actionReadinessEntry(
      scaleReason,
      scaleObserved,
      MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
    ),
    cut: actionReadinessEntry(
      cutReason,
      cutObserved,
      NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR,
    ),
    refresh: actionReadinessEntry(
      refreshReason,
      refreshObserved,
      NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR,
    ),
  };
}

function blockedActionReadiness(
  reason: NativeAdCalibrationActionBlockReason,
  observed: Record<NativeAdCalibrationAction, number>,
): NativeAdCalibrationActionReadiness {
  return {
    scale: actionReadinessEntry(
      reason,
      observed.scale,
      MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
    ),
    cut: actionReadinessEntry(
      reason,
      observed.cut,
      NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR,
    ),
    refresh: actionReadinessEntry(
      reason,
      observed.refresh,
      NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR,
    ),
  };
}

function actionReadinessEntry(
  reason: NativeAdCalibrationActionBlockReason | null,
  observedSampleCount: number,
  requiredSampleCount: number,
): NativeAdCalibrationActionReadinessEntry {
  return {
    ready: reason === null,
    reason,
    observedSampleCount,
    requiredSampleCount,
  };
}

function addCellObservation(
  grouped: Map<
    string,
    { key: NativeAdCalibrationCellKey; rows: NativeAdCalibrationObservation[] }
  >,
  key: NativeAdCalibrationCellKey,
  observation: NativeAdCalibrationObservation,
) {
  const identity = cellIdentity(key);
  const entry = grouped.get(identity) ?? { key, rows: [] };
  entry.rows.push(observation);
  grouped.set(identity, entry);
}

function cellIdentity(key: NativeAdCalibrationCellKey) {
  return [
    key.businessId,
    key.providerAccountRefId,
    key.providerAccountId,
    key.accountTimezone,
    key.accountCurrency,
    key.cellScope,
    key.objective,
    key.cohort,
    key.optimizationContext,
  ].join("\u0000");
}

function observationIdentity(row: NativeAdCalibrationObservation) {
  return `${row.businessId}\u0000${row.providerAccountRefId}\u0000${row.providerAccountId}\u0000${row.adId}`;
}

function emptyQualityCounts(
  candidateSourceRowCount: number,
): NativeAdCalibrationQualityCounts {
  return {
    candidateSourceRowCount,
    cutoffSafeSourceRowCount: 0,
    candidateAdCount: 0,
    eligibleAdObservationCount: 0,
    identitySourceRowExclusionCount: 0,
    duplicateSourceRowExclusionCount: 0,
    duplicateConflictAdExclusionCount: 0,
    missingContextAdExclusionCount: 0,
    mixedContextAdExclusionCount: 0,
    mixedCurrencyAdExclusionCount: 0,
    mixedObjectiveAdExclusionCount: 0,
    mixedCohortAdExclusionCount: 0,
    censoredSourceRowExclusionCount: 0,
    censoredAdExclusionCount: 0,
    freshnessSourceRowExclusionCount: 0,
    freshnessAdExclusionCount: 0,
    commercialAuthorityAdExclusionCount: 0,
  };
}

function gatedPercentile(
  rows: NativeAdCalibrationObservation[],
  key:
    | "ctrRate"
    | "cpm"
    | "thumbstopRate"
    | "linkToLpvRate"
    | "linkToAtcRate"
    | "lpvToAtcRate"
    | "atcToIcRate"
    | "icToPurchaseRate"
    | "clickToPurchaseRate",
  quantile: number,
) {
  const values = rows.map((row) => row[key]).filter(isFiniteNumber);
  return values.length >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
    ? percentile(values, quantile)
    : null;
}

function metricCount(
  rows: NativeAdCalibrationObservation[],
  key:
    | "cumulative28dCtr"
    | "ctrRate"
    | "cpm"
    | "thumbstopRate"
    | "linkToLpvRate"
    | "linkToAtcRate"
    | "lpvToAtcRate"
    | "atcToIcRate"
    | "icToPurchaseRate"
    | "clickToPurchaseRate",
) {
  return rows.map((row) => row[key]).filter(isFiniteNumber).length;
}

function percentile(values: number[], quantile: number): number | null {
  const sorted = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const position = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) return null;
  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

function classifyMetaAovQuality(purchaseCount: number): MetaAovQuality {
  if (purchaseCount >= 20) return "ready";
  if (purchaseCount >= 5) return "low_sample";
  if (purchaseCount >= 1) return "unstable";
  return "unavailable";
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function sum<T>(rows: T[], value: (row: T) => number) {
  return rows.reduce((total, row) => total + value(row), 0);
}

function sumOptionalComplete<T>(
  rows: T[],
  value: (row: T) => number | null | undefined,
): number | null {
  const values = rows.map(value);
  if (
    values.some(
      (entry) =>
        entry === null || entry === undefined || !Number.isFinite(entry),
    )
  ) {
    return null;
  }
  let total = 0;
  for (const entry of values) total += entry as number;
  return total;
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const identity = key(row);
    const list = grouped.get(identity) ?? [];
    list.push(row);
    grouped.set(identity, list);
  }
  return grouped;
}

function distinctCount(values: string[]) {
  return new Set(values).size;
}

function positiveFinite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function manifestNumber(value: number | null) {
  if (value === null) return null;
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return value;
}

function compareNamedSchemaDefinitions(input: {
  kind: "constraint" | "index" | "trigger";
  expected: Readonly<Record<string, string>>;
  actual: Record<string, unknown>[];
  missing: string[];
  mismatched: string[];
}) {
  const available = new Map(
    input.actual.map((row) => [
      dbRequiredText(row.name, `${input.kind}.name`),
      dbRequiredText(row.definition, `${input.kind}.definition`),
    ]),
  );
  for (const [name, expected] of Object.entries(input.expected)) {
    const actual = available.get(name);
    if (!actual) {
      input.missing.push(`${input.kind}:${name}`);
      continue;
    }
    if (
      normalizeSchemaDefinition(actual) !== normalizeSchemaDefinition(expected)
    ) {
      input.mismatched.push(`${input.kind}:${name}`);
    }
  }
}

function normalizeSchemaDefinition(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value)
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/\bpublic\./g, "")
    .replace(/\busing btree\b/g, "")
    .replace(
      /::(?:text|date|double precision|timestamptz|timestamp with time zone|character varying)/g,
      "",
    )
    .replace(/\s*(->>|->)\s*/g, "$1")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .trim();
}

function requiredText(value: string, label: string) {
  const normalized = normalizeText(value);
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

function normalizeText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeGoal(value: string | null | undefined) {
  const text = normalizeText(value);
  return text ? text.replace(/[\s-]+/g, "_").toUpperCase() : null;
}

function normalizeDate(value: string | null | undefined) {
  const text = normalizeText(value);
  if (!text) return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(text);
  if (!match) return null;
  const parsed = new Date(`${match[0]}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : match[0];
}

function normalizeTimestamp(value: string | null | undefined) {
  const text = normalizeText(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeRequiredTimestamp(value: string, label: string) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) throw new TypeError(`${label} must be an ISO timestamp.`);
  return normalized;
}

function requireTimestamp(value: string, label: string) {
  const parsed = timestampOrNull(value);
  if (parsed === null)
    throw new TypeError(`${label} must be an ISO timestamp.`);
  return parsed;
}

function timestampOrNull(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addUtcDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function minText(values: string[]) {
  return values.length > 0
    ? ([...values].sort((left, right) => left.localeCompare(right))[0] ?? null)
    : null;
}

function maxText(values: string[]) {
  return values.length > 0
    ? ([...values].sort((left, right) => right.localeCompare(left))[0] ?? null)
    : null;
}

function mapNativeAdCalibrationSourceRow(
  row: Record<string, unknown>,
): NativeAdCalibrationSourceRow {
  return {
    sourceRowId: dbRequiredText(row.source_row_id, "source_row_id"),
    businessId: dbRequiredText(row.business_id, "business_id"),
    providerAccountRefId: requiredUuid(
      row.provider_account_ref_id,
      "provider_account_ref_id",
    ),
    providerAccountId: dbRequiredText(
      row.provider_account_id,
      "provider_account_id",
    ),
    date: dbRequiredDate(row.date, "date"),
    campaignId: dbOptionalText(row.campaign_id),
    adsetId: dbOptionalText(row.adset_id),
    adId: dbRequiredText(row.ad_id, "ad_id"),
    accountTimezone: dbOptionalText(row.account_timezone),
    accountCurrency: dbOptionalText(row.account_currency),
    objective: dbOptionalText(row.objective),
    optimizationGoal: dbOptionalText(row.optimization_goal),
    customEventType: dbOptionalText(row.custom_event_type),
    spend: dbRequiredNumber(row.spend, "spend"),
    impressions: dbRequiredNumber(row.impressions, "impressions"),
    clicks: dbRequiredNumber(row.clicks, "clicks"),
    linkClicks: dbRequiredNumber(row.link_clicks, "link_clicks"),
    conversions: dbRequiredNumber(row.conversions, "conversions"),
    revenue: dbRequiredNumber(row.revenue, "revenue"),
    landingPageViews: dbOptionalNumber(row.landing_page_views),
    addToCart: dbOptionalNumber(row.add_to_cart),
    initiateCheckout: dbOptionalNumber(row.initiate_checkout),
    thumbstop: dbOptionalNumber(row.thumbstop),
    truthState: dbOptionalText(row.truth_state),
    validationStatus: dbOptionalText(row.validation_status),
    finalizedAt: dbOptionalTimestamp(row.finalized_at),
    createdAt: dbRequiredTimestamp(row.created_at, "created_at"),
    updatedAt: dbRequiredTimestamp(row.updated_at, "updated_at"),
    campaignSourceRowId: dbOptionalText(row.campaign_source_row_id),
    campaignTruthState: dbOptionalText(row.campaign_truth_state),
    campaignValidationStatus: dbOptionalText(row.campaign_validation_status),
    campaignCreatedAt: dbOptionalTimestamp(row.campaign_created_at),
    campaignUpdatedAt: dbOptionalTimestamp(row.campaign_updated_at),
    adsetSourceRowId: dbOptionalText(row.adset_source_row_id),
    adsetTruthState: dbOptionalText(row.adset_truth_state),
    adsetValidationStatus: dbOptionalText(row.adset_validation_status),
    adsetCreatedAt: dbOptionalTimestamp(row.adset_created_at),
    adsetUpdatedAt: dbOptionalTimestamp(row.adset_updated_at),
  };
}

function mapNativeAdTargetAuthorityRow(
  row: Record<string, unknown>,
): NativeAdTargetAuthorityInput {
  const operation = dbRequiredText(row.operation, "target operation");
  if (operation !== "upsert" && operation !== "delete") {
    throw new TypeError(`Unsupported native target operation: ${operation}`);
  }
  const risk = dbOptionalText(row.default_risk_posture);
  if (
    risk !== null &&
    risk !== "aggressive" &&
    risk !== "balanced" &&
    risk !== "conservative"
  ) {
    throw new TypeError(`Unsupported target risk posture: ${risk}`);
  }
  return {
    sourceRowId: dbOptionalText(row.source_row_id),
    operation,
    targetCpa: dbOptionalNumber(row.target_cpa),
    targetRoas: dbOptionalNumber(row.target_roas),
    breakEvenCpa: dbOptionalNumber(row.break_even_cpa),
    breakEvenRoas: dbOptionalNumber(row.break_even_roas),
    operatorAovAssumption: dbOptionalNumber(row.operator_aov_assumption),
    defaultRiskPosture: risk,
    effectiveAt: dbOptionalTimestamp(row.effective_at),
    recordedAt: dbOptionalTimestamp(row.recorded_at),
  };
}

function dbOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  const text = value.trim();
  return text || null;
}

function dbRequiredText(value: unknown, field: string): string {
  const text = dbOptionalText(value);
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}

function dbOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function dbRequiredNumber(value: unknown, field: string): number {
  const number = dbOptionalNumber(value);
  if (number === null) throw new TypeError(`${field} must be finite.`);
  return number;
}

function dbOptionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function dbRequiredTimestamp(value: unknown, field: string): string {
  const timestamp = dbOptionalTimestamp(value);
  if (timestamp === null) throw new TypeError(`${field} must be a timestamp.`);
  return timestamp;
}

function dbRequiredDate(value: unknown, field: string): string {
  const text = dbOptionalText(value);
  const match = text?.match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) throw new TypeError(`${field} must be an ISO date.`);
  return match[0];
}

function requiredInteger(value: unknown, field: string): number {
  const number = dbRequiredNumber(value, field);
  if (!Number.isInteger(number)) {
    throw new TypeError(`${field} must be an integer.`);
  }
  return number;
}

function requiredHash(value: unknown, field: string): string {
  const hash = dbRequiredText(value, field);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 hash.`);
  }
  return hash;
}

function requiredUuid(value: unknown, field: string): string {
  const id = dbRequiredText(value, field);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new TypeError(`${field} must be a UUID.`);
  }
  return id;
}

function errorToJson(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error instanceof NativeAdCalibrationSchemaNotReadyError
        ? { missing: error.missing }
        : {}),
      ...(error instanceof NativeAdHistoricalCalibrationUnsafeError
        ? { code: error.code }
        : {}),
    };
  }
  return { name: "Error", message: String(error) };
}
