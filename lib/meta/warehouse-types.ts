export type MetaSyncType =
  | "initial_backfill"
  | "incremental_recent"
  | "today_refresh"
  | "today_observe"
  | "finalize_day"
  | "finalize_range"
  | "repair_recent_day"
  | "repair_window"
  | "reconnect_backfill";

export type MetaSyncStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export type MetaSyncLane = "core" | "extended" | "maintenance";

export type MetaSyncPartitionSource =
  | "historical"
  | "historical_recovery"
  | "recent"
  | "recent_recovery"
  | "yesterday"
  | "today"
  | "today_observe"
  | "finalize_day"
  | "repair_recent_day"
  | "priority_window"
  | "request_runtime"
  | "initial_connect"
  | "core_success"
  | "manual_refresh";

export type MetaWarehouseTruthState =
  | "provisional"
  | "finalized"
  | "repair_pending"
  | "repair_failed";

export type MetaWarehouseValidationStatus =
  | "pending"
  | "passed"
  | "failed";

export type MetaPartitionStatus =
  | "queued"
  | "leased"
  | "running"
  | "succeeded"
  | "failed"
  | "dead_letter"
  | "cancelled";

export type MetaWarehouseDataState =
  | "not_connected"
  | "connected_no_assignment"
  | "syncing"
  | "partial"
  | "stale"
  | "paused"
  | "ready"
  | "action_required";

export type MetaRawSnapshotStatus = "fetched" | "partial" | "failed" | "superseded";

export type MetaWarehouseScope =
  | "account_daily"
  | "campaign_daily"
  | "adset_daily"
  | "ad_daily"
  | "creative_daily"
  | "breakdown_daily";

export type MetaAuthoritativeFinalizationState =
  | "live"
  | "pending_finalization"
  | "finalizing"
  | "finalized_verified"
  | "failed"
  | "repair_required"
  | "superseded";

export type MetaAuthoritativeSourceManifestStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "superseded";

export type MetaAuthoritativeSourceWindowKind =
  | "today"
  | "d_minus_1"
  | "recent_repair"
  | "historical";

export type MetaAuthoritativeSliceVersionStatus =
  | "staging"
  | "validated"
  | "published"
  | "failed"
  | "superseded";

export type MetaAuthoritativeReconciliationResult =
  | "passed"
  | "failed"
  | "repair_required"
  | "superseded";

export type MetaHistoricalVerificationState =
  | "processing"
  | "blocked"
  | "finalized_verified"
  | "failed"
  | "repair_required";

/**
 * The dimensions the breakdown warehouse can store, one identity per dimension.
 *
 * `gender` is additive and was the defect: Meta's `age,gender` breakdown is TWO
 * dimensions, and the write path folded both onto the single `age` identity, so
 * every gender row collapsed onto its age bucket and the split was unrecoverable
 * from the warehouse. Adding the type does not change what an `age` row means —
 * `age` keys are still the raw age bucket and read exactly as they always have.
 */
export type MetaBreakdownType = "age" | "gender" | "country" | "placement";

export type MetaDirtyRecentSeverity = "critical" | "high" | "low";

export type MetaDirtyRecentReason =
  | "non_finalized"
  | "validation_failed"
  | "spend_drift"
  | "tiny_stale_spend"
  | "missing_campaign"
  | "missing_adset"
  | "missing_breakdown";

export interface MetaDirtyRecentDateRow {
  providerAccountId: string;
  date: string;
  severity: MetaDirtyRecentSeverity;
  reasons: MetaDirtyRecentReason[];
  breakdownOnly?: boolean;
  nonFinalized?: boolean;
  validationFailed?: boolean;
  coverageMissing?: boolean;
  spendDrift?: boolean;
  tinyStaleSpend?: boolean;
}

export interface MetaRecentAuthoritativeSliceGuard {
  activeAuthoritativeSource: MetaSyncPartitionSource | null;
  activeAuthoritativePriority: number;
  lastSameSourceAttemptAt: string | null;
  lastSameSourceSuccessAt: string | null;
  repeatedFailures24h: number;
}

export interface MetaSelectedRangeTruthReadiness {
  truthReady: boolean;
  state: MetaHistoricalVerificationState;
  totalDays: number;
  completedCoreDays: number;
  blockingReasons: MetaDirtyRecentReason[];
  reasonCounts: Record<string, number>;
  detectorReasonCodes?: string[];
  sourceFetchedAt?: string | null;
  publishedAt?: string | null;
  verificationState?: MetaHistoricalVerificationState;
  asOf?: string | null;
}

/*
 * Lives in this leaf module, not beside the warehouse queries, because it is a
 * pure arithmetic law with no database in it and every layer that derives
 * frequency — ingestion, warehouse and serving — has to call the SAME one. A
 * home inside `warehouse.ts` put it behind that module's test doubles, where a
 * mock could satisfy the call and the law itself would go unexercised.
 */
/**
 * The ONE frequency law in the Meta warehouse: impressions per reached person.
 *
 * It already existed, twice, spelled the same way — the account rebuild in
 * `lib/meta/serving.ts` and the ad-set aggregation beside it both wrote
 * `reach > 0 ? r2(impressions / reach) : null`. Breakdown rows needed the same
 * derivation, and the wrong move would have been to write a third copy. This is
 * that expression, named, so the three call sites cannot drift.
 *
 * The `null` is the point. A reach of zero is not a divisor, and a reach that
 * was never MEASURED (`null`) is not a zero — either one yields "unknown", never
 * 0 and never Infinity. Callers must not substitute a fallback numerator
 * (impressions-as-reach makes frequency identically 1.0, which is a fabricated
 * measurement wearing a plausible value).
 */
export function deriveMetaFrequencyFromReach(input: {
  impressions: number;
  reach: number | null | undefined;
}): number | null {
  const reach = input.reach;
  if (reach == null || !Number.isFinite(reach) || reach <= 0) return null;
  if (!Number.isFinite(input.impressions)) return null;
  return Math.round((input.impressions / reach) * 100) / 100;
}

export interface MetaWarehouseMetricSet {
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  frequency: number | null;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number | null;
  ctr: number | null;
  cpc: number | null;
}

export interface MetaWarehouseBaseRow extends MetaWarehouseMetricSet {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  accountCurrency: string;
  sourceSnapshotId: string | null;
  metricSchemaVersion?: number;
  truthState?: MetaWarehouseTruthState;
  truthVersion?: number;
  finalizedAt?: string | null;
  validationStatus?: MetaWarehouseValidationStatus;
  sourceRunId?: string | null;
  /**
   * When the CONFIGURATION carried by this row was actually observed.
   *
   * Distinct from `date` (the metric day) and from `finalizedAt` (when the
   * metrics were sealed). Config history is keyed partly on captured_at, and the
   * old fallback of `${date}T00:00:00Z` was a synthetic midnight that had never
   * been an observation — it collapsed two genuine same-day observations into
   * one and backdated a 14:00 configuration to the start of the day. Rows
   * without a real observation time are excluded from config history rather
   * than given an invented one.
   */
  configObservedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MetaAccountDailyRow extends MetaWarehouseBaseRow {
  accountName: string | null;
}

export interface MetaCampaignDailyRow extends MetaWarehouseBaseRow {
  campaignId: string;
  campaignNameCurrent: string | null;
  campaignNameHistorical: string | null;
  campaignStatus: string | null;
  objective: string | null;
  buyingType: string | null;
  optimizationGoal: string | null;
  customEventType?: string | null;
  bidStrategyType: string | null;
  bidStrategyLabel: string | null;
  manualBidAmount: number | null;
  bidValue: number | null;
  bidValueFormat: "currency" | "roas" | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  isBudgetMixed: boolean;
  isConfigMixed: boolean;
  isOptimizationGoalMixed: boolean;
  isCustomEventTypeMixed?: boolean;
  isBidStrategyMixed: boolean;
  isBidValueMixed: boolean;
}

export interface MetaAdSetDailyRow extends MetaWarehouseBaseRow {
  campaignId: string | null;
  adsetId: string;
  adsetNameCurrent: string | null;
  adsetNameHistorical: string | null;
  adsetStatus: string | null;
  optimizationGoal: string | null;
  customEventType?: string | null;
  pixelId?: string | null;
  customConversionId?: string | null;
  promotedObjectJson?: unknown;
  bidStrategyType: string | null;
  bidStrategyLabel: string | null;
  manualBidAmount: number | null;
  bidValue: number | null;
  bidValueFormat: "currency" | "roas" | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  isBudgetMixed: boolean;
  isConfigMixed: boolean;
  isOptimizationGoalMixed: boolean;
  isBidStrategyMixed: boolean;
  isBidValueMixed: boolean;
}

export interface MetaAdDailyRow extends MetaWarehouseBaseRow {
  campaignId: string | null;
  adsetId: string | null;
  adId: string;
  adNameCurrent: string | null;
  adNameHistorical: string | null;
  adStatus: string | null;
  linkClicks?: number | null;
  outboundClicks?: number | null;
  landingPageViews?: number | null;
  addToCart?: number | null;
  initiateCheckout?: number | null;
  viewContent?: number | null;
  leads?: number | null;
  postEngagement?: number | null;
  thruplayActions?: number | null;
  videoViews3s?: number | null;
  destinationUrl?: string | null;
  destinationUrlRaw?: string | null;
  destinationUrlSource?: string | null;
  destinationUrlConfidence?: string | null;
  ctaType?: string | null;
  objectStoryId?: string | null;
  effectiveObjectStoryId?: string | null;
  payloadJson?: unknown;
}

export interface MetaCreativeDailyRow extends MetaWarehouseBaseRow {
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  creativeId: string;
  creativeName: string | null;
  headline: string | null;
  primaryText: string | null;
  descriptionText?: string | null;
  destinationUrl: string | null;
  destinationUrlRaw?: string | null;
  destinationUrlSource?: string | null;
  destinationUrlConfidence?: string | null;
  ctaType?: string | null;
  objectStoryId?: string | null;
  effectiveObjectStoryId?: string | null;
  thumbnailUrl: string | null;
  assetType: string | null;
  launchDate?: string | null;
  firstSeenAt?: string | null;
  firstSpendAt?: string | null;
  outboundClicks?: number | null;
  effectiveStatus?: string | null;
  objective?: string | null;
  attributionSetting?: string | null;
  qualityRanking?: string | null;
  engagementRateRanking?: string | null;
  conversionRateRanking?: string | null;
  bidStrategy?: string | null;
  optimizationGoal?: string | null;
  campaignDailyBudget?: number | null;
  adsetDailyBudget?: number | null;
  campaignLifetimeBudget?: number | null;
  adsetLifetimeBudget?: number | null;
  creativeDeliveryType?: string | null;
  creativeVisualFormat?: string | null;
  creativePrimaryType?: string | null;
  creativeSecondaryType?: string | null;
  imageHash?: string | null;
  linkClicks?: number | null;
  landingPageViews?: number | null;
  addToCart?: number | null;
  initiateCheckout?: number | null;
  payloadJson?: unknown;
}

export interface MetaCreativeMediaRow {
  businessId: string;
  providerAccountId: string;
  date: string;
  campaignId?: string | null;
  adsetId?: string | null;
  adId?: string | null;
  creativeId: string;
  previewUrl?: string | null;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  tableThumbnailUrl?: string | null;
  cardPreviewUrl?: string | null;
  videoUrl?: string | null;
  posterUrl?: string | null;
  previewHtml?: string | null;
  mediaCacheKey?: string | null;
  imageHash?: string | null;
  payloadJson?: unknown;
  sourceRunId?: string | null;
  /**
   * When the CONFIGURATION carried by this row was actually observed.
   *
   * Distinct from `date` (the metric day) and from `finalizedAt` (when the
   * metrics were sealed). Config history is keyed partly on captured_at, and the
   * old fallback of `${date}T00:00:00Z` was a synthetic midnight that had never
   * been an observation — it collapsed two genuine same-day observations into
   * one and backdated a 14:00 configuration to the start of the day. Rows
   * without a real observation time are excluded from config history rather
   * than given an invented one.
   */
  configObservedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MetaWarehouseIntegrityDelta {
  account?: number | null;
  campaign?: number | null;
  adset?: number | null;
  ad?: number | null;
  creative?: number | null;
}

export interface MetaWarehouseIntegrityIncident {
  businessId: string;
  providerAccountId: string;
  date: string;
  scope: "account_daily" | "campaign_daily" | "adset_daily" | "ad_daily" | "creative_daily" | "system";
  severity: "info" | "warning" | "error";
  metricsCompared: string[];
  delta: Record<string, MetaWarehouseIntegrityDelta>;
  provenanceState:
    | "authoritative"
    | "missing_source_run"
    | "mixed"
    | "legacy_schema"
    | "unverified";
  repairRecommended: boolean;
  repairStatus: "not_needed" | "queued" | "completed" | "pending";
  suspectedCause: string;
  details?: Record<string, unknown>;
}

export interface MetaSyncJobRecord {
  id?: string;
  businessId: string;
  providerAccountId: string;
  syncType: MetaSyncType;
  scope: MetaWarehouseScope;
  startDate: string;
  endDate: string;
  status: MetaSyncStatus;
  progressPercent: number;
  triggerSource: string;
  retryCount: number;
  lastError: string | null;
  triggeredAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string;
}

export interface MetaAuthoritativeSourceManifestRecord {
  id?: string;
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
  accountTimezone: string;
  sourceKind: string;
  sourceWindowKind: MetaAuthoritativeSourceWindowKind;
  runId?: string | null;
  fetchStatus: MetaAuthoritativeSourceManifestStatus;
  freshStartApplied?: boolean;
  checkpointResetApplied?: boolean;
  rawSnapshotWatermark?: string | null;
  sourceSpend?: number | null;
  validationBasisVersion?: string | null;
  metaJson?: Record<string, unknown>;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MetaAuthoritativeSliceVersionRecord {
  id?: string;
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
  manifestId?: string | null;
  candidateVersion: number;
  state: MetaAuthoritativeFinalizationState;
  truthState: MetaWarehouseTruthState;
  validationStatus: MetaWarehouseValidationStatus;
  status: MetaAuthoritativeSliceVersionStatus;
  stagedRowCount?: number | null;
  aggregatedSpend?: number | null;
  validationSummary?: Record<string, unknown>;
  sourceRunId?: string | null;
  stageStartedAt?: string | null;
  stageCompletedAt?: string | null;
  publishStartedAt?: string | null;
  publishedAt?: string | null;
  supersededAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MetaAuthoritativePublicationPointerRecord {
  id?: string;
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
  activeSliceVersionId: string;
  publishedByRunId?: string | null;
  publicationReason: string;
  publishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type MetaAuthoritativeDayStateStatus =
  | "pending"
  | "queued"
  | "running"
  | "published"
  | "repair_required"
  | "failed"
  | "blocked"
  | "not_applicable";

export interface MetaAuthoritativeDayStateRecord {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
  state: MetaAuthoritativeDayStateStatus;
  accountTimezone: string;
  activePartitionId?: string | null;
  lastRunId?: string | null;
  lastManifestId?: string | null;
  lastPublicationPointerId?: string | null;
  publishedAt?: string | null;
  retryAfterAt?: string | null;
  failureStreak?: number;
  diagnosisCode?: string | null;
  diagnosisDetailJson?: Record<string, unknown>;
  lastStartedAt?: string | null;
  lastFinishedAt?: string | null;
  lastAutohealAt?: string | null;
  autohealCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface MetaAuthoritativeDaySurfaceRequirement {
  surface: MetaWarehouseScope;
  state: MetaAuthoritativeDayStateStatus;
}

export interface MetaAuthoritativeReconciliationEventRecord {
  id?: string;
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
  sliceVersionId?: string | null;
  manifestId?: string | null;
  eventKind: string;
  severity: "info" | "warning" | "error";
  sourceSpend?: number | null;
  warehouseAccountSpend?: number | null;
  warehouseCampaignSpend?: number | null;
  toleranceApplied?: number | null;
  result: MetaAuthoritativeReconciliationResult;
  detailsJson?: Record<string, unknown>;
  createdAt?: string;
}

export interface MetaRawSnapshotRecord {
  id?: string;
  businessId: string;
  providerAccountId: string;
  endpointName: string;
  entityScope: string;
  partitionId?: string | null;
  checkpointId?: string | null;
  runId?: string | null;
  pageIndex?: number | null;
  providerCursor?: string | null;
  startDate: string;
  endDate: string;
  accountTimezone: string | null;
  accountCurrency: string | null;
  payloadJson: unknown;
  payloadHash: string;
  requestContext: Record<string, unknown>;
  responseHeaders?: Record<string, unknown>;
  providerHttpStatus: number | null;
  status: MetaRawSnapshotStatus;
  fetchedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type MetaSyncCheckpointPhase =
  | "fetch_raw"
  | "transform"
  | "bulk_upsert"
  | "finalize";

export type MetaSyncPhaseTimingPhase =
  | MetaSyncCheckpointPhase
  | "publish";

export type MetaSyncCheckpointStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface MetaSyncCheckpointRecord {
  id?: string;
  partitionId: string;
  businessId: string;
  providerAccountId: string;
  checkpointScope: string;
  runId?: string | null;
  phase: MetaSyncCheckpointPhase;
  status: MetaSyncCheckpointStatus;
  pageIndex: number;
  nextPageUrl?: string | null;
  providerCursor?: string | null;
  rowsFetched?: number;
  rowsWritten?: number;
  lastSuccessfulEntityKey?: string | null;
  lastResponseHeaders?: Record<string, unknown>;
  checkpointHash?: string | null;
  attemptCount: number;
  retryAfterAt?: string | null;
  leaseEpoch?: number | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MetaSyncPhaseTimingRecord {
  id?: string;
  partitionId: string;
  businessId: string;
  providerAccountId: string;
  timingScope: string;
  runId?: string | null;
  phase: MetaSyncPhaseTimingPhase;
  status: MetaSyncCheckpointStatus;
  rowsFetched?: number;
  rowsWritten?: number;
  attemptCount: number;
  leaseEpoch?: number | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MetaSyncPhaseTimingSummary {
  phase: MetaSyncPhaseTimingPhase;
  runCount: number;
  timingScope: string | null;
  latestFinishedAt: string | null;
  latestDurationMs: number | null;
  avgDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  maxDurationMs: number | null;
  throughputBasis: "rows_fetched" | "rows_written";
  latestRowsFetched: number;
  latestRowsWritten: number;
  latestRowsPerSecond: number | null;
  p50RowsPerSecond: number | null;
}

/**
 * `reach` is nullable HERE and nowhere else in the warehouse.
 *
 * `MetaWarehouseBaseRow.reach` is `number`, which can only say "zero people".
 * The breakdown fetch never asked Meta for `reach` at all, so every breakdown
 * row was written with a fabricated 0 — a number that looks measured and is
 * not. A reach Meta did not report is now `null`, and `frequency` derived from
 * a null or zero reach is `null` rather than 0 or Infinity. Widened with `Omit`
 * rather than by loosening the base row, because an account/campaign/adset
 * reach IS fetched and a null there would be a different, unproven claim.
 */
export interface MetaBreakdownDailyRow
  extends Omit<MetaWarehouseBaseRow, "reach"> {
  reach: number | null;
  breakdownType: MetaBreakdownType;
  breakdownKey: string;
  breakdownLabel: string;
}

export interface MetaSyncPartitionRecord {
  id?: string;
  businessId: string;
  providerAccountId: string;
  lane: MetaSyncLane;
  scope: MetaWarehouseScope;
  partitionDate: string;
  status: MetaPartitionStatus;
  priority: number;
  source: MetaSyncPartitionSource | string;
  leaseEpoch?: number | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  attemptCount: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string;
}

export interface MetaSyncRunRecord {
  id?: string;
  partitionId: string;
  businessId: string;
  providerAccountId: string;
  lane: MetaSyncLane;
  scope: MetaWarehouseScope;
  partitionDate: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  workerId?: string | null;
  attemptCount: number;
  rowCount?: number | null;
  durationMs?: number | null;
  errorClass?: string | null;
  errorMessage?: string | null;
  metaJson?: Record<string, unknown>;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MetaSyncStateRecord {
  businessId: string;
  providerAccountId: string;
  scope: MetaWarehouseScope;
  historicalTargetStart: string;
  historicalTargetEnd: string;
  effectiveTargetStart: string;
  effectiveTargetEnd: string;
  readyThroughDate?: string | null;
  lastSuccessfulPartitionDate?: string | null;
  latestBackgroundActivityAt?: string | null;
  latestSuccessfulSyncAt?: string | null;
  completedDays: number;
  deadLetterCount: number;
  updatedAt?: string;
}

export interface MetaWarehouseFreshness {
  dataState: MetaWarehouseDataState;
  lastSyncedAt: string | null;
  liveRefreshedAt: string | null;
  isPartial: boolean;
  missingWindows: string[];
  warnings: string[];
}

export interface MetaPublishedVerificationSummary {
  verificationState: MetaHistoricalVerificationState;
  truthReady: boolean;
  totalDays: number;
  completedCoreDays: number;
  sourceFetchedAt: string | null;
  publishedAt: string | null;
  asOf: string | null;
  publishedSlices: number;
  totalExpectedSlices: number;
  reasonCounts: Record<string, number>;
  publishedKeysBySurface: Partial<Record<MetaWarehouseScope, string[]>>;
}

export interface MetaAuthoritativeManifestCounts {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  superseded: number;
  total: number;
}

export interface MetaAuthoritativeProgressionSummary {
  queued: number;
  leased: number;
  published: number;
  retryableFailed: number;
  deadLetter: number;
  staleLeases: number;
  repairBacklog: number;
}

export interface MetaAuthoritativeLatestPublishRecord {
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
  stageStartedAt?: string | null;
  publishStartedAt?: string | null;
  publishedAt: string | null;
  verificationState: MetaHistoricalVerificationState;
  sourceKind: string | null;
  manifestFetchStatus: MetaAuthoritativeSourceManifestStatus | null;
}

export interface MetaAuthoritativeD1FinalizeSlaRecord {
  providerAccountId: string;
  accountTimezone: string;
  expectedDay: string;
  verificationState: MetaHistoricalVerificationState;
  publishedAt: string | null;
  breached: boolean;
}

export interface MetaAuthoritativeRecentFailureRecord {
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
  result: MetaAuthoritativeReconciliationResult;
  eventKind: string;
  severity: "info" | "warning" | "error";
  reason: string | null;
  createdAt: string;
}

export interface MetaAuthoritativeBusinessOpsSnapshot {
  businessId: string;
  capturedAt: string;
  manifestCounts: MetaAuthoritativeManifestCounts;
  progression: MetaAuthoritativeProgressionSummary;
  latestPublishes: MetaAuthoritativeLatestPublishRecord[];
  d1FinalizeSla: {
    totalAccounts: number;
    breachedAccounts: number;
    accounts: MetaAuthoritativeD1FinalizeSlaRecord[];
  };
  validationFailures24h: number;
  recentFailures: MetaAuthoritativeRecentFailureRecord[];
  lastSuccessfulPublishAt: string | null;
}

export interface MetaAuthoritativeDaySurfaceState {
  surface: MetaWarehouseScope;
  manifest: MetaAuthoritativeSourceManifestRecord | null;
  latestSlice?: MetaAuthoritativeSliceVersionRecord | null;
  publication:
    | {
        publication: MetaAuthoritativePublicationPointerRecord;
        sliceVersion: MetaAuthoritativeSliceVersionRecord;
      }
    | null;
  latestFailure?: MetaAuthoritativeRecentFailureRecord | null;
  plannerState?: MetaAuthoritativeDayStateRecord | null;
  detectorState?: MetaAuthoritativeDayStateStatus;
  detectorReasonCode?: string | null;
  contractMismatch?: boolean;
}

export interface MetaAuthoritativeDayVerification {
  businessId: string;
  providerAccountId: string;
  day: string;
  verificationState: MetaHistoricalVerificationState;
  sourceManifestState: MetaAuthoritativeSourceManifestStatus | "missing";
  validationState: MetaHistoricalVerificationState;
  activePublication: {
    publishStartedAt?: string | null;
    publishedAt: string | null;
    publicationReason: string | null;
    activeSliceVersionId: string | null;
  } | null;
  surfaces: MetaAuthoritativeDaySurfaceState[];
  lastFailure: MetaAuthoritativeRecentFailureRecord | null;
  detectorReasonCodes?: string[];
  repairBacklog: number;
  deadLetters: number;
  staleLeases: number;
  queuedPartitions: number;
  leasedPartitions: number;
}
