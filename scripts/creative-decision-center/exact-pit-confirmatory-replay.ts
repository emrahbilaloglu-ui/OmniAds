#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSimulationInputManifest,
  type SimulationConfigProvenance,
  type SimulationIdentityProvenance,
  type SimulationIdentityProvenanceMap,
  type SimulationInputManifest,
  type SimulationTargetProvenance,
} from "@/lib/creative-decision-engine/simulation/input-manifest";
import { SUPPORTED_OBJECTIVES } from "@/lib/creative-decision-engine/config";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  buildPitIntegrityReport,
  deterministicSha256,
  normalizePitSnapshotDbRow,
  type PitRawSnapshotRow,
  type PitIntegrityReport,
} from "@/scripts/creative-decision-center/raw-snapshot-pit-integrity";

const CONTRACT_VERSION =
  "adsecute.meta.exact-pit-confirmatory-replay.v3" as const;
const QUERY_TIMEOUT_MS = 120_000;
const DEFAULT_CUTOFF_TIME_UTC = "03:00:00";
const MAX_ROLLING_WINDOW_DAYS = 28;
const CAMPAIGN_STATUS_ENDPOINT = "campaign_statuses" as const;
const CAMPAIGN_STATUS_CONTRACT_VERSION =
  "adsecute.meta.campaign-status-pit-receipt.v1" as const;

type GateStatus = "pass" | "fail" | "unknown";
type CoverageStatus = "no_rows" | "none" | "partial" | "complete";
type IntegrityScope = PitIntegrityReport["scopes"][number];
type IntegrityEvidence = IntegrityScope["evidence"][number];

export interface ParsedExactPitArgs {
  startDate: string;
  endDate: string;
  cutoffTimeUtc: string;
  businessId: string | null;
  providerAccountId: string | null;
  jsonOut: string | null;
  markdownOut: string | null;
}

export interface ExactConfigReceipt {
  key: string;
  entityType: "campaign" | "adset";
  rowId: string;
  businessId: string;
  providerAccountId: string;
  entityId: string;
  campaignId: string | null;
  configFingerprint: string;
  objective: string | null;
  optimizationGoal: string | null;
  sourceKind: string;
  sourceSnapshotId: string | null;
  capturedAt: string;
  createdAt: string;
  effectiveFrom: string | null;
  sourceSnapshotBusinessId: string | null;
  sourceSnapshotProviderAccountId: string | null;
  sourceSnapshotFetchedAt: string | null;
  sourceSnapshotCreatedAt: string | null;
  conflictingAtLatestCapture: boolean;
}

export interface ExactTargetCandidate {
  businessId: string;
  rowId: string;
  source: "business_target_pack_history" | "business_target_packs";
  targetRoas: number | null;
  breakevenRoas: number | null;
  effectiveAt: string;
  recordedAt: string;
}

export interface PersistedBaselineRow {
  snapshotId: string;
  businessId: string;
  providerAccountId: string;
  decisionDate: string;
  engineVersion: string;
  creativeId: string;
  label: string;
  rawLabel: string | null;
  confidence: number;
  truthSource: string;
  effectiveTargetRoas: number;
  ratioToTarget: number | null;
  badges: unknown;
  reason: string;
  spend: number | null;
  purchases: number | null;
  roas: number | null;
  recent7dRoas: number | null;
  scopeType: string;
  scopeId: string;
  labelTransform: string | null;
  blockedActionType: string | null;
  decisionInputHash: string | null;
  lifecycleInputHash: string | null;
  calibrationInputHash: string | null;
  lifecycleComputedAt: string | null;
  lifecycleSourceMaxUpdatedAt: string | null;
  decisionComputedAt: string;
}

interface ExactObservationMetrics {
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  reach: number | null;
  ctr: number | null;
  cpm: number | null;
  frequency: number | null;
  actions: unknown;
  actionValues: unknown;
  presentFields: string[];
}

export interface ExactRollingCutoffSourceReceipt {
  sourceMode: "exact_raw_pit";
  decisionDate: string;
  cutoff: string;
  sourceDate: string;
  businessId: string;
  providerAccountId: string;
  reconstructable: boolean;
  generationStatus: GateStatus;
  generationReason: IntegrityScope["generationReason"];
  identityStatus: GateStatus;
  unisolatedCanSupersedeLatest: boolean;
  selectedGenerationKey: string | null;
  selectedGenerationSnapshotIds: string[];
  selectedGenerationConflictCount: number;
  receiptHash: string;
}

interface ExactRollingWindowStatus {
  sourceMode: "exact_raw_pit";
  days: 3 | 7 | 14 | 28;
  status: "complete" | "incomplete";
  requiredSourceDays: number;
  availableSourceDays: number;
  missingSourceDates: string[];
  observedSourceReceiptHashes: string[];
  selectedGenerationKeys: string[];
  receiptHash: string;
}

export interface ExactRollingCutoffWindowReceipt {
  sourceMode: "exact_raw_pit";
  decisionDate: string;
  cutoff: string;
  businessId: string;
  providerAccountId: string;
  threeDay: ExactRollingWindowStatus;
  sevenDay: ExactRollingWindowStatus;
  fourteenDay: ExactRollingWindowStatus;
  twentyEightDay: ExactRollingWindowStatus;
  receiptHash: string;
}

type ExactCampaignStatus = "ACTIVE" | "PAUSED" | "DELETED" | "REJECTED";

type CampaignStatusGenerationReason =
  | "latest_generation_complete"
  | "latest_generation_incomplete"
  | "latest_generation_conflict"
  | "no_rows_at_cutoff"
  | "timestamp_unprovable";

export interface ExactCampaignStatusReceipt {
  contractVersion: typeof CAMPAIGN_STATUS_CONTRACT_VERSION;
  sourceMode: "exact_raw_pit";
  decisionDate: string;
  cutoff: string;
  businessId: string;
  providerAccountId: string;
  campaignId: string;
  rawEffectiveStatus: string | null;
  rawConfiguredStatus: string | null;
  normalizedStatus: ExactCampaignStatus | null;
  statusSourceField: "effective_status" | "status" | null;
  sourceSnapshotId: string;
  sourceDate: string;
  fetchedAt: string;
  createdAt: string;
  generationKey: string;
  receiptHash: string;
}

export interface ExactCampaignStatusScopeReceipt {
  sourceMode: "exact_raw_pit";
  decisionDate: string;
  cutoff: string;
  businessId: string;
  providerAccountId: string;
  generationStatus: GateStatus;
  generationReason: CampaignStatusGenerationReason;
  selectedGenerationKey: string | null;
  selectedSnapshotIds: string[];
  observedSnapshotRows: number;
  atCutoffSnapshotRows: number;
  postCutoffSnapshotRowsExcluded: number;
  statusBearingPayloadRows: number;
  unmappedPayloadRows: number;
  statusConflictCount: number;
  exactDuplicateSnapshotRows: number;
  exactDuplicateCampaignRows: number;
  receipts: ExactCampaignStatusReceipt[];
  receiptHash: string;
}

export interface ExactCampaignStatusSelection {
  scopes: ExactCampaignStatusScopeReceipt[];
  receipts: ExactCampaignStatusReceipt[];
  summary: {
    observedSnapshotRows: number;
    atCutoffSnapshotRows: number;
    postCutoffSnapshotRowsExcluded: number;
    observedScopes: number;
    reconstructableScopes: number;
    incompleteLatestScopes: number;
    conflictingLatestScopes: number;
    statusBearingPayloadRows: number;
    statusBearingScopes: number;
    unmappedPayloadRows: number;
    statusConflictCount: number;
    exactDuplicateSnapshotRows: number;
    exactDuplicateCampaignRows: number;
  };
  selectionHash: string;
}

interface BranchTerminalCoreEvaluation {
  status: "resolved" | "not_terminal" | "not_evaluable";
  branch: "unsupported_objective" | "campaign_paused" | null;
  resolutionKind: "exact_decision_label" | "exact_delivery_state_only" | null;
  objective: string | null;
  normalizedCampaignStatus: ExactCampaignStatus | null;
  exactDecisionLabel: "out_of_scope" | null;
  reason: string | null;
  missingFields: string[];
  branchTerminalCoreHash: string | null;
}

interface LegacyCreativeOutputHashJoin {
  status:
    | "joinable"
    | "creative_identity_unavailable"
    | "no_matching_persisted_output";
  creativeId: string | null;
  matchedOutputRows: number;
  matchCardinality: "none" | "one" | "many";
  hashKind: "persisted_output_only";
  persistedOutputSetHash: string | null;
}

interface ExactManifestRow {
  rowKey: string;
  businessId: string;
  providerAccountId: string;
  decisionDate: string;
  adId: string;
  campaignId: string;
  adsetId: string;
  creativeId: string | null;
  observationHash: string;
  sourceManifestHash: string;
  campaignStatusReceipt: ExactCampaignStatusReceipt | null;
  branchTerminalCore: BranchTerminalCoreEvaluation;
  fullResolverInputStatus: "evaluable" | "not_evaluable";
  fullResolverMissingFields: string[];
  fullResolverInputHash: null;
  decisionHash: null;
  legacyCreativeOutputHashJoin: LegacyCreativeOutputHashJoin;
  exactWindowReceipt: {
    sourceMode: "exact_raw_pit";
    threeDayScopeWindowComplete: boolean;
    sevenDayScopeWindowComplete: boolean;
    fourteenDayScopeWindowComplete: boolean;
    twentyEightDayScopeWindowComplete: boolean;
    threeDayReceiptHash: string;
    sevenDayReceiptHash: string;
    fourteenDayReceiptHash: string;
    twentyEightDayReceiptHash: string;
  };
  observation: ExactObservationMetrics;
  manifest: SimulationInputManifest;
}

interface RejectedManifestRow {
  rowKey: string;
  decisionDate: string;
  businessId: string;
  providerAccountId: string;
  reasons: string[];
  assertedSourceMode: SimulationInputManifest["assertedSourceMode"];
  resultingSourceMode: SimulationInputManifest["sourceMode"];
  sourceManifestHash: string;
}

interface DailyCoverageRow {
  decisionDate: string;
  cutoff: string;
  observedScopeCount: number;
  reconstructableScopeCount: number;
  nonReconstructableScopeCount: number;
  exactEvidenceRows: number;
  exactManifestRows: number;
  rejectedManifestRows: number;
  exactThreeDayScopeWindows: number;
  exactSevenDayScopeWindows: number;
  exactFourteenDayScopeWindows: number;
  exactTwentyEightDayScopeWindows: number;
  postCutoffSnapshotRowsExcluded: number;
  generationReasonCounts: Record<string, number>;
  rawConflictCount: number;
}

interface BaselineExample {
  snapshotId: string;
  decisionDate: string;
  businessId: string;
  providerAccountId: string;
  engineVersion: string;
  creativeId: string;
  label: string;
  rawLabel: string | null;
  decisionHash: string;
}

interface PersistedBaselineSummary {
  boundary: "persisted_output_only_not_joined_to_exact_raw_metrics";
  status:
    | "not_available"
    | "persisted_output_hash_only"
    | "current_engine_output_hash_only";
  persistedDecisionRows: number;
  currentEngineDecisionRows: number;
  rowsWithDecisionInputHash: number;
  rowsWithLifecycleInputHash: number;
  rowsWithCalibrationInputHash: number;
  rowsWithCompleteInputHashChain: number;
  rowsWithCanonicalSerializedInput: 0;
  replayableRows: 0;
  lifecycleRowsComputedAfterCutoff: number;
  lifecycleRowsWithPostCutoffSourceUpdate: number;
  persistedDecisionSetHash: string | null;
  currentEngineDecisionSetHash: string | null;
  engineVersions: Record<string, number>;
  reasons: string[];
  examples: BaselineExample[];
}

export interface RetainedRawEndpointInventoryRow {
  endpointName: string;
  entityScope: string;
  snapshotRows: number;
  earliestSourceDate: string;
  latestSourceDate: string;
  earliestFetchedAt: string | null;
  latestFetchedAt: string | null;
  requestedFieldSets: string[];
}

interface RetainedRawSourceProof {
  field: string;
  role: "optional_grouping_join" | "full_resolver_input";
  payloadFields: string[];
  exactRowsWithAnyField: number;
  totalExactRows: number;
  coveragePct: number | null;
  requestedByExactMetricEndpoint: boolean | null;
  status: "present" | "partial" | "missing" | "inventory_not_queried";
}

export interface ExactPitConfirmatoryReport {
  contractVersion: typeof CONTRACT_VERSION;
  generatedAt: string;
  readOnly: true;
  mutatesData: false;
  providerCalls: false;
  jobsRun: false;
  currentEngineVersion: string;
  input: {
    startDate: string;
    endDate: string;
    cutoffTimeUtc: string;
    businessId: string | null;
    providerAccountId: string | null;
  };
  sourceBoundary: {
    exactSourceMode: "exact_raw_pit";
    rawTable: "meta_raw_snapshots";
    rawEndpoint: "ad_insights_bulk";
    campaignStatusEndpoint: "campaign_statuses";
    configSources: [
      "meta_campaign_config_history",
      "meta_adset_config_history",
    ];
    targetSources: ["business_target_pack_history", "business_target_packs"];
    persistedBaselineTables: [
      "engine_v3_decision_snapshots_daily",
      "engine_v3_creative_lifecycle_daily",
      "engine_v3_account_calibration_daily",
    ];
    restatedAdDailyRows: 0;
    currentDimensionRows: 0;
    exactAndRestatedMetricsMerged: false;
    currentDimensionsPromoted: false;
  };
  summary: {
    rollingCutoffWindowCountBasis: "ad_insights_bulk_latest_generation_terminal_supersede_identity_conflict_safe";
    requestedDays: number;
    daysWithReconstructableScope: number;
    observedScopeDays: number;
    reconstructableScopeDays: number;
    nonReconstructableScopeDays: number;
    exactEvidenceRows: number;
    exactManifestRows: number;
    rejectedManifestRows: number;
    exactThreeDayScopeWindows: number;
    exactSevenDayScopeWindows: number;
    exactFourteenDayScopeWindows: number;
    exactTwentyEightDayScopeWindows: number;
    campaignConfigCoveredRows: number;
    adsetConfigCoveredRows: number;
    targetCoveredRows: number;
    creativeIdentityCoveredRows: number;
    branchTerminalCoreEvaluatedRows: number;
    branchTerminalCoreResolvedRows: number;
    unsupportedObjectiveResolvedRows: number;
    campaignPausedResolvedRows: number;
    fullResolverInputEvaluableRows: number;
    legacyCreativeOutputHashJoinableRows: number;
  };
  coverage: {
    scopeCoveragePct: number | null;
    manifestEligibilityPct: number | null;
    campaignConfigCoveragePct: number | null;
    adsetConfigCoveragePct: number | null;
    targetCoveragePct: number | null;
    creativeIdentityCoveragePct: number | null;
    campaignStatus: {
      statusBearingPayloadRows: number;
      statusBearingScopes: number;
      mappedAdManifests: number;
      unmappedAdManifests: number;
      unmappedCampaignStatusRows: number;
      resolvedPausedBranches: number;
      postCutoffSnapshotRowsExcluded: number;
      incompleteLatestScopes: number;
      conflictingLatestScopes: number;
      statusConflictCount: number;
      mappingCoveragePct: number | null;
    };
    metricFieldPresence: Record<
      string,
      { presentRows: number; totalRows: number; coveragePct: number | null }
    >;
  };
  evaluability: {
    decisionGrain: "ad_id";
    branchTerminalCore: {
      status: CoverageStatus;
      evaluatedRows: number;
      resolvedRows: number;
      totalRows: number;
      terminalBranches: ["unsupported_objective", "campaign_paused"];
      hashKind: "branch_terminal_core_only";
    };
    fullResolverInputs: {
      status: CoverageStatus;
      evaluableRows: number;
      totalRows: number;
      fullInputHashRows: number;
      fullDecisionHashRows: number;
    };
    legacyCreativeOutputHashJoin: {
      status: CoverageStatus;
      joinableRows: number;
      creativeIdentityAvailableRows: number;
      totalRows: number;
      hashKind: "persisted_output_only";
      grantsAdExecutionAuthority: false;
    };
  };
  conflicts: {
    rawExactDuplicatePageRows: number;
    rawConflictingPageIndices: number;
    rawExactDuplicateAdRows: number;
    rawConflictingAdIds: number;
    rawHierarchyConflictAdIds: number;
    campaignConfigLatestCaptureConflicts: number;
    adsetConfigLatestCaptureConflicts: number;
    campaignStatusConflicts: number;
    status: GateStatus;
  };
  hashes: {
    algorithm: "sha256";
    exactObservationManifestSetHash: string | null;
    branchTerminalCoreDecisionSetHash: string | null;
    fullResolverInputSetHash: null;
    fullResolverDecisionSetHash: null;
    legacyCreativeOutputJoinSetHash: string | null;
    persistedDecisionSetHash: string | null;
    currentEngineDecisionSetHash: string | null;
    deterministicTransformVerified: boolean;
  };
  rollingWindowIntegrity: {
    sourceMode: "exact_raw_pit";
    endpoint: "ad_insights_bulk";
    sourceReceiptCount: number;
    reconstructableSourceReceipts: number;
    nonReconstructableSourceReceipts: number;
    selectedGenerationConflictSourceReceipts: number;
    unisolatedSupersedeSourceReceipts: number;
    generationReasonCounts: Record<string, number>;
  };
  campaignStatusIntegrity: ExactCampaignStatusSelection;
  dailyCoverage: DailyCoverageRow[];
  rollingWindowReceipts: ExactRollingCutoffWindowReceipt[];
  manifests: ExactManifestRow[];
  rejectedManifests: RejectedManifestRow[];
  persistedBaseline: PersistedBaselineSummary;
  retainedRawEndpointInventory: {
    status: "available" | "empty" | "not_queried";
    sourceDateStart: string;
    sourceDateEnd: string;
    snapshotRows: number;
    endpoints: RetainedRawEndpointInventoryRow[];
    exactMetricEndpointRequestedFieldSets: string[];
    sourceProof: RetainedRawSourceProof[];
  };
  physicallyUnreconstructable: string[];
  caveats: string[];
  reportHash: string;
}

type DbSnapshotRow = {
  id: unknown;
  business_id: unknown;
  provider_account_id: unknown;
  partition_id: unknown;
  checkpoint_id: unknown;
  run_id: unknown;
  endpoint_name: unknown;
  entity_scope: unknown;
  page_index: unknown;
  provider_cursor: unknown;
  start_date: unknown;
  end_date: unknown;
  account_timezone: unknown;
  account_currency: unknown;
  payload_json: unknown;
  payload_hash: unknown;
  provider_http_status: unknown;
  status: unknown;
  fetched_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type ConfigDbRow = Record<string, unknown> & {
  key: unknown;
  entity_type: unknown;
  id: unknown;
  business_id: unknown;
  provider_account_id: unknown;
  entity_id: unknown;
  campaign_id: unknown;
  config_fingerprint: unknown;
  objective: unknown;
  optimization_goal: unknown;
  source_kind: unknown;
  source_snapshot_id: unknown;
  captured_at: unknown;
  config_created_at: unknown;
  effective_from: unknown;
  source_business_id: unknown;
  source_provider_account_id: unknown;
  source_fetched_at: unknown;
  source_created_at: unknown;
};

type TargetDbRow = Record<string, unknown> & {
  business_id: unknown;
  id: unknown;
  source: unknown;
  target_roas: unknown;
  break_even_roas: unknown;
  effective_at: unknown;
  recorded_at: unknown;
};

type BaselineDbRow = Record<string, unknown> & {
  snapshot_id: unknown;
  business_id: unknown;
  provider_account_id: unknown;
  decision_date: unknown;
  engine_version: unknown;
  creative_id: unknown;
  label: unknown;
  raw_label: unknown;
  confidence: unknown;
  truth_source: unknown;
  effective_target_roas: unknown;
  ratio_to_target: unknown;
  badges: unknown;
  reason: unknown;
  spend: unknown;
  purchases: unknown;
  roas: unknown;
  recent7d_roas: unknown;
  scope_type: unknown;
  scope_id: unknown;
  label_transform: unknown;
  blocked_action_type: unknown;
  decision_input_hash: unknown;
  lifecycle_input_hash: unknown;
  calibration_input_hash: unknown;
  lifecycle_computed_at: unknown;
  lifecycle_source_max_updated_at: unknown;
  decision_computed_at: unknown;
};

interface ConfigLookupKey {
  key: string;
  decisionDate: string;
  cutoff: string;
  businessId: string;
  providerAccountId: string;
  campaignId: string;
  adsetId: string;
}

type RawEndpointInventoryDbRow = Record<string, unknown> & {
  endpoint_name: unknown;
  entity_scope: unknown;
  snapshot_rows: unknown;
  earliest_source_date: unknown;
  latest_source_date: unknown;
  earliest_fetched_at: unknown;
  latest_fetched_at: unknown;
  requested_field_sets: unknown;
};

type CampaignStatusDbRow = DbSnapshotRow & {
  decision_scope_key: unknown;
  post_cutoff_rows_excluded: unknown;
};

export interface ExactRollingDecisionScope {
  decisionDate: string;
  businessId: string;
  providerAccountId: string;
}

function cliValue(argv: string[], name: string) {
  const prefix = `--${name}=`;
  return (
    argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function assertDateOnly(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} is not a valid calendar date.`);
  }
  return value;
}

function assertCutoffTime(value: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) {
    throw new Error("cutoffTimeUtc must use HH:MM:SS.");
  }
  return value;
}

export function parseExactPitArgs(argv: string[]): ParsedExactPitArgs {
  const startDateRaw = cliValue(argv, "start");
  const endDateRaw = cliValue(argv, "end");
  if (!startDateRaw || !endDateRaw) {
    throw new Error("--start=YYYY-MM-DD and --end=YYYY-MM-DD are required.");
  }
  const startDate = assertDateOnly(startDateRaw, "start");
  const endDate = assertDateOnly(endDateRaw, "end");
  if (startDate > endDate) throw new Error("start must be on or before end.");
  return {
    startDate,
    endDate,
    cutoffTimeUtc: assertCutoffTime(
      cliValue(argv, "cutoffTimeUtc") ?? DEFAULT_CUTOFF_TIME_UTC,
    ),
    businessId: cliValue(argv, "business"),
    providerAccountId: cliValue(argv, "account"),
    jsonOut: cliValue(argv, "jsonOut"),
    markdownOut: cliValue(argv, "markdownOut"),
  };
}

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function textArray(value: unknown) {
  return Array.isArray(value)
    ? sortedUnique(value.flatMap((entry) => optionalText(entry) ?? []))
    : [];
}

function requiredText(value: unknown, field: string) {
  const text = optionalText(value);
  if (!text) throw new Error(`Missing ${field}.`);
  return text;
}

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredNumber(value: unknown, field: string) {
  const parsed = optionalNumber(value);
  if (parsed === null) throw new Error(`Missing numeric ${field}.`);
  return parsed;
}

function isoTimestamp(value: unknown): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function requiredTimestamp(value: unknown, field: string) {
  const timestamp = isoTimestamp(value);
  if (!timestamp) throw new Error(`Missing timestamp ${field}.`);
  return timestamp;
}

function dateOnly(value: unknown) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
      value.getDate(),
    ).padStart(2, "0")}`;
  }
  return requiredText(value, "date").slice(0, 10);
}

function enumerateDates(startDate: string, endDate: string) {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function cutoffForDate(date: string, cutoffTimeUtc: string) {
  return `${date}T${cutoffTimeUtc}.000Z`;
}

function roundPct(numerator: number, denominator: number) {
  return denominator > 0
    ? Math.round((numerator / denominator) * 10_000) / 100
    : null;
}

function coverageStatus(
  coveredRows: number,
  totalRows: number,
): CoverageStatus {
  if (totalRows === 0) return "no_rows";
  if (coveredRows === 0) return "none";
  return coveredRows === totalRows ? "complete" : "partial";
}

function sortedUnique(values: readonly string[]) {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function scopeKey(date: string, businessId: string, providerAccountId: string) {
  return `${date}::${businessId}::${providerAccountId}`;
}

function rollingSourceReceiptKey(input: {
  decisionDate: string;
  sourceDate: string;
  businessId: string;
  providerAccountId: string;
}) {
  return [
    input.decisionDate,
    input.sourceDate,
    input.businessId,
    input.providerAccountId,
  ].join("::");
}

function configKey(input: {
  decisionDate: string;
  businessId: string;
  providerAccountId: string;
  campaignId: string;
  adsetId: string;
}) {
  return [
    input.decisionDate,
    input.businessId,
    input.providerAccountId,
    input.campaignId,
    input.adsetId,
  ].join("::");
}

function isReconstructableScope(scope: IntegrityScope) {
  return (
    scope.generationStatus === "pass" &&
    scope.identityCoverage.status === "pass" &&
    scope.selectedGeneration?.reconstructable === true &&
    !scope.unisolatedCanSupersedeLatest &&
    scope.evidence.length > 0
  );
}

function selectedGenerationConflictCount(scope: IntegrityScope) {
  const generation = scope.selectedGeneration;
  if (!generation) return 0;
  return (
    generation.exactDuplicatePageRows +
    generation.conflictingPageIndices.length +
    generation.exactDuplicateAdRows +
    generation.conflictingAdIds.length +
    generation.hierarchyConflictAdIds.length
  );
}

export function buildRollingCutoffSourceReceipts(input: {
  decisionDate: string;
  integrityReport: PitIntegrityReport;
}): ExactRollingCutoffSourceReceipt[] {
  const decisionDate = assertDateOnly(input.decisionDate, "decisionDate");
  if (input.integrityReport.input.cutoff.slice(0, 10) !== decisionDate) {
    throw new Error(
      "Rolling source receipt cutoff must fall on its decision date.",
    );
  }
  return input.integrityReport.scopes
    .map((scope) => {
      const receipt = {
        sourceMode: "exact_raw_pit" as const,
        decisionDate,
        cutoff: input.integrityReport.input.cutoff,
        sourceDate: input.integrityReport.input.decisionDate,
        businessId: scope.businessId,
        providerAccountId: scope.providerAccountId,
        reconstructable: isReconstructableScope(scope),
        generationStatus: scope.generationStatus,
        generationReason: scope.generationReason,
        identityStatus: scope.identityCoverage.status,
        unisolatedCanSupersedeLatest: scope.unisolatedCanSupersedeLatest,
        selectedGenerationKey: scope.selectedGeneration?.generationKey ?? null,
        selectedGenerationSnapshotIds:
          scope.selectedGeneration?.snapshotIds ?? [],
        selectedGenerationConflictCount: selectedGenerationConflictCount(scope),
      };
      return { ...receipt, receiptHash: deterministicSha256(receipt) };
    })
    .sort(
      (left, right) =>
        left.decisionDate.localeCompare(right.decisionDate) ||
        left.sourceDate.localeCompare(right.sourceDate) ||
        left.businessId.localeCompare(right.businessId) ||
        left.providerAccountId.localeCompare(right.providerAccountId),
    );
}

function buildRollingWindowStatus(input: {
  days: 3 | 7 | 14 | 28;
  decisionScope: ExactRollingDecisionScope;
  sourceReceiptsByKey: Map<string, ExactRollingCutoffSourceReceipt[]>;
}): ExactRollingWindowStatus {
  const sourceDates = Array.from({ length: input.days }, (_, index) =>
    shiftDate(input.decisionScope.decisionDate, -index),
  ).sort();
  const missingSourceDates: string[] = [];
  const observedSourceReceiptHashes: string[] = [];
  const selectedGenerationKeys: string[] = [];
  let availableSourceDays = 0;

  for (const sourceDate of sourceDates) {
    const entries =
      input.sourceReceiptsByKey.get(
        rollingSourceReceiptKey({
          decisionDate: input.decisionScope.decisionDate,
          sourceDate,
          businessId: input.decisionScope.businessId,
          providerAccountId: input.decisionScope.providerAccountId,
        }),
      ) ?? [];
    const uniqueEntries = Array.from(
      new Map(entries.map((entry) => [entry.receiptHash, entry])).values(),
    );
    observedSourceReceiptHashes.push(
      ...uniqueEntries.map((entry) => entry.receiptHash),
    );
    const receipt = uniqueEntries.length === 1 ? uniqueEntries[0] : null;
    if (receipt?.reconstructable) {
      availableSourceDays += 1;
      if (receipt.selectedGenerationKey) {
        selectedGenerationKeys.push(receipt.selectedGenerationKey);
      }
    } else {
      missingSourceDates.push(sourceDate);
    }
  }

  const status: ExactRollingWindowStatus["status"] =
    availableSourceDays === input.days ? "complete" : "incomplete";
  const receipt = {
    sourceMode: "exact_raw_pit" as const,
    days: input.days,
    status,
    requiredSourceDays: input.days,
    availableSourceDays,
    missingSourceDates,
    observedSourceReceiptHashes: sortedUnique(observedSourceReceiptHashes),
    selectedGenerationKeys: sortedUnique(selectedGenerationKeys),
  };
  return { ...receipt, receiptHash: deterministicSha256(receipt) };
}

export function buildRollingCutoffWindowReceipts(input: {
  decisionScopes: ExactRollingDecisionScope[];
  sourceReceipts: ExactRollingCutoffSourceReceipt[];
  cutoffTimeUtc?: string;
}): ExactRollingCutoffWindowReceipt[] {
  const cutoffTimeUtc = assertCutoffTime(
    input.cutoffTimeUtc ?? DEFAULT_CUTOFF_TIME_UTC,
  );
  const sourceReceiptsByKey = new Map<
    string,
    ExactRollingCutoffSourceReceipt[]
  >();
  for (const receipt of input.sourceReceipts) {
    if (
      receipt.sourceMode !== "exact_raw_pit" ||
      receipt.cutoff !== cutoffForDate(receipt.decisionDate, cutoffTimeUtc)
    ) {
      continue;
    }
    const key = rollingSourceReceiptKey(receipt);
    const entries = sourceReceiptsByKey.get(key) ?? [];
    entries.push(receipt);
    sourceReceiptsByKey.set(key, entries);
  }
  const decisionScopes = Array.from(
    new Map(
      input.decisionScopes.map((scope) => [
        scopeKey(scope.decisionDate, scope.businessId, scope.providerAccountId),
        {
          decisionDate: assertDateOnly(scope.decisionDate, "decisionDate"),
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
        },
      ]),
    ).values(),
  ).sort(
    (left, right) =>
      left.decisionDate.localeCompare(right.decisionDate) ||
      left.businessId.localeCompare(right.businessId) ||
      left.providerAccountId.localeCompare(right.providerAccountId),
  );

  return decisionScopes.map((decisionScope) => {
    const threeDay = buildRollingWindowStatus({
      days: 3,
      decisionScope,
      sourceReceiptsByKey,
    });
    const sevenDay = buildRollingWindowStatus({
      days: 7,
      decisionScope,
      sourceReceiptsByKey,
    });
    const fourteenDay = buildRollingWindowStatus({
      days: 14,
      decisionScope,
      sourceReceiptsByKey,
    });
    const twentyEightDay = buildRollingWindowStatus({
      days: 28,
      decisionScope,
      sourceReceiptsByKey,
    });
    const receipt = {
      sourceMode: "exact_raw_pit" as const,
      decisionDate: decisionScope.decisionDate,
      cutoff: cutoffForDate(decisionScope.decisionDate, cutoffTimeUtc),
      businessId: decisionScope.businessId,
      providerAccountId: decisionScope.providerAccountId,
      threeDay,
      sevenDay,
      fourteenDay,
      twentyEightDay,
    };
    return { ...receipt, receiptHash: deterministicSha256(receipt) };
  });
}

function timestampMs(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function campaignStatusScopeKey(input: {
  decisionDate: string;
  businessId: string;
  providerAccountId: string;
}) {
  return [input.decisionDate, input.businessId, input.providerAccountId].join(
    "::",
  );
}

function campaignStatusReceiptKey(input: {
  decisionDate: string;
  businessId: string;
  providerAccountId: string;
  campaignId: string;
}) {
  return `${campaignStatusScopeKey(input)}::${input.campaignId}`;
}

function normalizeCampaignStatus(value: unknown): ExactCampaignStatus | null {
  const normalized = optionalText(value)?.toUpperCase() ?? null;
  if (normalized === "CAMPAIGN_PAUSED" || normalized === "ADSET_PAUSED") {
    return "PAUSED";
  }
  if (
    normalized === "ACTIVE" ||
    normalized === "PAUSED" ||
    normalized === "DELETED" ||
    normalized === "REJECTED"
  ) {
    return normalized;
  }
  return null;
}

function campaignStatusObservedAt(row: PitRawSnapshotRow) {
  const fetchedAt = timestampMs(row.fetchedAt);
  const createdAt = timestampMs(row.createdAt);
  if (fetchedAt === null || createdAt === null) return null;
  return Math.max(fetchedAt, createdAt);
}

function campaignStatusSnapshotSignature(row: PitRawSnapshotRow) {
  return deterministicSha256({
    endpointName: row.endpointName,
    entityScope: row.entityScope,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status,
    payloadJson: row.payloadJson,
  });
}

function isCampaignStatusSnapshotStructurallyComplete(
  row: PitRawSnapshotRow,
  decisionDate: string,
  cutoff: string,
) {
  const cutoffMs = timestampMs(cutoff);
  const fetchedAt = timestampMs(row.fetchedAt);
  const createdAt = timestampMs(row.createdAt);
  const updatedAt = timestampMs(row.updatedAt);
  const statusEligible =
    row.status === "fetched" ||
    (row.status === "superseded" &&
      cutoffMs !== null &&
      updatedAt !== null &&
      updatedAt > cutoffMs);
  return (
    cutoffMs !== null &&
    fetchedAt !== null &&
    createdAt !== null &&
    fetchedAt <= cutoffMs &&
    createdAt <= cutoffMs &&
    row.endpointName === CAMPAIGN_STATUS_ENDPOINT &&
    row.entityScope === "campaign" &&
    row.startDate === row.endDate &&
    row.endDate <= decisionDate &&
    statusEligible &&
    Array.isArray(row.payloadJson) &&
    row.payloadJson.every(
      (entry) =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    )
  );
}

export function buildExactCampaignStatusSelection(input: {
  rows: PitRawSnapshotRow[];
  decisionScopes: ExactRollingDecisionScope[];
  cutoffTimeUtc?: string;
  additionalPostCutoffRowsExcluded?: number;
}): ExactCampaignStatusSelection {
  const cutoffTimeUtc = assertCutoffTime(
    input.cutoffTimeUtc ?? DEFAULT_CUTOFF_TIME_UTC,
  );
  const rows = Array.from(
    new Map(input.rows.map((row) => [row.id, row])).values(),
  );
  const decisionScopes = Array.from(
    new Map(
      input.decisionScopes.map((scope) => [
        campaignStatusScopeKey(scope),
        {
          decisionDate: assertDateOnly(scope.decisionDate, "decisionDate"),
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
        },
      ]),
    ).values(),
  ).sort(
    (left, right) =>
      left.decisionDate.localeCompare(right.decisionDate) ||
      left.businessId.localeCompare(right.businessId) ||
      left.providerAccountId.localeCompare(right.providerAccountId),
  );

  const scopes: ExactCampaignStatusScopeReceipt[] = [];
  for (const decisionScope of decisionScopes) {
    const cutoff = cutoffForDate(decisionScope.decisionDate, cutoffTimeUtc);
    const cutoffMs = timestampMs(cutoff) as number;
    const relevantRows = rows.filter(
      (row) =>
        row.endpointName === CAMPAIGN_STATUS_ENDPOINT &&
        row.entityScope === "campaign" &&
        row.businessId === decisionScope.businessId &&
        row.providerAccountId === decisionScope.providerAccountId &&
        row.startDate === row.endDate &&
        row.endDate <= decisionScope.decisionDate,
    );
    const timestampUnprovable = relevantRows.filter(
      (row) => campaignStatusObservedAt(row) === null,
    );
    const postCutoffRows = relevantRows.filter((row) => {
      const fetchedAt = timestampMs(row.fetchedAt);
      const createdAt = timestampMs(row.createdAt);
      return (
        (fetchedAt !== null && fetchedAt > cutoffMs) ||
        (createdAt !== null && createdAt > cutoffMs)
      );
    });
    const atCutoffRows = relevantRows.filter((row) => {
      const fetchedAt = timestampMs(row.fetchedAt);
      const createdAt = timestampMs(row.createdAt);
      return (
        fetchedAt !== null &&
        createdAt !== null &&
        fetchedAt <= cutoffMs &&
        createdAt <= cutoffMs
      );
    });

    let generationStatus: GateStatus = "unknown";
    let generationReason: CampaignStatusGenerationReason = "no_rows_at_cutoff";
    let selectedGenerationKey: string | null = null;
    let selectedSnapshotIds: string[] = [];
    let statusBearingPayloadRows = 0;
    let unmappedPayloadRows = 0;
    let statusConflictCount = 0;
    let exactDuplicateSnapshotRows = 0;
    let exactDuplicateCampaignRows = 0;
    let receipts: ExactCampaignStatusReceipt[] = [];

    if (timestampUnprovable.length > 0) {
      generationStatus = "fail";
      generationReason = "timestamp_unprovable";
    } else if (atCutoffRows.length > 0) {
      const latestObservedAt = Math.max(
        ...atCutoffRows.map((row) => campaignStatusObservedAt(row) as number),
      );
      const latestRows = atCutoffRows
        .filter((row) => campaignStatusObservedAt(row) === latestObservedAt)
        .sort((left, right) => left.id.localeCompare(right.id));
      selectedSnapshotIds = latestRows.map((row) => row.id);
      const latestSignatures = new Set(
        latestRows.map(campaignStatusSnapshotSignature),
      );
      exactDuplicateSnapshotRows =
        latestSignatures.size === 1 ? Math.max(0, latestRows.length - 1) : 0;
      if (latestSignatures.size > 1) {
        generationStatus = "fail";
        generationReason = "latest_generation_conflict";
        statusConflictCount += latestRows.length;
      } else {
        const selected = latestRows[0] as PitRawSnapshotRow;
        selectedGenerationKey = deterministicSha256({
          contractVersion: CAMPAIGN_STATUS_CONTRACT_VERSION,
          businessId: decisionScope.businessId,
          providerAccountId: decisionScope.providerAccountId,
          sourceDate: selected.startDate,
          fetchedAt: selected.fetchedAt,
          createdAt: selected.createdAt,
          snapshotSignature: campaignStatusSnapshotSignature(selected),
        });
        if (
          !isCampaignStatusSnapshotStructurallyComplete(
            selected,
            decisionScope.decisionDate,
            cutoff,
          )
        ) {
          generationStatus = "fail";
          generationReason = "latest_generation_incomplete";
        } else {
          const payloadRows = selected.payloadJson as Array<
            Record<string, unknown>
          >;
          const byCampaign = new Map<
            string,
            Array<{
              rawEffectiveStatus: string | null;
              rawConfiguredStatus: string | null;
              normalizedStatus: ExactCampaignStatus | null;
              statusSourceField: "effective_status" | "status" | null;
            }>
          >();
          for (const payload of payloadRows) {
            const rawEffectiveStatus = optionalText(payload.effective_status);
            const rawConfiguredStatus = optionalText(payload.status);
            if (!rawEffectiveStatus && !rawConfiguredStatus) continue;
            statusBearingPayloadRows += 1;
            const campaignId = optionalText(payload.id);
            if (!campaignId) {
              unmappedPayloadRows += 1;
              continue;
            }
            const normalizedEffectiveStatus =
              normalizeCampaignStatus(rawEffectiveStatus);
            const normalizedConfiguredStatus =
              normalizeCampaignStatus(rawConfiguredStatus);
            if (
              rawEffectiveStatus &&
              rawConfiguredStatus &&
              normalizedEffectiveStatus !== normalizedConfiguredStatus
            ) {
              statusConflictCount += 1;
              continue;
            }
            const normalizedStatus =
              normalizedEffectiveStatus ?? normalizedConfiguredStatus;
            const entries = byCampaign.get(campaignId) ?? [];
            entries.push({
              rawEffectiveStatus,
              rawConfiguredStatus,
              normalizedStatus,
              statusSourceField: rawEffectiveStatus
                ? "effective_status"
                : rawConfiguredStatus
                  ? "status"
                  : null,
            });
            byCampaign.set(campaignId, entries);
          }

          const receiptRows: ExactCampaignStatusReceipt[] = [];
          for (const [campaignId, values] of Array.from(
            byCampaign.entries(),
          ).sort(([left], [right]) => left.localeCompare(right))) {
            const signatures = new Set(
              values.map((value) => deterministicSha256(value)),
            );
            if (signatures.size > 1) {
              statusConflictCount += values.length;
              continue;
            }
            exactDuplicateCampaignRows += Math.max(0, values.length - 1);
            const value = values[0];
            if (!value || !selected.fetchedAt || !selected.createdAt) continue;
            const receiptCore = {
              contractVersion: CAMPAIGN_STATUS_CONTRACT_VERSION,
              sourceMode: "exact_raw_pit" as const,
              decisionDate: decisionScope.decisionDate,
              cutoff,
              businessId: decisionScope.businessId,
              providerAccountId: decisionScope.providerAccountId,
              campaignId,
              ...value,
              sourceSnapshotId: selected.id,
              sourceDate: selected.startDate,
              fetchedAt: selected.fetchedAt,
              createdAt: selected.createdAt,
              generationKey: selectedGenerationKey,
            };
            receiptRows.push({
              ...receiptCore,
              receiptHash: deterministicSha256(receiptCore),
            });
          }
          if (statusConflictCount > 0) {
            generationStatus = "fail";
            generationReason = "latest_generation_conflict";
          } else {
            generationStatus = "pass";
            generationReason = "latest_generation_complete";
            receipts = receiptRows;
          }
        }
      }
    }

    const scopeCore = {
      sourceMode: "exact_raw_pit" as const,
      decisionDate: decisionScope.decisionDate,
      cutoff,
      businessId: decisionScope.businessId,
      providerAccountId: decisionScope.providerAccountId,
      generationStatus,
      generationReason,
      selectedGenerationKey,
      selectedSnapshotIds,
      observedSnapshotRows: relevantRows.length,
      atCutoffSnapshotRows: atCutoffRows.length,
      postCutoffSnapshotRowsExcluded: postCutoffRows.length,
      statusBearingPayloadRows,
      unmappedPayloadRows,
      statusConflictCount,
      exactDuplicateSnapshotRows,
      exactDuplicateCampaignRows,
      receipts,
    };
    scopes.push({
      ...scopeCore,
      receiptHash: deterministicSha256(scopeCore),
    });
  }

  const receipts = scopes
    .flatMap((scope) => scope.receipts)
    .sort(
      (left, right) =>
        left.decisionDate.localeCompare(right.decisionDate) ||
        left.businessId.localeCompare(right.businessId) ||
        left.providerAccountId.localeCompare(right.providerAccountId) ||
        left.campaignId.localeCompare(right.campaignId),
    );
  const summary = {
    observedSnapshotRows: scopes.reduce(
      (sum, scope) => sum + scope.observedSnapshotRows,
      0,
    ),
    atCutoffSnapshotRows: scopes.reduce(
      (sum, scope) => sum + scope.atCutoffSnapshotRows,
      0,
    ),
    postCutoffSnapshotRowsExcluded:
      scopes.reduce(
        (sum, scope) => sum + scope.postCutoffSnapshotRowsExcluded,
        0,
      ) + (input.additionalPostCutoffRowsExcluded ?? 0),
    observedScopes: scopes.filter((scope) => scope.observedSnapshotRows > 0)
      .length,
    reconstructableScopes: scopes.filter(
      (scope) => scope.generationStatus === "pass",
    ).length,
    incompleteLatestScopes: scopes.filter(
      (scope) => scope.generationReason === "latest_generation_incomplete",
    ).length,
    conflictingLatestScopes: scopes.filter(
      (scope) => scope.generationReason === "latest_generation_conflict",
    ).length,
    statusBearingPayloadRows: scopes.reduce(
      (sum, scope) => sum + scope.statusBearingPayloadRows,
      0,
    ),
    statusBearingScopes: scopes.filter(
      (scope) => scope.statusBearingPayloadRows > 0,
    ).length,
    unmappedPayloadRows: scopes.reduce(
      (sum, scope) => sum + scope.unmappedPayloadRows,
      0,
    ),
    statusConflictCount: scopes.reduce(
      (sum, scope) => sum + scope.statusConflictCount,
      0,
    ),
    exactDuplicateSnapshotRows: scopes.reduce(
      (sum, scope) => sum + scope.exactDuplicateSnapshotRows,
      0,
    ),
    exactDuplicateCampaignRows: scopes.reduce(
      (sum, scope) => sum + scope.exactDuplicateCampaignRows,
      0,
    ),
  };
  return {
    scopes,
    receipts,
    summary,
    selectionHash: deterministicSha256({
      scopes: scopes.map((scope) => scope.receiptHash),
      receipts: receipts.map((receipt) => receipt.receiptHash),
      summary,
    }),
  };
}

function identityProof(input: {
  value: string | null;
  required: boolean;
  source: string;
  sourceId: string | null;
  observedAt: string | null;
  evidenceClass?: SimulationIdentityProvenance["evidenceClass"];
}): SimulationIdentityProvenance {
  return {
    value: input.value,
    required: input.required,
    source: input.source,
    evidenceClass: input.evidenceClass ?? "exact_observation",
    sourceId: input.sourceId,
    observedAt: input.observedAt,
  };
}

function payloadMetric(payload: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(payload, field)
    ? optionalNumber(payload[field])
    : null;
}

function normalizeObservation(
  payload: Record<string, unknown>,
): ExactObservationMetrics {
  const fields = [
    "spend",
    "impressions",
    "clicks",
    "reach",
    "ctr",
    "cpm",
    "frequency",
    "actions",
    "action_values",
    "creative_id",
    "effective_status",
    "review_status",
    "ad_review_status",
    "disapproval_reason",
    "limited_reason",
  ];
  return {
    spend: payloadMetric(payload, "spend"),
    impressions: payloadMetric(payload, "impressions"),
    clicks: payloadMetric(payload, "clicks"),
    reach: payloadMetric(payload, "reach"),
    ctr: payloadMetric(payload, "ctr"),
    cpm: payloadMetric(payload, "cpm"),
    frequency: payloadMetric(payload, "frequency"),
    actions: Object.prototype.hasOwnProperty.call(payload, "actions")
      ? payload.actions
      : null,
    actionValues: Object.prototype.hasOwnProperty.call(payload, "action_values")
      ? payload.action_values
      : null,
    presentFields: fields.filter((field) =>
      Object.prototype.hasOwnProperty.call(payload, field),
    ),
  };
}

function configCandidatesByKey(receipts: ExactConfigReceipt[]) {
  const byKeyAndType = new Map<string, ExactConfigReceipt[]>();
  for (const receipt of receipts) {
    const key = `${receipt.key}::${receipt.entityType}`;
    const values = byKeyAndType.get(key) ?? [];
    values.push(receipt);
    byKeyAndType.set(key, values);
  }
  return new Map(
    Array.from(byKeyAndType.entries()).map(([key, values]) => [
      key,
      [...values].sort(
        (left, right) =>
          right.capturedAt.localeCompare(left.capturedAt) ||
          right.rowId.localeCompare(left.rowId),
      ),
    ]),
  );
}

function timestampAtOrBeforeCutoff(value: string | null, cutoff: string) {
  const normalized = isoTimestamp(value);
  return normalized !== null && normalized <= cutoff;
}

function exactConfigAtCutoff(input: {
  candidates: ExactConfigReceipt[];
  entityType: "campaign" | "adset";
  cutoff: string;
  businessId: string;
  providerAccountId: string;
  campaignId: string;
  adsetId: string;
  selectedGeneration: NonNullable<IntegrityScope["selectedGeneration"]>;
}) {
  const candidatesThatCouldExist = input.candidates.filter((receipt) => {
    const createdAt = isoTimestamp(receipt.createdAt);
    return (
      timestampAtOrBeforeCutoff(receipt.capturedAt, input.cutoff) &&
      (createdAt === null || createdAt <= input.cutoff)
    );
  });
  const latest = candidatesThatCouldExist[0] ?? null;
  if (!latest) return null;

  const expectedEntityId =
    input.entityType === "campaign" ? input.campaignId : input.adsetId;
  const sourceSnapshotId = latest.sourceSnapshotId;
  const configCreatedAt = isoTimestamp(latest.createdAt);
  const sourceFetchedAt = isoTimestamp(latest.sourceSnapshotFetchedAt);
  const sourceCreatedAt = isoTimestamp(latest.sourceSnapshotCreatedAt);
  const sourceIdentityMatches =
    latest.sourceSnapshotBusinessId === input.businessId &&
    latest.sourceSnapshotProviderAccountId === input.providerAccountId;
  const receiptIdentityMatches =
    latest.entityType === input.entityType &&
    latest.businessId === input.businessId &&
    latest.providerAccountId === input.providerAccountId &&
    latest.entityId === expectedEntityId &&
    (latest.campaignId === null || latest.campaignId === input.campaignId);
  const sourceIsSelectedExactGeneration =
    sourceSnapshotId !== null &&
    input.selectedGeneration.reconstructable &&
    input.selectedGeneration.conflictFree &&
    input.selectedGeneration.snapshotIds.includes(sourceSnapshotId);
  const sourcePredatesReceipt =
    configCreatedAt !== null &&
    sourceFetchedAt !== null &&
    sourceCreatedAt !== null &&
    sourceFetchedAt <= configCreatedAt &&
    sourceCreatedAt <= configCreatedAt;

  if (
    latest.conflictingAtLatestCapture ||
    !timestampAtOrBeforeCutoff(latest.createdAt, input.cutoff) ||
    !sourceSnapshotId ||
    !receiptIdentityMatches ||
    !sourceIdentityMatches ||
    !timestampAtOrBeforeCutoff(
      latest.sourceSnapshotFetchedAt,
      input.cutoff,
    ) ||
    !timestampAtOrBeforeCutoff(
      latest.sourceSnapshotCreatedAt,
      input.cutoff,
    ) ||
    !sourcePredatesReceipt ||
    !sourceIsSelectedExactGeneration
  ) {
    return null;
  }

  return latest;
}

function targetForCutoff(
  candidates: ExactTargetCandidate[],
  businessId: string,
  cutoff: string,
) {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.businessId === businessId &&
      candidate.effectiveAt <= cutoff &&
      candidate.recordedAt <= cutoff,
  );
  return (
    eligible.sort(
      (left, right) =>
        right.effectiveAt.localeCompare(left.effectiveAt) ||
        right.recordedAt.localeCompare(left.recordedAt) ||
        right.rowId.localeCompare(left.rowId),
    )[0] ?? null
  );
}

function targetProvenance(
  candidate: ExactTargetCandidate | null,
): SimulationTargetProvenance | null {
  if (!candidate) return null;
  return {
    required: false,
    source: candidate.source,
    evidenceClass: "bitemporal_observation",
    sourceId: `${candidate.rowId}:${deterministicSha256({
      targetRoas: candidate.targetRoas,
      breakevenRoas: candidate.breakevenRoas,
      effectiveAt: candidate.effectiveAt,
      recordedAt: candidate.recordedAt,
    })}`,
    effectiveAt: candidate.effectiveAt,
    recordedAt: candidate.recordedAt,
  };
}

function configProvenance(
  receipts: Array<ExactConfigReceipt | null>,
): SimulationConfigProvenance[] {
  return receipts.flatMap((receipt) => {
    if (!receipt) return [];
    return [
      {
        required: false,
        source:
          receipt.entityType === "campaign"
            ? "meta_campaign_config_history"
            : "meta_adset_config_history",
        evidenceClass: "bitemporal_observation" as const,
        sourceId: `${receipt.rowId}:${receipt.configFingerprint}`,
        observedAt: receipt.capturedAt,
        effectiveFrom: receipt.effectiveFrom,
      },
    ];
  });
}

function fullResolverMissingFields(input: {
  sevenDayComplete: boolean;
  twentyEightDayComplete: boolean;
  target: ExactTargetCandidate | null;
  campaignConfig: ExactConfigReceipt | null;
  adsetConfig: ExactConfigReceipt | null;
  campaignStatus: ExactCampaignStatusReceipt | null;
}) {
  const objective = input.campaignConfig?.objective ?? null;
  const optimizationGoal =
    input.adsetConfig?.optimizationGoal ??
    input.campaignConfig?.optimizationGoal ??
    null;
  return sortedUnique([
    ...(input.sevenDayComplete ? [] : ["metrics.exact_7d_window"]),
    ...(input.twentyEightDayComplete ? [] : ["metrics.exact_28d_window"]),
    ...(objective ? [] : ["context.objective_at_cutoff"]),
    ...(optimizationGoal ? [] : ["context.optimization_goal_at_cutoff"]),
    ...(input.target?.targetRoas != null
      ? []
      : ["commercial_target.target_roas_at_cutoff"]),
    ...(input.target?.breakevenRoas != null
      ? []
      : ["commercial_target.breakeven_roas_at_cutoff"]),
    ...(input.campaignStatus
      ? []
      : ["delivery.campaign_effective_status_at_cutoff"]),
    "delivery.ad_effective_status_at_cutoff",
    "delivery.ad_configured_status_at_cutoff",
    "profile.account_calibration_canonical_input",
    "profile.business_engine_config_at_cutoff",
    "context.campaign_kind_at_cutoff",
    "lifecycle.fatigue_and_peak_features_at_cutoff",
    "stability.previous_published_label_for_engine_version",
    "resolver.canonical_serialized_input",
  ]);
}

function branchTerminalCoreEvaluation(input: {
  cutoff: string;
  adId: string;
  campaignId: string;
  adHierarchySourceSnapshotId: string;
  campaignConfig: ExactConfigReceipt | null;
  campaignStatus: ExactCampaignStatusReceipt | null;
}): BranchTerminalCoreEvaluation {
  const campaignConfig = input.campaignConfig;
  const objective = campaignConfig?.objective ?? null;
  const objectiveMissingFields = sortedUnique([
    ...(campaignConfig ? [] : ["context.campaign_config_at_cutoff"]),
    ...(objective ? [] : ["context.objective_at_cutoff"]),
    ...(campaignConfig?.conflictingAtLatestCapture
      ? ["context.campaign_config_latest_capture_conflict"]
      : []),
    ...(campaignConfig && campaignConfig.capturedAt > input.cutoff
      ? ["context.objective_post_cutoff"]
      : []),
  ]);
  if (
    objectiveMissingFields.length === 0 &&
    objective &&
    campaignConfig &&
    !Array.from(SUPPORTED_OBJECTIVES).some(
      (candidate) => candidate === objective,
    )
  ) {
    const reason = `Engine currently supports OUTCOME_SALES only; this creative is ${objective}.`;
    const receipt = {
      contractVersion: "adsecute.meta.branch-terminal-core.v2" as const,
      hashScope: "branch_terminal_core_only" as const,
      resolutionKind: "exact_decision_label" as const,
      decisionGrain: "ad_id" as const,
      cutoff: input.cutoff,
      adId: input.adId,
      campaignId: input.campaignId,
      adHierarchySourceSnapshotId: input.adHierarchySourceSnapshotId,
      branch: "unsupported_objective" as const,
      objective,
      objectiveSource: "meta_campaign_config_history" as const,
      objectiveSourceId: campaignConfig.rowId,
      objectiveObservedAt: campaignConfig.capturedAt,
      exactDecisionLabel: "out_of_scope" as const,
      reason,
    };
    return {
      status: "resolved",
      branch: "unsupported_objective",
      resolutionKind: "exact_decision_label",
      objective,
      normalizedCampaignStatus: input.campaignStatus?.normalizedStatus ?? null,
      exactDecisionLabel: "out_of_scope",
      reason,
      missingFields: [],
      branchTerminalCoreHash: deterministicSha256(receipt),
    };
  }

  if (input.campaignStatus?.normalizedStatus === "PAUSED") {
    const reason =
      "Campaign was observed PAUSED at the decision cutoff; this proves parent delivery state only, not ad status or a buyer-action label.";
    const receipt = {
      contractVersion: "adsecute.meta.branch-terminal-core.v2" as const,
      hashScope: "branch_terminal_core_only" as const,
      resolutionKind: "exact_delivery_state_only" as const,
      decisionGrain: "ad_id" as const,
      cutoff: input.cutoff,
      adId: input.adId,
      campaignId: input.campaignId,
      adHierarchySourceSnapshotId: input.adHierarchySourceSnapshotId,
      branch: "campaign_paused" as const,
      normalizedCampaignStatus: "PAUSED" as const,
      campaignStatusReceiptHash: input.campaignStatus.receiptHash,
      campaignStatusSourceSnapshotId: input.campaignStatus.sourceSnapshotId,
      exactDecisionLabel: null,
      reason,
    };
    return {
      status: "resolved",
      branch: "campaign_paused",
      resolutionKind: "exact_delivery_state_only",
      objective,
      normalizedCampaignStatus: "PAUSED",
      exactDecisionLabel: null,
      reason,
      missingFields: [],
      branchTerminalCoreHash: deterministicSha256(receipt),
    };
  }

  if (objectiveMissingFields.length > 0 || !objective || !campaignConfig) {
    return {
      status: "not_evaluable",
      branch: null,
      resolutionKind: null,
      objective,
      normalizedCampaignStatus: input.campaignStatus?.normalizedStatus ?? null,
      exactDecisionLabel: null,
      reason: null,
      missingFields: sortedUnique([
        ...objectiveMissingFields,
        ...(input.campaignStatus
          ? []
          : ["delivery.campaign_effective_status_at_cutoff"]),
      ]),
      branchTerminalCoreHash: null,
    };
  }

  return {
    status: "not_terminal",
    branch: null,
    resolutionKind: null,
    objective,
    normalizedCampaignStatus: input.campaignStatus?.normalizedStatus ?? null,
    exactDecisionLabel: null,
    reason: null,
    missingFields: [],
    branchTerminalCoreHash: null,
  };
}

function rawConflictCount(report: PitIntegrityReport) {
  const gate = report.gates.conflicts;
  return (
    gate.exactDuplicatePageRows +
    gate.conflictingPageIndices +
    gate.exactDuplicateAdRows +
    gate.conflictingAdIds +
    gate.hierarchyConflictAdIds
  );
}

function semanticDecision(row: PersistedBaselineRow) {
  return {
    businessId: row.businessId,
    providerAccountId: row.providerAccountId,
    decisionDate: row.decisionDate,
    engineVersion: row.engineVersion,
    creativeId: row.creativeId,
    label: row.label,
    rawLabel: row.rawLabel,
    confidence: row.confidence,
    truthSource: row.truthSource,
    effectiveTargetRoas: row.effectiveTargetRoas,
    ratioToTarget: row.ratioToTarget,
    badges: row.badges,
    reason: row.reason,
    spend: row.spend,
    purchases: row.purchases,
    roas: row.roas,
    recent7dRoas: row.recent7dRoas,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    labelTransform: row.labelTransform,
    blockedActionType: row.blockedActionType,
  };
}

function legacyCreativeOutputJoinKey(input: {
  decisionDate: string;
  businessId: string;
  providerAccountId: string;
  creativeId: string;
}) {
  return [
    input.decisionDate,
    input.businessId,
    input.providerAccountId,
    input.creativeId,
  ].join("::");
}

function buildLegacyCreativeOutputLookup(rows: PersistedBaselineRow[]) {
  const lookup = new Map<string, string[]>();
  for (const row of rows) {
    const key = legacyCreativeOutputJoinKey(row);
    const hashes = lookup.get(key) ?? [];
    hashes.push(deterministicSha256(semanticDecision(row)));
    lookup.set(key, hashes);
  }
  return new Map(
    Array.from(lookup.entries()).map(([key, hashes]) => [
      key,
      [...hashes].sort(),
    ]),
  );
}

function legacyCreativeOutputHashJoin(input: {
  decisionDate: string;
  businessId: string;
  providerAccountId: string;
  creativeId: string | null;
  outputHashesByCreative: Map<string, string[]>;
}): LegacyCreativeOutputHashJoin {
  if (!input.creativeId) {
    return {
      status: "creative_identity_unavailable",
      creativeId: null,
      matchedOutputRows: 0,
      matchCardinality: "none",
      hashKind: "persisted_output_only",
      persistedOutputSetHash: null,
    };
  }
  const hashes =
    input.outputHashesByCreative.get(
      legacyCreativeOutputJoinKey({
        decisionDate: input.decisionDate,
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        creativeId: input.creativeId,
      }),
    ) ?? [];
  if (hashes.length === 0) {
    return {
      status: "no_matching_persisted_output",
      creativeId: input.creativeId,
      matchedOutputRows: 0,
      matchCardinality: "none",
      hashKind: "persisted_output_only",
      persistedOutputSetHash: null,
    };
  }
  return {
    status: "joinable",
    creativeId: input.creativeId,
    matchedOutputRows: hashes.length,
    matchCardinality: hashes.length === 1 ? "one" : "many",
    hashKind: "persisted_output_only",
    persistedOutputSetHash: deterministicSha256(hashes),
  };
}

export function summarizePersistedBaseline(input: {
  rows: PersistedBaselineRow[];
  cutoffTimeUtc: string;
  currentEngineVersion?: string;
}): PersistedBaselineSummary {
  const currentEngineVersion = input.currentEngineVersion ?? ENGINE_VERSION;
  const rowHashes = input.rows
    .map((row) => ({ row, hash: deterministicSha256(semanticDecision(row)) }))
    .sort(
      (left, right) =>
        left.row.decisionDate.localeCompare(right.row.decisionDate) ||
        left.row.businessId.localeCompare(right.row.businessId) ||
        left.row.providerAccountId.localeCompare(right.row.providerAccountId) ||
        left.row.creativeId.localeCompare(right.row.creativeId) ||
        left.row.snapshotId.localeCompare(right.row.snapshotId),
    );
  const currentRows = rowHashes.filter(
    ({ row }) => row.engineVersion === currentEngineVersion,
  );
  const engineVersions = Object.fromEntries(
    Array.from(
      input.rows.reduce((counts, row) => {
        counts.set(row.engineVersion, (counts.get(row.engineVersion) ?? 0) + 1);
        return counts;
      }, new Map<string, number>()),
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
  const lifecycleRowsComputedAfterCutoff = input.rows.filter((row) => {
    if (!row.lifecycleComputedAt) return false;
    return (
      row.lifecycleComputedAt >
      cutoffForDate(row.decisionDate, input.cutoffTimeUtc)
    );
  }).length;
  const lifecycleRowsWithPostCutoffSourceUpdate = input.rows.filter((row) => {
    if (!row.lifecycleSourceMaxUpdatedAt) return false;
    return (
      row.lifecycleSourceMaxUpdatedAt >
      cutoffForDate(row.decisionDate, input.cutoffTimeUtc)
    );
  }).length;
  const rowsWithDecisionInputHash = input.rows.filter(
    (row) => row.decisionInputHash !== null,
  ).length;
  const rowsWithLifecycleInputHash = input.rows.filter(
    (row) => row.lifecycleInputHash !== null,
  ).length;
  const rowsWithCalibrationInputHash = input.rows.filter(
    (row) => row.calibrationInputHash !== null,
  ).length;
  const rowsWithCompleteInputHashChain = input.rows.filter(
    (row) =>
      row.decisionInputHash !== null &&
      row.lifecycleInputHash !== null &&
      row.calibrationInputHash !== null,
  ).length;
  const reasons = sortedUnique([
    ...(input.rows.length === 0
      ? ["no_persisted_decision_outputs_for_exact_scopes"]
      : []),
    ...(currentRows.length === 0
      ? ["no_current_engine_version_outputs_in_historical_window"]
      : []),
    "canonical_serialized_decision_input_not_persisted",
    ...(input.rows.length > 0 && rowsWithDecisionInputHash === 0
      ? ["decision_snapshot_input_hash_not_populated"]
      : input.rows.length > rowsWithDecisionInputHash
        ? ["decision_snapshot_input_hash_partially_populated"]
        : []),
    "persisted_outputs_are_creative_grain_not_ad_execution_grain",
    "persisted_outputs_are_not_merged_with_exact_raw_metrics",
  ]);
  return {
    boundary: "persisted_output_only_not_joined_to_exact_raw_metrics",
    status:
      input.rows.length === 0
        ? "not_available"
        : currentRows.length > 0
          ? "current_engine_output_hash_only"
          : "persisted_output_hash_only",
    persistedDecisionRows: input.rows.length,
    currentEngineDecisionRows: currentRows.length,
    rowsWithDecisionInputHash,
    rowsWithLifecycleInputHash,
    rowsWithCalibrationInputHash,
    rowsWithCompleteInputHashChain,
    rowsWithCanonicalSerializedInput: 0,
    replayableRows: 0,
    lifecycleRowsComputedAfterCutoff,
    lifecycleRowsWithPostCutoffSourceUpdate,
    persistedDecisionSetHash:
      rowHashes.length > 0
        ? deterministicSha256(rowHashes.map((entry) => entry.hash).sort())
        : null,
    currentEngineDecisionSetHash:
      currentRows.length > 0
        ? deterministicSha256(currentRows.map((entry) => entry.hash).sort())
        : null,
    engineVersions,
    reasons,
    examples: rowHashes.slice(0, 12).map(({ row, hash }) => ({
      snapshotId: row.snapshotId,
      decisionDate: row.decisionDate,
      businessId: row.businessId,
      providerAccountId: row.providerAccountId,
      engineVersion: row.engineVersion,
      creativeId: row.creativeId,
      label: row.label,
      rawLabel: row.rawLabel,
      decisionHash: hash,
    })),
  };
}

function metricCoverage(manifests: ExactManifestRow[]) {
  const fields = [
    "spend",
    "impressions",
    "clicks",
    "reach",
    "ctr",
    "cpm",
    "frequency",
    "actions",
    "action_values",
  ];
  return Object.fromEntries(
    fields.map((field) => {
      const presentRows = manifests.filter((row) =>
        row.observation.presentFields.includes(field),
      ).length;
      return [
        field,
        {
          presentRows,
          totalRows: manifests.length,
          coveragePct: roundPct(presentRows, manifests.length),
        },
      ];
    }),
  );
}

function requestedFieldSetContains(fieldSet: string, field: string) {
  return fieldSet
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean)
    .includes(field);
}

function buildRetainedRawEndpointInventory(input: {
  rows: RetainedRawEndpointInventoryRow[] | undefined;
  manifests: ExactManifestRow[];
  startDate: string;
  endDate: string;
}): ExactPitConfirmatoryReport["retainedRawEndpointInventory"] {
  const endpoints = (input.rows ?? [])
    .map((row) => ({
      ...row,
      requestedFieldSets: sortedUnique(row.requestedFieldSets),
    }))
    .sort(
      (left, right) =>
        left.endpointName.localeCompare(right.endpointName) ||
        left.entityScope.localeCompare(right.entityScope),
    );
  const exactMetricEndpointRequestedFieldSets = sortedUnique(
    endpoints
      .filter((row) => row.endpointName === "ad_insights_bulk")
      .flatMap((row) => row.requestedFieldSets),
  );
  const proofSpecs = [
    {
      field: "identity.creative_id_at_cutoff",
      role: "optional_grouping_join" as const,
      payloadFields: ["creative_id"],
    },
    {
      field: "delivery.effective_status_at_cutoff",
      role: "full_resolver_input" as const,
      payloadFields: ["effective_status"],
    },
    {
      field: "policy.review_status_at_cutoff",
      role: "full_resolver_input" as const,
      payloadFields: ["review_status", "ad_review_status"],
    },
    {
      field: "policy.disapproval_or_limited_reason_at_cutoff",
      role: "full_resolver_input" as const,
      payloadFields: ["disapproval_reason", "limited_reason"],
    },
  ];
  const sourceProof = proofSpecs.map((spec): RetainedRawSourceProof => {
    const exactRowsWithAnyField = input.manifests.filter((row) =>
      spec.payloadFields.some((field) =>
        field === "creative_id"
          ? row.creativeId !== null
          : row.observation.presentFields.includes(field),
      ),
    ).length;
    const totalExactRows = input.manifests.length;
    const requestedByExactMetricEndpoint =
      input.rows === undefined
        ? null
        : spec.payloadFields.some((field) =>
            exactMetricEndpointRequestedFieldSets.some((fieldSet) =>
              requestedFieldSetContains(fieldSet, field),
            ),
          );
    const status: RetainedRawSourceProof["status"] =
      exactRowsWithAnyField > 0 && exactRowsWithAnyField === totalExactRows
        ? "present"
        : exactRowsWithAnyField > 0
          ? "partial"
          : input.rows === undefined
            ? "inventory_not_queried"
            : "missing";
    return {
      ...spec,
      exactRowsWithAnyField,
      totalExactRows,
      coveragePct: roundPct(exactRowsWithAnyField, totalExactRows),
      requestedByExactMetricEndpoint,
      status,
    };
  });
  return {
    status:
      input.rows === undefined
        ? "not_queried"
        : endpoints.length > 0
          ? "available"
          : "empty",
    sourceDateStart: shiftDate(input.startDate, -(MAX_ROLLING_WINDOW_DAYS - 1)),
    sourceDateEnd: input.endDate,
    snapshotRows: endpoints.reduce((sum, row) => sum + row.snapshotRows, 0),
    endpoints,
    exactMetricEndpointRequestedFieldSets,
    sourceProof,
  };
}

export function buildExactPitConfirmatoryReport(input: {
  integrityReports: PitIntegrityReport[];
  rollingSourceReceipts?: ExactRollingCutoffSourceReceipt[];
  campaignStatusRows?: PitRawSnapshotRow[];
  campaignStatusPostCutoffRowsExcluded?: number;
  configReceipts?: ExactConfigReceipt[];
  targetCandidates?: ExactTargetCandidate[];
  baselineRows?: PersistedBaselineRow[];
  rawEndpointInventory?: RetainedRawEndpointInventoryRow[];
  startDate: string;
  endDate: string;
  cutoffTimeUtc?: string;
  businessId?: string | null;
  providerAccountId?: string | null;
  currentEngineVersion?: string;
  generatedAt?: string;
}): ExactPitConfirmatoryReport {
  const cutoffTimeUtc = assertCutoffTime(
    input.cutoffTimeUtc ?? DEFAULT_CUTOFF_TIME_UTC,
  );
  const currentEngineVersion = input.currentEngineVersion ?? ENGINE_VERSION;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const configReceipts = input.configReceipts ?? [];
  const targetCandidates = input.targetCandidates ?? [];
  const baselineRows = input.baselineRows ?? [];
  const configCandidates = configCandidatesByKey(configReceipts);
  const legacyOutputHashesByCreative =
    buildLegacyCreativeOutputLookup(baselineRows);
  const reports = [...input.integrityReports].sort((left, right) =>
    left.input.decisionDate.localeCompare(right.input.decisionDate),
  );
  const decisionScopes = reports.flatMap((report) =>
    report.scopes.filter(isReconstructableScope).map((scope) => ({
      decisionDate: report.input.decisionDate,
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
    })),
  );
  const rollingSourceReceipts =
    input.rollingSourceReceipts ??
    reports.flatMap((report) =>
      buildRollingCutoffSourceReceipts({
        decisionDate: report.input.decisionDate,
        integrityReport: report,
      }),
    );
  const rollingWindowReceipts = buildRollingCutoffWindowReceipts({
    decisionScopes,
    sourceReceipts: rollingSourceReceipts,
    cutoffTimeUtc,
  });
  const rollingWindowReceiptByScope = new Map(
    rollingWindowReceipts.map((receipt) => [
      scopeKey(
        receipt.decisionDate,
        receipt.businessId,
        receipt.providerAccountId,
      ),
      receipt,
    ]),
  );
  const campaignStatusIntegrity = buildExactCampaignStatusSelection({
    rows: input.campaignStatusRows ?? [],
    decisionScopes,
    cutoffTimeUtc,
    additionalPostCutoffRowsExcluded:
      input.campaignStatusPostCutoffRowsExcluded ?? 0,
  });
  const campaignStatusByKey = new Map(
    campaignStatusIntegrity.receipts.map((receipt) => [
      campaignStatusReceiptKey(receipt),
      receipt,
    ]),
  );
  const manifests: ExactManifestRow[] = [];
  const rejectedManifests: RejectedManifestRow[] = [];
  const dailyCoverage: DailyCoverageRow[] = [];

  for (const report of reports) {
    let dailyManifestRows = 0;
    let dailyRejectedRows = 0;
    const reconstructableScopes = report.scopes.filter(isReconstructableScope);
    for (const scope of reconstructableScopes) {
      const selectedGeneration = scope.selectedGeneration;
      if (!selectedGeneration) continue;
      const rollingWindowReceipt = rollingWindowReceiptByScope.get(
        scopeKey(
          report.input.decisionDate,
          scope.businessId,
          scope.providerAccountId,
        ),
      );
      if (!rollingWindowReceipt) {
        throw new Error(
          "Missing deterministic rolling-cutoff receipt for reconstructable scope.",
        );
      }
      const scopeSourceHash = deterministicSha256({
        contract: "exact_raw_pit_scope_generation.v1",
        decisionDate: report.input.decisionDate,
        cutoff: report.input.cutoff,
        businessId: scope.businessId,
        providerAccountId: scope.providerAccountId,
        generationKey: selectedGeneration.generationKey,
        snapshotIds: selectedGeneration.snapshotIds,
        evidence: scope.evidence,
      });
      const sevenDayComplete =
        rollingWindowReceipt.sevenDay.status === "complete";
      const twentyEightDayComplete =
        rollingWindowReceipt.twentyEightDay.status === "complete";

      for (const evidence of scope.evidence) {
        if (!evidence.adId || !evidence.adsetId || !evidence.campaignId)
          continue;
        const lookupKey = configKey({
          decisionDate: report.input.decisionDate,
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
          campaignId: evidence.campaignId,
          adsetId: evidence.adsetId,
        });
        const campaignConfig = exactConfigAtCutoff({
          candidates: configCandidates.get(`${lookupKey}::campaign`) ?? [],
          entityType: "campaign",
          cutoff: report.input.cutoff,
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
          campaignId: evidence.campaignId,
          adsetId: evidence.adsetId,
          selectedGeneration,
        });
        const adsetConfig = exactConfigAtCutoff({
          candidates: configCandidates.get(`${lookupKey}::adset`) ?? [],
          entityType: "adset",
          cutoff: report.input.cutoff,
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
          campaignId: evidence.campaignId,
          adsetId: evidence.adsetId,
          selectedGeneration,
        });
        const campaignStatus =
          campaignStatusByKey.get(
            campaignStatusReceiptKey({
              decisionDate: report.input.decisionDate,
              businessId: scope.businessId,
              providerAccountId: scope.providerAccountId,
              campaignId: evidence.campaignId,
            }),
          ) ?? null;
        const target = targetForCutoff(
          targetCandidates,
          scope.businessId,
          report.input.cutoff,
        );
        const goal =
          adsetConfig?.optimizationGoal ??
          campaignConfig?.optimizationGoal ??
          campaignConfig?.objective ??
          null;
        const goalReceipt = adsetConfig?.optimizationGoal
          ? adsetConfig
          : campaignConfig &&
              (campaignConfig.optimizationGoal || campaignConfig.objective)
            ? campaignConfig
            : null;
        const goalSource = goalReceipt
          ? goalReceipt.entityType === "campaign"
            ? "meta_campaign_config_history"
            : "meta_adset_config_history"
          : "meta_raw_snapshots";
        const goalSourceId = goalReceipt?.rowId ?? evidence.source.snapshotId;
        const goalObservedAt =
          goalReceipt?.capturedAt ?? evidence.source.fetchedAt;
        const payloadHash = deterministicSha256(evidence.payload);
        const configConflictFields = sortedUnique([
          ...(campaignConfig?.conflictingAtLatestCapture
            ? ["context.campaign_config_latest_capture"]
            : []),
          ...(adsetConfig?.conflictingAtLatestCapture
            ? ["context.adset_config_latest_capture"]
            : []),
        ]);
        const sourceIds = [
          `snapshot:${evidence.source.snapshotId}`,
          `payload_sha256:${payloadHash}`,
          ...[campaignConfig, adsetConfig].flatMap((receipt) =>
            receipt
              ? [`config:${receipt.rowId}:${receipt.configFingerprint}`]
              : [],
          ),
          ...(target ? [`target:${target.rowId}`] : []),
          ...(campaignStatus
            ? [
                `campaign_status:${campaignStatus.sourceSnapshotId}:${campaignStatus.receiptHash}`,
              ]
            : []),
        ];
        const identity: SimulationIdentityProvenanceMap = {
          account: identityProof({
            value: scope.providerAccountId,
            required: true,
            source: "meta_raw_snapshots",
            sourceId: evidence.source.snapshotId,
            observedAt: evidence.source.fetchedAt,
          }),
          campaign: identityProof({
            value: evidence.campaignId,
            required: true,
            source: "meta_raw_snapshots.payload_json",
            sourceId: evidence.source.snapshotId,
            observedAt: evidence.source.fetchedAt,
          }),
          adset: identityProof({
            value: evidence.adsetId,
            required: true,
            source: "meta_raw_snapshots.payload_json",
            sourceId: evidence.source.snapshotId,
            observedAt: evidence.source.fetchedAt,
          }),
          ad: identityProof({
            value: evidence.adId,
            required: true,
            source: "meta_raw_snapshots.payload_json",
            sourceId: evidence.source.snapshotId,
            observedAt: evidence.source.fetchedAt,
          }),
          creative: identityProof({
            value: evidence.creativeId,
            required: false,
            source: "meta_raw_snapshots.payload_json",
            sourceId: evidence.creativeId ? evidence.source.snapshotId : null,
            observedAt: evidence.creativeId ? evidence.source.fetchedAt : null,
          }),
          goal: identityProof({
            value: goal,
            required: false,
            source: goalSource,
            sourceId: goal ? goalSourceId : null,
            observedAt: goal ? goalObservedAt : null,
            evidenceClass: goalReceipt
              ? "bitemporal_observation"
              : "exact_observation",
          }),
          country: identityProof({
            value: optionalText(evidence.payload.country),
            required: false,
            source: "meta_raw_snapshots.payload_json",
            sourceId: evidence.payload.country
              ? evidence.source.snapshotId
              : null,
            observedAt: evidence.payload.country
              ? evidence.source.fetchedAt
              : null,
          }),
          currency: identityProof({
            value: evidence.accountCurrency,
            required: true,
            source: "meta_raw_snapshots.account_currency",
            sourceId: evidence.source.snapshotId,
            observedAt: evidence.source.fetchedAt,
          }),
        };
        const manifest = buildSimulationInputManifest({
          sourceMode: "exact_raw_pit",
          cutoff: report.input.cutoff,
          identity,
          targetProvenance: targetProvenance(target),
          configProvenance: configProvenance([campaignConfig, adsetConfig]),
          generation: {
            complete: true,
            partitionId: selectedGeneration.partitionId,
            runId: selectedGeneration.runId,
            snapshotIds: selectedGeneration.snapshotIds,
            sourceManifestHash: scopeSourceHash,
          },
          sourceIds,
          missingFields: [],
          conflictFields: configConflictFields,
          outcomeCompleteness: {
            status: "not_requested",
            checkedAt: report.input.cutoff,
            windowDays: [],
            completeThrough: null,
            sourceIds: [],
            missingFields: [],
          },
        });
        const rowKey = [
          report.input.decisionDate,
          scope.businessId,
          scope.providerAccountId,
          evidence.campaignId,
          evidence.adsetId,
          evidence.adId,
        ].join("::");
        if (!manifest.eligibility.exactPitEligible) {
          rejectedManifests.push({
            rowKey,
            decisionDate: report.input.decisionDate,
            businessId: scope.businessId,
            providerAccountId: scope.providerAccountId,
            reasons: manifest.eligibility.reasons,
            assertedSourceMode: manifest.assertedSourceMode,
            resultingSourceMode: manifest.sourceMode,
            sourceManifestHash: manifest.sha256,
          });
          dailyRejectedRows += 1;
          continue;
        }
        const fullMissingFields = fullResolverMissingFields({
          sevenDayComplete,
          twentyEightDayComplete,
          target,
          campaignConfig,
          adsetConfig,
          campaignStatus,
        });
        const branchTerminalCore = branchTerminalCoreEvaluation({
          cutoff: report.input.cutoff,
          adId: evidence.adId,
          campaignId: evidence.campaignId,
          adHierarchySourceSnapshotId: evidence.source.snapshotId,
          campaignConfig,
          campaignStatus,
        });
        manifests.push({
          rowKey,
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
          decisionDate: report.input.decisionDate,
          adId: evidence.adId,
          campaignId: evidence.campaignId,
          adsetId: evidence.adsetId,
          creativeId: evidence.creativeId,
          observationHash: payloadHash,
          sourceManifestHash: manifest.sha256,
          campaignStatusReceipt: campaignStatus,
          branchTerminalCore,
          fullResolverInputStatus:
            fullMissingFields.length === 0 ? "evaluable" : "not_evaluable",
          fullResolverMissingFields: fullMissingFields,
          fullResolverInputHash: null,
          decisionHash: null,
          legacyCreativeOutputHashJoin: legacyCreativeOutputHashJoin({
            decisionDate: report.input.decisionDate,
            businessId: scope.businessId,
            providerAccountId: scope.providerAccountId,
            creativeId: evidence.creativeId,
            outputHashesByCreative: legacyOutputHashesByCreative,
          }),
          exactWindowReceipt: {
            sourceMode: "exact_raw_pit",
            threeDayScopeWindowComplete:
              rollingWindowReceipt.threeDay.status === "complete",
            sevenDayScopeWindowComplete: sevenDayComplete,
            fourteenDayScopeWindowComplete:
              rollingWindowReceipt.fourteenDay.status === "complete",
            twentyEightDayScopeWindowComplete: twentyEightDayComplete,
            threeDayReceiptHash: rollingWindowReceipt.threeDay.receiptHash,
            sevenDayReceiptHash: rollingWindowReceipt.sevenDay.receiptHash,
            fourteenDayReceiptHash:
              rollingWindowReceipt.fourteenDay.receiptHash,
            twentyEightDayReceiptHash:
              rollingWindowReceipt.twentyEightDay.receiptHash,
          },
          observation: normalizeObservation(evidence.payload),
          manifest,
        });
        dailyManifestRows += 1;
      }
    }
    dailyCoverage.push({
      decisionDate: report.input.decisionDate,
      cutoff: report.input.cutoff,
      observedScopeCount: report.scopes.length,
      reconstructableScopeCount: reconstructableScopes.length,
      nonReconstructableScopeCount:
        report.scopes.length - reconstructableScopes.length,
      exactEvidenceRows: reconstructableScopes.reduce(
        (sum, scope) => sum + scope.evidence.length,
        0,
      ),
      exactManifestRows: dailyManifestRows,
      rejectedManifestRows: dailyRejectedRows,
      exactThreeDayScopeWindows: rollingWindowReceipts.filter(
        (receipt) =>
          receipt.decisionDate === report.input.decisionDate &&
          receipt.threeDay.status === "complete",
      ).length,
      exactSevenDayScopeWindows: rollingWindowReceipts.filter(
        (receipt) =>
          receipt.decisionDate === report.input.decisionDate &&
          receipt.sevenDay.status === "complete",
      ).length,
      exactFourteenDayScopeWindows: rollingWindowReceipts.filter(
        (receipt) =>
          receipt.decisionDate === report.input.decisionDate &&
          receipt.fourteenDay.status === "complete",
      ).length,
      exactTwentyEightDayScopeWindows: rollingWindowReceipts.filter(
        (receipt) =>
          receipt.decisionDate === report.input.decisionDate &&
          receipt.twentyEightDay.status === "complete",
      ).length,
      postCutoffSnapshotRowsExcluded:
        report.summary.postCutoffSnapshotRowsExcluded,
      generationReasonCounts: report.summary.generationReasonCounts,
      rawConflictCount: rawConflictCount(report),
    });
  }

  manifests.sort((left, right) => left.rowKey.localeCompare(right.rowKey));
  rejectedManifests.sort((left, right) =>
    left.rowKey.localeCompare(right.rowKey),
  );
  const baseline = summarizePersistedBaseline({
    rows: baselineRows,
    cutoffTimeUtc,
    currentEngineVersion,
  });
  const observedScopeDays = dailyCoverage.reduce(
    (sum, day) => sum + day.observedScopeCount,
    0,
  );
  const reconstructableScopeDays = dailyCoverage.reduce(
    (sum, day) => sum + day.reconstructableScopeCount,
    0,
  );
  const rawConflictTotals = reports.reduce(
    (totals, report) => {
      totals.rawExactDuplicatePageRows +=
        report.gates.conflicts.exactDuplicatePageRows;
      totals.rawConflictingPageIndices +=
        report.gates.conflicts.conflictingPageIndices;
      totals.rawExactDuplicateAdRows +=
        report.gates.conflicts.exactDuplicateAdRows;
      totals.rawConflictingAdIds += report.gates.conflicts.conflictingAdIds;
      totals.rawHierarchyConflictAdIds +=
        report.gates.conflicts.hierarchyConflictAdIds;
      return totals;
    },
    {
      rawExactDuplicatePageRows: 0,
      rawConflictingPageIndices: 0,
      rawExactDuplicateAdRows: 0,
      rawConflictingAdIds: 0,
      rawHierarchyConflictAdIds: 0,
    },
  );
  const campaignConfigLatestCaptureConflicts = configReceipts.filter(
    (receipt) =>
      receipt.entityType === "campaign" && receipt.conflictingAtLatestCapture,
  ).length;
  const adsetConfigLatestCaptureConflicts = configReceipts.filter(
    (receipt) =>
      receipt.entityType === "adset" && receipt.conflictingAtLatestCapture,
  ).length;
  const totalConflicts =
    Object.values(rawConflictTotals).reduce((sum, value) => sum + value, 0) +
    campaignConfigLatestCaptureConflicts +
    adsetConfigLatestCaptureConflicts +
    campaignStatusIntegrity.summary.statusConflictCount;
  const campaignConfigCoveredRows = manifests.filter((row) =>
    row.manifest.configProvenance.some(
      (receipt) => receipt.source === "meta_campaign_config_history",
    ),
  ).length;
  const adsetConfigCoveredRows = manifests.filter((row) =>
    row.manifest.configProvenance.some(
      (receipt) => receipt.source === "meta_adset_config_history",
    ),
  ).length;
  const targetCoveredRows = manifests.filter(
    (row) => row.manifest.targetProvenance !== null,
  ).length;
  const creativeIdentityCoveredRows = manifests.filter(
    (row) => row.creativeId !== null,
  ).length;
  const exactThreeDayScopeWindows = rollingWindowReceipts.filter(
    (receipt) => receipt.threeDay.status === "complete",
  ).length;
  const exactSevenDayScopeWindows = rollingWindowReceipts.filter(
    (receipt) => receipt.sevenDay.status === "complete",
  ).length;
  const exactFourteenDayScopeWindows = rollingWindowReceipts.filter(
    (receipt) => receipt.fourteenDay.status === "complete",
  ).length;
  const exactTwentyEightDayScopeWindows = rollingWindowReceipts.filter(
    (receipt) => receipt.twentyEightDay.status === "complete",
  ).length;
  const branchTerminalCoreEvaluatedRows = manifests.filter(
    (row) => row.branchTerminalCore.status !== "not_evaluable",
  ).length;
  const branchTerminalCoreResolvedRows = manifests.filter(
    (row) => row.branchTerminalCore.status === "resolved",
  ).length;
  const unsupportedObjectiveResolvedRows = manifests.filter(
    (row) => row.branchTerminalCore.branch === "unsupported_objective",
  ).length;
  const campaignPausedResolvedRows = manifests.filter(
    (row) => row.branchTerminalCore.branch === "campaign_paused",
  ).length;
  const fullResolverInputEvaluableRows = manifests.filter(
    (row) => row.fullResolverInputStatus === "evaluable",
  ).length;
  const legacyCreativeOutputHashJoinableRows = manifests.filter(
    (row) => row.legacyCreativeOutputHashJoin.status === "joinable",
  ).length;
  const mappedAdManifests = manifests.filter(
    (row) => row.campaignStatusReceipt !== null,
  ).length;
  const unmappedAdManifests = manifests.length - mappedAdManifests;
  const manifestCampaignStatusKeys = new Set(
    manifests.map((row) =>
      campaignStatusReceiptKey({
        decisionDate: row.decisionDate,
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        campaignId: row.campaignId,
      }),
    ),
  );
  const unmappedCampaignStatusRows =
    campaignStatusIntegrity.summary.unmappedPayloadRows +
    campaignStatusIntegrity.receipts.filter(
      (receipt) =>
        !manifestCampaignStatusKeys.has(campaignStatusReceiptKey(receipt)),
    ).length;
  const exactObservationManifestSetHash =
    manifests.length > 0
      ? deterministicSha256(
          manifests.map((row) => row.sourceManifestHash).sort(),
        )
      : null;
  const branchTerminalCoreHashes = manifests.flatMap((row) =>
    row.branchTerminalCore.branchTerminalCoreHash
      ? [
          {
            rowKey: row.rowKey,
            branchTerminalCoreHash:
              row.branchTerminalCore.branchTerminalCoreHash,
          },
        ]
      : [],
  );
  const branchTerminalCoreDecisionSetHash =
    branchTerminalCoreHashes.length > 0
      ? deterministicSha256(branchTerminalCoreHashes)
      : null;
  const legacyCreativeOutputJoinHashes = manifests.flatMap((row) =>
    row.legacyCreativeOutputHashJoin.persistedOutputSetHash
      ? [
          {
            rowKey: row.rowKey,
            persistedOutputSetHash:
              row.legacyCreativeOutputHashJoin.persistedOutputSetHash,
          },
        ]
      : [],
  );
  const legacyCreativeOutputJoinSetHash =
    legacyCreativeOutputJoinHashes.length > 0
      ? deterministicSha256(legacyCreativeOutputJoinHashes)
      : null;
  const retainedRawEndpointInventory = buildRetainedRawEndpointInventory({
    rows: input.rawEndpointInventory,
    manifests,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  const retainedFullResolverSourceProofMissing =
    retainedRawEndpointInventory.sourceProof.some(
      (proof) =>
        proof.role === "full_resolver_input" && proof.status !== "present",
    );
  const rollingWindowGenerationReasonCounts = rollingSourceReceipts.reduce(
    (counts, receipt) => {
      counts[receipt.generationReason] =
        (counts[receipt.generationReason] ?? 0) + 1;
      return counts;
    },
    {} as Record<string, number>,
  );
  const rollingWindowIntegrity: ExactPitConfirmatoryReport["rollingWindowIntegrity"] =
    {
      sourceMode: "exact_raw_pit",
      endpoint: "ad_insights_bulk",
      sourceReceiptCount: rollingSourceReceipts.length,
      reconstructableSourceReceipts: rollingSourceReceipts.filter(
        (receipt) => receipt.reconstructable,
      ).length,
      nonReconstructableSourceReceipts: rollingSourceReceipts.filter(
        (receipt) => !receipt.reconstructable,
      ).length,
      selectedGenerationConflictSourceReceipts: rollingSourceReceipts.filter(
        (receipt) => receipt.selectedGenerationConflictCount > 0,
      ).length,
      unisolatedSupersedeSourceReceipts: rollingSourceReceipts.filter(
        (receipt) => receipt.unisolatedCanSupersedeLatest,
      ).length,
      generationReasonCounts: Object.fromEntries(
        Object.entries(rollingWindowGenerationReasonCounts).sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      ),
    };

  const deterministicCore = {
    contractVersion: CONTRACT_VERSION,
    currentEngineVersion,
    input: {
      startDate: input.startDate,
      endDate: input.endDate,
      cutoffTimeUtc,
      businessId: input.businessId ?? null,
      providerAccountId: input.providerAccountId ?? null,
    },
    dailyCoverage,
    rollingWindowIntegrity,
    rollingWindowReceipts,
    campaignStatusIntegrity,
    manifestHashes: manifests.map((row) => ({
      rowKey: row.rowKey,
      observationHash: row.observationHash,
      sourceManifestHash: row.sourceManifestHash,
      branchTerminalCoreHash: row.branchTerminalCore.branchTerminalCoreHash,
      fullResolverMissingFields: row.fullResolverMissingFields,
      legacyCreativeOutputHash:
        row.legacyCreativeOutputHashJoin.persistedOutputSetHash,
      campaignStatusReceiptHash: row.campaignStatusReceipt?.receiptHash ?? null,
      threeDayReceiptHash: row.exactWindowReceipt.threeDayReceiptHash,
      sevenDayReceiptHash: row.exactWindowReceipt.sevenDayReceiptHash,
      fourteenDayReceiptHash: row.exactWindowReceipt.fourteenDayReceiptHash,
      twentyEightDayReceiptHash:
        row.exactWindowReceipt.twentyEightDayReceiptHash,
    })),
    rejectedManifests,
    baseline,
    retainedRawEndpointInventory,
    configReceiptHashes: configReceipts
      .map((receipt) => deterministicSha256(receipt))
      .sort(),
    targetCandidateHashes: targetCandidates
      .map((candidate) => deterministicSha256(candidate))
      .sort(),
  };
  const reportHash = deterministicSha256(deterministicCore);

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt,
    readOnly: true,
    mutatesData: false,
    providerCalls: false,
    jobsRun: false,
    currentEngineVersion,
    input: {
      startDate: input.startDate,
      endDate: input.endDate,
      cutoffTimeUtc,
      businessId: input.businessId ?? null,
      providerAccountId: input.providerAccountId ?? null,
    },
    sourceBoundary: {
      exactSourceMode: "exact_raw_pit",
      rawTable: "meta_raw_snapshots",
      rawEndpoint: "ad_insights_bulk",
      campaignStatusEndpoint: CAMPAIGN_STATUS_ENDPOINT,
      configSources: [
        "meta_campaign_config_history",
        "meta_adset_config_history",
      ],
      targetSources: ["business_target_pack_history", "business_target_packs"],
      persistedBaselineTables: [
        "engine_v3_decision_snapshots_daily",
        "engine_v3_creative_lifecycle_daily",
        "engine_v3_account_calibration_daily",
      ],
      restatedAdDailyRows: 0,
      currentDimensionRows: 0,
      exactAndRestatedMetricsMerged: false,
      currentDimensionsPromoted: false,
    },
    summary: {
      rollingCutoffWindowCountBasis:
        "ad_insights_bulk_latest_generation_terminal_supersede_identity_conflict_safe",
      requestedDays: enumerateDates(input.startDate, input.endDate).length,
      daysWithReconstructableScope: dailyCoverage.filter(
        (day) => day.reconstructableScopeCount > 0,
      ).length,
      observedScopeDays,
      reconstructableScopeDays,
      nonReconstructableScopeDays: observedScopeDays - reconstructableScopeDays,
      exactEvidenceRows: dailyCoverage.reduce(
        (sum, day) => sum + day.exactEvidenceRows,
        0,
      ),
      exactManifestRows: manifests.length,
      rejectedManifestRows: rejectedManifests.length,
      exactThreeDayScopeWindows,
      exactSevenDayScopeWindows,
      exactFourteenDayScopeWindows,
      exactTwentyEightDayScopeWindows,
      campaignConfigCoveredRows,
      adsetConfigCoveredRows,
      targetCoveredRows,
      creativeIdentityCoveredRows,
      branchTerminalCoreEvaluatedRows,
      branchTerminalCoreResolvedRows,
      unsupportedObjectiveResolvedRows,
      campaignPausedResolvedRows,
      fullResolverInputEvaluableRows,
      legacyCreativeOutputHashJoinableRows,
    },
    coverage: {
      scopeCoveragePct: roundPct(reconstructableScopeDays, observedScopeDays),
      manifestEligibilityPct: roundPct(
        manifests.length,
        manifests.length + rejectedManifests.length,
      ),
      campaignConfigCoveragePct: roundPct(
        campaignConfigCoveredRows,
        manifests.length,
      ),
      adsetConfigCoveragePct: roundPct(
        adsetConfigCoveredRows,
        manifests.length,
      ),
      targetCoveragePct: roundPct(targetCoveredRows, manifests.length),
      creativeIdentityCoveragePct: roundPct(
        creativeIdentityCoveredRows,
        manifests.length,
      ),
      campaignStatus: {
        statusBearingPayloadRows:
          campaignStatusIntegrity.summary.statusBearingPayloadRows,
        statusBearingScopes:
          campaignStatusIntegrity.summary.statusBearingScopes,
        mappedAdManifests,
        unmappedAdManifests,
        unmappedCampaignStatusRows,
        resolvedPausedBranches: campaignPausedResolvedRows,
        postCutoffSnapshotRowsExcluded:
          campaignStatusIntegrity.summary.postCutoffSnapshotRowsExcluded,
        incompleteLatestScopes:
          campaignStatusIntegrity.summary.incompleteLatestScopes,
        conflictingLatestScopes:
          campaignStatusIntegrity.summary.conflictingLatestScopes,
        statusConflictCount:
          campaignStatusIntegrity.summary.statusConflictCount,
        mappingCoveragePct: roundPct(mappedAdManifests, manifests.length),
      },
      metricFieldPresence: metricCoverage(manifests),
    },
    evaluability: {
      decisionGrain: "ad_id",
      branchTerminalCore: {
        status: coverageStatus(
          branchTerminalCoreResolvedRows,
          manifests.length,
        ),
        evaluatedRows: branchTerminalCoreEvaluatedRows,
        resolvedRows: branchTerminalCoreResolvedRows,
        totalRows: manifests.length,
        terminalBranches: ["unsupported_objective", "campaign_paused"],
        hashKind: "branch_terminal_core_only",
      },
      fullResolverInputs: {
        status: coverageStatus(
          fullResolverInputEvaluableRows,
          manifests.length,
        ),
        evaluableRows: fullResolverInputEvaluableRows,
        totalRows: manifests.length,
        fullInputHashRows: 0,
        fullDecisionHashRows: 0,
      },
      legacyCreativeOutputHashJoin: {
        status: coverageStatus(
          legacyCreativeOutputHashJoinableRows,
          manifests.length,
        ),
        joinableRows: legacyCreativeOutputHashJoinableRows,
        creativeIdentityAvailableRows: creativeIdentityCoveredRows,
        totalRows: manifests.length,
        hashKind: "persisted_output_only",
        grantsAdExecutionAuthority: false,
      },
    },
    conflicts: {
      ...rawConflictTotals,
      campaignConfigLatestCaptureConflicts,
      adsetConfigLatestCaptureConflicts,
      campaignStatusConflicts:
        campaignStatusIntegrity.summary.statusConflictCount,
      status:
        totalConflicts > 0 ? "fail" : manifests.length > 0 ? "pass" : "unknown",
    },
    hashes: {
      algorithm: "sha256",
      exactObservationManifestSetHash,
      branchTerminalCoreDecisionSetHash,
      fullResolverInputSetHash: null,
      fullResolverDecisionSetHash: null,
      legacyCreativeOutputJoinSetHash,
      persistedDecisionSetHash: baseline.persistedDecisionSetHash,
      currentEngineDecisionSetHash: baseline.currentEngineDecisionSetHash,
      deterministicTransformVerified: true,
    },
    rollingWindowIntegrity,
    campaignStatusIntegrity,
    dailyCoverage,
    rollingWindowReceipts,
    manifests,
    rejectedManifests,
    persistedBaseline: baseline,
    retainedRawEndpointInventory,
    physicallyUnreconstructable: [
      ...(exactTwentyEightDayScopeWindows === 0
        ? [
            "no decision scope has a complete 28-day exact_raw_pit rolling-cutoff receipt in the requested interval",
          ]
        : []),
      "canonical serialized CreativeInput, AccountDecisionProfile, DataHealth, campaign-label context, and hysteresis memory were not persisted",
      ...(baseline.persistedDecisionRows > 0 &&
      baseline.rowsWithCompleteInputHashChain < baseline.persistedDecisionRows
        ? [
            "the persisted historical baseline does not have a complete decision/lifecycle/calibration input-hash chain for every output row",
          ]
        : []),
      ...(retainedFullResolverSourceProofMissing
        ? [
            "retained sources do not completely prove historical ad-level configured/effective status or policy/review inputs; campaign-status receipts prove only positively observed parent state",
          ]
        : []),
      "provider attribution restatements cannot be reversed to the value Meta exposed at an earlier cutoff when that generation was not retained",
    ],
    caveats: [
      "Exact scope coverage uses only scopes observed in meta_raw_snapshots; it is not an account-inventory denominator.",
      "Config-history is accepted as exact provenance only when the config row existed by cutoff and its cutoff-safe raw source belongs to the selected complete, conflict-free generation; an invalid latest capture never falls back to an older config. Target-pack receipts are cutoff-safe bitemporal provenance, not raw insight metrics.",
      "A current business_target_packs row is used only when its recorded update predates the cutoff; pre-update values are never projected backward.",
      "Rolling window receipts use exact_raw_pit source generations only. A source-day generation fetched after that source date is valid only when it is latest, complete, conflict-free, and at or before the later decision cutoff.",
      "Campaign-status receipts require both fetched_at and created_at at or before the decision cutoff. The latest observed captured generation wins; an incomplete or conflicting latest generation never falls back to an older capture.",
      "campaign_statuses stores an aggregated fetched collection but not provider page cursors. A status-bearing campaign row is positive observation evidence; absence from the collection is never treated as deletion or active status.",
      "A campaign PAUSED receipt resolves parent delivery state only. Ad configured/effective status, policy state, and the final buyer-action label remain unavailable without their own cutoff-safe inputs.",
      "Creative identity is optional portfolio/grouping provenance at native ad_id decision grain. Its absence affects only creative coverage and legacy output-hash joins.",
      "Persisted creative decision hashes are output-only. An optional creative_id join never becomes an ad-grain decision hash or execution authority.",
      "Branch-terminal core hashes cover only the exact terminal branch receipt. Full resolver input and decision hashes remain null while canonical inputs are missing.",
      "Retained endpoint inventory reports endpoint names and requested field metadata; endpoints outside ad_insights_bulk are not silently promoted into the exact metric tier.",
      "Missing raw fields remain null and are never converted to zero.",
    ],
    reportHash,
  };
}

function buildConfigLookupKeys(reports: PitIntegrityReport[]) {
  const values = new Map<string, ConfigLookupKey>();
  for (const report of reports) {
    for (const scope of report.scopes.filter(isReconstructableScope)) {
      for (const evidence of scope.evidence) {
        if (!evidence.campaignId || !evidence.adsetId) continue;
        const key = configKey({
          decisionDate: report.input.decisionDate,
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
          campaignId: evidence.campaignId,
          adsetId: evidence.adsetId,
        });
        values.set(key, {
          key,
          decisionDate: report.input.decisionDate,
          cutoff: report.input.cutoff,
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
          campaignId: evidence.campaignId,
          adsetId: evidence.adsetId,
        });
      }
    }
  }
  return Array.from(values.values()).sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

function configReceiptFromRows(rows: ConfigDbRow[]) {
  const grouped = new Map<string, ConfigDbRow[]>();
  for (const row of rows) {
    if (!optionalText(row.id)) continue;
    const key = `${requiredText(row.key, "config key")}::${requiredText(
      row.entity_type,
      "entity type",
    )}`;
    const values = grouped.get(key) ?? [];
    values.push(row);
    grouped.set(key, values);
  }
  const receipts: ExactConfigReceipt[] = [];
  for (const [, values] of grouped) {
    const sorted = [...values].sort(
      (left, right) =>
        requiredTimestamp(right.captured_at, "captured_at").localeCompare(
          requiredTimestamp(left.captured_at, "captured_at"),
        ) ||
        requiredText(right.id, "id").localeCompare(requiredText(left.id, "id")),
    );
    const latest = sorted[0];
    if (!latest) continue;
    const latestCapturedAt = requiredTimestamp(
      latest.captured_at,
      "captured_at",
    );
    const latestFingerprints = new Set(
      sorted
        .filter(
          (row) =>
            requiredTimestamp(row.captured_at, "captured_at") ===
            latestCapturedAt,
        )
        .map((row) =>
          requiredText(row.config_fingerprint, "config_fingerprint"),
        ),
    );
    const entityType = requiredText(latest.entity_type, "entity_type");
    if (entityType !== "campaign" && entityType !== "adset") {
      throw new Error(`Unexpected config entity type: ${entityType}`);
    }
    receipts.push({
      key: requiredText(latest.key, "key"),
      entityType,
      rowId: requiredText(latest.id, "id"),
      businessId: requiredText(latest.business_id, "business_id"),
      providerAccountId: requiredText(
        latest.provider_account_id,
        "provider_account_id",
      ),
      entityId: requiredText(latest.entity_id, "entity_id"),
      campaignId: optionalText(latest.campaign_id),
      configFingerprint: requiredText(
        latest.config_fingerprint,
        "config_fingerprint",
      ),
      objective: optionalText(latest.objective),
      optimizationGoal: optionalText(latest.optimization_goal),
      sourceKind: requiredText(latest.source_kind, "source_kind"),
      sourceSnapshotId: optionalText(latest.source_snapshot_id),
      capturedAt: latestCapturedAt,
      createdAt: requiredTimestamp(
        latest.config_created_at,
        "config_created_at",
      ),
      effectiveFrom: optionalText(latest.effective_from)?.slice(0, 10) ?? null,
      sourceSnapshotBusinessId: optionalText(latest.source_business_id),
      sourceSnapshotProviderAccountId: optionalText(
        latest.source_provider_account_id,
      ),
      sourceSnapshotFetchedAt: isoTimestamp(latest.source_fetched_at),
      sourceSnapshotCreatedAt: isoTimestamp(latest.source_created_at),
      conflictingAtLatestCapture: latestFingerprints.size > 1,
    });
  }
  return receipts.sort(
    (left, right) =>
      left.key.localeCompare(right.key) ||
      left.entityType.localeCompare(right.entityType),
  );
}

async function readIntegrityReports(args: ParsedExactPitArgs) {
  const [{ getDb, resetDbClientCache, runDbTransaction }, operational] =
    await Promise.all([
      import("@/lib/db"),
      import("@/scripts/_operational-runtime"),
    ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  try {
    return await operational.withOperationalStartupLogsSilenced(async () =>
      runDbTransaction(
        async () => {
          const sql = getDb();
          await sql.query("SET TRANSACTION READ ONLY");
          const readOnlyState = await sql.query<{
            transaction_read_only: string;
          }>("SHOW transaction_read_only");
          if (readOnlyState[0]?.transaction_read_only !== "on") {
            throw new Error(
              "Database transaction is not read-only; refusing to query.",
            );
          }
          const integrityReports: PitIntegrityReport[] = [];
          const rollingSourceReceipts: ExactRollingCutoffSourceReceipt[] = [];
          const decisionDates = enumerateDates(args.startDate, args.endDate);
          const sourceDates = enumerateDates(
            shiftDate(args.startDate, -(MAX_ROLLING_WINDOW_DAYS - 1)),
            args.endDate,
          );
          for (const sourceDate of sourceDates) {
            // Hold one source day's payloads at a time. Every later cutoff is
            // reduced to a lightweight receipt before the rows are released.
            const rows = await sql.query<DbSnapshotRow>(
              `
                SELECT
                  id::text,
                  business_id,
                  provider_account_id,
                  partition_id::text,
                  checkpoint_id::text,
                  run_id,
                  endpoint_name,
                  entity_scope,
                  page_index,
                  provider_cursor,
                  start_date::text AS start_date,
                  end_date::text AS end_date,
                  account_timezone,
                  account_currency,
                  payload_json,
                  payload_hash,
                  provider_http_status,
                  status,
                  fetched_at,
                  created_at,
                  updated_at
                FROM meta_raw_snapshots
                WHERE endpoint_name = 'ad_insights_bulk'
                  AND start_date = $1::date
                  AND end_date = $1::date
                  AND ($2::text IS NULL OR business_id = $2)
                  AND ($3::text IS NULL OR provider_account_id = $3)
                ORDER BY business_id, provider_account_id, fetched_at, created_at, id
              `,
              [sourceDate, args.businessId, args.providerAccountId],
            );
            const normalizedRows = rows.map(normalizePitSnapshotDbRow);
            const relevantDecisionDates = decisionDates.filter(
              (decisionDate) =>
                sourceDate <= decisionDate &&
                sourceDate >=
                  shiftDate(decisionDate, -(MAX_ROLLING_WINDOW_DAYS - 1)),
            );
            for (const decisionDate of relevantDecisionDates) {
              const report = buildPitIntegrityReport({
                rows: normalizedRows,
                decisionDate: sourceDate,
                cutoff: cutoffForDate(decisionDate, args.cutoffTimeUtc),
                businessId: args.businessId,
                providerAccountId: args.providerAccountId,
                generatedAt: cutoffForDate(decisionDate, args.cutoffTimeUtc),
              });
              rollingSourceReceipts.push(
                ...buildRollingCutoffSourceReceipts({
                  decisionDate,
                  integrityReport: report,
                }),
              );
              if (sourceDate === decisionDate) {
                integrityReports.push(report);
              }
            }
          }
          return { integrityReports, rollingSourceReceipts };
        },
        { timeoutMs: QUERY_TIMEOUT_MS },
      ),
    );
  } finally {
    resetDbClientCache();
  }
}

async function readCampaignStatusRows(
  scopeDays: Array<{
    decisionDate: string;
    businessId: string;
    providerAccountId: string;
  }>,
  cutoffTimeUtc: string,
) {
  if (scopeDays.length === 0) {
    return { rows: [] as PitRawSnapshotRow[], postCutoffRowsExcluded: 0 };
  }
  const [{ getDb, resetDbClientCache, runDbTransaction }, operational] =
    await Promise.all([
      import("@/lib/db"),
      import("@/scripts/_operational-runtime"),
    ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  const keys = Array.from(
    new Map(
      scopeDays.map((scope) => {
        const decisionDate = assertDateOnly(scope.decisionDate, "decisionDate");
        const value = {
          decision_scope_key: campaignStatusScopeKey(scope),
          decision_date: decisionDate,
          cutoff: cutoffForDate(decisionDate, cutoffTimeUtc),
          business_id: scope.businessId,
          provider_account_id: scope.providerAccountId,
        };
        return [value.decision_scope_key, value];
      }),
    ).values(),
  );
  try {
    const dbRows = await operational.withOperationalStartupLogsSilenced(
      async () =>
        runDbTransaction(
          async () => {
            const sql = getDb();
            await sql.query("SET TRANSACTION READ ONLY");
            const readOnlyState = await sql.query<{
              transaction_read_only: string;
            }>("SHOW transaction_read_only");
            if (readOnlyState[0]?.transaction_read_only !== "on") {
              throw new Error(
                "Database transaction is not read-only; refusing to query campaign statuses.",
              );
            }
            return sql.query<CampaignStatusDbRow>(
              `
                WITH keys AS (
                  SELECT *
                  FROM jsonb_to_recordset($1::jsonb) AS row(
                    decision_scope_key text,
                    decision_date date,
                    cutoff timestamptz,
                    business_id text,
                    provider_account_id text
                  )
                )
                SELECT
                  keys.decision_scope_key,
                  COALESCE(post_cutoff.row_count, 0)::text
                    AS post_cutoff_rows_excluded,
                  selected.id::text,
                  selected.business_id,
                  selected.provider_account_id,
                  selected.partition_id::text,
                  selected.checkpoint_id::text,
                  selected.run_id,
                  selected.endpoint_name,
                  selected.entity_scope,
                  selected.page_index,
                  selected.provider_cursor,
                  selected.start_date::text AS start_date,
                  selected.end_date::text AS end_date,
                  selected.account_timezone,
                  selected.account_currency,
                  selected.payload_json,
                  selected.payload_hash,
                  selected.provider_http_status,
                  selected.status,
                  selected.fetched_at,
                  selected.created_at,
                  selected.updated_at
                FROM keys
                LEFT JOIN LATERAL (
                  SELECT COUNT(*) AS row_count
                  FROM meta_raw_snapshots future
                  WHERE future.endpoint_name = 'campaign_statuses'
                    AND future.entity_scope = 'campaign'
                    AND future.business_id = keys.business_id
                    AND future.provider_account_id = keys.provider_account_id
                    AND future.start_date = future.end_date
                    AND future.end_date <= keys.decision_date
                    AND (
                      future.fetched_at > keys.cutoff
                      OR future.created_at > keys.cutoff
                    )
                ) post_cutoff ON TRUE
                LEFT JOIN LATERAL (
                  SELECT ranked.*
                  FROM (
                    SELECT
                      candidate.*,
                      DENSE_RANK() OVER (
                        ORDER BY GREATEST(
                          candidate.fetched_at,
                          candidate.created_at
                        ) DESC
                      ) AS observed_rank
                    FROM meta_raw_snapshots candidate
                    WHERE candidate.endpoint_name = 'campaign_statuses'
                      AND candidate.entity_scope = 'campaign'
                      AND candidate.business_id = keys.business_id
                      AND candidate.provider_account_id = keys.provider_account_id
                      AND candidate.start_date = candidate.end_date
                      AND candidate.end_date <= keys.decision_date
                      AND candidate.fetched_at IS NOT NULL
                      AND candidate.created_at IS NOT NULL
                      AND candidate.fetched_at <= keys.cutoff
                      AND candidate.created_at <= keys.cutoff
                  ) ranked
                  WHERE ranked.observed_rank = 1
                  UNION ALL
                  SELECT unprovable.*, 1::bigint AS observed_rank
                  FROM LATERAL (
                    SELECT candidate.*
                    FROM meta_raw_snapshots candidate
                    WHERE candidate.endpoint_name = 'campaign_statuses'
                      AND candidate.entity_scope = 'campaign'
                      AND candidate.business_id = keys.business_id
                      AND candidate.provider_account_id = keys.provider_account_id
                      AND candidate.start_date = candidate.end_date
                      AND candidate.end_date <= keys.decision_date
                      AND (
                        candidate.fetched_at IS NULL
                        OR candidate.created_at IS NULL
                      )
                    ORDER BY candidate.id
                    LIMIT 1
                  ) unprovable
                ) selected ON TRUE
                ORDER BY keys.decision_scope_key, selected.id
              `,
              [JSON.stringify(keys)],
            );
          },
          { timeoutMs: QUERY_TIMEOUT_MS },
        ),
    );
    const rowsById = new Map<string, PitRawSnapshotRow>();
    const postCutoffByScope = new Map<string, number>();
    for (const row of dbRows) {
      const key = requiredText(
        row.decision_scope_key,
        "campaign status decision_scope_key",
      );
      postCutoffByScope.set(
        key,
        requiredNumber(
          row.post_cutoff_rows_excluded,
          "campaign status post_cutoff_rows_excluded",
        ),
      );
      if (!optionalText(row.id)) continue;
      const normalized = normalizePitSnapshotDbRow(row);
      rowsById.set(normalized.id, normalized);
    }
    return {
      rows: Array.from(rowsById.values()),
      postCutoffRowsExcluded: Array.from(postCutoffByScope.values()).reduce(
        (sum, value) => sum + value,
        0,
      ),
    };
  } finally {
    resetDbClientCache();
  }
}

async function readRawEndpointInventory(args: ParsedExactPitArgs) {
  const [{ getDb, resetDbClientCache, runDbTransaction }, operational] =
    await Promise.all([
      import("@/lib/db"),
      import("@/scripts/_operational-runtime"),
    ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  const sourceDateStart = shiftDate(
    args.startDate,
    -(MAX_ROLLING_WINDOW_DAYS - 1),
  );
  try {
    const rows = await operational.withOperationalStartupLogsSilenced(
      async () =>
        runDbTransaction(
          async () => {
            const sql = getDb();
            await sql.query("SET TRANSACTION READ ONLY");
            return sql.query<RawEndpointInventoryDbRow>(
              `
                SELECT
                  endpoint_name,
                  entity_scope,
                  COUNT(*)::text AS snapshot_rows,
                  MIN(start_date)::text AS earliest_source_date,
                  MAX(end_date)::text AS latest_source_date,
                  MIN(fetched_at) AS earliest_fetched_at,
                  MAX(fetched_at) AS latest_fetched_at,
                  COALESCE(
                    ARRAY_AGG(
                      DISTINCT NULLIF(request_context->>'fields', '')
                    ) FILTER (
                      WHERE NULLIF(request_context->>'fields', '') IS NOT NULL
                    ),
                    ARRAY[]::text[]
                  ) AS requested_field_sets
                FROM meta_raw_snapshots
                WHERE start_date <= $2::date
                  AND end_date >= $1::date
                  AND ($3::text IS NULL OR business_id = $3)
                  AND ($4::text IS NULL OR provider_account_id = $4)
                GROUP BY endpoint_name, entity_scope
                ORDER BY endpoint_name, entity_scope
              `,
              [
                sourceDateStart,
                args.endDate,
                args.businessId,
                args.providerAccountId,
              ],
            );
          },
          { timeoutMs: QUERY_TIMEOUT_MS },
        ),
    );
    return rows.map((row): RetainedRawEndpointInventoryRow => ({
      endpointName: requiredText(row.endpoint_name, "endpoint_name"),
      entityScope: requiredText(row.entity_scope, "entity_scope"),
      snapshotRows: requiredNumber(row.snapshot_rows, "snapshot_rows"),
      earliestSourceDate: requiredText(
        row.earliest_source_date,
        "earliest_source_date",
      ).slice(0, 10),
      latestSourceDate: requiredText(
        row.latest_source_date,
        "latest_source_date",
      ).slice(0, 10),
      earliestFetchedAt: isoTimestamp(row.earliest_fetched_at),
      latestFetchedAt: isoTimestamp(row.latest_fetched_at),
      requestedFieldSets: textArray(row.requested_field_sets),
    }));
  } finally {
    resetDbClientCache();
  }
}

export function buildExactConfigReceiptQuery(
  entityType: "campaign" | "adset",
) {
  const table =
    entityType === "campaign"
      ? "meta_campaign_config_history"
      : "meta_adset_config_history";
  const idColumn = entityType === "campaign" ? "campaign_id" : "adset_id";
  return `
      WITH keys AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS row(
          key text,
          cutoff timestamptz,
          business_id text,
          provider_account_id text,
          campaign_id text,
          adset_id text
        )
      )
      SELECT
        keys.key,
        '${entityType}'::text AS entity_type,
        config.id::text,
        config.business_id,
        config.provider_account_id,
        config.${idColumn} AS entity_id,
        config.campaign_id,
        config.config_fingerprint,
        ${entityType === "campaign" ? "config.objective" : "NULL::text"} AS objective,
        config.optimization_goal,
        config.source_kind,
        config.source_snapshot_id::text,
        config.captured_at,
        config.created_at AS config_created_at,
        config.effective_from::text AS effective_from,
        raw_source.business_id AS source_business_id,
        raw_source.provider_account_id AS source_provider_account_id,
        raw_source.fetched_at AS source_fetched_at,
        raw_source.created_at AS source_created_at
      FROM keys
      LEFT JOIN LATERAL (
        SELECT *
        FROM ${table} config
        WHERE config.business_id = keys.business_id
          AND config.provider_account_id = keys.provider_account_id
          AND config.${idColumn} = keys.${idColumn}
          AND config.captured_at <= keys.cutoff
          AND config.created_at <= keys.cutoff
          AND config.captured_at = (
            SELECT MAX(latest.captured_at)
            FROM ${table} latest
            WHERE latest.business_id = keys.business_id
              AND latest.provider_account_id = keys.provider_account_id
              AND latest.${idColumn} = keys.${idColumn}
              AND latest.captured_at <= keys.cutoff
              AND latest.created_at <= keys.cutoff
          )
        ORDER BY config.captured_at DESC, config.id DESC
      ) config ON TRUE
      LEFT JOIN meta_raw_snapshots raw_source
        ON raw_source.id = config.source_snapshot_id
      ORDER BY keys.key, config.captured_at DESC, config.id DESC
    `;
}

async function readConfigReceipts(keys: ConfigLookupKey[]) {
  if (keys.length === 0) return [];
  const [{ getDb, resetDbClientCache, runDbTransaction }, operational] =
    await Promise.all([
      import("@/lib/db"),
      import("@/scripts/_operational-runtime"),
    ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  const payload = keys.map((key) => ({
    key: key.key,
    cutoff: key.cutoff,
    business_id: key.businessId,
    provider_account_id: key.providerAccountId,
    campaign_id: key.campaignId,
    adset_id: key.adsetId,
  }));
  try {
    const rows = await operational.withOperationalStartupLogsSilenced(
      async () =>
        runDbTransaction(
          async () => {
            const sql = getDb();
            await sql.query("SET TRANSACTION READ ONLY");
            const [campaignRows, adsetRows] = await Promise.all([
              sql.query<ConfigDbRow>(buildExactConfigReceiptQuery("campaign"), [
                JSON.stringify(payload),
              ]),
              sql.query<ConfigDbRow>(buildExactConfigReceiptQuery("adset"), [
                JSON.stringify(payload),
              ]),
            ]);
            return [...campaignRows, ...adsetRows];
          },
          { timeoutMs: QUERY_TIMEOUT_MS },
        ),
    );
    return configReceiptFromRows(rows);
  } finally {
    resetDbClientCache();
  }
}

async function readTargetCandidates(businessIds: string[]) {
  if (businessIds.length === 0) return [];
  const [{ getDb, resetDbClientCache, runDbTransaction }, operational] =
    await Promise.all([
      import("@/lib/db"),
      import("@/scripts/_operational-runtime"),
    ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  try {
    const rows = await operational.withOperationalStartupLogsSilenced(
      async () =>
        runDbTransaction(
          async () => {
            const sql = getDb();
            await sql.query("SET TRANSACTION READ ONLY");
            return sql.query<TargetDbRow>(
              `
              SELECT
                business_ref_id::text AS business_id,
                id::text,
                'business_target_pack_history'::text AS source,
                target_roas,
                break_even_roas,
                effective_at,
                recorded_at
              FROM business_target_pack_history
              WHERE business_ref_id::text = ANY($1::text[])
              UNION ALL
              SELECT
                business_ref_id::text AS business_id,
                id::text,
                'business_target_packs'::text AS source,
                target_roas,
                break_even_roas,
                updated_at AS effective_at,
                updated_at AS recorded_at
              FROM business_target_packs
              WHERE business_ref_id::text = ANY($1::text[])
              ORDER BY business_id, effective_at, recorded_at, id
            `,
              [businessIds],
            );
          },
          { timeoutMs: QUERY_TIMEOUT_MS },
        ),
    );
    return rows.map((row): ExactTargetCandidate => {
      const source = requiredText(row.source, "target source");
      if (
        source !== "business_target_pack_history" &&
        source !== "business_target_packs"
      ) {
        throw new Error(`Unexpected target source: ${source}`);
      }
      return {
        businessId: requiredText(row.business_id, "target business_id"),
        rowId: requiredText(row.id, "target id"),
        source,
        targetRoas: optionalNumber(row.target_roas),
        breakevenRoas: optionalNumber(row.break_even_roas),
        effectiveAt: requiredTimestamp(row.effective_at, "target effective_at"),
        recordedAt: requiredTimestamp(row.recorded_at, "target recorded_at"),
      };
    });
  } finally {
    resetDbClientCache();
  }
}

async function readPersistedBaselineRows(
  scopeDays: Array<{
    decisionDate: string;
    businessId: string;
    providerAccountId: string;
  }>,
) {
  if (scopeDays.length === 0) return [];
  const [{ getDb, resetDbClientCache, runDbTransaction }, operational] =
    await Promise.all([
      import("@/lib/db"),
      import("@/scripts/_operational-runtime"),
    ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  try {
    const rows = await operational.withOperationalStartupLogsSilenced(
      async () =>
        runDbTransaction(
          async () => {
            const sql = getDb();
            await sql.query("SET TRANSACTION READ ONLY");
            return sql.query<BaselineDbRow>(
              `
              WITH keys AS (
                SELECT *
                FROM jsonb_to_recordset($1::jsonb) AS row(
                  decision_date date,
                  business_id text,
                  provider_account_id text
                )
              )
              SELECT
                decision.id::text AS snapshot_id,
                decision.business_ref_id::text AS business_id,
                lifecycle.provider_account_id,
                decision.as_of_date::text AS decision_date,
                decision.engine_version,
                decision.creative_id,
                decision.label,
                decision.raw_label,
                decision.confidence,
                decision.truth_source,
                decision.effective_target_roas,
                decision.ratio_to_target,
                decision.badges,
                decision.reason,
                decision.spend,
                decision.purchases,
                decision.roas,
                decision.recent7d_roas,
                decision.scope_type,
                decision.scope_id,
                decision.label_transform,
                decision.blocked_action_type,
                decision.input_hash AS decision_input_hash,
                lifecycle.input_hash AS lifecycle_input_hash,
                calibration.input_hash AS calibration_input_hash,
                lifecycle.computed_at AS lifecycle_computed_at,
                lifecycle.source_max_updated_at AS lifecycle_source_max_updated_at,
                decision.computed_at AS decision_computed_at
              FROM keys
              JOIN engine_v3_decision_snapshots_daily decision
                ON decision.business_ref_id::text = keys.business_id
               AND decision.as_of_date = keys.decision_date
              JOIN engine_v3_creative_lifecycle_daily lifecycle
                ON lifecycle.id = decision.lifecycle_row_id
               AND lifecycle.provider_account_id = keys.provider_account_id
              LEFT JOIN engine_v3_account_calibration_daily calibration
                ON calibration.id = decision.calibration_row_id
              ORDER BY
                decision.as_of_date,
                decision.business_ref_id,
                lifecycle.provider_account_id,
                decision.creative_id,
                decision.id
            `,
              [
                JSON.stringify(
                  scopeDays.map((entry) => ({
                    decision_date: entry.decisionDate,
                    business_id: entry.businessId,
                    provider_account_id: entry.providerAccountId,
                  })),
                ),
              ],
            );
          },
          { timeoutMs: QUERY_TIMEOUT_MS },
        ),
    );
    return rows.map((row): PersistedBaselineRow => ({
      snapshotId: requiredText(row.snapshot_id, "snapshot_id"),
      businessId: requiredText(row.business_id, "baseline business_id"),
      providerAccountId: requiredText(
        row.provider_account_id,
        "baseline provider_account_id",
      ),
      decisionDate: dateOnly(row.decision_date),
      engineVersion: requiredText(row.engine_version, "engine_version"),
      creativeId: requiredText(row.creative_id, "creative_id"),
      label: requiredText(row.label, "label"),
      rawLabel: optionalText(row.raw_label),
      confidence: requiredNumber(row.confidence, "confidence"),
      truthSource: requiredText(row.truth_source, "truth_source"),
      effectiveTargetRoas: requiredNumber(
        row.effective_target_roas,
        "effective_target_roas",
      ),
      ratioToTarget: optionalNumber(row.ratio_to_target),
      badges: row.badges,
      reason: requiredText(row.reason, "reason"),
      spend: optionalNumber(row.spend),
      purchases: optionalNumber(row.purchases),
      roas: optionalNumber(row.roas),
      recent7dRoas: optionalNumber(row.recent7d_roas),
      scopeType: requiredText(row.scope_type, "scope_type"),
      scopeId: requiredText(row.scope_id, "scope_id"),
      labelTransform: optionalText(row.label_transform),
      blockedActionType: optionalText(row.blocked_action_type),
      decisionInputHash: optionalText(row.decision_input_hash),
      lifecycleInputHash: optionalText(row.lifecycle_input_hash),
      calibrationInputHash: optionalText(row.calibration_input_hash),
      lifecycleComputedAt: isoTimestamp(row.lifecycle_computed_at),
      lifecycleSourceMaxUpdatedAt: isoTimestamp(
        row.lifecycle_source_max_updated_at,
      ),
      decisionComputedAt: requiredTimestamp(
        row.decision_computed_at,
        "decision_computed_at",
      ),
    }));
  } finally {
    resetDbClientCache();
  }
}

function renderMarkdown(report: ExactPitConfirmatoryReport) {
  const tableHeaders = [
    "Date",
    "Exact scopes",
    "Observed scopes",
    "Evidence rows",
    "Manifests",
    "Exact 3d windows",
    "Exact 7d windows",
    "Exact 14d windows",
    "Exact 28d windows",
    "Excluded post-cutoff snapshots",
  ];
  const tableRows = report.dailyCoverage.map((day) => [
    day.decisionDate,
    String(day.reconstructableScopeCount),
    String(day.observedScopeCount),
    String(day.exactEvidenceRows),
    String(day.exactManifestRows),
    String(day.exactThreeDayScopeWindows),
    String(day.exactSevenDayScopeWindows),
    String(day.exactFourteenDayScopeWindows),
    String(day.exactTwentyEightDayScopeWindows),
    String(day.postCutoffSnapshotRowsExcluded),
  ]);
  const tableWidths = tableHeaders.map((header, index) =>
    Math.max(header.length, ...tableRows.map((row) => row[index]?.length ?? 0)),
  );
  const formatTableRow = (row: string[]) =>
    `| ${row
      .map((value, index) =>
        index === 0
          ? value.padEnd(tableWidths[index] ?? value.length)
          : value.padStart(tableWidths[index] ?? value.length),
      )
      .join(" | ")} |`;
  const tableSeparator = `| ${tableWidths
    .map((width, index) =>
      index === 0
        ? "-".repeat(width)
        : `${"-".repeat(Math.max(1, width - 1))}:`,
    )
    .join(" | ")} |`;
  const lines = [
    "# Exact-PIT Confirmatory Replay",
    "",
    `Generated: ${report.generatedAt}`,
    `Range: ${report.input.startDate} to ${report.input.endDate}`,
    `Current code engine: ${report.currentEngineVersion}`,
    "",
    "## Boundary",
    "",
    "- Exact metrics source: `meta_raw_snapshots` / `ad_insights_bulk` only.",
    "- Exact parent-status source: cutoff-safe positive observations from `meta_raw_snapshots` / `campaign_statuses`.",
    "- Restated `meta_ad_daily` rows used: **0**.",
    "- Current dimension rows used: **0**.",
    "- Persisted decisions are reported as a separate output-hash baseline and are not merged with exact metrics.",
    "",
    "## Coverage",
    "",
    `- Requested days: **${report.summary.requestedDays}**`,
    `- Days with at least one reconstructable scope: **${report.summary.daysWithReconstructableScope}**`,
    `- Reconstructable scope-days: **${report.summary.reconstructableScopeDays}/${report.summary.observedScopeDays}** (${report.coverage.scopeCoveragePct ?? "n/a"}%)`,
    `- Exact manifest rows: **${report.summary.exactManifestRows}**; rejected manifests: **${report.summary.rejectedManifestRows}**`,
    `- Generation/conflict-safe exact 3-day scope windows: **${report.summary.exactThreeDayScopeWindows}**`,
    `- Generation/conflict-safe exact 7-day scope windows: **${report.summary.exactSevenDayScopeWindows}**`,
    `- Generation/conflict-safe exact 14-day scope windows: **${report.summary.exactFourteenDayScopeWindows}**`,
    `- Generation/conflict-safe exact 28-day scope windows: **${report.summary.exactTwentyEightDayScopeWindows}**`,
    `- Window count basis: \`${report.summary.rollingCutoffWindowCountBasis}\``,
    `- Campaign config coverage: **${report.coverage.campaignConfigCoveragePct ?? "n/a"}%**`,
    `- Adset config coverage: **${report.coverage.adsetConfigCoveragePct ?? "n/a"}%**`,
    `- Target coverage: **${report.coverage.targetCoveragePct ?? "n/a"}%**`,
    `- Optional creative grouping identity coverage: **${report.coverage.creativeIdentityCoveragePct ?? "n/a"}%**`,
    `- Campaign-status mapped ad manifests: **${report.coverage.campaignStatus.mappedAdManifests}/${report.summary.exactManifestRows}** (${report.coverage.campaignStatus.mappingCoveragePct ?? "n/a"}%)`,
    `- Status-bearing rows/scopes: **${report.coverage.campaignStatus.statusBearingPayloadRows}/${report.coverage.campaignStatus.statusBearingScopes}**; unmapped status rows: **${report.coverage.campaignStatus.unmappedCampaignStatusRows}**`,
    `- Exact campaign-paused delivery-state branches: **${report.coverage.campaignStatus.resolvedPausedBranches}**; status conflicts: **${report.coverage.campaignStatus.statusConflictCount}**`,
    "",
    "## Evaluability",
    "",
    `- Decision grain: **${report.evaluability.decisionGrain}**`,
    `- Branch-terminal core: **${report.evaluability.branchTerminalCore.status}**; evaluated **${report.summary.branchTerminalCoreEvaluatedRows}**, exact resolutions **${report.summary.branchTerminalCoreResolvedRows}** (unsupported objective labels **${report.summary.unsupportedObjectiveResolvedRows}**, parent-paused state-only **${report.summary.campaignPausedResolvedRows}**)`,
    `- Full resolver inputs: **${report.evaluability.fullResolverInputs.status}**; evaluable **${report.summary.fullResolverInputEvaluableRows}**`,
    `- Legacy creative-output hash join: **${report.evaluability.legacyCreativeOutputHashJoin.status}**; joinable **${report.summary.legacyCreativeOutputHashJoinableRows}**`,
    "",
    "## Hashes And Reproducibility",
    "",
    `- Exact observation-manifest-set SHA-256: \`${report.hashes.exactObservationManifestSetHash ?? "unavailable"}\``,
    `- Branch-terminal core decision-set SHA-256: \`${report.hashes.branchTerminalCoreDecisionSetHash ?? "unavailable"}\``,
    `- Full resolver input-set SHA-256: \`${report.hashes.fullResolverInputSetHash ?? "unavailable"}\``,
    `- Full resolver decision-set SHA-256: \`${report.hashes.fullResolverDecisionSetHash ?? "unavailable"}\``,
    `- Legacy creative-output join-set SHA-256: \`${report.hashes.legacyCreativeOutputJoinSetHash ?? "unavailable"}\``,
    `- Persisted decision-set SHA-256: \`${report.hashes.persistedDecisionSetHash ?? "unavailable"}\``,
    `- Current-engine decision-set SHA-256: \`${report.hashes.currentEngineDecisionSetHash ?? "unavailable"}\``,
    `- Deterministic transform verified: **${report.hashes.deterministicTransformVerified ? "yes" : "no"}**`,
    `- Persisted baseline status: **${report.persistedBaseline.status}**`,
    `- Persisted rows: **${report.persistedBaseline.persistedDecisionRows}**; replayable rows: **${report.persistedBaseline.replayableRows}**`,
    "",
    "## Retained Raw Source Inventory",
    "",
    `- Inventory status: **${report.retainedRawEndpointInventory.status}**; snapshots: **${report.retainedRawEndpointInventory.snapshotRows}**`,
    `- Retained endpoint names: **${sortedUnique(report.retainedRawEndpointInventory.endpoints.map((row) => row.endpointName)).join(", ") || "none"}**`,
    ...report.retainedRawEndpointInventory.sourceProof.map(
      (proof) =>
        `- ${proof.field} (${proof.role}): **${proof.status}**; exact rows ${proof.exactRowsWithAnyField}/${proof.totalExactRows}; requested by exact endpoint: **${proof.requestedByExactMetricEndpoint ?? "unknown"}**`,
    ),
    "",
    "## Daily Exact Coverage",
    "",
    formatTableRow(tableHeaders),
    tableSeparator,
    ...tableRows.map(formatTableRow),
    "",
    "## Physically Unreconstructable",
    "",
    ...report.physicallyUnreconstructable.map((reason) => `- ${reason}`),
    "",
    "## Verdict",
    "",
    report.summary.unsupportedObjectiveResolvedRows > 0 &&
    report.summary.fullResolverInputEvaluableRows === 0
      ? `The exact tier resolves ${report.summary.unsupportedObjectiveResolvedRows} branch-terminal out_of_scope row(s) and ${report.summary.campaignPausedResolvedRows} parent-paused delivery-state-only row(s) at native ad_id grain. Full resolver inputs remain unavailable, so no full resolver input or decision hash is claimed for paused rows.`
      : report.summary.campaignPausedResolvedRows > 0 &&
          report.summary.fullResolverInputEvaluableRows === 0
        ? `The exact tier resolves ${report.summary.campaignPausedResolvedRows} parent-paused delivery-state-only row(s). Ad status and buyer-action labels remain unavailable, so no full resolver input or decision hash is claimed.`
        : report.summary.fullResolverInputEvaluableRows === 0
          ? "The exact tier confirms observation manifests and rolling-cutoff receipts, but no row has the complete canonical full-resolver input. Full input and decision hashes remain unavailable."
          : "At least one row has complete full-resolver inputs, but this report still emits no full decision hash until the canonical resolver execution is performed.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runExactPitConfirmatoryCli(argv: string[]) {
  const args = parseExactPitArgs(argv);
  const { integrityReports, rollingSourceReceipts } =
    await readIntegrityReports(args);
  const lookupKeys = buildConfigLookupKeys(integrityReports);
  const scopeDays = integrityReports.flatMap((report) =>
    report.scopes.filter(isReconstructableScope).map((scope) => ({
      decisionDate: report.input.decisionDate,
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
    })),
  );
  const businessIds = sortedUnique(scopeDays.map((entry) => entry.businessId));
  // These helpers share the process-level DB client cache. Keep the read-only
  // transactions sequential so one helper cannot reset another helper's
  // active client while closing its own connection.
  const campaignStatusRead = await readCampaignStatusRows(
    scopeDays,
    args.cutoffTimeUtc,
  );
  const configReceipts = await readConfigReceipts(lookupKeys);
  const targetCandidates = await readTargetCandidates(businessIds);
  const baselineRows = await readPersistedBaselineRows(scopeDays);
  const rawEndpointInventory = await readRawEndpointInventory(args);
  const generatedAt = new Date().toISOString();
  const report = buildExactPitConfirmatoryReport({
    integrityReports,
    rollingSourceReceipts,
    campaignStatusRows: campaignStatusRead.rows,
    campaignStatusPostCutoffRowsExcluded:
      campaignStatusRead.postCutoffRowsExcluded,
    configReceipts,
    targetCandidates,
    baselineRows,
    rawEndpointInventory,
    startDate: args.startDate,
    endDate: args.endDate,
    cutoffTimeUtc: args.cutoffTimeUtc,
    businessId: args.businessId,
    providerAccountId: args.providerAccountId,
    generatedAt,
  });
  const repeated = buildExactPitConfirmatoryReport({
    integrityReports,
    rollingSourceReceipts,
    campaignStatusRows: campaignStatusRead.rows,
    campaignStatusPostCutoffRowsExcluded:
      campaignStatusRead.postCutoffRowsExcluded,
    configReceipts,
    targetCandidates,
    baselineRows,
    rawEndpointInventory,
    startDate: args.startDate,
    endDate: args.endDate,
    cutoffTimeUtc: args.cutoffTimeUtc,
    businessId: args.businessId,
    providerAccountId: args.providerAccountId,
    generatedAt,
  });
  if (report.reportHash !== repeated.reportHash) {
    throw new Error(
      "Exact-PIT transform is not deterministic; refusing to write artifacts.",
    );
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderMarkdown(report);
  if (args.jsonOut) {
    const path = resolve(args.jsonOut);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, json, "utf8");
  }
  if (args.markdownOut) {
    const path = resolve(args.markdownOut);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, markdown, "utf8");
  }
  if (!args.jsonOut && !args.markdownOut) process.stdout.write(json);
  else
    process.stdout.write(
      `${JSON.stringify({ reportHash: report.reportHash })}\n`,
    );
  return report;
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1] as string)).href === import.meta.url;

if (isMain) {
  runExactPitConfirmatoryCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  });
}
