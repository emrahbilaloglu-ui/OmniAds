import { createHash } from "node:crypto";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { getCurrentSchedulingAttemptId } from "@/lib/sync/scheduling-attempt";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import { META_PRODUCT_CORE_COVERAGE_SCOPES } from "@/lib/meta/core-config";
import { getDb, getDbWithTimeout, runDbTransaction } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";
import { refreshOverviewSummaryMaterializationFromMetaAccountRows } from "@/lib/overview-summary-materializer";
import { logRuntimeInfo } from "@/lib/runtime-logging";
import { recordSyncReclaimEvents } from "@/lib/sync/worker-health";
import {
  classifyMetaSyncFailure,
  type MetaDeadLetterRecoveryKind,
} from "@/lib/sync/meta-error-classification";
import type {
  ProviderReclaimDecision,
  ProviderReclaimDisposition,
} from "@/lib/sync/provider-orchestration";
import type {
  MetaAuthoritativeBusinessOpsSnapshot,
  MetaAuthoritativeDayStateRecord,
  MetaAuthoritativeDayStateStatus,
  MetaAuthoritativeDaySurfaceRequirement,
  MetaAuthoritativeDayVerification,
  MetaAuthoritativeLatestPublishRecord,
  MetaAuthoritativeRecentFailureRecord,
  MetaAuthoritativePublicationPointerRecord,
  MetaAuthoritativeReconciliationEventRecord,
  MetaAuthoritativeSliceVersionRecord,
  MetaAuthoritativeSourceManifestRecord,
  MetaAccountDailyRow,
  MetaAdDailyRow,
  MetaAdSetDailyRow,
  MetaBreakdownDailyRow,
  MetaBreakdownType,
  MetaCampaignDailyRow,
  MetaCreativeDailyRow,
  MetaCreativeMediaRow,
  MetaDirtyRecentDateRow,
  MetaDirtyRecentReason,
  MetaDirtyRecentSeverity,
  MetaPartitionStatus,
  MetaRawSnapshotRecord,
  MetaRecentAuthoritativeSliceGuard,
  MetaSyncJobRecord,
  MetaSyncLane,
  MetaSyncType,
  MetaSyncCheckpointRecord,
  MetaSyncPhaseTimingRecord,
  MetaSyncPhaseTimingSummary,
  MetaSyncPartitionRecord,
  MetaSyncPhaseTimingPhase,
  MetaSyncPartitionSource,
  MetaSyncRunRecord,
  MetaSyncStateRecord,
  MetaWarehouseDataState,
  MetaWarehouseFreshness,
  MetaWarehouseIntegrityIncident,
  MetaWarehouseMetricSet,
  MetaPublishedVerificationSummary,
  MetaWarehouseScope,
} from "@/lib/meta/warehouse-types";
import {
  type MetaFinalizationCompletenessProof,
  assertMetaFinalizationCompletenessProof,
} from "@/lib/meta/finalization-proof";
import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";
import {
  deriveManualBidAmount,
  formatBidStrategyLabel,
  stripIncompleteConstrainedBidFields,
} from "@/lib/meta/configuration";

const META_SOURCE_PRIORITY_SQL = `
  CASE source
    WHEN 'finalize_day' THEN 725
    WHEN 'priority_window' THEN 700
    WHEN 'repair_recent_day' THEN 690
    WHEN 'today_observe' THEN 660
    WHEN 'yesterday' THEN 655
    WHEN 'today' THEN 650
    WHEN 'request_runtime' THEN 625
    WHEN 'recent' THEN 600
    WHEN 'recent_recovery' THEN 550
    WHEN 'manual_refresh' THEN 525
    WHEN 'core_success' THEN 500
    WHEN 'initial_connect' THEN 250
    WHEN 'historical_recovery' THEN 200
    WHEN 'historical' THEN 150
    ELSE 100
  END
`;

const META_MUTATION_TABLES = [
  "meta_authoritative_source_manifests",
  "meta_authoritative_slice_versions",
  "meta_authoritative_reconciliation_events",
  "meta_authoritative_day_state",
  "meta_sync_jobs",
  "meta_sync_partitions",
  "meta_sync_runs",
  "meta_sync_checkpoints",
  "meta_sync_phase_timings",
  "meta_sync_state",
  "meta_raw_snapshots",
  "meta_account_daily",
  "meta_campaign_daily",
  "meta_adset_daily",
  "meta_breakdown_daily",
  "meta_ad_daily",
  "meta_creative_daily",
  "meta_creative_media",
  "meta_campaign_dimensions",
  "meta_campaign_config_history",
  "meta_adset_dimensions",
  "meta_adset_config_history",
  "meta_ad_dimensions",
  "meta_creative_dimensions",
] as const;

function normalizeDate(value: unknown) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return text.slice(0, 10);
}

function canonicalizeMetaSyncJobType(syncType: MetaSyncType): Extract<
  MetaSyncType,
  "initial_backfill" | "incremental_recent" | "today_refresh" | "repair_window" | "reconnect_backfill"
> {
  switch (syncType) {
    case "today_observe":
      return "today_refresh";
    case "finalize_day":
    case "finalize_range":
    case "repair_recent_day":
      return "repair_window";
    default:
      return syncType;
  }
}

function normalizeTimestamp(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  return text;
}

function toNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: unknown) {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function payloadMetricNumber(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object") return null;
  return toNullableNumber((payload as Record<string, unknown>)[key]);
}

function payloadActionValueArrayNumber(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return null;
  let total = 0;
  let matched = false;
  for (const item of raw) {
    const value =
      item && typeof item === "object"
        ? toNullableNumber((item as { value?: unknown }).value)
        : toNullableNumber(item);
    if (value == null) continue;
    total += value;
    matched = true;
  }
  return matched ? total : null;
}

function payloadActionMetricNumber(payload: unknown, actionTypes: string[]) {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).actions;
  if (!Array.isArray(raw)) return null;
  const allowed = new Set(actionTypes.map((item) => item.toLowerCase()));
  let total = 0;
  let matched = false;
  for (const action of raw) {
    if (!action || typeof action !== "object") continue;
    const actionType = String((action as { action_type?: unknown }).action_type ?? "").toLowerCase();
    if (!allowed.has(actionType)) continue;
    const value = toNullableNumber((action as { value?: unknown }).value);
    if (value == null) continue;
    total += value;
    matched = true;
  }
  return matched ? total : null;
}

function payloadThruplayActions(payload: unknown) {
  const explicit = payloadMetricNumber(payload, "thruplay_actions");
  if (explicit != null) return explicit;
  const rawThruplayActions =
    payloadActionValueArrayNumber(payload, "video_thruplay_watched_actions") ??
    payloadMetricNumber(payload, "video_thruplay_watched_actions");
  if (rawThruplayActions != null) return rawThruplayActions;
  const explicitActionThruplay = payloadActionMetricNumber(payload, [
    "thruplay",
    "video_thruplay",
    "video_thruplay_watched",
    "video_thruplay_watched_actions",
    "onsite_conversion.video_thruplay_watched",
  ]);
  if (explicitActionThruplay != null) return explicitActionThruplay;
  return payloadActionMetricNumber(payload, ["video_view"]);
}

function payloadVideoViews3s(payload: unknown, impressions: number) {
  if (payload && typeof payload === "object") {
    const raw = (payload as Record<string, unknown>).video_play_actions;
    if (Array.isArray(raw)) {
      const first = raw[0];
      const parsed =
        first && typeof first === "object"
          ? toNullableNumber((first as { value?: unknown }).value)
          : toNullableNumber(first);
      if (parsed != null) return parsed;
    }
  }
  const rawVideoPlayActions = payloadMetricNumber(payload, "video_play_actions");
  if (rawVideoPlayActions != null) return rawVideoPlayActions;
  const rawActionsVideoViews = payloadActionMetricNumber(payload, ["video_view"]);
  if (rawActionsVideoViews != null) return rawActionsVideoViews;
  const thumbstop = payloadMetricNumber(payload, "thumbstop");
  if (thumbstop == null || impressions <= 0) return null;
  return Math.round((thumbstop / 100) * impressions);
}

const META_CREATIVE_MEDIA_PAYLOAD_KEYS = new Set([
  "preview_url",
  "thumbnail_url",
  "image_url",
  "table_thumbnail_url",
  "card_preview_url",
  "cached_thumbnail_url",
  "video_url",
  "poster_url",
  "preview",
  "preview_manifest",
  "debug_stage_raw_ad_creative_thumbnail_url",
  "debug_stage_enriched_ad_creative_thumbnail_url",
  "debug_raw_creative_thumbnail_url",
  "debug_enriched_creative_thumbnail_url",
  "debug_stage_final_thumbnail_url",
  "debug_stage_row_input_thumbnail_url",
]);

export function stripMetaCreativeMediaPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripMetaCreativeMediaPayload(item));
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (META_CREATIVE_MEDIA_PAYLOAD_KEYS.has(key)) continue;
    output[key] = stripMetaCreativeMediaPayload(nested);
  }
  return output;
}

function getTodayIsoForTimeZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function getMetaAccountTimeZone(
  accountTimeZoneById: Map<string, string>,
  providerAccountId: string,
) {
  return accountTimeZoneById.get(providerAccountId) ?? "UTC";
}

function isMetaCurrentAccountDay(input: {
  day: string;
  providerAccountId: string;
  accountTimeZoneById: Map<string, string>;
}) {
  return (
    normalizeDate(input.day) ===
    getTodayIsoForTimeZone(
      getMetaAccountTimeZone(
        input.accountTimeZoneById,
        input.providerAccountId,
      ),
    )
  );
}

function getMetaHistoricalDayAgeForAccountDay(input: {
  day: string;
  providerAccountId: string;
  accountTimeZoneById: Map<string, string>;
}) {
  const normalizedDay = normalizeDate(input.day);
  const today = getTodayIsoForTimeZone(
    getMetaAccountTimeZone(
      input.accountTimeZoneById,
      input.providerAccountId,
    ),
  );
  const historicalEnd = addIsoDays(today, -1);
  if (normalizedDay > historicalEnd) return 0;
  return Math.max(
    0,
    Math.floor(
      (new Date(`${historicalEnd}T00:00:00.000Z`).getTime() -
        new Date(`${normalizedDay}T00:00:00.000Z`).getTime()) /
        86_400_000,
    ),
  );
}

function getMetaApplicableVerificationSurfaces(input: {
  day: string;
  providerAccountId: string;
  accountTimeZoneById: Map<string, string>;
  requestedSurfaces: MetaWarehouseScope[];
}) {
  const requestedSurfaces = new Set(input.requestedSurfaces);
  return getMetaAuthoritativeRequiredSurfacesForDayAge(
    getMetaHistoricalDayAgeForAccountDay({
      day: input.day,
      providerAccountId: input.providerAccountId,
      accountTimeZoneById: input.accountTimeZoneById,
    }),
  )
    .filter(
      (requirement) =>
        requirement.state !== "not_applicable" &&
        requestedSurfaces.has(requirement.surface),
    )
    .map((requirement) => requirement.surface);
}

function addIsoDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function withinToleranceForDirtyDate(left: number, right: number) {
  const tolerance = Math.max(0.01, Math.abs(left) * 0.001);
  return Math.abs(left - right) <= tolerance;
}

function looksLikeTinyStaleSpend(left: number, right: number) {
  const accountSpend = Math.max(0, Math.abs(left));
  const campaignSpend = Math.max(0, Math.abs(right));
  if (accountSpend <= 0 || campaignSpend <= 0) return false;
  if (withinToleranceForDirtyDate(accountSpend, campaignSpend)) return false;
  const ratio = campaignSpend / Math.max(accountSpend, 0.01);
  const absoluteDelta = campaignSpend - accountSpend;
  return (
    ratio >= 5 &&
    accountSpend <= Math.max(5, campaignSpend * 0.2) &&
    absoluteDelta >= Math.max(1, campaignSpend * 0.25)
  );
}

function metaSourcePriority(source: string | null | undefined) {
  switch (String(source ?? "")) {
    case "finalize_day":
      return 725;
    case "priority_window":
      return 700;
    case "repair_recent_day":
      return 690;
    case "today_observe":
      return 660;
    default:
      return 0;
  }
}

function mergeDirtySeverity(
  left: MetaDirtyRecentSeverity,
  right: MetaDirtyRecentSeverity,
) {
  const priority: Record<MetaDirtyRecentSeverity, number> = {
    low: 1,
    high: 2,
    critical: 3,
  };
  return priority[right] > priority[left] ? right : left;
}

const META_EXPECTED_FINALIZED_BREAKDOWN_TYPES = [
  "age",
  "country",
  "placement",
] as const satisfies readonly MetaBreakdownType[];

const META_BREAKDOWN_CHECKPOINT_SCOPES = [
  "breakdown:age,gender",
  "breakdown:country",
  "breakdown:publisher_platform,platform_position,impression_device",
] as const;

const META_BREAKDOWN_ENDPOINT_COVERAGE_MAP = [
  {
    endpointName: "breakdown_age",
    breakdownType: "age",
    checkpointScope: "breakdown:age,gender",
  },
  {
    endpointName: "breakdown_country",
    breakdownType: "country",
    checkpointScope: "breakdown:country",
  },
  {
    endpointName: "breakdown_publisher_platform,platform_position,impression_device",
    breakdownType: "placement",
    checkpointScope: "breakdown:publisher_platform,platform_position,impression_device",
  },
] as const satisfies ReadonlyArray<{
  endpointName: string;
  breakdownType: MetaBreakdownType;
  checkpointScope: (typeof META_BREAKDOWN_CHECKPOINT_SCOPES)[number];
}>;

const META_BREAKDOWN_CHECKPOINT_SCOPE_TO_TYPE_SQL = `
  CASE checkpoint.checkpoint_scope
    WHEN 'breakdown:age,gender' THEN 'age'
    WHEN 'breakdown:country' THEN 'country'
    WHEN 'breakdown:publisher_platform,platform_position,impression_device' THEN 'placement'
    ELSE NULL
  END
`;

const META_AUTHORITATIVE_CORE_SCOPES = [
  "account_daily",
  "campaign_daily",
  "adset_daily",
] as const satisfies readonly MetaWarehouseScope[];

function deriveMetaDirtyRecentFlags(input: {
  reasons: MetaDirtyRecentReason[];
  severity: MetaDirtyRecentSeverity;
}) {
  const reasonSet = new Set(input.reasons);
  return {
    severity: input.severity,
    reasons: Array.from(reasonSet),
    breakdownOnly:
      reasonSet.size > 0 &&
      Array.from(reasonSet).every((reason) => reason === "missing_breakdown"),
    nonFinalized: reasonSet.has("non_finalized"),
    validationFailed: reasonSet.has("validation_failed"),
    coverageMissing:
      reasonSet.has("missing_campaign") ||
      reasonSet.has("missing_adset") ||
      reasonSet.has("missing_breakdown"),
    spendDrift:
      reasonSet.has("spend_drift") || reasonSet.has("tiny_stale_spend"),
    tinyStaleSpend: reasonSet.has("tiny_stale_spend"),
  };
}

async function runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return runDbTransaction(fn);
}

let cachedMetaTruthLifecycleColumnsAvailable: boolean | null = null;
let cachedMetaTruthLifecycleColumnsAvailablePromise: Promise<boolean> | null = null;

async function hasMetaTruthLifecycleColumns() {
  if (cachedMetaTruthLifecycleColumnsAvailable != null) {
    return cachedMetaTruthLifecycleColumnsAvailable;
  }
  if (cachedMetaTruthLifecycleColumnsAvailablePromise) {
    return cachedMetaTruthLifecycleColumnsAvailablePromise;
  }
  cachedMetaTruthLifecycleColumnsAvailablePromise = (async () => {
    try {
      const sql = getDb();
      const rows = await sql`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'meta_account_daily'
            AND column_name = 'truth_state'
        ) AS present
      ` as Array<{ present: boolean }>;
      const present = Boolean(rows[0]?.present);
      cachedMetaTruthLifecycleColumnsAvailable = present;
      return present;
    } catch {
      cachedMetaTruthLifecycleColumnsAvailable = false;
      return false;
    } finally {
      cachedMetaTruthLifecycleColumnsAvailablePromise = null;
    }
  })();
  return cachedMetaTruthLifecycleColumnsAvailablePromise;
}

async function assertMetaRequestReadTablesReady(
  tables: string[],
  context: string,
) {
  await assertDbSchemaReady({
    tables,
    context,
  });
}

async function assertMetaMutationTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: [...META_MUTATION_TABLES],
    context,
  });
}

function parseTimestampMs(value: unknown) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) return null;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function tallyDisposition(
  counts: Record<ProviderReclaimDisposition, number>,
  disposition: ProviderReclaimDisposition
) {
  counts[disposition] = (counts[disposition] ?? 0) + 1;
}

type MetaClosedCheckpointGroup = {
  checkpointScope: string;
  previousPhase: string;
  count: number;
};

type MetaRunObservabilityPath = "primary" | "backfill" | "repair";

export type MetaPartitionAttemptCompletionResult =
  | {
      ok: true;
      runUpdated: boolean;
      closedRunningRunCount: number;
      callerRunIdWasClosed: boolean | null;
      closedRunningRunIds: string[];
      closedCheckpointGroups: MetaClosedCheckpointGroup[];
      observedLatestRunningRunId: string | null;
      callerRunIdMatchedLatestRunningRunId: boolean | null;
    }
  | {
      ok: false;
      reason: "lease_conflict";
    };

export type MetaCompletionDenialClassification =
  | "owner_mismatch"
  | "epoch_mismatch"
  | "lease_expired"
  | "already_terminal"
  | "unknown_denial";

export interface MetaPartitionCompletionDenialSnapshot {
  currentPartitionStatus: string | null;
  currentLeaseOwner: string | null;
  currentLeaseEpoch: number | null;
  currentLeaseExpiresAt: string | null;
  ownerMatchesCaller: boolean | null;
  epochMatchesCaller: boolean | null;
  leaseExpiredAtObservation: boolean | null;
  currentPartitionFinishedAt: string | null;
  latestCheckpointScope: string | null;
  latestCheckpointPhase: string | null;
  latestCheckpointUpdatedAt: string | null;
  latestRunningRunId: string | null;
  runningRunCount: number;
  denialClassification: MetaCompletionDenialClassification;
}

const META_DAILY_COVERAGE_TABLE_BY_SCOPE: Partial<Record<MetaWarehouseScope, string>> = {
  account_daily: "meta_account_daily",
  campaign_daily: "meta_campaign_daily",
  adset_daily: "meta_adset_daily",
  ad_daily: "meta_ad_daily",
  creative_daily: "meta_creative_daily",
};

export interface MetaCleanupPreservedByReason {
  recentCheckpointProgress: number;
  matchingRunnerLeasePresent: number;
  leaseNotExpired: number;
}

export interface MetaCleanupSummary {
  candidateCount: number;
  stalePartitionCount: number;
  aliveSlowCount: number;
  reconciledRunCount: number;
  staleRunCount: number;
  staleLegacyCount: number;
  reclaimReasons: {
    stalledReclaimable: string[];
  };
  preservedByReason: MetaCleanupPreservedByReason;
}

type MetaReclaimCandidateRow = {
  id: string;
  lane: string;
  scope: string;
  updated_at: string | null;
  started_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  checkpoint_scope: string | null;
  phase: string | null;
  page_index: number | null;
  checkpoint_updated_at: string | null;
  has_matching_runner_lease: boolean;
};

function chunkRows<T>(rows: T[], size = 250) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function buildSqlValueTuple(
  offset: number,
  valueCount: number,
  casts: Record<number, string> = {},
) {
  const refs = Array.from({ length: valueCount }, (_, index) => {
    const position = index + 1;
    return `$${offset + position}${casts[position] ?? ""}`;
  });
  refs.push("now()");
  return `(${refs.join(",")})`;
}

async function resolveMetaChunkReferenceContext(
  rows: Array<{
    businessId: string;
    providerAccountId: string;
    accountName?: string | null;
    accountCurrency?: string | null;
    accountTimezone?: string | null;
  }>,
) {
  return {
    businessRefIds: await resolveBusinessReferenceIds(rows.map((row) => row.businessId)),
    providerAccountRefIds: await ensureProviderAccountReferenceIds({
      provider: "meta",
      accounts: rows.map((row) => ({
        externalAccountId: row.providerAccountId,
        accountName: row.accountName ?? null,
        currency: row.accountCurrency ?? null,
        timezone: row.accountTimezone ?? null,
      })),
    }),
  };
}

async function resolveMetaRecordReferenceContext(input: {
  businessId: string;
  providerAccountId: string;
  accountName?: string | null;
  accountCurrency?: string | null;
  accountTimezone?: string | null;
}) {
  const context = await resolveMetaChunkReferenceContext([input]);
  return {
    businessRefId: context.businessRefIds.get(input.businessId) ?? null,
    providerAccountRefId:
      context.providerAccountRefIds.get(input.providerAccountId) ?? null,
  };
}

function enumerateIsoDays(startDate: string, endDate: string) {
  const days: string[] = [];
  const start = new Date(`${normalizeDate(startDate)}T00:00:00Z`);
  const end = new Date(`${normalizeDate(endDate)}T00:00:00Z`);
  for (
    let cursor = new Date(start);
    cursor <= end;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

export function buildMetaAuthoritativePublicationLookup(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
}) {
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    day: normalizeDate(input.day),
    surface: input.surface,
  };
}

export function getMetaAuthoritativeRequiredSurfacesForDayAge(
  dayAge: number,
): MetaAuthoritativeDaySurfaceRequirement[] {
  if (!Number.isFinite(dayAge) || dayAge < 0) return [];
  if (dayAge > 761) return [];

  const baseSurfaces: MetaAuthoritativeDaySurfaceRequirement[] = [
    { surface: "account_daily", state: "pending" },
    { surface: "campaign_daily", state: "pending" },
    { surface: "adset_daily", state: "pending" },
    { surface: "ad_daily", state: "pending" },
  ];

  if (dayAge >= 394) {
    return [
      ...baseSurfaces,
      { surface: "breakdown_daily", state: "not_applicable" },
    ];
  }

  return [
    ...baseSurfaces,
    { surface: "breakdown_daily", state: "pending" },
  ];
}

export function buildMetaAuthoritativeDayStateLookup(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
}) {
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    day: normalizeDate(input.day),
    surface: input.surface,
  };
}

function mapMetaAuthoritativeDayStateRow(row: {
  business_id: string;
  provider_account_id: string;
  day: string;
  surface: MetaWarehouseScope;
  state: MetaAuthoritativeDayStateStatus;
  account_timezone: string;
  active_partition_id: string | null;
  last_run_id: string | null;
  last_manifest_id: string | null;
  last_publication_pointer_id: string | null;
  published_at: string | null;
  retry_after_at: string | null;
  failure_streak: number;
  diagnosis_code: string | null;
  diagnosis_detail_json: Record<string, unknown> | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_autoheal_at: string | null;
  autoheal_count: number;
  created_at: string;
  updated_at: string;
}): MetaAuthoritativeDayStateRecord {
  return {
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    day: normalizeDate(row.day),
    surface: row.surface,
    state: row.state,
    accountTimezone: row.account_timezone,
    activePartitionId: row.active_partition_id,
    lastRunId: row.last_run_id,
    lastManifestId: row.last_manifest_id,
    lastPublicationPointerId: row.last_publication_pointer_id,
    publishedAt: row.published_at,
    retryAfterAt: row.retry_after_at,
    failureStreak: toNumber(row.failure_streak),
    diagnosisCode: row.diagnosis_code,
    diagnosisDetailJson: row.diagnosis_detail_json ?? {},
    lastStartedAt: row.last_started_at,
    lastFinishedAt: row.last_finished_at,
    lastAutohealAt: row.last_autoheal_at,
    autohealCount: toNumber(row.autoheal_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertMetaAuthoritativeDayState(
  input: MetaAuthoritativeDayStateRecord,
) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    accountTimezone: input.accountTimezone,
  });
  const rows = await sql`
    INSERT INTO meta_authoritative_day_state (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      day,
      surface,
      state,
      account_timezone,
      active_partition_id,
      last_run_id,
      last_manifest_id,
      last_publication_pointer_id,
      published_at,
      retry_after_at,
      failure_streak,
      diagnosis_code,
      diagnosis_detail_json,
      last_started_at,
      last_finished_at,
      last_autoheal_at,
      autoheal_count,
      created_at,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${normalizeDate(input.day)},
      ${input.surface},
      ${input.state},
      ${input.accountTimezone},
      ${input.activePartitionId ?? null},
      ${input.lastRunId ?? null},
      ${input.lastManifestId ?? null},
      ${input.lastPublicationPointerId ?? null},
      ${input.publishedAt ?? null},
      ${input.retryAfterAt ?? null},
      ${Math.max(0, Math.trunc(input.failureStreak ?? 0))},
      ${input.diagnosisCode ?? null},
      ${JSON.stringify(input.diagnosisDetailJson ?? {})}::jsonb,
      ${input.lastStartedAt ?? null},
      ${input.lastFinishedAt ?? null},
      ${input.lastAutohealAt ?? null},
      ${Math.max(0, Math.trunc(input.autohealCount ?? 0))},
      COALESCE(${input.createdAt ?? null}, now()),
      COALESCE(${input.updatedAt ?? null}, now())
    )
    ON CONFLICT (business_id, provider_account_id, day, surface)
    DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_authoritative_day_state.business_ref_id),
      provider_account_ref_id = COALESCE(
        EXCLUDED.provider_account_ref_id,
        meta_authoritative_day_state.provider_account_ref_id
      ),
      state = EXCLUDED.state,
      account_timezone = EXCLUDED.account_timezone,
      active_partition_id = EXCLUDED.active_partition_id,
      last_run_id = EXCLUDED.last_run_id,
      last_manifest_id = EXCLUDED.last_manifest_id,
      last_publication_pointer_id = EXCLUDED.last_publication_pointer_id,
      published_at = EXCLUDED.published_at,
      retry_after_at = EXCLUDED.retry_after_at,
      failure_streak = EXCLUDED.failure_streak,
      diagnosis_code = EXCLUDED.diagnosis_code,
      diagnosis_detail_json = EXCLUDED.diagnosis_detail_json,
      last_started_at = EXCLUDED.last_started_at,
      last_finished_at = EXCLUDED.last_finished_at,
      last_autoheal_at = EXCLUDED.last_autoheal_at,
      autoheal_count = EXCLUDED.autoheal_count,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  ` as Array<{
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    state: MetaAuthoritativeDayStateStatus;
    account_timezone: string;
    active_partition_id: string | null;
    last_run_id: string | null;
    last_manifest_id: string | null;
    last_publication_pointer_id: string | null;
    published_at: string | null;
    retry_after_at: string | null;
    failure_streak: number;
    diagnosis_code: string | null;
    diagnosis_detail_json: Record<string, unknown> | null;
    last_started_at: string | null;
    last_finished_at: string | null;
    last_autoheal_at: string | null;
    autoheal_count: number;
    created_at: string;
    updated_at: string;
  }>;
  return rows[0] ? mapMetaAuthoritativeDayStateRow(rows[0]) : null;
}

export async function getMetaAuthoritativeDayState(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT *
    FROM meta_authoritative_day_state
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND day = ${normalizeDate(input.day)}
      AND surface = ${input.surface}
    LIMIT 1
  ` as Array<{
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    state: MetaAuthoritativeDayStateStatus;
    account_timezone: string;
    active_partition_id: string | null;
    last_run_id: string | null;
    last_manifest_id: string | null;
    last_publication_pointer_id: string | null;
    published_at: string | null;
    retry_after_at: string | null;
    failure_streak: number;
    diagnosis_code: string | null;
    diagnosis_detail_json: Record<string, unknown> | null;
    last_started_at: string | null;
    last_finished_at: string | null;
    last_autoheal_at: string | null;
    autoheal_count: number;
    created_at: string;
    updated_at: string;
}>;
  return rows[0] ? mapMetaAuthoritativeDayStateRow(rows[0]) : null;
}

export async function listMetaAuthoritativeDayStates(input: {
  businessId: string;
  providerAccountId: string;
  startDay: string;
  endDay: string;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT *
    FROM meta_authoritative_day_state
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND day >= ${normalizeDate(input.startDay)}
      AND day <= ${normalizeDate(input.endDay)}
    ORDER BY day DESC, surface ASC
  ` as Array<{
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    state: MetaAuthoritativeDayStateStatus;
    account_timezone: string;
    active_partition_id: string | null;
    last_run_id: string | null;
    last_manifest_id: string | null;
    last_publication_pointer_id: string | null;
    published_at: string | null;
    retry_after_at: string | null;
    failure_streak: number;
    diagnosis_code: string | null;
    diagnosis_detail_json: Record<string, unknown> | null;
    last_started_at: string | null;
    last_finished_at: string | null;
    last_autoheal_at: string | null;
    autoheal_count: number;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map(mapMetaAuthoritativeDayStateRow);
}

function hasMetaPublishedAuthoritativeSurface(input: {
  publication?:
    | {
        publication: MetaAuthoritativePublicationPointerRecord;
        sliceVersion: MetaAuthoritativeSliceVersionRecord;
      }
    | null;
}) {
  return Boolean(
    input.publication?.publication.activeSliceVersionId &&
      input.publication?.publication.publishedAt &&
      input.publication?.sliceVersion.status === "published" &&
      input.publication?.sliceVersion.validationStatus === "passed",
  );
}

function classifyMetaAuthoritativeSurfaceState(input: {
  manifestStatus?: MetaAuthoritativeSourceManifestRecord["fetchStatus"] | "missing" | null;
  latestFailureResult?: MetaAuthoritativeRecentFailureRecord["result"] | null;
  latestSliceState?: MetaAuthoritativeSliceVersionRecord["state"] | null;
  latestSliceStatus?: MetaAuthoritativeSliceVersionRecord["status"] | null;
  latestSliceValidationStatus?: MetaAuthoritativeSliceVersionRecord["validationStatus"] | null;
  plannerState?: MetaAuthoritativeDayStateStatus | null;
  plannerDiagnosisCode?: string | null;
  hasPublishedPublication?: boolean;
  publication:
    | {
        publication: MetaAuthoritativePublicationPointerRecord;
        sliceVersion: MetaAuthoritativeSliceVersionRecord;
      }
    | null;
  queuedPartitions?: number;
  leasedPartitions?: number;
  staleLeases?: number;
  repairBacklog?: number;
}) {
  const isPublished =
    input.hasPublishedPublication ??
    hasMetaPublishedAuthoritativeSurface({
      publication: input.publication,
    });
  if (isPublished) {
    return {
      state: "published" as const,
      diagnosisCode: null,
      contractMismatch: false,
    };
  }

  const queuedPartitions = Math.max(0, input.queuedPartitions ?? 0);
  const leasedPartitions = Math.max(0, input.leasedPartitions ?? 0);
  const staleLeases = Math.max(0, input.staleLeases ?? 0);
  const repairBacklog = Math.max(0, input.repairBacklog ?? 0);
  const hasRunningWork =
    input.manifestStatus === "running" || leasedPartitions > 0;
  const hasQueuedWork =
    input.manifestStatus === "pending" ||
    queuedPartitions > 0 ||
    repairBacklog > 0;
  const finalizeLikeWithoutPublication =
    input.manifestStatus === "completed" ||
    input.latestSliceState === "finalized_verified" ||
    input.latestSliceStatus === "published";

  if (input.plannerState === "published") {
    return {
      state: "blocked" as const,
      diagnosisCode: "planner_publication_mismatch",
      contractMismatch: true,
    };
  }

  if (input.plannerState === "blocked") {
    return {
      state: "blocked" as const,
      diagnosisCode:
        input.plannerDiagnosisCode ??
        (finalizeLikeWithoutPublication
          ? "publication_pointer_missing_after_finalize"
          : "authoritative_contract_mismatch"),
      contractMismatch: true,
    };
  }

  if (input.latestFailureResult === "repair_required") {
    return {
      state: "repair_required" as const,
      diagnosisCode: "authoritative_retry_required",
      contractMismatch: false,
    };
  }

  if (input.latestFailureResult === "failed") {
    return {
      state: "failed" as const,
      diagnosisCode: "authoritative_finalize_failed",
      contractMismatch: false,
    };
  }

  if (input.manifestStatus === "failed") {
    return {
      state: "failed" as const,
      diagnosisCode: "source_manifest_failed",
      contractMismatch: false,
    };
  }

  if (finalizeLikeWithoutPublication) {
    if (hasRunningWork) {
      return {
        state: "running" as const,
        diagnosisCode: "publication_pending_while_running",
        contractMismatch: false,
      };
    }
    if (hasQueuedWork) {
      return {
        state: "queued" as const,
        diagnosisCode: "publication_pending_while_queued",
        contractMismatch: false,
      };
    }
    if (staleLeases > 0) {
      return {
        state: "pending" as const,
        diagnosisCode: "stale_lease_pending_proof",
        contractMismatch: false,
      };
    }
    return {
      state: "blocked" as const,
      diagnosisCode:
        input.latestSliceStatus === "published" ||
        input.latestSliceState === "finalized_verified"
          ? "published_slice_pointer_missing"
          : "publication_pointer_missing_after_finalize",
      contractMismatch: true,
    };
  }

  if (hasRunningWork) {
    return {
      state: "running" as const,
      diagnosisCode: "authoritative_in_progress",
      contractMismatch: false,
    };
  }

  if (hasQueuedWork) {
    return {
      state: "queued" as const,
      diagnosisCode: "authoritative_retry_pending",
      contractMismatch: false,
    };
  }

  if (staleLeases > 0) {
    return {
      state: "pending" as const,
      diagnosisCode: "stale_lease_pending_proof",
      contractMismatch: false,
    };
  }

  return {
    state: "pending" as const,
    diagnosisCode:
      input.manifestStatus === "missing" ? "awaiting_authoritative_work" : null,
    contractMismatch: false,
  };
}

export async function reconcileMetaAuthoritativeDayStateFromVerification(input: {
  verification: MetaAuthoritativeDayVerification;
  accountTimezone?: string | null;
  activePartitionIdBySurface?: Partial<Record<MetaWarehouseScope, string | null>>;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const existingStates = await Promise.all(
    input.verification.surfaces.map((surfaceState) =>
      getMetaAuthoritativeDayState({
        businessId: input.verification.businessId,
        providerAccountId: input.verification.providerAccountId,
        day: input.verification.day,
        surface: surfaceState.surface,
      }),
    ),
  );
  const updates: MetaAuthoritativeDayStateRecord[] = [];

  for (const [index, surfaceState] of input.verification.surfaces.entries()) {
    const existing = existingStates[index] ?? null;
    const publication = surfaceState.publication?.publication ?? null;
    const lastFailure =
      surfaceState.latestFailure ??
      (input.verification.lastFailure?.surface === surfaceState.surface
        ? input.verification.lastFailure
        : null);
    const manifestStatus = surfaceState.manifest?.fetchStatus ?? "missing";
    const classification = classifyMetaAuthoritativeSurfaceState({
      manifestStatus,
      latestFailureResult: lastFailure?.result ?? null,
      latestSliceState: surfaceState.latestSlice?.state ?? null,
      latestSliceStatus: surfaceState.latestSlice?.status ?? null,
      latestSliceValidationStatus:
        surfaceState.latestSlice?.validationStatus ?? null,
      plannerState: surfaceState.plannerState?.state ?? existing?.state ?? null,
      plannerDiagnosisCode:
        surfaceState.plannerState?.diagnosisCode ??
        existing?.diagnosisCode ??
        null,
      publication: surfaceState.publication,
      queuedPartitions:
        input.verification.queuedPartitions +
        (input.activePartitionIdBySurface?.[surfaceState.surface] ? 1 : 0),
      leasedPartitions: input.verification.leasedPartitions,
      staleLeases: input.verification.staleLeases,
      repairBacklog: input.verification.repairBacklog,
    });
    const derivedState: MetaAuthoritativeDayStateStatus = classification.state;
    const terminalFailureState =
      derivedState === "failed" ||
      derivedState === "repair_required" ||
      derivedState === "blocked";

    updates.push({
      businessId: input.verification.businessId,
      providerAccountId: input.verification.providerAccountId,
      day: input.verification.day,
      surface: surfaceState.surface,
      state: derivedState,
      accountTimezone:
        surfaceState.manifest?.accountTimezone ??
        input.accountTimezone ??
        existing?.accountTimezone ??
        "UTC",
      activePartitionId:
        derivedState === "queued" || derivedState === "running"
          ? input.activePartitionIdBySurface?.[surfaceState.surface] ??
            existing?.activePartitionId ??
            null
          : null,
      lastRunId: surfaceState.manifest?.runId ?? existing?.lastRunId ?? null,
      lastManifestId: surfaceState.manifest?.id ?? existing?.lastManifestId ?? null,
      lastPublicationPointerId:
        publication?.id ?? existing?.lastPublicationPointerId ?? null,
      publishedAt: publication?.publishedAt ?? null,
      retryAfterAt:
        derivedState === "published"
          ? null
          : terminalFailureState
            ? surfaceState.manifest?.completedAt ?? existing?.retryAfterAt ?? null
            : existing?.retryAfterAt ?? null,
      failureStreak:
        derivedState === "published"
          ? 0
          : terminalFailureState
            ? Math.max(0, (existing?.failureStreak ?? 0) + 1)
            : existing?.failureStreak ?? 0,
      diagnosisCode:
        derivedState === "published"
          ? null
          : classification.diagnosisCode ??
            lastFailure?.reason ??
            manifestStatus ??
            input.verification.sourceManifestState,
      diagnosisDetailJson: {
        verificationState: input.verification.verificationState,
        validationState: input.verification.validationState,
        sourceManifestState: input.verification.sourceManifestState,
        surface: surfaceState.surface,
        plannerState: derivedState,
        manifestFetchStatus: manifestStatus,
        detectorReasonCode: classification.diagnosisCode,
        contractMismatch: classification.contractMismatch,
        publishedAt: publication?.publishedAt ?? null,
        publicationReason: publication?.publicationReason ?? null,
        activeSliceVersionId: publication?.activeSliceVersionId ?? null,
        latestSliceId: surfaceState.latestSlice?.id ?? null,
        latestSliceStatus: surfaceState.latestSlice?.status ?? null,
        latestSliceState: surfaceState.latestSlice?.state ?? null,
        latestSliceValidationStatus:
          surfaceState.latestSlice?.validationStatus ?? null,
      },
      lastStartedAt: surfaceState.manifest?.startedAt ?? existing?.lastStartedAt ?? null,
      lastFinishedAt: surfaceState.manifest?.completedAt ?? existing?.lastFinishedAt ?? null,
      lastAutohealAt: existing?.lastAutohealAt ?? null,
      autohealCount: existing?.autohealCount ?? 0,
    });
  }

  if (updates.length === 0) return [];
  const rows = await Promise.all(updates.map((row) => upsertMetaAuthoritativeDayState(row)));
  return rows.filter((row): row is MetaAuthoritativeDayStateRecord => Boolean(row));
}

function mapMetaAuthoritativeSourceManifestRow(row: {
  id: string;
  business_id: string;
  provider_account_id: string;
  day: string;
  surface: MetaWarehouseScope;
  account_timezone: string;
  source_kind: string;
  source_window_kind: MetaAuthoritativeSourceManifestRecord["sourceWindowKind"];
  run_id: string | null;
  fetch_status: MetaAuthoritativeSourceManifestRecord["fetchStatus"];
  fresh_start_applied: boolean;
  checkpoint_reset_applied: boolean;
  raw_snapshot_watermark: string | null;
  source_spend: number | null;
  validation_basis_version: string | null;
  meta_json: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}): MetaAuthoritativeSourceManifestRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    day: normalizeDate(row.day),
    surface: row.surface,
    accountTimezone: row.account_timezone,
    sourceKind: row.source_kind,
    sourceWindowKind: row.source_window_kind,
    runId: row.run_id,
    fetchStatus: row.fetch_status,
    freshStartApplied: Boolean(row.fresh_start_applied),
    checkpointResetApplied: Boolean(row.checkpoint_reset_applied),
    rawSnapshotWatermark: row.raw_snapshot_watermark,
    sourceSpend: row.source_spend == null ? null : Number(row.source_spend),
    validationBasisVersion: row.validation_basis_version,
    metaJson: row.meta_json ?? {},
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMetaAuthoritativeSliceVersionRow(row: {
  id: string;
  business_id: string;
  provider_account_id: string;
  day: string;
  surface: MetaWarehouseScope;
  manifest_id: string | null;
  candidate_version: number;
  state: MetaAuthoritativeSliceVersionRecord["state"];
  truth_state: MetaAuthoritativeSliceVersionRecord["truthState"];
  validation_status: MetaAuthoritativeSliceVersionRecord["validationStatus"];
  status: MetaAuthoritativeSliceVersionRecord["status"];
  staged_row_count: number | null;
  aggregated_spend: number | null;
  validation_summary: Record<string, unknown> | null;
  source_run_id: string | null;
  stage_started_at: string | null;
  stage_completed_at: string | null;
  publish_started_at?: string | null;
  published_at: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}): MetaAuthoritativeSliceVersionRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    day: normalizeDate(row.day),
    surface: row.surface,
    manifestId: row.manifest_id,
    candidateVersion: Number(row.candidate_version ?? 0),
    state: row.state,
    truthState: row.truth_state,
    validationStatus: row.validation_status,
    status: row.status,
    stagedRowCount: row.staged_row_count == null ? null : Number(row.staged_row_count),
    aggregatedSpend: row.aggregated_spend == null ? null : Number(row.aggregated_spend),
    validationSummary: row.validation_summary ?? {},
    sourceRunId: row.source_run_id,
    stageStartedAt: row.stage_started_at,
    stageCompletedAt: row.stage_completed_at,
    publishStartedAt: row.publish_started_at ?? null,
    publishedAt: row.published_at,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMetaAuthoritativePublicationPointerRow(row: {
  id: string;
  business_id: string;
  provider_account_id: string;
  day: string;
  surface: MetaWarehouseScope;
  active_slice_version_id: string;
  published_by_run_id: string | null;
  publication_reason: string;
  published_at: string;
  created_at: string;
  updated_at: string;
}): MetaAuthoritativePublicationPointerRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    day: normalizeDate(row.day),
    surface: row.surface,
    activeSliceVersionId: row.active_slice_version_id,
    publishedByRunId: row.published_by_run_id,
    publicationReason: row.publication_reason,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMetaAuthoritativeReconciliationEventRow(row: {
  id: string;
  business_id: string;
  provider_account_id: string;
  day: string;
  surface: MetaWarehouseScope;
  slice_version_id: string | null;
  manifest_id: string | null;
  event_kind: string;
  severity: MetaAuthoritativeReconciliationEventRecord["severity"];
  source_spend: number | null;
  warehouse_account_spend: number | null;
  warehouse_campaign_spend: number | null;
  tolerance_applied: number | null;
  result: MetaAuthoritativeReconciliationEventRecord["result"];
  details_json: Record<string, unknown> | null;
  created_at: string;
}): MetaAuthoritativeReconciliationEventRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    day: normalizeDate(row.day),
    surface: row.surface,
    sliceVersionId: row.slice_version_id,
    manifestId: row.manifest_id,
    eventKind: row.event_kind,
    severity: row.severity,
    sourceSpend: row.source_spend == null ? null : Number(row.source_spend),
    warehouseAccountSpend:
      row.warehouse_account_spend == null ? null : Number(row.warehouse_account_spend),
    warehouseCampaignSpend:
      row.warehouse_campaign_spend == null ? null : Number(row.warehouse_campaign_spend),
    toleranceApplied:
      row.tolerance_applied == null ? null : Number(row.tolerance_applied),
    result: row.result,
    detailsJson: row.details_json ?? {},
    createdAt: row.created_at,
  };
}

export function buildMetaRawSnapshotHash(input: {
  businessId: string;
  providerAccountId: string;
  endpointName: string;
  startDate: string;
  endDate: string;
  payload: unknown;
}) {
  return createHash("sha1")
    .update(
      JSON.stringify({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        endpointName: input.endpointName,
        startDate: normalizeDate(input.startDate),
        endDate: normalizeDate(input.endDate),
        payload: input.payload,
      })
    )
    .digest("hex");
}

export function emptyMetaWarehouseMetrics(): MetaWarehouseMetricSet {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    reach: 0,
    frequency: null,
    conversions: 0,
    revenue: 0,
    roas: 0,
    cpa: null,
    ctr: null,
    cpc: null,
  };
}

export async function createMetaAuthoritativeSourceManifest(
  input: MetaAuthoritativeSourceManifestRecord,
) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    accountTimezone: input.accountTimezone,
  });
  const rows = await sql`
    INSERT INTO meta_authoritative_source_manifests (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      day,
      surface,
      account_timezone,
      source_kind,
      source_window_kind,
      run_id,
      fetch_status,
      fresh_start_applied,
      checkpoint_reset_applied,
      raw_snapshot_watermark,
      source_spend,
      validation_basis_version,
      meta_json,
      started_at,
      completed_at,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${normalizeDate(input.day)},
      ${input.surface},
      ${input.accountTimezone},
      ${input.sourceKind},
      ${input.sourceWindowKind},
      ${input.runId ?? null},
      ${input.fetchStatus},
      ${input.freshStartApplied ?? false},
      ${input.checkpointResetApplied ?? false},
      ${input.rawSnapshotWatermark ?? null},
      ${input.sourceSpend ?? null},
      ${input.validationBasisVersion ?? null},
      ${JSON.stringify(input.metaJson ?? {})}::jsonb,
      ${input.startedAt ?? null},
      ${input.completedAt ?? null},
      now()
    )
    RETURNING *
  ` as Array<{
    id: string;
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    account_timezone: string;
    source_kind: string;
    source_window_kind: MetaAuthoritativeSourceManifestRecord["sourceWindowKind"];
    run_id: string | null;
    fetch_status: MetaAuthoritativeSourceManifestRecord["fetchStatus"];
    fresh_start_applied: boolean;
    checkpoint_reset_applied: boolean;
    raw_snapshot_watermark: string | null;
    source_spend: number | null;
    validation_basis_version: string | null;
    meta_json: Record<string, unknown> | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows[0] ? mapMetaAuthoritativeSourceManifestRow(rows[0]) : null;
}

export async function updateMetaAuthoritativeSourceManifest(input: {
  manifestId: string;
  fetchStatus?: MetaAuthoritativeSourceManifestRecord["fetchStatus"];
  rawSnapshotWatermark?: string | null;
  sourceSpend?: number | null;
  validationBasisVersion?: string | null;
  metaJson?: Record<string, unknown>;
  startedAt?: string | null;
  completedAt?: string | null;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const metaJsonPatch = input.metaJson == null ? null : JSON.stringify(input.metaJson);
  const rows = await sql`
    UPDATE meta_authoritative_source_manifests
    SET
      fetch_status = COALESCE(${input.fetchStatus ?? null}, fetch_status),
      raw_snapshot_watermark = COALESCE(${input.rawSnapshotWatermark ?? null}, raw_snapshot_watermark),
      source_spend = COALESCE(${input.sourceSpend ?? null}, source_spend),
      validation_basis_version = COALESCE(${input.validationBasisVersion ?? null}, validation_basis_version),
      meta_json = CASE
        WHEN ${metaJsonPatch}::jsonb IS NULL THEN meta_json
        ELSE COALESCE(meta_json, '{}'::jsonb) || ${metaJsonPatch}::jsonb
      END,
      started_at = COALESCE(${input.startedAt ?? null}, started_at),
      completed_at = COALESCE(${input.completedAt ?? null}, completed_at),
      updated_at = now()
    WHERE id = ${input.manifestId}
    RETURNING *
  ` as Array<{
    id: string;
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    account_timezone: string;
    source_kind: string;
    source_window_kind: MetaAuthoritativeSourceManifestRecord["sourceWindowKind"];
    run_id: string | null;
    fetch_status: MetaAuthoritativeSourceManifestRecord["fetchStatus"];
    fresh_start_applied: boolean;
    checkpoint_reset_applied: boolean;
    raw_snapshot_watermark: string | null;
    source_spend: number | null;
    validation_basis_version: string | null;
    meta_json: Record<string, unknown> | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows[0] ? mapMetaAuthoritativeSourceManifestRow(rows[0]) : null;
}

export async function getLatestMetaAuthoritativeSourceManifest(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT *
    FROM meta_authoritative_source_manifests
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND day = ${normalizeDate(input.day)}
      AND surface = ${input.surface}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  ` as Array<{
    id: string;
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    account_timezone: string;
    source_kind: string;
    source_window_kind: MetaAuthoritativeSourceManifestRecord["sourceWindowKind"];
    run_id: string | null;
    fetch_status: MetaAuthoritativeSourceManifestRecord["fetchStatus"];
    fresh_start_applied: boolean;
    checkpoint_reset_applied: boolean;
    raw_snapshot_watermark: string | null;
    source_spend: number | null;
    validation_basis_version: string | null;
    meta_json: Record<string, unknown> | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows[0] ? mapMetaAuthoritativeSourceManifestRow(rows[0]) : null;
}

export async function reserveNextMetaAuthoritativeCandidateVersion(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT COALESCE(MAX(candidate_version), 0) + 1 AS next_candidate_version
    FROM meta_authoritative_slice_versions
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND day = ${normalizeDate(input.day)}
      AND surface = ${input.surface}
  ` as Array<{ next_candidate_version: number }>;
  return Number(rows[0]?.next_candidate_version ?? 1);
}

const META_AUTHORITATIVE_CANDIDATE_CREATE_MAX_ATTEMPTS = 5;

function isPgUniqueViolation(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

function isMetaAuthoritativeSliceVersionConflict(error: unknown) {
  if (!isPgUniqueViolation(error)) return false;
  const constraint =
    "constraint" in (error as object)
      ? String((error as { constraint?: string }).constraint ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    constraint.includes("meta_authoritative_slice_vers") ||
    message.includes("meta_authoritative_slice_vers")
  );
}

async function getExistingMetaAuthoritativeSliceVersionForRun(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
  sourceRunId?: string | null;
}) {
  if (!input.sourceRunId) return null;
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT *
    FROM meta_authoritative_slice_versions
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND day = ${normalizeDate(input.day)}
      AND surface = ${input.surface}
      AND source_run_id = ${input.sourceRunId}
    ORDER BY candidate_version DESC, created_at DESC
    LIMIT 1
  ` as Array<{
    id: string;
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    manifest_id: string | null;
    candidate_version: number;
    state: MetaAuthoritativeSliceVersionRecord["state"];
    truth_state: MetaAuthoritativeSliceVersionRecord["truthState"];
    validation_status: MetaAuthoritativeSliceVersionRecord["validationStatus"];
    status: MetaAuthoritativeSliceVersionRecord["status"];
    staged_row_count: number | null;
    aggregated_spend: number | null;
    validation_summary: Record<string, unknown> | null;
    source_run_id: string | null;
    stage_started_at: string | null;
    stage_completed_at: string | null;
    publish_started_at: string | null;
    published_at: string | null;
    superseded_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows[0] ? mapMetaAuthoritativeSliceVersionRow(rows[0]) : null;
}

export async function createMetaAuthoritativeSliceVersion(
  input: Omit<MetaAuthoritativeSliceVersionRecord, "candidateVersion"> & {
    candidateVersion?: number;
  },
) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const existingForRun = await getExistingMetaAuthoritativeSliceVersionForRun(input);
  if (existingForRun) return existingForRun;
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });

  let lastError: unknown = null;
  for (
    let attempt = 1;
    attempt <= META_AUTHORITATIVE_CANDIDATE_CREATE_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const candidateVersion =
      input.candidateVersion ??
      (await reserveNextMetaAuthoritativeCandidateVersion({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        day: input.day,
        surface: input.surface,
      }));
    try {
      const rows = await sql`
        INSERT INTO meta_authoritative_slice_versions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          day,
          surface,
          manifest_id,
          candidate_version,
          state,
          truth_state,
          validation_status,
          status,
          staged_row_count,
          aggregated_spend,
          validation_summary,
          source_run_id,
          stage_started_at,
          stage_completed_at,
          publish_started_at,
          published_at,
          superseded_at,
          updated_at
        )
        VALUES (
          ${input.businessId},
          ${refs.businessRefId},
          ${input.providerAccountId},
          ${refs.providerAccountRefId},
          ${normalizeDate(input.day)},
          ${input.surface},
          ${input.manifestId ?? null},
          ${candidateVersion},
          ${input.state},
          ${input.truthState},
          ${input.validationStatus},
          ${input.status},
          ${input.stagedRowCount ?? null},
          ${input.aggregatedSpend ?? null},
          ${JSON.stringify(input.validationSummary ?? {})}::jsonb,
          ${input.sourceRunId ?? null},
          ${input.stageStartedAt ?? null},
          ${input.stageCompletedAt ?? null},
          ${input.publishStartedAt ?? null},
          ${input.publishedAt ?? null},
          ${input.supersededAt ?? null},
          now()
        )
        RETURNING *
      ` as Array<{
        id: string;
        business_id: string;
        provider_account_id: string;
        day: string;
        surface: MetaWarehouseScope;
        manifest_id: string | null;
        candidate_version: number;
        state: MetaAuthoritativeSliceVersionRecord["state"];
        truth_state: MetaAuthoritativeSliceVersionRecord["truthState"];
        validation_status: MetaAuthoritativeSliceVersionRecord["validationStatus"];
        status: MetaAuthoritativeSliceVersionRecord["status"];
        staged_row_count: number | null;
        aggregated_spend: number | null;
        validation_summary: Record<string, unknown> | null;
        source_run_id: string | null;
        stage_started_at: string | null;
        stage_completed_at: string | null;
        publish_started_at: string | null;
        published_at: string | null;
        superseded_at: string | null;
        created_at: string;
        updated_at: string;
      }>;
      return rows[0] ? mapMetaAuthoritativeSliceVersionRow(rows[0]) : null;
    } catch (error) {
      if (!isMetaAuthoritativeSliceVersionConflict(error)) {
        throw error;
      }
      lastError = error;
      const existingAfterConflict =
        await getExistingMetaAuthoritativeSliceVersionForRun(input);
      if (existingAfterConflict) return existingAfterConflict;
      if (input.candidateVersion != null) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        "Failed to create Meta authoritative slice version after retrying unique conflicts.",
      );
}

export async function updateMetaAuthoritativeSliceVersion(input: {
  sliceVersionId: string;
  state?: MetaAuthoritativeSliceVersionRecord["state"];
  truthState?: MetaAuthoritativeSliceVersionRecord["truthState"];
  validationStatus?: MetaAuthoritativeSliceVersionRecord["validationStatus"];
  status?: MetaAuthoritativeSliceVersionRecord["status"];
  stagedRowCount?: number | null;
  aggregatedSpend?: number | null;
  validationSummary?: Record<string, unknown>;
  sourceRunId?: string | null;
  stageStartedAt?: string | null;
  stageCompletedAt?: string | null;
  publishStartedAt?: string | null;
  publishedAt?: string | null;
  supersededAt?: string | null;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const validationSummaryPatch =
    input.validationSummary == null ? null : JSON.stringify(input.validationSummary);
  const rows = await sql`
    UPDATE meta_authoritative_slice_versions
    SET
      state = COALESCE(${input.state ?? null}, state),
      truth_state = COALESCE(${input.truthState ?? null}, truth_state),
      validation_status = COALESCE(${input.validationStatus ?? null}, validation_status),
      status = COALESCE(${input.status ?? null}, status),
      staged_row_count = COALESCE(${input.stagedRowCount ?? null}, staged_row_count),
      aggregated_spend = COALESCE(${input.aggregatedSpend ?? null}, aggregated_spend),
      validation_summary = CASE
        WHEN ${validationSummaryPatch}::jsonb IS NULL THEN validation_summary
        ELSE COALESCE(validation_summary, '{}'::jsonb) || ${validationSummaryPatch}::jsonb
      END,
      source_run_id = COALESCE(${input.sourceRunId ?? null}, source_run_id),
      stage_started_at = COALESCE(${input.stageStartedAt ?? null}, stage_started_at),
      stage_completed_at = COALESCE(${input.stageCompletedAt ?? null}, stage_completed_at),
      publish_started_at = COALESCE(${input.publishStartedAt ?? null}, publish_started_at),
      published_at = COALESCE(${input.publishedAt ?? null}, published_at),
      superseded_at = COALESCE(${input.supersededAt ?? null}, superseded_at),
      updated_at = now()
    WHERE id = ${input.sliceVersionId}
    RETURNING *
  ` as Array<{
    id: string;
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    manifest_id: string | null;
    candidate_version: number;
    state: MetaAuthoritativeSliceVersionRecord["state"];
    truth_state: MetaAuthoritativeSliceVersionRecord["truthState"];
    validation_status: MetaAuthoritativeSliceVersionRecord["validationStatus"];
    status: MetaAuthoritativeSliceVersionRecord["status"];
    staged_row_count: number | null;
    aggregated_spend: number | null;
    validation_summary: Record<string, unknown> | null;
    source_run_id: string | null;
    stage_started_at: string | null;
    stage_completed_at: string | null;
    publish_started_at: string | null;
    published_at: string | null;
    superseded_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows[0] ? mapMetaAuthoritativeSliceVersionRow(rows[0]) : null;
}

export async function getLatestMetaAuthoritativeSliceVersion(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT *
    FROM meta_authoritative_slice_versions
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND day = ${normalizeDate(input.day)}
      AND surface = ${input.surface}
    ORDER BY candidate_version DESC, created_at DESC
    LIMIT 1
  ` as Array<{
    id: string;
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    manifest_id: string | null;
    candidate_version: number;
    state: MetaAuthoritativeSliceVersionRecord["state"];
    truth_state: MetaAuthoritativeSliceVersionRecord["truthState"];
    validation_status: MetaAuthoritativeSliceVersionRecord["validationStatus"];
    status: MetaAuthoritativeSliceVersionRecord["status"];
    staged_row_count: number | null;
    aggregated_spend: number | null;
    validation_summary: Record<string, unknown> | null;
    source_run_id: string | null;
    stage_started_at: string | null;
    stage_completed_at: string | null;
    publish_started_at: string | null;
    published_at: string | null;
    superseded_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows[0] ? mapMetaAuthoritativeSliceVersionRow(rows[0]) : null;
}

export async function supersedeMetaAuthoritativeSliceVersions(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
  excludeSliceVersionId?: string | null;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const rows = await sql`
    UPDATE meta_authoritative_slice_versions
    SET
      business_ref_id = COALESCE(business_ref_id, ${refs.businessRefId}),
      provider_account_ref_id = COALESCE(
        provider_account_ref_id,
        ${refs.providerAccountRefId}
      ),
      state = 'superseded',
      status = 'superseded',
      superseded_at = COALESCE(superseded_at, now()),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND day = ${normalizeDate(input.day)}
      AND surface = ${input.surface}
      AND (${input.excludeSliceVersionId ?? null}::uuid IS NULL OR id <> ${input.excludeSliceVersionId ?? null}::uuid)
      AND status <> 'superseded'
    RETURNING *
  ` as Array<{
    id: string;
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    manifest_id: string | null;
    candidate_version: number;
    state: MetaAuthoritativeSliceVersionRecord["state"];
    truth_state: MetaAuthoritativeSliceVersionRecord["truthState"];
    validation_status: MetaAuthoritativeSliceVersionRecord["validationStatus"];
    status: MetaAuthoritativeSliceVersionRecord["status"];
    staged_row_count: number | null;
    aggregated_spend: number | null;
    validation_summary: Record<string, unknown> | null;
    source_run_id: string | null;
    stage_started_at: string | null;
    stage_completed_at: string | null;
    publish_started_at: string | null;
    published_at: string | null;
    superseded_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map(mapMetaAuthoritativeSliceVersionRow);
}

export async function publishMetaAuthoritativeSliceVersion(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
  sliceVersionId: string;
  publishedByRunId?: string | null;
  publicationReason: string;
  publishStartedAt?: string | null;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  return runInTransaction(async () => {
    await sql`
      UPDATE meta_authoritative_slice_versions
      SET
        state = 'superseded',
        status = 'superseded',
        superseded_at = COALESCE(superseded_at, now()),
        updated_at = now()
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND day = ${normalizeDate(input.day)}
        AND surface = ${input.surface}
        AND id <> ${input.sliceVersionId}::uuid
        AND status = 'published'
    `;

    await sql`
      UPDATE meta_authoritative_slice_versions
      SET
        state = CASE
          WHEN COALESCE(truth_state, 'finalized') = 'finalized'
            THEN 'finalized_verified'
          ELSE 'live'
        END,
        truth_state = COALESCE(truth_state, 'finalized'),
        validation_status = CASE
          WHEN COALESCE(truth_state, 'finalized') = 'finalized'
            THEN 'passed'
          ELSE COALESCE(validation_status, 'pending')
        END,
        status = 'published',
        publish_started_at = COALESCE(${input.publishStartedAt ?? null}, publish_started_at, now()),
        published_at = now(),
        updated_at = now()
      WHERE id = ${input.sliceVersionId}::uuid
    `;

    const rows = await sql`
      INSERT INTO meta_authoritative_publication_pointers (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        day,
        surface,
        active_slice_version_id,
        published_by_run_id,
        publication_reason,
        published_at,
        updated_at
      )
      VALUES (
        ${input.businessId},
        ${refs.businessRefId},
        ${input.providerAccountId},
        ${refs.providerAccountRefId},
        ${normalizeDate(input.day)},
        ${input.surface},
        ${input.sliceVersionId}::uuid,
        ${input.publishedByRunId ?? null},
        ${input.publicationReason},
        now(),
        now()
      )
      ON CONFLICT (business_id, provider_account_id, day, surface)
      DO UPDATE SET
        business_ref_id = COALESCE(
          EXCLUDED.business_ref_id,
          meta_authoritative_publication_pointers.business_ref_id
        ),
        provider_account_ref_id = COALESCE(
          EXCLUDED.provider_account_ref_id,
          meta_authoritative_publication_pointers.provider_account_ref_id
        ),
        active_slice_version_id = EXCLUDED.active_slice_version_id,
        published_by_run_id = EXCLUDED.published_by_run_id,
        publication_reason = EXCLUDED.publication_reason,
        published_at = now(),
        updated_at = now()
      RETURNING *
    ` as unknown as Array<{
      id: string;
      business_id: string;
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      active_slice_version_id: string;
      published_by_run_id: string | null;
      publication_reason: string;
      published_at: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows[0] ? mapMetaAuthoritativePublicationPointerRow(rows[0]) : null;
  });
}

export async function getMetaActivePublishedSliceVersion(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  surface: MetaWarehouseScope;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT
      pointer.*,
      slice.candidate_version,
      slice.state,
      slice.truth_state,
      slice.validation_status,
      slice.status,
      slice.manifest_id,
      slice.staged_row_count,
      slice.aggregated_spend,
      slice.validation_summary,
      slice.source_run_id,
      slice.stage_started_at,
      slice.stage_completed_at,
      slice.publish_started_at,
      slice.superseded_at,
      slice.created_at AS slice_created_at,
      slice.updated_at AS slice_updated_at
    FROM meta_authoritative_publication_pointers pointer
    INNER JOIN meta_authoritative_slice_versions slice
      ON slice.id = pointer.active_slice_version_id
    WHERE pointer.business_id = ${input.businessId}
      AND pointer.provider_account_id = ${input.providerAccountId}
      AND pointer.day = ${normalizeDate(input.day)}
      AND pointer.surface = ${input.surface}
    LIMIT 1
  ` as Array<{
    id: string;
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    active_slice_version_id: string;
    published_by_run_id: string | null;
    publication_reason: string;
    published_at: string;
    created_at: string;
    updated_at: string;
    candidate_version: number;
    state: MetaAuthoritativeSliceVersionRecord["state"];
    truth_state: MetaAuthoritativeSliceVersionRecord["truthState"];
    validation_status: MetaAuthoritativeSliceVersionRecord["validationStatus"];
    status: MetaAuthoritativeSliceVersionRecord["status"];
    manifest_id: string | null;
    staged_row_count: number | null;
    aggregated_spend: number | null;
    validation_summary: Record<string, unknown> | null;
    source_run_id: string | null;
    stage_started_at: string | null;
    stage_completed_at: string | null;
    publish_started_at: string | null;
    superseded_at: string | null;
    slice_created_at: string;
    slice_updated_at: string;
  }>;
  if (!rows[0]) return null;
  return {
    publication: mapMetaAuthoritativePublicationPointerRow(rows[0]),
    sliceVersion: mapMetaAuthoritativeSliceVersionRow({
      id: rows[0].active_slice_version_id,
      business_id: rows[0].business_id,
      provider_account_id: rows[0].provider_account_id,
      day: rows[0].day,
      surface: rows[0].surface,
      manifest_id: rows[0].manifest_id,
      candidate_version: rows[0].candidate_version,
      state: rows[0].state,
      truth_state: rows[0].truth_state,
      validation_status: rows[0].validation_status,
      status: rows[0].status,
      staged_row_count: rows[0].staged_row_count,
      aggregated_spend: rows[0].aggregated_spend,
      validation_summary: rows[0].validation_summary,
      source_run_id: rows[0].source_run_id,
      stage_started_at: rows[0].stage_started_at,
      stage_completed_at: rows[0].stage_completed_at,
      publish_started_at: rows[0].publish_started_at,
      published_at: rows[0].published_at,
      superseded_at: rows[0].superseded_at,
      created_at: rows[0].slice_created_at,
      updated_at: rows[0].slice_updated_at,
    }),
  };
}

export async function createMetaAuthoritativeReconciliationEvent(
  input: MetaAuthoritativeReconciliationEventRecord,
) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const rows = await sql`
    INSERT INTO meta_authoritative_reconciliation_events (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      day,
      surface,
      slice_version_id,
      manifest_id,
      event_kind,
      severity,
      source_spend,
      warehouse_account_spend,
      warehouse_campaign_spend,
      tolerance_applied,
      result,
      details_json
    )
    VALUES (
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${normalizeDate(input.day)},
      ${input.surface},
      ${input.sliceVersionId ?? null}::uuid,
      ${input.manifestId ?? null}::uuid,
      ${input.eventKind},
      ${input.severity},
      ${input.sourceSpend ?? null},
      ${input.warehouseAccountSpend ?? null},
      ${input.warehouseCampaignSpend ?? null},
      ${input.toleranceApplied ?? null},
      ${input.result},
      ${JSON.stringify(input.detailsJson ?? {})}::jsonb
    )
    RETURNING *
  ` as Array<{
    id: string;
    business_id: string;
    provider_account_id: string;
    day: string;
    surface: MetaWarehouseScope;
    slice_version_id: string | null;
    manifest_id: string | null;
    event_kind: string;
    severity: MetaAuthoritativeReconciliationEventRecord["severity"];
    source_spend: number | null;
    warehouse_account_spend: number | null;
    warehouse_campaign_spend: number | null;
    tolerance_applied: number | null;
    result: MetaAuthoritativeReconciliationEventRecord["result"];
    details_json: Record<string, unknown> | null;
    created_at: string;
  }>;
  return rows[0] ? mapMetaAuthoritativeReconciliationEventRow(rows[0]) : null;
}

export async function getMetaPublishedVerificationSummary(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds: string[];
  surfaces: MetaWarehouseScope[];
  timeoutMs?: number;
}): Promise<MetaPublishedVerificationSummary> {
  const providerAccountIds = Array.from(new Set(input.providerAccountIds.filter(Boolean)));
  const surfaces = Array.from(new Set(input.surfaces));
  const totalDays = enumerateIsoDays(input.startDate, input.endDate).length;
  if (providerAccountIds.length === 0 || surfaces.length === 0 || totalDays === 0) {
    return {
      verificationState: "processing",
      truthReady: false,
      totalDays,
      completedCoreDays: 0,
      sourceFetchedAt: null,
      publishedAt: null,
      asOf: null,
      publishedSlices: 0,
      totalExpectedSlices: 0,
      reasonCounts: {},
      publishedKeysBySurface: {},
    };
  }

  await assertMetaRequestReadTablesReady(
    [
      "meta_authoritative_slice_versions",
      "meta_authoritative_source_manifests",
      "meta_authoritative_reconciliation_events",
      "meta_authoritative_day_state",
      "meta_authoritative_publication_pointers",
      "meta_sync_partitions",
    ],
    "meta_published_verification_summary",
  );
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const [
    latestSliceRows,
    latestManifestRows,
    latestFailureRows,
    latestPlannerRows,
    partitionRows,
    accountTimezoneRows,
  ] = await Promise.all([
    sql`
      WITH latest_slice AS (
        SELECT *
        FROM (
          SELECT
            slice.*,
            ROW_NUMBER() OVER (
              PARTITION BY slice.business_id, slice.provider_account_id, slice.day, slice.surface
              ORDER BY slice.candidate_version DESC, slice.created_at DESC, slice.id DESC
            ) AS row_num
          FROM meta_authoritative_slice_versions slice
          WHERE slice.business_id = ${input.businessId}
            AND slice.provider_account_id = ANY(${providerAccountIds}::text[])
            AND slice.day >= ${normalizeDate(input.startDate)}
            AND slice.day <= ${normalizeDate(input.endDate)}
            AND slice.surface = ANY(${surfaces}::text[])
        ) ranked
        WHERE row_num = 1
      )
      SELECT
        latest_slice.business_id,
        latest_slice.provider_account_id,
        latest_slice.day,
        latest_slice.surface,
        latest_slice.id AS latest_slice_id,
        latest_slice.state AS latest_state,
        latest_slice.status AS latest_status,
        latest_slice.validation_status AS latest_validation_status,
        latest_slice.published_at AS latest_slice_published_at,
        pointer.active_slice_version_id,
        pointer.published_at,
        published_slice.state AS published_state,
        published_slice.status AS published_status
      FROM latest_slice
      LEFT JOIN meta_authoritative_publication_pointers pointer
        ON pointer.business_id = latest_slice.business_id
        AND pointer.provider_account_id = latest_slice.provider_account_id
        AND pointer.day = latest_slice.day
        AND pointer.surface = latest_slice.surface
      LEFT JOIN meta_authoritative_slice_versions published_slice
        ON published_slice.id = pointer.active_slice_version_id
    ` as unknown as Array<{
      business_id: string;
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      latest_slice_id: string | null;
      latest_state: string | null;
      latest_status: string | null;
      latest_validation_status: string | null;
      latest_slice_published_at: string | null;
      active_slice_version_id: string | null;
      published_at: string | null;
      published_state: string | null;
      published_status: string | null;
    }>,
    sql`
      WITH latest_manifests AS (
        SELECT *
        FROM (
          SELECT
            manifest.*,
            ROW_NUMBER() OVER (
              PARTITION BY manifest.business_id, manifest.provider_account_id, manifest.day, manifest.surface
              ORDER BY manifest.updated_at DESC, manifest.id DESC
            ) AS row_num
          FROM meta_authoritative_source_manifests manifest
          WHERE manifest.business_id = ${input.businessId}
            AND manifest.provider_account_id = ANY(${providerAccountIds}::text[])
            AND manifest.day >= ${normalizeDate(input.startDate)}
            AND manifest.day <= ${normalizeDate(input.endDate)}
            AND manifest.surface = ANY(${surfaces}::text[])
        ) ranked
        WHERE row_num = 1
      )
      SELECT
        business_id,
        provider_account_id,
        day,
        surface,
        id,
        fetch_status,
        completed_at,
        run_id
      FROM latest_manifests
    ` as unknown as Array<{
      business_id: string;
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      id: string;
      fetch_status: MetaAuthoritativeSourceManifestRecord["fetchStatus"];
      completed_at: string | null;
      run_id: string | null;
    }>,
    sql`
      WITH latest_failures AS (
        SELECT *
        FROM (
          SELECT
            event.provider_account_id,
            event.day,
            event.surface,
            event.result,
            event.event_kind,
            event.created_at,
            ROW_NUMBER() OVER (
              PARTITION BY event.provider_account_id, event.day, event.surface
              ORDER BY event.created_at DESC, event.id DESC
            ) AS row_num
          FROM meta_authoritative_reconciliation_events event
          WHERE event.business_id = ${input.businessId}
            AND event.provider_account_id = ANY(${providerAccountIds}::text[])
            AND event.day >= ${normalizeDate(input.startDate)}
            AND event.day <= ${normalizeDate(input.endDate)}
            AND event.surface = ANY(${surfaces}::text[])
            AND event.result IN ('failed', 'repair_required')
        ) ranked
        WHERE row_num = 1
      )
      SELECT
        provider_account_id,
        day,
        surface,
        result,
        event_kind,
        created_at
      FROM latest_failures
    ` as unknown as Array<{
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      result: "failed" | "repair_required";
      event_kind: string;
      created_at: string;
    }>,
    sql`
      SELECT
        provider_account_id,
        day,
        surface,
        state,
        diagnosis_code
      FROM meta_authoritative_day_state
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ANY(${providerAccountIds}::text[])
        AND day >= ${normalizeDate(input.startDate)}
        AND day <= ${normalizeDate(input.endDate)}
        AND surface = ANY(${surfaces}::text[])
    ` as unknown as Array<{
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      state: MetaAuthoritativeDayStateStatus;
      diagnosis_code: string | null;
    }>,
    sql`
      SELECT
        provider_account_id,
        partition_date AS day,
        COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_partitions,
        COUNT(*) FILTER (WHERE status IN ('leased', 'running'))::int AS leased_partitions,
        COUNT(*) FILTER (
          WHERE status IN ('leased', 'running')
            AND updated_at < now() - interval '15 minutes'
        )::int AS stale_leases,
        COUNT(*) FILTER (
          WHERE source IN ('finalize_day', 'finalize_range', 'manual_refresh', 'repair_recent_day')
            AND status IN ('queued', 'leased', 'running', 'failed', 'dead_letter')
        )::int AS repair_backlog
      FROM meta_sync_partitions
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ANY(${providerAccountIds}::text[])
        AND partition_date >= ${normalizeDate(input.startDate)}
        AND partition_date <= ${normalizeDate(input.endDate)}
      GROUP BY provider_account_id, partition_date
    ` as unknown as Array<{
      provider_account_id: string;
      day: string;
      queued_partitions: number | string | null;
      leased_partitions: number | string | null;
      stale_leases: number | string | null;
      repair_backlog: number | string | null;
    }>,
    sql`
      WITH manifest_accounts AS (
        SELECT DISTINCT ON (provider_account_id)
          provider_account_id,
          COALESCE(NULLIF(account_timezone, ''), 'UTC') AS account_timezone
        FROM meta_authoritative_source_manifests
        WHERE business_id = ${input.businessId}
          AND provider_account_id = ANY(${providerAccountIds}::text[])
        ORDER BY provider_account_id, updated_at DESC
      ),
      warehouse_accounts AS (
        SELECT DISTINCT ON (provider_account_id)
          provider_account_id,
          COALESCE(NULLIF(account_timezone, ''), 'UTC') AS account_timezone
        FROM meta_account_daily
        WHERE business_id = ${input.businessId}
          AND provider_account_id = ANY(${providerAccountIds}::text[])
        ORDER BY provider_account_id, date DESC, updated_at DESC
      )
      SELECT
        COALESCE(manifest_accounts.provider_account_id, warehouse_accounts.provider_account_id) AS provider_account_id,
        COALESCE(manifest_accounts.account_timezone, warehouse_accounts.account_timezone, 'UTC') AS account_timezone
      FROM manifest_accounts
      FULL OUTER JOIN warehouse_accounts
        ON warehouse_accounts.provider_account_id = manifest_accounts.provider_account_id
      WHERE COALESCE(manifest_accounts.provider_account_id, warehouse_accounts.provider_account_id) IS NOT NULL
    ` as unknown as Array<{
      provider_account_id: string;
      account_timezone: string;
    }>,
  ]);
  const accountTimeZoneById = new Map(
    accountTimezoneRows.map((row) => [
      row.provider_account_id,
      row.account_timezone || "UTC",
    ]),
  );

  const sliceByKey = new Map(
    latestSliceRows.map((row) => [
      `${row.provider_account_id}:${normalizeDate(row.day)}:${row.surface}`,
      row,
    ]),
  );
  const manifestByKey = new Map(
    latestManifestRows.map((row) => [
      `${row.provider_account_id}:${normalizeDate(row.day)}:${row.surface}`,
      row,
    ]),
  );
  const failureByKey = new Map(
    latestFailureRows.map((row) => [
      `${row.provider_account_id}:${normalizeDate(row.day)}:${row.surface}`,
      row,
    ]),
  );
  const plannerByKey = new Map(
    latestPlannerRows.map((row) => [
      `${row.provider_account_id}:${normalizeDate(row.day)}:${row.surface}`,
      row,
    ]),
  );
  const partitionByDayKey = new Map(
    partitionRows.map((row) => [
      `${row.provider_account_id}:${normalizeDate(row.day)}`,
      row,
    ]),
  );
  const days = enumerateIsoDays(input.startDate, input.endDate);
  const publishedKeysBySurface = {} as Partial<Record<MetaWarehouseScope, string[]>>;
  const reasonCounts: Record<string, number> = {};
  let publishedSlices = 0;
  let completedCoreDays = 0;
  let sourceFetchedAt: string | null = null;
  let publishedAt: string | null = null;
  let blocked = false;
  let failed = false;
  let repairRequired = false;
  let totalExpectedSlices = 0;

  for (const day of days) {
    let dayComplete = true;
    for (const providerAccountId of providerAccountIds) {
      const requiredSurfaces = getMetaApplicableVerificationSurfaces({
        day,
        providerAccountId,
        accountTimeZoneById,
        requestedSurfaces: surfaces,
      });
      totalExpectedSlices += requiredSurfaces.length;
      for (const surface of requiredSurfaces) {
        const key = `${providerAccountId}:${day}:${surface}`;
        const row = sliceByKey.get(key);
        const manifestRow = manifestByKey.get(key);
        const failureRow = failureByKey.get(key);
        const plannerRow = plannerByKey.get(key);
        const partitionRow =
          partitionByDayKey.get(`${providerAccountId}:${day}`) ?? null;
        const isCurrentDay = isMetaCurrentAccountDay({
          day,
          providerAccountId,
          accountTimeZoneById,
        });
        const isPublished =
          !isCurrentDay &&
          row?.active_slice_version_id != null &&
          row.published_status === "published" &&
          row.published_state === "finalized_verified";
        if (isPublished) {
          publishedSlices += 1;
          publishedKeysBySurface[surface] = [
            ...(publishedKeysBySurface[surface] ?? []),
            `${providerAccountId}:${day}`,
          ];
          const normalizedFetchedAt =
            normalizeTimestamp(manifestRow?.completed_at) ?? null;
          if (
            normalizedFetchedAt &&
            (!sourceFetchedAt || normalizedFetchedAt > sourceFetchedAt)
          ) {
            sourceFetchedAt = normalizedFetchedAt;
          }
          const normalizedPublishedAt =
            normalizeTimestamp(row?.published_at) ?? null;
          if (
            normalizedPublishedAt &&
            (!publishedAt || normalizedPublishedAt > publishedAt)
          ) {
            publishedAt = normalizedPublishedAt;
          }
          continue;
        }
        dayComplete = false;
        if (isCurrentDay) {
          reasonCounts.processing = (reasonCounts.processing ?? 0) + 1;
          reasonCounts.current_day_live = (reasonCounts.current_day_live ?? 0) + 1;
          continue;
        }
        const classification = classifyMetaAuthoritativeSurfaceState({
          manifestStatus: manifestRow?.fetch_status ?? "missing",
          latestFailureResult: failureRow?.result ?? null,
          latestSliceState:
            row?.latest_state == null
              ? null
              : (String(row.latest_state) as MetaAuthoritativeSliceVersionRecord["state"]),
          latestSliceStatus:
            row?.latest_status == null
              ? null
              : (String(row.latest_status) as MetaAuthoritativeSliceVersionRecord["status"]),
          latestSliceValidationStatus:
            row?.latest_validation_status == null
              ? null
              : (String(row.latest_validation_status) as MetaAuthoritativeSliceVersionRecord["validationStatus"]),
          plannerState: plannerRow?.state ?? null,
          plannerDiagnosisCode: plannerRow?.diagnosis_code ?? null,
          hasPublishedPublication: isPublished,
          publication: null,
          queuedPartitions: toNumber(partitionRow?.queued_partitions),
          leasedPartitions: toNumber(partitionRow?.leased_partitions),
          staleLeases: toNumber(partitionRow?.stale_leases),
          repairBacklog: toNumber(partitionRow?.repair_backlog),
        });

        const bumpReason = (code: string | null | undefined) => {
          if (!code) return;
          reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
        };

        if (classification.state === "blocked") {
          blocked = true;
          bumpReason("blocked");
          bumpReason(classification.diagnosisCode);
        } else if (classification.state === "repair_required") {
          repairRequired = true;
          bumpReason("repair_required");
          bumpReason(classification.diagnosisCode);
        } else if (classification.state === "failed") {
          failed = true;
          bumpReason("failed");
          bumpReason(classification.diagnosisCode);
        } else {
          bumpReason("processing");
          bumpReason(classification.state);
          bumpReason(classification.diagnosisCode);
        }
      }
    }
    if (dayComplete) {
      completedCoreDays += 1;
    }
  }

  const verificationState =
    totalExpectedSlices > 0 && publishedSlices === totalExpectedSlices
      ? "finalized_verified"
      : blocked
        ? "blocked"
      : failed
        ? "failed"
        : repairRequired
          ? "repair_required"
          : "processing";
  const asOf = publishedAt ?? sourceFetchedAt ?? null;

  return {
    verificationState,
    truthReady:
      totalExpectedSlices > 0 &&
      verificationState === "finalized_verified",
    totalDays: days.length,
    completedCoreDays,
    sourceFetchedAt,
    publishedAt,
    asOf,
    publishedSlices,
    totalExpectedSlices,
    reasonCounts,
    publishedKeysBySurface,
  };
}

export async function getMetaAuthoritativeBusinessOpsSnapshot(input: {
  businessId: string;
  latestPublishLimit?: number;
  timeoutMs?: number;
}): Promise<MetaAuthoritativeBusinessOpsSnapshot> {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const latestPublishLimit = Math.max(1, input.latestPublishLimit ?? 10);

  const [
    manifestRows,
    progressionRows,
    latestPublishRows,
    failureRows,
    accountRows,
    recentCoreRows,
    recentPlannerRows,
  ] = await Promise.all([
    sql`
      SELECT fetch_status, COUNT(*)::int AS count
      FROM meta_authoritative_source_manifests
      WHERE business_id = ${input.businessId}
      GROUP BY fetch_status
    ` as unknown as Array<{ fetch_status: string; count: number }>,
    sql`
      WITH published_days AS (
        SELECT COUNT(DISTINCT CONCAT(pointer.provider_account_id, ':', pointer.day))::int AS published_days
        FROM meta_authoritative_publication_pointers pointer
        INNER JOIN meta_authoritative_slice_versions slice
          ON slice.id = pointer.active_slice_version_id
        WHERE pointer.business_id = ${input.businessId}
          AND pointer.surface = 'account_daily'
          AND slice.validation_status = 'passed'
          AND slice.status = 'published'
      )
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE status IN ('leased', 'running'))::int AS leased,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS retryable_failed,
        COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter,
        COUNT(*) FILTER (
          WHERE status IN ('leased', 'running')
            AND updated_at < now() - interval '15 minutes'
        )::int AS stale_leases,
        COUNT(*) FILTER (
          WHERE source IN ('finalize_day', 'finalize_range', 'manual_refresh', 'repair_recent_day')
            AND status IN ('queued', 'leased', 'running', 'failed', 'dead_letter')
        )::int AS repair_backlog,
        COALESCE((SELECT published_days FROM published_days), 0)::int AS published
      FROM meta_sync_partitions
      WHERE business_id = ${input.businessId}
    ` as unknown as Array<Record<string, unknown>>,
    sql`
      SELECT
        pointer.provider_account_id,
        pointer.day,
        pointer.surface,
        slice.stage_started_at,
        slice.publish_started_at,
        pointer.published_at,
        manifest.source_kind,
        manifest.fetch_status AS manifest_fetch_status,
        CASE
          WHEN slice.validation_status = 'passed' AND slice.status = 'published'
            THEN 'finalized_verified'
          WHEN latest_failure.result = 'failed'
            THEN 'failed'
          WHEN latest_failure.result = 'repair_required'
            THEN 'repair_required'
          ELSE 'processing'
        END AS verification_state
      FROM meta_authoritative_publication_pointers pointer
      INNER JOIN meta_authoritative_slice_versions slice
        ON slice.id = pointer.active_slice_version_id
      LEFT JOIN meta_authoritative_source_manifests manifest
        ON manifest.id = slice.manifest_id
      LEFT JOIN LATERAL (
        SELECT result
        FROM meta_authoritative_reconciliation_events event
        WHERE event.business_id = pointer.business_id
          AND event.provider_account_id = pointer.provider_account_id
          AND event.day = pointer.day
          AND event.surface = pointer.surface
        ORDER BY event.created_at DESC
        LIMIT 1
      ) latest_failure ON TRUE
      WHERE pointer.business_id = ${input.businessId}
        AND pointer.surface IN ('account_daily', 'campaign_daily')
      ORDER BY pointer.published_at DESC
      LIMIT ${latestPublishLimit}
    ` as unknown as Array<{
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      stage_started_at: string | null;
      publish_started_at: string | null;
      published_at: string | null;
      source_kind: string | null;
      manifest_fetch_status: string | null;
      verification_state: string;
    }>,
    sql`
      SELECT
        provider_account_id,
        day,
        surface,
        result,
        event_kind,
        severity,
        COALESCE(
          details_json ->> 'reason',
          details_json ->> 'error',
          details_json ->> 'message',
          details_json ->> 'failureReason'
        ) AS reason,
        created_at
      FROM meta_authoritative_reconciliation_events
      WHERE business_id = ${input.businessId}
        AND result IN ('failed', 'repair_required')
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC
      LIMIT 20
    ` as unknown as Array<{
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      result: "failed" | "repair_required" | "passed" | "superseded";
      event_kind: string;
      severity: "info" | "warning" | "error";
      reason: string | null;
      created_at: string;
    }>,
    sql`
      WITH manifest_accounts AS (
        SELECT DISTINCT ON (provider_account_id)
          provider_account_id,
          COALESCE(NULLIF(account_timezone, ''), 'UTC') AS account_timezone
        FROM meta_authoritative_source_manifests
        WHERE business_id = ${input.businessId}
        ORDER BY provider_account_id, updated_at DESC
      ),
      warehouse_accounts AS (
        SELECT DISTINCT ON (provider_account_id)
          provider_account_id,
          COALESCE(NULLIF(account_timezone, ''), 'UTC') AS account_timezone
        FROM meta_account_daily
        WHERE business_id = ${input.businessId}
        ORDER BY provider_account_id, date DESC, updated_at DESC
      )
      SELECT
        COALESCE(manifest_accounts.provider_account_id, warehouse_accounts.provider_account_id) AS provider_account_id,
        COALESCE(manifest_accounts.account_timezone, warehouse_accounts.account_timezone, 'UTC') AS account_timezone
      FROM manifest_accounts
      FULL OUTER JOIN warehouse_accounts
        ON warehouse_accounts.provider_account_id = manifest_accounts.provider_account_id
      WHERE COALESCE(manifest_accounts.provider_account_id, warehouse_accounts.provider_account_id) IS NOT NULL
      ORDER BY provider_account_id
    ` as unknown as Array<{ provider_account_id: string; account_timezone: string }>,
    sql`
      SELECT
        pointer.provider_account_id,
        pointer.day,
        pointer.surface,
        pointer.published_at,
        slice.validation_status,
        latest_failure.result AS latest_failure_result
      FROM meta_authoritative_publication_pointers pointer
      INNER JOIN meta_authoritative_slice_versions slice
        ON slice.id = pointer.active_slice_version_id
      LEFT JOIN LATERAL (
        SELECT result
        FROM meta_authoritative_reconciliation_events event
        WHERE event.business_id = pointer.business_id
          AND event.provider_account_id = pointer.provider_account_id
          AND event.day = pointer.day
          AND event.surface = pointer.surface
        ORDER BY event.created_at DESC
        LIMIT 1
      ) latest_failure ON TRUE
      WHERE pointer.business_id = ${input.businessId}
        AND pointer.surface IN ('account_daily', 'campaign_daily')
        AND pointer.day >= ${addIsoDays(new Date().toISOString().slice(0, 10), -5)}
    ` as unknown as Array<{
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      published_at: string | null;
      validation_status: string | null;
      latest_failure_result: string | null;
    }>,
    sql`
      SELECT
        provider_account_id,
        day,
        surface,
        state,
        published_at
      FROM meta_authoritative_day_state
      WHERE business_id = ${input.businessId}
        AND surface IN ('account_daily', 'campaign_daily')
        AND day >= ${addIsoDays(new Date().toISOString().slice(0, 10), -5)}
    ` as unknown as Array<{
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      state: MetaAuthoritativeDayStateStatus;
      published_at: string | null;
    }>,
  ]);

  const manifestCounts = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    superseded: 0,
    total: 0,
  };
  for (const row of manifestRows) {
    const key = String(row.fetch_status ?? "") as keyof typeof manifestCounts;
    if (key in manifestCounts && key !== "total") {
      manifestCounts[key] = toNumber(row.count);
      manifestCounts.total += toNumber(row.count);
    }
  }

  const progressionRow = progressionRows[0] ?? {};
  const accountTimeZoneById = new Map(
    accountRows.map((row) => [
      row.provider_account_id,
      row.account_timezone || "UTC",
    ]),
  );
  const recentCoreByKey = new Map(
    recentCoreRows.map((row) => [
      `${row.provider_account_id}:${normalizeDate(row.day)}:${row.surface}`,
      row,
    ]),
  );
  const recentPlannerByKey = new Map(
    recentPlannerRows.map((row) => [
      `${row.provider_account_id}:${normalizeDate(row.day)}:${row.surface}`,
      row,
    ]),
  );

  const d1Accounts = accountRows.map((row) => {
    const expectedDay = addIsoDays(getTodayIsoForTimeZone(row.account_timezone || "UTC"), -1);
    const accountRow = recentCoreByKey.get(`${row.provider_account_id}:${expectedDay}:account_daily`);
    const campaignRow = recentCoreByKey.get(`${row.provider_account_id}:${expectedDay}:campaign_daily`);
    const accountPlanner = recentPlannerByKey.get(
      `${row.provider_account_id}:${expectedDay}:account_daily`,
    );
    const campaignPlanner = recentPlannerByKey.get(
      `${row.provider_account_id}:${expectedDay}:campaign_daily`,
    );
    const finalized =
      accountRow?.validation_status === "passed" &&
      Boolean(accountRow?.published_at) &&
      campaignRow?.validation_status === "passed" &&
      Boolean(campaignRow?.published_at);
    const failureResult =
      accountPlanner?.state === "failed" ||
      campaignPlanner?.state === "failed" ||
      accountRow?.latest_failure_result === "failed" ||
      campaignRow?.latest_failure_result === "failed"
        ? "failed"
        : accountPlanner?.state === "blocked" ||
            campaignPlanner?.state === "blocked"
          ? "blocked"
          : accountPlanner?.state === "repair_required" ||
              campaignPlanner?.state === "repair_required" ||
              accountRow?.latest_failure_result === "repair_required" ||
              campaignRow?.latest_failure_result === "repair_required"
            ? "repair_required"
            : null;
    const publishedAtCandidates = [
      accountRow?.published_at,
      campaignRow?.published_at,
    ]
      .map((value) => normalizeTimestamp(value))
      .filter((value): value is string => Boolean(value));
    const verificationState =
      finalized
        ? "finalized_verified"
        : failureResult === "blocked"
          ? "blocked"
        : failureResult === "failed"
          ? "failed"
          : failureResult === "repair_required"
            ? "repair_required"
            : "processing";
    return {
      providerAccountId: row.provider_account_id,
      accountTimezone: row.account_timezone || "UTC",
      expectedDay,
      verificationState: verificationState as MetaPublishedVerificationSummary["verificationState"],
      publishedAt: publishedAtCandidates.sort((a, b) => b.localeCompare(a))[0] ?? null,
      breached: verificationState !== "finalized_verified",
    };
  });

  return {
    businessId: input.businessId,
    capturedAt: new Date().toISOString(),
    manifestCounts,
    progression: {
      queued: toNumber(progressionRow.queued),
      leased: toNumber(progressionRow.leased),
      published: toNumber(progressionRow.published),
      retryableFailed: toNumber(progressionRow.retryable_failed),
      deadLetter: toNumber(progressionRow.dead_letter),
      staleLeases: toNumber(progressionRow.stale_leases),
      repairBacklog: toNumber(progressionRow.repair_backlog),
    },
    latestPublishes: latestPublishRows.map(
      (row): MetaAuthoritativeLatestPublishRecord => {
        const normalizedDay = normalizeDate(row.day);
        const isCurrentDay = isMetaCurrentAccountDay({
          day: normalizedDay,
          providerAccountId: row.provider_account_id,
          accountTimeZoneById,
        });
        return {
          providerAccountId: row.provider_account_id,
          day: normalizedDay,
          surface: row.surface,
          stageStartedAt: normalizeTimestamp(row.stage_started_at),
          publishStartedAt: normalizeTimestamp(row.publish_started_at),
          publishedAt: normalizeTimestamp(row.published_at),
          verificationState:
            row.verification_state === "failed" ||
            row.verification_state === "repair_required"
              ? row.verification_state
              : row.verification_state === "finalized_verified" && !isCurrentDay
                ? "finalized_verified"
                : "processing",
          sourceKind: row.source_kind,
          manifestFetchStatus: (row.manifest_fetch_status as MetaAuthoritativeSourceManifestRecord["fetchStatus"] | null) ?? null,
        };
      },
    ),
    d1FinalizeSla: {
      totalAccounts: d1Accounts.length,
      breachedAccounts: d1Accounts.filter((row) => row.breached).length,
      accounts: d1Accounts,
    },
    validationFailures24h: failureRows.length,
    recentFailures: failureRows.map(
      (row): MetaAuthoritativeRecentFailureRecord => ({
        providerAccountId: row.provider_account_id,
        day: normalizeDate(row.day),
        surface: row.surface,
        result: row.result,
        eventKind: row.event_kind,
        severity: row.severity,
        reason: row.reason,
        createdAt: normalizeTimestamp(row.created_at) ?? row.created_at,
      }),
    ),
    lastSuccessfulPublishAt:
      latestPublishRows
        .filter(
          (row) =>
            row.verification_state === "finalized_verified" &&
            row.published_at &&
            !isMetaCurrentAccountDay({
              day: normalizeDate(row.day),
              providerAccountId: row.provider_account_id,
              accountTimeZoneById,
            }),
        )
        .map((row) => normalizeTimestamp(row.published_at))
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => b.localeCompare(a))[0] ?? null,
  };
}

export async function getMetaAuthoritativeDayVerification(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
}): Promise<MetaAuthoritativeDayVerification> {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const day = normalizeDate(input.day);
  const referenceToday = new Date().toISOString().slice(0, 10);
  const dayAge = Math.max(
    0,
    Math.floor(
      (new Date(`${referenceToday}T00:00:00.000Z`).getTime() -
        new Date(`${day}T00:00:00.000Z`).getTime()) /
        86_400_000,
    ),
  );
  const surfaces: MetaWarehouseScope[] = getMetaAuthoritativeRequiredSurfacesForDayAge(
    dayAge,
  )
    .filter((requirement) => requirement.state !== "not_applicable")
    .map((requirement) => requirement.surface);
  const [
    manifestRows,
    latestFailureRows,
    plannerRows,
    latestSliceRows,
    partitionRows,
    verification,
  ] = await Promise.all([
    sql`
      WITH latest_manifests AS (
        SELECT *
        FROM (
          SELECT
            manifest.*,
            ROW_NUMBER() OVER (
              PARTITION BY manifest.surface
              ORDER BY manifest.updated_at DESC, manifest.id DESC
            ) AS row_num
          FROM meta_authoritative_source_manifests manifest
          WHERE manifest.business_id = ${input.businessId}
            AND manifest.provider_account_id = ${input.providerAccountId}
            AND manifest.day = ${day}
            AND manifest.surface = ANY(${surfaces}::text[])
        ) ranked
        WHERE row_num = 1
      )
      SELECT *
      FROM latest_manifests
    ` as unknown as Array<{
      id: string;
      business_id: string;
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      account_timezone: string;
      source_kind: string;
      source_window_kind: MetaAuthoritativeSourceManifestRecord["sourceWindowKind"];
      run_id: string | null;
      fetch_status: MetaAuthoritativeSourceManifestRecord["fetchStatus"];
      fresh_start_applied: boolean;
      checkpoint_reset_applied: boolean;
      raw_snapshot_watermark: string | null;
      source_spend: number | null;
      validation_basis_version: string | null;
      meta_json: Record<string, unknown> | null;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
      updated_at: string;
    }>,
    sql`
      SELECT
        provider_account_id,
        day,
        surface,
        result,
        event_kind,
        severity,
        COALESCE(
          details_json ->> 'reason',
          details_json ->> 'error',
          details_json ->> 'message',
          details_json ->> 'failureReason'
        ) AS reason,
        created_at
      FROM (
        SELECT
          event.*,
          ROW_NUMBER() OVER (
            PARTITION BY event.surface
            ORDER BY event.created_at DESC, event.id DESC
          ) AS row_num
        FROM meta_authoritative_reconciliation_events event
        WHERE business_id = ${input.businessId}
          AND provider_account_id = ${input.providerAccountId}
          AND day = ${day}
          AND result IN ('failed', 'repair_required')
      ) ranked
      WHERE row_num = 1
      ORDER BY created_at DESC
    ` as unknown as Array<{
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      result: "failed" | "repair_required" | "passed" | "superseded";
      event_kind: string;
      severity: "info" | "warning" | "error";
      reason: string | null;
      created_at: string;
    }>,
    sql`
      SELECT *
      FROM meta_authoritative_day_state
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND day = ${day}
        AND surface = ANY(${surfaces}::text[])
    ` as unknown as Array<{
      business_id: string;
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      state: MetaAuthoritativeDayStateStatus;
      account_timezone: string;
      active_partition_id: string | null;
      last_run_id: string | null;
      last_manifest_id: string | null;
      last_publication_pointer_id: string | null;
      published_at: string | null;
      retry_after_at: string | null;
      failure_streak: number;
      diagnosis_code: string | null;
      diagnosis_detail_json: Record<string, unknown> | null;
      last_started_at: string | null;
      last_finished_at: string | null;
      last_autoheal_at: string | null;
      autoheal_count: number;
      created_at: string;
      updated_at: string;
    }>,
    sql`
      WITH latest_slice AS (
        SELECT *
        FROM (
          SELECT
            slice.*,
            ROW_NUMBER() OVER (
              PARTITION BY slice.surface
              ORDER BY slice.candidate_version DESC, slice.created_at DESC, slice.id DESC
            ) AS row_num
          FROM meta_authoritative_slice_versions slice
          WHERE slice.business_id = ${input.businessId}
            AND slice.provider_account_id = ${input.providerAccountId}
            AND slice.day = ${day}
            AND slice.surface = ANY(${surfaces}::text[])
        ) ranked
        WHERE row_num = 1
      )
      SELECT *
      FROM latest_slice
    ` as unknown as Array<{
      id: string;
      business_id: string;
      provider_account_id: string;
      day: string;
      surface: MetaWarehouseScope;
      manifest_id: string | null;
      candidate_version: number;
      state: MetaAuthoritativeSliceVersionRecord["state"];
      truth_state: MetaAuthoritativeSliceVersionRecord["truthState"];
      validation_status: MetaAuthoritativeSliceVersionRecord["validationStatus"];
      status: MetaAuthoritativeSliceVersionRecord["status"];
      staged_row_count: number | null;
      aggregated_spend: number | null;
      validation_summary: Record<string, unknown> | null;
      source_run_id: string | null;
      stage_started_at: string | null;
      stage_completed_at: string | null;
      publish_started_at: string | null;
      published_at: string | null;
      superseded_at: string | null;
      created_at: string;
      updated_at: string;
    }>,
    sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_partitions,
        COUNT(*) FILTER (WHERE status IN ('leased', 'running'))::int AS leased_partitions,
        COUNT(*) FILTER (
          WHERE status IN ('leased', 'running')
            AND updated_at < now() - interval '15 minutes'
        )::int AS stale_leases,
        COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letters,
        COUNT(*) FILTER (
          WHERE source IN ('finalize_day', 'finalize_range', 'manual_refresh', 'repair_recent_day')
            AND status IN ('queued', 'leased', 'running', 'failed', 'dead_letter')
        )::int AS repair_backlog
      FROM meta_sync_partitions
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND partition_date = ${day}
    ` as unknown as Array<Record<string, unknown>>,
    getMetaPublishedVerificationSummary({
      businessId: input.businessId,
      startDate: day,
      endDate: day,
      providerAccountIds: [input.providerAccountId],
      surfaces,
    }),
  ]);

  const manifestsBySurface = new Map(
    manifestRows.map((row) => [row.surface, mapMetaAuthoritativeSourceManifestRow(row)]),
  );
  const plannerStateBySurface = new Map(
    plannerRows.map((row) => [row.surface, mapMetaAuthoritativeDayStateRow(row)]),
  );
  const latestFailureBySurface = new Map(
    latestFailureRows.map((row) => [
      row.surface,
      {
        providerAccountId: row.provider_account_id,
        day: normalizeDate(row.day),
        surface: row.surface,
        result: row.result,
        eventKind: row.event_kind,
        severity: row.severity,
        reason: row.reason,
        createdAt: normalizeTimestamp(row.created_at) ?? row.created_at,
      } satisfies MetaAuthoritativeRecentFailureRecord,
    ]),
  );
  const latestSliceBySurface = new Map(
    latestSliceRows.map((row) => [row.surface, mapMetaAuthoritativeSliceVersionRow(row)]),
  );
  const partitionRow = partitionRows[0] ?? {};
  const surfacesState = await Promise.all(
    surfaces.map(async (surface) => {
      const publication = await getMetaActivePublishedSliceVersion({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        day,
        surface,
      });
      const latestFailure = latestFailureBySurface.get(surface) ?? null;
      const plannerState = plannerStateBySurface.get(surface) ?? null;
      const latestSlice = latestSliceBySurface.get(surface) ?? null;
      const classification = classifyMetaAuthoritativeSurfaceState({
        manifestStatus: manifestsBySurface.get(surface)?.fetchStatus ?? "missing",
        latestFailureResult: latestFailure?.result ?? null,
        latestSliceState: latestSlice?.state ?? null,
        latestSliceStatus: latestSlice?.status ?? null,
        latestSliceValidationStatus: latestSlice?.validationStatus ?? null,
        plannerState: plannerState?.state ?? null,
        plannerDiagnosisCode: plannerState?.diagnosisCode ?? null,
        publication,
        queuedPartitions: toNumber(partitionRow.queued_partitions),
        leasedPartitions: toNumber(partitionRow.leased_partitions),
        staleLeases: toNumber(partitionRow.stale_leases),
        repairBacklog: toNumber(partitionRow.repair_backlog),
      });

      return {
        surface,
        manifest: manifestsBySurface.get(surface) ?? null,
        latestSlice,
        publication,
        latestFailure,
        plannerState,
        detectorState: classification.state,
        detectorReasonCode: classification.diagnosisCode,
        contractMismatch: classification.contractMismatch,
      };
    }),
  );

  const allManifests = surfacesState.map((row) => row.manifest).filter(Boolean);
  const sourceManifestState =
    allManifests.length === 0
      ? "missing"
      : allManifests.some((row) => row?.fetchStatus === "failed")
        ? "failed"
        : allManifests.some((row) => row?.fetchStatus === "running")
          ? "running"
          : allManifests.some((row) => row?.fetchStatus === "pending")
            ? "pending"
            : allManifests.every((row) => row?.fetchStatus === "completed")
              ? "completed"
              : "superseded";
  const accountPublication = surfacesState.find((row) => row.surface === "account_daily")?.publication ?? null;
  const lastFailure = latestFailureRows[0]
    ? {
        providerAccountId: latestFailureRows[0].provider_account_id,
        day: normalizeDate(latestFailureRows[0].day),
        surface: latestFailureRows[0].surface,
        result: latestFailureRows[0].result,
        eventKind: latestFailureRows[0].event_kind,
        severity: latestFailureRows[0].severity,
        reason: latestFailureRows[0].reason,
        createdAt: normalizeTimestamp(latestFailureRows[0].created_at) ?? latestFailureRows[0].created_at,
      }
    : null;

  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    day,
    verificationState: verification.verificationState,
    sourceManifestState,
    validationState: verification.verificationState,
    activePublication: accountPublication
      ? {
          publishStartedAt: accountPublication.sliceVersion.publishStartedAt ?? null,
          publishedAt: accountPublication.publication.publishedAt ?? null,
          publicationReason: accountPublication.publication.publicationReason ?? null,
          activeSliceVersionId: accountPublication.publication.activeSliceVersionId ?? null,
        }
      : null,
    surfaces: surfacesState,
    lastFailure,
    detectorReasonCodes: Array.from(
      new Set(
        surfacesState
          .map((surfaceState) => surfaceState.detectorReasonCode)
          .filter((value): value is string => Boolean(value)),
      ),
    ),
    repairBacklog: toNumber(partitionRow.repair_backlog),
    deadLetters: toNumber(partitionRow.dead_letters),
    staleLeases: toNumber(partitionRow.stale_leases),
    queuedPartitions: toNumber(partitionRow.queued_partitions),
    leasedPartitions: toNumber(partitionRow.leased_partitions),
  };
}

export function createMetaWarehouseFreshness(
  input: Partial<MetaWarehouseFreshness> = {}
): MetaWarehouseFreshness {
  return {
    dataState: input.dataState ?? "syncing",
    lastSyncedAt: input.lastSyncedAt ?? null,
    liveRefreshedAt: input.liveRefreshedAt ?? null,
    isPartial: input.isPartial ?? false,
    missingWindows: input.missingWindows ?? [],
    warnings: input.warnings ?? [],
  };
}

export function mergeMetaWarehouseState(
  current: MetaWarehouseDataState,
  next: MetaWarehouseDataState
): MetaWarehouseDataState {
  const priority: Record<MetaWarehouseDataState, number> = {
    not_connected: 0,
    connected_no_assignment: 1,
    action_required: 2,
    syncing: 3,
    stale: 4,
    paused: 5,
    partial: 6,
    ready: 7,
  };
  return priority[next] > priority[current] ? next : current;
}

export async function createMetaSyncJob(input: MetaSyncJobRecord) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const canonicalSyncType = canonicalizeMetaSyncJobType(input.syncType);
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const existingRows = await sql`
    SELECT id
    FROM meta_sync_jobs
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND sync_type = ${canonicalSyncType}
      AND scope = ${input.scope}
      AND start_date = ${normalizeDate(input.startDate)}
      AND end_date = ${normalizeDate(input.endDate)}
      AND trigger_source = ${input.triggerSource}
      AND status = 'running'
    ORDER BY triggered_at DESC
    LIMIT 1
  ` as Array<{ id: string }>;
  if (existingRows[0]?.id) return existingRows[0].id;
  const rows = await sql`
    INSERT INTO meta_sync_jobs (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      sync_type,
      scope,
      start_date,
      end_date,
      status,
      progress_percent,
      trigger_source,
      retry_count,
      last_error,
      triggered_at,
      started_at,
      finished_at,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${canonicalSyncType},
      ${input.scope},
      ${normalizeDate(input.startDate)},
      ${normalizeDate(input.endDate)},
      ${input.status},
      ${input.progressPercent},
      ${input.triggerSource},
      ${input.retryCount},
      ${input.lastError},
      COALESCE(${input.triggeredAt ?? null}, now()),
      ${input.startedAt ?? null},
      ${input.finishedAt ?? null},
      now()
    )
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function updateMetaSyncJob(input: {
  id: string;
  status: MetaSyncJobRecord["status"];
  progressPercent?: number;
  lastError?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  await sql`
    UPDATE meta_sync_jobs
    SET
      status = ${input.status},
      progress_percent = COALESCE(${input.progressPercent ?? null}, progress_percent),
      last_error = COALESCE(${input.lastError ?? null}, last_error),
      started_at = COALESCE(${input.startedAt ?? null}, started_at),
      finished_at = COALESCE(${input.finishedAt ?? null}, finished_at),
      updated_at = now()
    WHERE id = ${input.id}
  `;
}

export async function queueMetaSyncPartition(input: MetaSyncPartitionRecord) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const rows = await sql`
    INSERT INTO meta_sync_partitions (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      lane,
      scope,
      partition_date,
      status,
      priority,
      source,
      lease_owner,
      lease_expires_at,
      attempt_count,
      next_retry_at,
      last_error,
      started_at,
      finished_at,
      -- Which scheduling operation created this row, if any. Null for work the
      -- worker or a cron tick planned for itself, which belongs to no
      -- user-facing request.
      scheduling_attempt_id,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${input.lane},
      ${input.scope},
      ${normalizeDate(input.partitionDate)},
      ${input.status},
      ${input.priority},
      ${input.source},
      ${input.leaseOwner ?? null},
      ${input.leaseExpiresAt ?? null},
      ${input.attemptCount},
      ${input.nextRetryAt ?? null},
      ${input.lastError ?? null},
      ${input.startedAt ?? null},
      ${input.finishedAt ?? null},
      ${getCurrentSchedulingAttemptId()},
      now()
    )
    ON CONFLICT (business_id, provider_account_id, lane, scope, partition_date)
    DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_sync_partitions.business_ref_id),
      provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_sync_partitions.provider_account_ref_id),
      priority = GREATEST(meta_sync_partitions.priority, EXCLUDED.priority),
      source = CASE
        WHEN meta_sync_partitions.source = 'finalize_day' THEN meta_sync_partitions.source
        WHEN EXCLUDED.source = 'finalize_day' THEN EXCLUDED.source
        WHEN meta_sync_partitions.source = 'priority_window' THEN meta_sync_partitions.source
        WHEN EXCLUDED.source = 'priority_window' THEN EXCLUDED.source
        WHEN meta_sync_partitions.source = 'repair_recent_day' THEN meta_sync_partitions.source
        WHEN EXCLUDED.source = 'repair_recent_day' THEN EXCLUDED.source
        WHEN meta_sync_partitions.source = 'yesterday' THEN meta_sync_partitions.source
        WHEN EXCLUDED.source = 'yesterday' THEN EXCLUDED.source
        WHEN meta_sync_partitions.source = 'today_observe' THEN meta_sync_partitions.source
        WHEN EXCLUDED.source = 'today_observe' THEN EXCLUDED.source
        WHEN meta_sync_partitions.source = 'today' THEN meta_sync_partitions.source
        WHEN EXCLUDED.source = 'today' THEN EXCLUDED.source
        WHEN meta_sync_partitions.source = 'request_runtime' THEN meta_sync_partitions.source
        WHEN EXCLUDED.source = 'request_runtime' THEN EXCLUDED.source
        WHEN meta_sync_partitions.source = 'recent' THEN meta_sync_partitions.source
        WHEN EXCLUDED.source = 'recent' THEN EXCLUDED.source
        WHEN meta_sync_partitions.source = 'recent_recovery' THEN meta_sync_partitions.source
        WHEN EXCLUDED.source = 'recent_recovery' THEN EXCLUDED.source
        ELSE meta_sync_partitions.source
      END,
      status = CASE
        WHEN EXCLUDED.source IN (
          'finalize_day',
          'priority_window',
          'repair_recent_day',
          'yesterday',
          'recent',
          'recent_recovery',
          'today_observe',
          'today',
          'request_runtime',
          'historical_recovery'
        )
          AND (
            meta_sync_partitions.status IN ('failed', 'cancelled')
            OR (
              meta_sync_partitions.status = 'succeeded'
              AND EXCLUDED.source <> 'historical_recovery'
            )
          )
          THEN 'queued'
        ELSE meta_sync_partitions.status
      END,
      lease_owner = CASE
        WHEN EXCLUDED.source IN (
          'finalize_day',
          'priority_window',
          'repair_recent_day',
          'recent',
          'recent_recovery',
          'today_observe',
          'today',
          'request_runtime',
          'historical_recovery'
        )
          AND (
            meta_sync_partitions.status IN ('failed', 'cancelled')
            OR (
              meta_sync_partitions.status = 'succeeded'
              AND EXCLUDED.source <> 'historical_recovery'
            )
          )
          THEN NULL
        ELSE meta_sync_partitions.lease_owner
      END,
      lease_expires_at = CASE
        WHEN EXCLUDED.source IN (
          'finalize_day',
          'priority_window',
          'repair_recent_day',
          'recent',
          'recent_recovery',
          'today_observe',
          'today',
          'request_runtime',
          'historical_recovery'
        )
          AND (
            meta_sync_partitions.status IN ('failed', 'cancelled')
            OR (
              meta_sync_partitions.status = 'succeeded'
              AND EXCLUDED.source <> 'historical_recovery'
            )
          )
          THEN NULL
        ELSE meta_sync_partitions.lease_expires_at
      END,
      last_error = CASE
        WHEN EXCLUDED.source IN (
          'finalize_day',
          'priority_window',
          'repair_recent_day',
          'recent',
          'recent_recovery',
          'today_observe',
          'today',
          'request_runtime',
          'historical_recovery'
        )
          AND (
            meta_sync_partitions.status IN ('failed', 'cancelled')
            OR (
              meta_sync_partitions.status = 'succeeded'
              AND EXCLUDED.source <> 'historical_recovery'
            )
          )
          THEN NULL
        ELSE meta_sync_partitions.last_error
      END,
      next_retry_at = CASE
        WHEN EXCLUDED.source IN (
          'finalize_day',
          'priority_window',
          'repair_recent_day',
          'recent',
          'recent_recovery',
          'today_observe',
          'today',
          'request_runtime',
          'historical_recovery'
        )
          AND (
            meta_sync_partitions.status IN ('failed', 'cancelled')
            OR (
              meta_sync_partitions.status = 'succeeded'
              AND EXCLUDED.source <> 'historical_recovery'
            )
          )
          THEN now()
        WHEN meta_sync_partitions.status IN ('succeeded', 'running', 'leased')
          THEN meta_sync_partitions.next_retry_at
        ELSE LEAST(COALESCE(meta_sync_partitions.next_retry_at, now()), COALESCE(EXCLUDED.next_retry_at, now()))
      END,
      updated_at = CASE
        WHEN meta_sync_partitions.status = 'dead_letter' THEN meta_sync_partitions.updated_at
        ELSE now()
      END
    RETURNING id, status
  ` as Array<{ id: string; status: MetaPartitionStatus }>;
  return rows[0] ?? null;
}

/**
 * Cancels every non-terminal partition for an account whose selection or
 * connection was revoked. Cancellation — not failure — is the truthful record:
 * the work did not fail, it is no longer authorised, and a failed row would be
 * retried against an account we may no longer touch.
 */
export async function cancelMetaPartitionsForRevokedAccount(input: {
  businessId: string;
  providerAccountId: string;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = (await sql`
    UPDATE meta_sync_partitions
    SET
      status = 'cancelled',
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = NULL,
      last_error = 'meta_account_selection_revoked',
      finished_at = COALESCE(finished_at, now()),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND status IN ('queued', 'leased', 'running', 'failed')
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export async function cancelObsoleteMetaCoreScopePartitions(input: {
  businessId: string;
  canonicalScope?: MetaWarehouseScope;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const canonicalScope = input.canonicalScope ?? META_PRODUCT_CORE_COVERAGE_SCOPES[0];
  const rows = await sql`
    UPDATE meta_sync_partitions
    SET
      status = 'cancelled',
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = NULL,
      last_error = COALESCE(
        last_error,
        'Obsolete duplicate core-day partition scope cancelled after product-core migration.'
      ),
      finished_at = COALESCE(finished_at, now()),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND lane IN ('core', 'maintenance')
      AND scope <> ${canonicalScope}
      AND status IN ('queued', 'failed', 'dead_letter')
    RETURNING id
  ` as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

export async function leaseMetaSyncPartitions(input: {
  businessId: string;
  lane?: "core" | "extended" | "maintenance";
  sources?: string[] | null;
  workerId: string;
  limit: number;
  leaseMinutes?: number;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    WITH candidates AS (
      SELECT id
      FROM meta_sync_partitions
      WHERE business_id = ${input.businessId}
        AND EXISTS (
          SELECT 1
          FROM sync_runner_leases lease
          WHERE lease.business_id = ${input.businessId}
            AND lease.provider_scope = 'meta'
            AND lease.lease_owner = ${input.workerId}
            AND lease.lease_expires_at > now()
        )
        AND (${input.lane ?? null}::text IS NULL OR lane = ${input.lane ?? null})
        AND (
          ${input.sources ?? null}::text[] IS NULL
          OR source = ANY(${input.sources ?? null}::text[])
        )
        AND (
          status = 'queued'
          OR (status = 'failed' AND COALESCE(next_retry_at, now()) <= now())
          OR (status = 'leased' AND COALESCE(lease_expires_at, now()) <= now())
        )
      -- Platform sync policy: always prepare the newest user-visible dates first.
      -- Recent and historical/backfill queues both run newest-first so a newly
      -- connected workspace becomes useful on current dates before older history fills in.
      ORDER BY
        priority DESC,
        CASE source
          WHEN 'finalize_day' THEN 725
          WHEN 'priority_window' THEN 700
          WHEN 'repair_recent_day' THEN 690
          WHEN 'yesterday' THEN 675
          WHEN 'today_observe' THEN 660
          WHEN 'today' THEN 650
          WHEN 'request_runtime' THEN 625
          WHEN 'recent' THEN 600
          WHEN 'recent_recovery' THEN 550
          WHEN 'manual_refresh' THEN 525
          WHEN 'core_success' THEN 500
          WHEN 'initial_connect' THEN 250
          WHEN 'historical_recovery' THEN 200
          WHEN 'historical' THEN 150
          ELSE 100
        END DESC,
        CASE
          WHEN source IN ('priority_window', 'finalize_day')
            THEN NULL
          WHEN source IN ('historical', 'historical_recovery', 'initial_connect')
            THEN partition_date
          ELSE NULL
        END DESC,
        CASE
          WHEN source IN ('priority_window', 'finalize_day')
            THEN partition_date
          WHEN source IN ('historical', 'historical_recovery', 'initial_connect')
            THEN NULL
          ELSE partition_date
        END DESC,
        updated_at ASC
      LIMIT ${Math.max(1, input.limit)}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE meta_sync_partitions partition
    SET
      status = 'leased',
      lease_epoch = partition.lease_epoch + 1,
      lease_owner = ${input.workerId},
      lease_expires_at = now() + (${input.leaseMinutes ?? 5} || ' minutes')::interval,
      updated_at = now()
    FROM candidates
    WHERE partition.id = candidates.id
    RETURNING
      partition.id,
      partition.business_id,
      partition.provider_account_id,
      partition.lane,
      partition.scope,
      partition.partition_date,
      partition.status,
      partition.priority,
      partition.source,
      partition.lease_epoch,
      partition.lease_owner,
      partition.lease_expires_at,
      partition.attempt_count,
      partition.next_retry_at,
      partition.last_error,
      partition.created_at,
      partition.started_at,
      partition.finished_at,
      partition.updated_at
  ` as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    lane: String(row.lane) as MetaSyncPartitionRecord["lane"],
    scope: String(row.scope) as MetaWarehouseScope,
    partitionDate: normalizeDate(row.partition_date),
    status: String(row.status) as MetaPartitionStatus,
    priority: toNumber(row.priority),
    source: String(row.source),
    leaseEpoch: toNumber(row.lease_epoch),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: normalizeTimestamp(row.lease_expires_at),
    attemptCount: toNumber(row.attempt_count),
    nextRetryAt: normalizeTimestamp(row.next_retry_at),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: normalizeTimestamp(row.created_at) ?? undefined,
    startedAt: normalizeTimestamp(row.started_at),
    finishedAt: normalizeTimestamp(row.finished_at),
    updatedAt: normalizeTimestamp(row.updated_at) ?? undefined,
  })) as MetaSyncPartitionRecord[];
}

export async function markMetaPartitionRunning(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  leaseMinutes?: number;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    UPDATE meta_sync_partitions partition
    SET
      status = 'running',
      lease_owner = ${input.workerId},
      started_at = COALESCE(started_at, now()),
      lease_expires_at = now() + (${input.leaseMinutes ?? 15} || ' minutes')::interval,
      attempt_count = attempt_count + 1,
      updated_at = now()
    WHERE partition.id = ${input.partitionId}
      AND partition.lease_owner = ${input.workerId}
      AND partition.lease_epoch = ${input.leaseEpoch}
      AND COALESCE(partition.lease_expires_at, now()) > now()
      AND EXISTS (
        SELECT 1
        FROM sync_runner_leases lease
        WHERE lease.business_id = partition.business_id
          AND lease.provider_scope = 'meta'
          AND lease.lease_owner = ${input.workerId}
          AND lease.lease_expires_at > now()
      )
    RETURNING partition.id AS id
  ` as Array<{ id: string }>;
  return rows.length > 0;
}

function parseMetaClosedCheckpointGroups(raw: unknown): MetaClosedCheckpointGroup[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        return {
          checkpointScope: String(record.checkpointScope ?? record.checkpoint_scope ?? ""),
          previousPhase: String(record.previousPhase ?? record.previous_phase ?? ""),
          count: toNumber(record.count ?? record.row_count),
        } satisfies MetaClosedCheckpointGroup;
      })
      .filter((entry): entry is MetaClosedCheckpointGroup => Boolean(entry?.checkpointScope));
  }
  if (typeof raw === "string") {
    try {
      return parseMetaClosedCheckpointGroups(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

function parseNullableBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function parseStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : String(entry ?? "").trim()))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    try {
      return parseStringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

export async function getMetaPartitionCompletionDenialSnapshot(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
}) {
  const sql = getDb();
  try {
    const [row] = (await sql`
      WITH input_values AS (
        SELECT
          ${input.partitionId}::uuid AS partition_id,
          ${input.workerId}::text AS worker_id,
          ${input.leaseEpoch}::bigint AS lease_epoch
      ),
      current_partition AS (
        SELECT
          partition.status::text AS current_partition_status,
          partition.lease_owner::text AS current_lease_owner,
          partition.lease_epoch AS current_lease_epoch,
          partition.lease_expires_at AS current_lease_expires_at,
          (partition.lease_owner = input_values.worker_id) AS owner_matches_caller,
          (partition.lease_epoch = input_values.lease_epoch) AS epoch_matches_caller,
          (COALESCE(partition.lease_expires_at, now() - interval '1 second') <= now())
            AS lease_expired_at_observation,
          partition.finished_at AS current_partition_finished_at
        FROM meta_sync_partitions partition
        CROSS JOIN input_values
        WHERE partition.id = input_values.partition_id
      ),
      latest_checkpoint AS (
        SELECT
          checkpoint.checkpoint_scope::text AS latest_checkpoint_scope,
          checkpoint.phase::text AS latest_checkpoint_phase,
          checkpoint.updated_at AS latest_checkpoint_updated_at
        FROM meta_sync_checkpoints checkpoint
        CROSS JOIN input_values
        WHERE checkpoint.partition_id = input_values.partition_id
        ORDER BY checkpoint.updated_at DESC
        LIMIT 1
      ),
      latest_running_run AS (
        SELECT run.id::text AS latest_running_run_id
        FROM meta_sync_runs run
        CROSS JOIN input_values
        WHERE run.partition_id = input_values.partition_id
          AND run.status = 'running'
        ORDER BY run.created_at DESC
        LIMIT 1
      ),
      running_run_count AS (
        SELECT COUNT(*)::int AS running_run_count
        FROM meta_sync_runs run
        CROSS JOIN input_values
        WHERE run.partition_id = input_values.partition_id
          AND run.status = 'running'
      )
      SELECT
        current_partition.current_partition_status,
        current_partition.current_lease_owner,
        current_partition.current_lease_epoch,
        current_partition.current_lease_expires_at,
        current_partition.owner_matches_caller,
        current_partition.epoch_matches_caller,
        current_partition.lease_expired_at_observation,
        current_partition.current_partition_finished_at,
        latest_checkpoint.latest_checkpoint_scope,
        latest_checkpoint.latest_checkpoint_phase,
        latest_checkpoint.latest_checkpoint_updated_at,
        latest_running_run.latest_running_run_id,
        running_run_count.running_run_count,
        CASE
          WHEN current_partition.current_partition_status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
            THEN 'already_terminal'
          WHEN current_partition.owner_matches_caller IS FALSE
            THEN 'owner_mismatch'
          WHEN current_partition.epoch_matches_caller IS FALSE
            THEN 'epoch_mismatch'
          WHEN current_partition.lease_expired_at_observation IS TRUE
            THEN 'lease_expired'
          ELSE 'unknown_denial'
        END AS denial_classification
      FROM current_partition
      LEFT JOIN latest_checkpoint ON TRUE
      LEFT JOIN latest_running_run ON TRUE
      LEFT JOIN running_run_count ON TRUE
    `) as Array<Record<string, unknown>>;

    if (!row) return null;

    return {
      currentPartitionStatus:
        typeof row.current_partition_status === "string" ? row.current_partition_status : null,
      currentLeaseOwner: typeof row.current_lease_owner === "string" ? row.current_lease_owner : null,
      currentLeaseEpoch:
        typeof row.current_lease_epoch === "number" ? row.current_lease_epoch : toNumber(row.current_lease_epoch),
      currentLeaseExpiresAt: normalizeTimestamp(row.current_lease_expires_at),
      ownerMatchesCaller: parseNullableBoolean(row.owner_matches_caller),
      epochMatchesCaller: parseNullableBoolean(row.epoch_matches_caller),
      leaseExpiredAtObservation: parseNullableBoolean(row.lease_expired_at_observation),
      currentPartitionFinishedAt: normalizeTimestamp(row.current_partition_finished_at),
      latestCheckpointScope:
        typeof row.latest_checkpoint_scope === "string" ? row.latest_checkpoint_scope : null,
      latestCheckpointPhase:
        typeof row.latest_checkpoint_phase === "string" ? row.latest_checkpoint_phase : null,
      latestCheckpointUpdatedAt: normalizeTimestamp(row.latest_checkpoint_updated_at),
      latestRunningRunId: typeof row.latest_running_run_id === "string" ? row.latest_running_run_id : null,
      runningRunCount: toNumber(row.running_run_count),
      denialClassification:
        typeof row.denial_classification === "string"
          ? (row.denial_classification as MetaCompletionDenialClassification)
          : "unknown_denial",
    } satisfies MetaPartitionCompletionDenialSnapshot;
  } catch (error) {
    console.warn("[meta-sync] partition_completion_denial_observability_failed", {
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function writeMetaPartitionCompletionObservability(input: {
  partitionId: string;
  runId?: string | null;
  recoveredRunId?: string | null;
  workerId: string;
  leaseEpoch: number;
  lane?: MetaSyncLane | null;
  scope?: MetaWarehouseScope | null;
  partitionStatus: Extract<MetaPartitionStatus, "succeeded" | "failed" | "dead_letter" | "cancelled">;
  runStatus: MetaSyncRunRecord["status"];
  observabilityPath?: MetaRunObservabilityPath | null;
}) {
  const sql = getDb();
  try {
    const [latestRow] = (await sql`
      SELECT id::text AS latest_running_run_id
      FROM meta_sync_runs
      WHERE partition_id = ${input.partitionId}::uuid
        AND status = 'running'
      ORDER BY created_at DESC
      LIMIT 1
    `) as Array<{ latest_running_run_id?: string | null }>;

    const observedLatestRunningRunId =
      typeof latestRow?.latest_running_run_id === "string" ? latestRow.latest_running_run_id : null;
    const callerRunIdMatchedLatestRunningRunId =
      input.runId && observedLatestRunningRunId ? input.runId === observedLatestRunningRunId : null;

    if (!observedLatestRunningRunId) {
      return {
        observedLatestRunningRunId: null,
        callerRunIdMatchedLatestRunningRunId,
      };
    }

    await sql`
      UPDATE meta_sync_runs run
      SET
        meta_json = COALESCE(run.meta_json, '{}'::jsonb) || jsonb_build_object(
          'runLeakObservability',
          jsonb_strip_nulls(
            jsonb_build_object(
              'callerRunId', ${input.runId ?? null}::text,
              'recoveredRunId', ${input.recoveredRunId ?? null}::text,
              'latestRunningRunId', ${observedLatestRunningRunId}::text,
              'callerRunIdMatchedLatestRunningRunId', ${callerRunIdMatchedLatestRunningRunId}::boolean,
              'pathKind', ${input.observabilityPath ?? null}::text,
              'workerId', ${input.workerId}::text,
              'leaseEpoch', ${input.leaseEpoch}::bigint,
              'lane', ${input.lane ?? null}::text,
              'scope', ${input.scope ?? null}::text,
              'partitionStatus', ${input.partitionStatus}::text,
              'runStatusBefore', 'running',
              'runStatusAfter', ${input.runStatus}::text,
              'observedAt', now()
            )
          )
        )
      WHERE run.id = ${observedLatestRunningRunId}::uuid
    `;

    return {
      observedLatestRunningRunId,
      callerRunIdMatchedLatestRunningRunId,
    };
  } catch (error) {
    console.warn("[meta-sync] partition_completion_observability_failed", {
      partitionId: input.partitionId,
      runId: input.runId ?? null,
      recoveredRunId: input.recoveredRunId ?? null,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      lane: input.lane ?? null,
      scope: input.scope ?? null,
      partitionStatus: input.partitionStatus,
      runStatusBefore: "running",
      runStatusAfter: input.runStatus,
      pathKind: input.observabilityPath ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      observedLatestRunningRunId: null,
      callerRunIdMatchedLatestRunningRunId: null,
    };
  }
}

export async function backfillMetaRunningRunsForTerminalPartition(input: {
  partitionId: string;
  runId?: string | null;
  recoveredRunId?: string | null;
}) {
  const sql = getDb();
  const [row] = (await sql`
    WITH input_values AS (
      SELECT
        ${input.partitionId}::uuid AS partition_id,
        ${input.runId ?? input.recoveredRunId ?? null}::uuid AS effective_run_id
    ),
    terminal_partition AS (
      SELECT
        partition.status::text AS partition_status,
        partition.last_error::text AS partition_last_error,
        partition.finished_at AS partition_finished_at
      FROM meta_sync_partitions partition
      CROSS JOIN input_values
      WHERE partition.id = input_values.partition_id
        AND partition.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
    ),
    updated_runs AS (
      UPDATE meta_sync_runs run
      SET
        status = CASE
          WHEN terminal_partition.partition_status = 'succeeded' THEN 'succeeded'
          WHEN terminal_partition.partition_status = 'cancelled' THEN 'cancelled'
          ELSE 'failed'
        END,
        error_class = CASE
          WHEN terminal_partition.partition_status IN ('succeeded', 'cancelled') THEN NULL
          WHEN terminal_partition.partition_status = 'dead_letter'
            THEN COALESCE(run.error_class, 'dead_letter')
          ELSE COALESCE(run.error_class, 'failed')
        END,
        error_message = CASE
          WHEN terminal_partition.partition_status IN ('succeeded', 'cancelled') THEN NULL
          WHEN terminal_partition.partition_status = 'dead_letter'
            THEN COALESCE(
              terminal_partition.partition_last_error,
              run.error_message,
              'partition already dead_letter'
            )
          ELSE COALESCE(
            terminal_partition.partition_last_error,
            run.error_message,
            'partition already failed'
          )
        END,
        finished_at = COALESCE(run.finished_at, terminal_partition.partition_finished_at, now()),
        duration_ms = COALESCE(
          run.duration_ms,
          GREATEST(
            0,
            FLOOR(
              EXTRACT(
                EPOCH FROM (
                  COALESCE(terminal_partition.partition_finished_at, now()) -
                  COALESCE(run.started_at, run.created_at)
                )
              ) * 1000
            )::int
          )
        ),
        meta_json = COALESCE(run.meta_json, '{}'::jsonb) || jsonb_build_object(
          'decisionCaller', 'backfillMetaRunningRunsForTerminalPartition',
          'closureReason', CASE
            WHEN terminal_partition.partition_status = 'succeeded' THEN 'partition_already_succeeded'
            WHEN terminal_partition.partition_status = 'failed' THEN 'partition_already_failed'
            WHEN terminal_partition.partition_status = 'dead_letter' THEN 'partition_already_dead_letter'
            ELSE 'partition_already_cancelled'
          END
        ),
        updated_at = now()
      FROM terminal_partition
      CROSS JOIN input_values
      WHERE run.partition_id = input_values.partition_id
        AND run.status = 'running'
      RETURNING
        run.id AS run_id_uuid,
        run.id::text AS run_id,
        terminal_partition.partition_status
    ),
    updated_summary AS (
      SELECT
        COALESCE(MAX(partition_status), (SELECT partition_status FROM terminal_partition LIMIT 1)) AS partition_status,
        COUNT(*)::int AS closed_running_run_count,
        CASE
          WHEN (SELECT effective_run_id FROM input_values) IS NULL THEN NULL
          ELSE BOOL_OR(run_id_uuid = (SELECT effective_run_id FROM input_values))
        END AS caller_run_id_was_closed
      FROM updated_runs
    ),
    capped_run_ids AS (
      SELECT run_id
      FROM updated_runs
      ORDER BY run_id
      LIMIT 10
    )
    SELECT
      (SELECT partition_status FROM updated_summary) AS partition_status,
      COALESCE((SELECT closed_running_run_count FROM updated_summary), 0) AS closed_running_run_count,
      (SELECT caller_run_id_was_closed FROM updated_summary) AS caller_run_id_was_closed,
      COALESCE((SELECT json_agg(run_id ORDER BY run_id) FROM capped_run_ids), '[]'::json) AS closed_running_run_ids
  `) as Array<Record<string, unknown>>;

  return {
    partitionStatus:
      typeof row?.partition_status === "string" ? row.partition_status : null,
    closedRunningRunCount: toNumber(row?.closed_running_run_count),
    callerRunIdWasClosed: parseNullableBoolean(row?.caller_run_id_was_closed),
    closedRunningRunIds: parseStringArray(row?.closed_running_run_ids),
  };
}

export async function completeMetaPartitionAttempt(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  partitionStatus: Extract<MetaPartitionStatus, "succeeded" | "failed" | "dead_letter" | "cancelled">;
  runId?: string | null;
  runStatus?: MetaSyncRunRecord["status"];
  durationMs?: number | null;
  errorClass?: string | null;
  errorMessage?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  retryDelayMinutes?: number;
  lane?: MetaSyncLane | null;
  scope?: MetaWarehouseScope | null;
  observabilityPath?: MetaRunObservabilityPath | null;
  recoveredRunId?: string | null;
}): Promise<MetaPartitionAttemptCompletionResult> {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const runStatus =
    input.runStatus ??
    (input.partitionStatus === "succeeded"
      ? "succeeded"
      : input.partitionStatus === "cancelled"
        ? "cancelled"
        : "failed");
  const rows = await sql`
    WITH input_values AS (
      SELECT
        ${input.partitionStatus}::text AS partition_status,
        ${input.retryDelayMinutes ?? 5}::int AS retry_delay_minutes,
        ${input.lastError ?? null}::text AS last_error,
        ${input.finishedAt ?? null}::timestamptz AS finished_at,
        ${input.partitionId}::uuid AS partition_id,
        ${input.workerId}::text AS worker_id,
        ${input.leaseEpoch}::bigint AS lease_epoch,
        ${input.runId ?? null}::uuid AS run_id,
        ${input.runId ?? input.recoveredRunId ?? null}::uuid AS effective_run_id,
        ${runStatus}::text AS run_status,
        ${input.durationMs ?? null}::int AS duration_ms,
        ${input.errorClass ?? null}::text AS error_class,
        ${input.errorMessage ?? null}::text AS error_message
    ),
    completed_partition AS (
      UPDATE meta_sync_partitions partition
      SET
        status = input_values.partition_status,
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_retry_at = CASE
          WHEN input_values.partition_status = 'failed'
            THEN now() + (input_values.retry_delay_minutes || ' minutes')::interval
          ELSE NULL
        END,
        last_error = input_values.last_error,
        finished_at = CASE
          WHEN input_values.partition_status IN ('succeeded', 'dead_letter', 'cancelled')
            THEN COALESCE(input_values.finished_at, now())
          ELSE partition.finished_at
        END,
        updated_at = now()
      FROM input_values
      WHERE partition.id = input_values.partition_id
        AND partition.lease_owner = input_values.worker_id
        AND partition.lease_epoch = input_values.lease_epoch
        AND COALESCE(partition.lease_expires_at, now()) > now()
      RETURNING partition.id
    ),
    candidate_checkpoints AS (
      SELECT
        checkpoint.id,
        checkpoint.checkpoint_scope,
        checkpoint.phase AS previous_phase
      FROM meta_sync_checkpoints checkpoint
      JOIN completed_partition partition
        ON partition.id = checkpoint.partition_id
      CROSS JOIN input_values
      WHERE input_values.partition_status = 'succeeded'
        AND COALESCE(checkpoint.lease_epoch, 0) = input_values.lease_epoch
        AND checkpoint.status = 'running'
    ),
    closed_checkpoints AS (
      UPDATE meta_sync_checkpoints checkpoint
      SET
        status = 'succeeded',
        phase = 'finalize',
        next_page_url = NULL,
        provider_cursor = NULL,
        finished_at = COALESCE(checkpoint.finished_at, now()),
        updated_at = now()
      FROM candidate_checkpoints candidate
      WHERE checkpoint.id = candidate.id
      RETURNING
        candidate.checkpoint_scope,
        candidate.previous_phase
    ),
    grouped_closed_checkpoints AS (
      SELECT
        checkpoint_scope,
        previous_phase,
        COUNT(*)::int AS row_count
      FROM closed_checkpoints
      GROUP BY checkpoint_scope, previous_phase
    ),
    updated_runs AS (
      UPDATE meta_sync_runs run
      SET
        status = input_values.run_status,
        duration_ms = COALESCE(input_values.duration_ms, run.duration_ms),
        error_class = CASE
          WHEN input_values.run_status IN ('succeeded', 'cancelled') THEN NULL
          ELSE COALESCE(input_values.error_class, run.error_class)
        END,
        error_message = CASE
          WHEN input_values.run_status IN ('succeeded', 'cancelled') THEN NULL
          ELSE COALESCE(input_values.error_message, run.error_message)
        END,
        finished_at = COALESCE(input_values.finished_at, now()),
        updated_at = now()
      FROM completed_partition partition
      CROSS JOIN input_values
      WHERE run.partition_id = partition.id
        AND run.status = 'running'
      RETURNING
        run.id AS run_id_uuid,
        run.id::text AS run_id
    ),
    updated_run_summary AS (
      SELECT
        COUNT(*)::int AS closed_running_run_count,
        CASE
          WHEN (SELECT effective_run_id FROM input_values) IS NULL THEN NULL
          ELSE BOOL_OR(run_id_uuid = (SELECT effective_run_id FROM input_values))
        END AS caller_run_id_was_closed
      FROM updated_runs
    ),
    capped_updated_run_ids AS (
      SELECT run_id
      FROM updated_runs
      ORDER BY run_id
      LIMIT 10
    )
    SELECT
      EXISTS(SELECT 1 FROM completed_partition) AS completed,
      EXISTS(SELECT 1 FROM updated_runs) AS run_updated,
      COALESCE((SELECT closed_running_run_count FROM updated_run_summary), 0) AS closed_running_run_count,
      (SELECT caller_run_id_was_closed FROM updated_run_summary) AS caller_run_id_was_closed,
      COALESCE((SELECT json_agg(run_id ORDER BY run_id) FROM capped_updated_run_ids), '[]'::json)
        AS closed_running_run_ids,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'checkpointScope', checkpoint_scope,
              'previousPhase', previous_phase,
              'count', row_count
            )
            ORDER BY checkpoint_scope, previous_phase
          )
          FROM grouped_closed_checkpoints
        ),
        '[]'::json
      ) AS closed_checkpoint_groups
  ` as Array<Record<string, unknown>>;

  const row = rows[0] ?? {};
  if (!Boolean(row.completed)) {
    return {
      ok: false,
      reason: "lease_conflict",
    };
  }

  const closedCheckpointGroups = parseMetaClosedCheckpointGroups(row.closed_checkpoint_groups);
  const closedRunningRunCount = toNumber(row.closed_running_run_count);
  const callerRunIdWasClosed = parseNullableBoolean(row.caller_run_id_was_closed);
  const closedRunningRunIds = parseStringArray(row.closed_running_run_ids);
  if (input.partitionStatus === "succeeded" && closedCheckpointGroups.length > 0) {
    logRuntimeInfo("meta-sync", "partition_success_closed_open_checkpoints", {
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      closedCheckpointGroups,
    });
  }
  if (closedRunningRunCount > 0) {
    logRuntimeInfo("meta-sync", "partition_completion_closed_running_runs", {
      partitionId: input.partitionId,
      runId: input.runId ?? null,
      recoveredRunId: input.recoveredRunId ?? null,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      lane: input.lane ?? null,
      scope: input.scope ?? null,
      partitionStatus: input.partitionStatus,
      runStatusBefore: "running",
      runStatusAfter: runStatus,
      pathKind: input.observabilityPath ?? null,
      closedRunningRunCount,
      callerRunIdWasClosed,
      closedRunningRunIds,
    });
  }
  const {
    observedLatestRunningRunId,
    callerRunIdMatchedLatestRunningRunId,
  } = await writeMetaPartitionCompletionObservability({
    partitionId: input.partitionId,
    runId: input.runId ?? null,
    recoveredRunId: input.recoveredRunId ?? null,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    lane: input.lane ?? null,
    scope: input.scope ?? null,
    partitionStatus: input.partitionStatus,
    runStatus,
    observabilityPath: input.observabilityPath ?? null,
  });
  if (!Boolean(row.run_updated)) {
    console.warn("[meta-sync] partition_completion_run_update_zero_rows", {
      partitionId: input.partitionId,
      runId: input.runId ?? null,
      recoveredRunId: input.recoveredRunId ?? null,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      lane: input.lane ?? null,
      scope: input.scope ?? null,
      partitionStatus: input.partitionStatus,
      runStatusBefore: "running",
      runStatusAfter: runStatus,
      pathKind: input.observabilityPath ?? null,
      closedRunningRunCount,
      callerRunIdWasClosed,
      closedRunningRunIds,
      observedLatestRunningRunId,
      callerRunIdMatchedLatestRunningRunId,
    });
  }

  return {
    ok: true,
    runUpdated: Boolean(row.run_updated),
    closedRunningRunCount,
    callerRunIdWasClosed,
    closedRunningRunIds,
    closedCheckpointGroups,
    observedLatestRunningRunId,
    callerRunIdMatchedLatestRunningRunId,
  };
}

export async function completeMetaPartition(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  status: Extract<MetaPartitionStatus, "succeeded" | "failed" | "dead_letter" | "cancelled">;
  lastError?: string | null;
  retryDelayMinutes?: number;
}) {
  const result = await completeMetaPartitionAttempt({
    partitionId: input.partitionId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    partitionStatus: input.status,
    lastError: input.lastError ?? null,
    retryDelayMinutes: input.retryDelayMinutes,
  });
  return result.ok;
}

async function readMetaReclaimCandidates(input: {
  businessId: string;
  timeoutMs?: number;
}) {
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  return (await sql`
    SELECT
      partition.id,
      partition.lane,
      partition.scope,
      partition.updated_at,
      partition.started_at,
      partition.lease_owner,
      partition.lease_expires_at,
      checkpoint.checkpoint_scope,
      checkpoint.phase,
      checkpoint.page_index,
      checkpoint.updated_at AS checkpoint_updated_at,
      EXISTS (
        SELECT 1
        FROM sync_runner_leases lease
        WHERE lease.business_id = partition.business_id
          AND lease.provider_scope = 'meta'
          AND lease.lease_owner = partition.lease_owner
          AND lease.lease_expires_at > now()
      ) AS has_matching_runner_lease
    FROM meta_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT checkpoint_scope, phase, page_index, updated_at
      FROM meta_sync_checkpoints checkpoint
      WHERE checkpoint.partition_id = partition.id
        AND COALESCE(checkpoint.lease_epoch, 0) = COALESCE(partition.lease_epoch, 0)
      ORDER BY checkpoint.updated_at DESC
      LIMIT 1
    ) checkpoint ON TRUE
    WHERE partition.business_id = ${input.businessId}
      AND partition.status IN ('leased', 'running')
  `) as MetaReclaimCandidateRow[];
}

function classifyMetaReclaimCandidate(input: {
  row: MetaReclaimCandidateRow;
  nowMs: number;
  staleThresholdMs: number;
  preservedByReason?: MetaCleanupPreservedByReason;
}): ProviderReclaimDecision {
  const progressMs = parseTimestampMs(input.row.checkpoint_updated_at);
  const leaseExpiresMs = parseTimestampMs(input.row.lease_expires_at);
  const startedMs = parseTimestampMs(input.row.started_at);
  const updatedMs = parseTimestampMs(input.row.updated_at);
  const orphanedLeaseGraceMs = Math.min(input.staleThresholdMs, 90_000);
  const hasRecentProgress =
    progressMs != null && input.nowMs - progressMs <= input.staleThresholdMs;
  const hasMatchingRunnerLease = Boolean(input.row.has_matching_runner_lease);
  const leaseNotExpired = leaseExpiresMs != null && leaseExpiresMs > input.nowMs;
  const leaseWithoutWorkerAgeMs =
    startedMs != null
      ? input.nowMs - startedMs
      : updatedMs != null
        ? input.nowMs - updatedMs
        : null;

  if (hasRecentProgress) {
    if (input.preservedByReason) {
      input.preservedByReason.recentCheckpointProgress += 1;
    }
    return {
      disposition: "alive_slow",
      reasonCode: "progress_recently_advanced",
      detail: "Recent checkpoint progress detected; keeping partition leased.",
    };
  }
  if (hasMatchingRunnerLease) {
    if (input.preservedByReason) {
      input.preservedByReason.matchingRunnerLeasePresent += 1;
    }
    return {
      disposition: "alive_slow",
      reasonCode: "active_worker_lease_present",
      detail: "Matching Meta runner lease is still active.",
    };
  }
  if (
    leaseNotExpired &&
    leaseWithoutWorkerAgeMs != null &&
    leaseWithoutWorkerAgeMs <= orphanedLeaseGraceMs
  ) {
    if (input.preservedByReason) {
      input.preservedByReason.leaseNotExpired += 1;
    }
    return {
      disposition: "alive_slow",
      reasonCode: "lease_not_expired",
      detail: "Partition lease is still within the initial reclaim grace window.",
    };
  }
  return {
    disposition: "stalled_reclaimable",
    reasonCode: leaseNotExpired ? "runner_lease_missing_no_progress" : "lease_expired_no_progress",
    detail: leaseNotExpired
      ? "Partition lease remained active without a matching runner lease or checkpoint progress."
      : "Partition lease expired without recent checkpoint progress.",
  };
}

export async function getMetaReclaimClassificationSummary(input: {
  businessId: string;
  staleLeaseMinutes?: number;
  timeoutMs?: number;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const staleThresholdMs = Math.max(1, input.staleLeaseMinutes ?? 8) * 60_000;
  const candidates = await readMetaReclaimCandidates({
    businessId: input.businessId,
    timeoutMs: input.timeoutMs,
  });
  const counts: Record<ProviderReclaimDisposition, number> = {
    alive_slow: 0,
    stalled_reclaimable: 0,
    poison_candidate: 0,
  };
  const nowMs = Date.now();
  for (const row of candidates) {
    const decision = classifyMetaReclaimCandidate({
      row,
      nowMs,
      staleThresholdMs,
    });
    tallyDisposition(counts, decision.disposition);
  }
  return {
    candidateCount: candidates.length,
    aliveSlowCount: counts.alive_slow,
    reclaimCandidateCount: counts.stalled_reclaimable,
  };
}

export async function cleanupMetaPartitionOrchestration(input: {
  businessId: string;
  staleLeaseMinutes?: number;
  staleRunMinutes?: number;
  staleRunMinutesByLane?: Partial<Record<MetaSyncLane, number>>;
  runProgressGraceMinutes?: number;
  staleLegacyMinutes?: number;
}) {
    // Admission BEFORE the first orchestration write.
  //
  // Cleanup reclaims leases, cancels runs and rewrites partition status. That is
  // a mutation of the exact state a closed lane or an exhausted capacity budget
  // is trying to hold still, and it runs on the worker, on cron and from the
  // admin recovery endpoint alike. Admitting at the callers only would leave
  // whichever caller was added next unguarded.
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_partition_cleanup", { fresh: true });
await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const staleThresholdMs = Math.max(1, input.staleLeaseMinutes ?? 8) * 60_000;
  const candidates = await readMetaReclaimCandidates({ businessId: input.businessId });

  const now = Date.now();
  const dispositionCounts: Record<ProviderReclaimDisposition, number> = {
    alive_slow: 0,
    stalled_reclaimable: 0,
    poison_candidate: 0,
  };
  const preservedByReason: MetaCleanupPreservedByReason = {
    recentCheckpointProgress: 0,
    matchingRunnerLeasePresent: 0,
    leaseNotExpired: 0,
  };
  const stalledDecisions: Array<ProviderReclaimDecision & { partitionId: string }> = [];

  for (const row of candidates) {
    const partitionId = String(row.id);
    const decision = classifyMetaReclaimCandidate({
      row,
      nowMs: now,
      staleThresholdMs,
      preservedByReason,
    });
    tallyDisposition(dispositionCounts, decision.disposition);
    if (decision.disposition === "stalled_reclaimable") {
      stalledDecisions.push({ partitionId, ...decision });
    }
  }

  const stalePartitionIds = stalledDecisions.map((row) => row.partitionId);
  let reconciledRunCount = 0;
  if (stalePartitionIds.length > 0) {
    await sql`
      UPDATE meta_sync_partitions
      SET
        status = 'failed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_retry_at = now() + interval '3 minutes',
        last_error = COALESCE(last_error, 'stalled partition reclaimed automatically'),
        updated_at = now()
      WHERE id = ANY(${stalePartitionIds}::uuid[])
    `;
    const reconciledRuns = await sql`
      UPDATE meta_sync_runs run
      SET
        status = 'failed',
        error_class = COALESCE(error_class, 'stale_run'),
        error_message = COALESCE(error_message, 'stale partition run closed automatically'),
        finished_at = COALESCE(finished_at, now()),
        duration_ms = COALESCE(
          duration_ms,
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(run.started_at, run.created_at))) * 1000))::int
        ),
        meta_json = COALESCE(run.meta_json, '{}'::jsonb) || jsonb_build_object(
          'decisionCaller', 'cleanupMetaPartitionOrchestration',
          'closureReason', 'partition_reclaimed',
          'partitionReclaimed', true
        ),
        updated_at = now()
      WHERE run.business_id = ${input.businessId}
        AND run.partition_id = ANY(${stalePartitionIds}::uuid[])
        AND run.status = 'running'
      RETURNING run.id
    ` as Array<Record<string, unknown>>;
    reconciledRunCount = reconciledRuns.length;
    for (const decision of stalledDecisions) {
      await recordSyncReclaimEvents({
        providerScope: "meta",
        businessId: input.businessId,
        partitionIds: [decision.partitionId],
        eventType: "reclaimed",
        disposition: decision.disposition,
        reasonCode: decision.reasonCode,
        detail: decision.detail,
      }).catch(() => null);
    }
  }

  const staleLegacyRows = await sql`
    UPDATE meta_sync_jobs
    SET
      status = 'failed',
      last_error = COALESCE(last_error, 'legacy meta sync job expired automatically'),
      finished_at = now(),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND status = 'running'
      AND started_at < now() - (${input.staleLegacyMinutes ?? 15} || ' minutes')::interval
    RETURNING id
  ` as Array<Record<string, unknown>>;

  const staleRunMinutesCore = Math.max(
    1,
    input.staleRunMinutesByLane?.core ?? input.staleRunMinutes ?? 12
  );
  const staleRunMinutesMaintenance = Math.max(
    1,
    input.staleRunMinutesByLane?.maintenance ?? Math.max(staleRunMinutesCore, 15)
  );
  const staleRunMinutesExtended = Math.max(
    1,
    input.staleRunMinutesByLane?.extended ?? Math.max(staleRunMinutesMaintenance, 25)
  );
  const runProgressGraceMinutes = Math.max(1, input.runProgressGraceMinutes ?? 3);
  const staleRunRows = await sql`
    WITH stale_candidates AS (
      SELECT
        run.id,
        run.partition_id,
        run.worker_id,
        run.lane,
        COALESCE(run.started_at, run.created_at) AS started_at,
        partition.status AS partition_status,
        partition.last_error AS partition_last_error,
        partition.finished_at AS partition_finished_at,
        partition.lease_epoch AS partition_lease_epoch,
        checkpoint.phase AS checkpoint_phase,
        checkpoint.updated_at AS progress_updated_at,
        lease.lease_owner AS active_lease_owner,
        lease.updated_at AS lease_updated_at,
        lease.lease_expires_at AS lease_expires_at,
        CASE
          WHEN run.lane = 'core' THEN ${staleRunMinutesCore}
          WHEN run.lane = 'maintenance' THEN ${staleRunMinutesMaintenance}
          ELSE ${staleRunMinutesExtended}
        END AS stale_threshold_minutes,
        (partition.id IS NULL OR partition.status NOT IN ('leased', 'running')) AS partition_state_invalid
      FROM meta_sync_runs run
      LEFT JOIN meta_sync_partitions partition
        ON partition.id = run.partition_id
      LEFT JOIN LATERAL (
        SELECT checkpoint.phase, checkpoint.updated_at
        FROM meta_sync_checkpoints checkpoint
        WHERE checkpoint.partition_id = run.partition_id
          AND (
            partition.id IS NULL
            OR COALESCE(checkpoint.lease_epoch, 0) = COALESCE(partition.lease_epoch, 0)
          )
        ORDER BY checkpoint.updated_at DESC
        LIMIT 1
      ) checkpoint ON TRUE
      LEFT JOIN LATERAL (
        SELECT lease.lease_owner, lease.updated_at, lease.lease_expires_at
        FROM sync_runner_leases lease
        WHERE lease.business_id = run.business_id
          AND lease.provider_scope = 'meta'
        ORDER BY lease.updated_at DESC
        LIMIT 1
      ) lease ON TRUE
      WHERE run.business_id = ${input.businessId}
        AND run.status = 'running'
    )
    UPDATE meta_sync_runs run
    SET
      status = CASE
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'succeeded'
          THEN 'succeeded'
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'cancelled'
          THEN 'cancelled'
        ELSE 'failed'
      END,
      error_class = CASE
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status IN ('succeeded', 'cancelled')
          THEN NULL
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'dead_letter'
          THEN COALESCE(error_class, 'dead_letter')
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'failed'
          THEN COALESCE(error_class, 'failed')
        ELSE COALESCE(error_class, 'stale_run')
      END,
      error_message = CASE
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status IN ('succeeded', 'cancelled')
          THEN NULL
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'dead_letter'
          THEN COALESCE(
            stale_candidates.partition_last_error,
            error_message,
            'partition already dead_letter'
          )
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'failed'
          THEN COALESCE(
            stale_candidates.partition_last_error,
            error_message,
            'partition already failed'
          )
        ELSE COALESCE(error_message, 'stale partition run closed automatically')
      END,
      finished_at = COALESCE(finished_at, stale_candidates.partition_finished_at, now()),
      duration_ms = COALESCE(
        duration_ms,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(run.started_at, run.created_at))) * 1000))::int
      ),
      meta_json = COALESCE(run.meta_json, '{}'::jsonb) || jsonb_build_object(
        'decisionCaller', 'cleanupMetaPartitionOrchestration',
        'checkpointPhase', stale_candidates.checkpoint_phase,
        'staleThresholdMs', (stale_candidates.stale_threshold_minutes::int * 60000),
        'runAgeMs', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - stale_candidates.started_at)) * 1000))::int,
        'leaseAgeMs', CASE
          WHEN stale_candidates.lease_updated_at IS NULL THEN NULL
          ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - stale_candidates.lease_updated_at)) * 1000))::int
        END,
        'heartbeatAgeMs', CASE
          WHEN stale_candidates.progress_updated_at IS NULL THEN NULL
          ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - stale_candidates.progress_updated_at)) * 1000))::int
        END,
        'runnerLeaseSeen', COALESCE(stale_candidates.lease_expires_at > now(), false),
        'closureReason', CASE
          WHEN stale_candidates.partition_state_invalid
            AND stale_candidates.partition_status = 'succeeded'
            THEN 'partition_already_succeeded'
          WHEN stale_candidates.partition_state_invalid
            AND stale_candidates.partition_status = 'failed'
            THEN 'partition_already_failed'
          WHEN stale_candidates.partition_state_invalid
            AND stale_candidates.partition_status = 'dead_letter'
            THEN 'partition_already_dead_letter'
          WHEN stale_candidates.partition_state_invalid
            AND stale_candidates.partition_status = 'cancelled'
            THEN 'partition_already_cancelled'
          ELSE 'lane_stale_threshold_exceeded'
        END
      ),
      updated_at = now()
    FROM stale_candidates
    WHERE run.id = stale_candidates.id
      AND (
        COALESCE(run.started_at, run.created_at) <
          now() - ((stale_candidates.stale_threshold_minutes)::text || ' minutes')::interval
        OR stale_candidates.partition_state_invalid
      )
      AND NOT (
        stale_candidates.active_lease_owner IS NOT NULL
        AND stale_candidates.active_lease_owner = run.worker_id
        AND stale_candidates.lease_expires_at > now()
      )
      AND NOT (
        stale_candidates.progress_updated_at IS NOT NULL
        AND stale_candidates.progress_updated_at >
          now() - (${runProgressGraceMinutes} || ' minutes')::interval
      )
    RETURNING run.id
  ` as Array<Record<string, unknown>>;

  return {
    candidateCount: candidates.length,
    stalePartitionCount: stalePartitionIds.length,
    aliveSlowCount: dispositionCounts.alive_slow,
    reconciledRunCount,
    staleRunCount: staleRunRows.length,
    staleLegacyCount: staleLegacyRows.length,
    reclaimReasons: {
      stalledReclaimable: stalledDecisions.map((row) => row.reasonCode),
    },
    preservedByReason,
  } satisfies MetaCleanupSummary;
}

export async function createMetaSyncRun(input: MetaSyncRunRecord) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  await sql`
    UPDATE meta_sync_runs
    SET
      status = 'cancelled',
      error_class = COALESCE(error_class, 'superseded_attempt'),
      error_message = COALESCE(error_message, 'partition attempt was superseded by a newer worker'),
      finished_at = COALESCE(finished_at, now()),
      duration_ms = COALESCE(
        duration_ms,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(started_at, created_at))) * 1000))::int
      ),
      updated_at = now()
    WHERE partition_id = ${input.partitionId}
      AND status = 'running'
  `;
  const rows = await sql`
    INSERT INTO meta_sync_runs (
      partition_id,
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      lane,
      scope,
      partition_date,
      status,
      worker_id,
      attempt_count,
      row_count,
      duration_ms,
      error_class,
      error_message,
      meta_json,
      started_at,
      finished_at,
      updated_at
    )
    VALUES (
      ${input.partitionId},
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${input.lane},
      ${input.scope},
      ${normalizeDate(input.partitionDate)},
      ${input.status},
      ${input.workerId ?? null},
      ${input.attemptCount},
      ${input.rowCount ?? null},
      ${input.durationMs ?? null},
      ${input.errorClass ?? null},
      ${input.errorMessage ?? null},
      ${JSON.stringify(input.metaJson ?? {})}::jsonb,
      COALESCE(${input.startedAt ?? null}, now()),
      ${input.finishedAt ?? null},
      now()
    )
    ON CONFLICT (partition_id)
      WHERE status = 'running'
    DO UPDATE SET
      business_id = EXCLUDED.business_id,
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_sync_runs.business_ref_id),
      provider_account_id = EXCLUDED.provider_account_id,
      provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_sync_runs.provider_account_ref_id),
      lane = EXCLUDED.lane,
      scope = EXCLUDED.scope,
      partition_date = EXCLUDED.partition_date,
      worker_id = EXCLUDED.worker_id,
      attempt_count = GREATEST(meta_sync_runs.attempt_count, EXCLUDED.attempt_count),
      meta_json = EXCLUDED.meta_json,
      updated_at = now()
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function updateMetaSyncRun(input: {
  id: string;
  status: MetaSyncRunRecord["status"];
  rowCount?: number | null;
  durationMs?: number | null;
  errorClass?: string | null;
  errorMessage?: string | null;
  metaJson?: Record<string, unknown>;
  finishedAt?: string | null;
  onlyIfCurrentStatus?: MetaSyncRunRecord["status"] | null;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  await sql`
    UPDATE meta_sync_runs
    SET
      status = ${input.status},
      row_count = COALESCE(${input.rowCount ?? null}, row_count),
      duration_ms = COALESCE(${input.durationMs ?? null}, duration_ms),
      error_class = CASE
        WHEN ${input.status} = 'succeeded' THEN NULL
        ELSE COALESCE(${input.errorClass ?? null}, error_class)
      END,
      error_message = CASE
        WHEN ${input.status} = 'succeeded' THEN NULL
        ELSE COALESCE(${input.errorMessage ?? null}, error_message)
      END,
      meta_json = COALESCE(${input.metaJson ? JSON.stringify(input.metaJson) : null}::jsonb, meta_json),
      finished_at = COALESCE(${input.finishedAt ?? null}, finished_at),
      updated_at = now()
    WHERE id = ${input.id}
      AND (${input.onlyIfCurrentStatus ?? null}::text IS NULL OR status = ${input.onlyIfCurrentStatus ?? null})
  `;
}

export async function getLatestRunningMetaSyncRunIdForPartition(input: {
  partitionId: string;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT id
    FROM meta_sync_runs
    WHERE partition_id = ${input.partitionId}
      AND status = 'running'
    ORDER BY created_at DESC
    LIMIT 1
  ` as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export function buildMetaSyncCheckpointHash(input: {
  partitionId: string;
  checkpointScope: string;
  phase: string;
  pageIndex: number;
  nextPageUrl?: string | null;
  providerCursor?: string | null;
}) {
  return createHash("sha1")
    .update(
      JSON.stringify({
        partitionId: input.partitionId,
        checkpointScope: input.checkpointScope,
        phase: input.phase,
        pageIndex: input.pageIndex,
        nextPageUrl: input.nextPageUrl ?? null,
        providerCursor: input.providerCursor ?? null,
      })
    )
    .digest("hex");
}

export async function upsertMetaSyncCheckpoint(input: MetaSyncCheckpointRecord) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const normalizedLeaseEpoch =
    input.leaseEpoch == null ? null : Math.max(0, Math.trunc(input.leaseEpoch));
  const checkpointHash =
    input.checkpointHash ??
    buildMetaSyncCheckpointHash({
      partitionId: input.partitionId,
      checkpointScope: input.checkpointScope,
      phase: input.phase,
      pageIndex: input.pageIndex,
      nextPageUrl: input.nextPageUrl ?? null,
      providerCursor: input.providerCursor ?? null,
    });
  const rows = await sql`
    WITH owner_guard AS (
      SELECT id
      FROM meta_sync_partitions
      WHERE id = ${input.partitionId}
        AND (
          ${input.leaseOwner ?? null}::text IS NULL
          OR (
            lease_owner = ${input.leaseOwner ?? null}
            AND ${normalizedLeaseEpoch}::bigint IS NOT NULL
            AND COALESCE(lease_epoch, 0) = ${normalizedLeaseEpoch}::bigint
            AND COALESCE(lease_expires_at, now() - interval '1 second') > now()
          )
        )
    )
    INSERT INTO meta_sync_checkpoints (
      partition_id,
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      checkpoint_scope,
      run_id,
      phase,
      status,
      page_index,
      next_page_url,
      provider_cursor,
      rows_fetched,
      rows_written,
      last_successful_entity_key,
      last_response_headers,
      checkpoint_hash,
      attempt_count,
      retry_after_at,
      lease_epoch,
      lease_owner,
      lease_expires_at,
      started_at,
      finished_at,
      updated_at
    )
    SELECT
      ${input.partitionId},
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${input.checkpointScope},
      ${input.runId ?? null},
      ${input.phase},
      ${input.status},
      ${input.pageIndex},
      ${input.nextPageUrl ?? null},
      ${input.providerCursor ?? null},
      ${input.rowsFetched ?? 0},
      ${input.rowsWritten ?? 0},
      ${input.lastSuccessfulEntityKey ?? null},
      ${JSON.stringify(input.lastResponseHeaders ?? {})}::jsonb,
      ${checkpointHash},
      ${input.attemptCount},
      ${input.retryAfterAt ?? null},
      ${normalizedLeaseEpoch},
      ${input.leaseOwner ?? null},
      ${input.leaseExpiresAt ?? null},
      ${input.startedAt ?? null},
      ${input.finishedAt ?? null},
      now()
    FROM owner_guard
    ON CONFLICT (partition_id, checkpoint_scope)
    DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_sync_checkpoints.business_ref_id),
      provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_sync_checkpoints.provider_account_ref_id),
      phase = EXCLUDED.phase,
      status = EXCLUDED.status,
      run_id = EXCLUDED.run_id,
      page_index = EXCLUDED.page_index,
      next_page_url = EXCLUDED.next_page_url,
      provider_cursor = EXCLUDED.provider_cursor,
      rows_fetched = EXCLUDED.rows_fetched,
      rows_written = EXCLUDED.rows_written,
      last_successful_entity_key = EXCLUDED.last_successful_entity_key,
      last_response_headers = EXCLUDED.last_response_headers,
      checkpoint_hash = EXCLUDED.checkpoint_hash,
      attempt_count = EXCLUDED.attempt_count,
      retry_after_at = EXCLUDED.retry_after_at,
      lease_epoch = EXCLUDED.lease_epoch,
      lease_owner = EXCLUDED.lease_owner,
      lease_expires_at = EXCLUDED.lease_expires_at,
      started_at = COALESCE(meta_sync_checkpoints.started_at, EXCLUDED.started_at, now()),
      finished_at = EXCLUDED.finished_at,
      updated_at = now()
    WHERE EXISTS (SELECT 1 FROM owner_guard)
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function upsertMetaSyncPhaseTiming(input: MetaSyncPhaseTimingRecord) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const normalizedLeaseEpoch =
    input.leaseEpoch == null ? null : Math.max(0, Math.trunc(input.leaseEpoch));
  const rows = await sql`
    WITH owner_guard AS (
      SELECT id
      FROM meta_sync_partitions
      WHERE id = ${input.partitionId}
        AND (
          ${input.leaseOwner ?? null}::text IS NULL
          OR (
            lease_owner = ${input.leaseOwner ?? null}
            AND ${normalizedLeaseEpoch}::bigint IS NOT NULL
            AND COALESCE(lease_epoch, 0) = ${normalizedLeaseEpoch}::bigint
            AND COALESCE(lease_expires_at, now() - interval '1 second') > now()
          )
        )
    )
    INSERT INTO meta_sync_phase_timings (
      partition_id,
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      timing_scope,
      run_id,
      phase,
      status,
      rows_fetched,
      rows_written,
      attempt_count,
      lease_epoch,
      lease_owner,
      lease_expires_at,
      started_at,
      finished_at,
      updated_at
    )
    SELECT
      ${input.partitionId},
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${input.timingScope},
      ${input.runId ?? null},
      ${input.phase},
      ${input.status},
      ${input.rowsFetched ?? 0},
      ${input.rowsWritten ?? 0},
      ${input.attemptCount},
      ${normalizedLeaseEpoch},
      ${input.leaseOwner ?? null},
      ${input.leaseExpiresAt ?? null},
      ${input.startedAt ?? null},
      ${input.finishedAt ?? null},
      now()
    FROM owner_guard
    ON CONFLICT (partition_id, timing_scope)
    DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_sync_phase_timings.business_ref_id),
      provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_sync_phase_timings.provider_account_ref_id),
      run_id = EXCLUDED.run_id,
      phase = EXCLUDED.phase,
      status = EXCLUDED.status,
      rows_fetched = EXCLUDED.rows_fetched,
      rows_written = EXCLUDED.rows_written,
      attempt_count = EXCLUDED.attempt_count,
      lease_epoch = EXCLUDED.lease_epoch,
      lease_owner = EXCLUDED.lease_owner,
      lease_expires_at = EXCLUDED.lease_expires_at,
      started_at = COALESCE(meta_sync_phase_timings.started_at, EXCLUDED.started_at, now()),
      finished_at = EXCLUDED.finished_at,
      updated_at = now()
    WHERE EXISTS (SELECT 1 FROM owner_guard)
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

function roundMetaPhaseTimingMetric(value: number | null, digits = 1) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeNullableMetric(value: unknown) {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getMetaSyncPhaseTimingSummaries(input: {
  businessId: string;
  providerAccountId?: string | null;
  windowHours?: number;
}): Promise<MetaSyncPhaseTimingSummary[]> {
  await assertMetaRequestReadTablesReady(
    ["meta_sync_phase_timings"],
    "meta_sync_phase_timing_summaries",
  );
  const sql = getDbWithTimeout(30_000);
  const windowHours = Math.max(1, Math.trunc(input.windowHours ?? 24));
  const rows = await sql`
    WITH samples AS (
      SELECT
        phase,
        timing_scope,
        rows_fetched,
        rows_written,
        finished_at,
        updated_at,
        GREATEST(
          EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000.0,
          1
        ) AS duration_ms,
        CASE
          WHEN phase = 'fetch_raw' THEN rows_fetched
          ELSE rows_written
        END AS throughput_rows,
        CASE
          WHEN phase = 'fetch_raw' THEN 'rows_fetched'
          ELSE 'rows_written'
        END AS throughput_basis
      FROM meta_sync_phase_timings
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND status = 'succeeded'
        AND started_at IS NOT NULL
        AND finished_at IS NOT NULL
        AND updated_at >= now() - (${windowHours} * interval '1 hour')
    ),
    aggregates AS (
      SELECT
        phase,
        COUNT(*)::int AS run_count,
        AVG(duration_ms)::float8 AS avg_duration_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p50_duration_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p95_duration_ms,
        MAX(duration_ms)::float8 AS max_duration_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY CASE
            WHEN throughput_rows > 0 THEN throughput_rows / GREATEST(duration_ms / 1000.0, 0.001)
            ELSE NULL
          END
        )::float8 AS p50_rows_per_second
      FROM samples
      GROUP BY phase
    ),
    latest AS (
      SELECT DISTINCT ON (phase)
        phase,
        timing_scope,
        finished_at,
        rows_fetched,
        rows_written,
        throughput_basis,
        duration_ms::float8 AS latest_duration_ms,
        CASE
          WHEN throughput_rows > 0
            THEN throughput_rows / GREATEST(duration_ms / 1000.0, 0.001)
          ELSE NULL
        END::float8 AS latest_rows_per_second
      FROM samples
      ORDER BY phase, finished_at DESC, updated_at DESC
    )
    SELECT
      aggregates.phase,
      aggregates.run_count,
      aggregates.avg_duration_ms,
      aggregates.p50_duration_ms,
      aggregates.p95_duration_ms,
      aggregates.max_duration_ms,
      aggregates.p50_rows_per_second,
      latest.timing_scope,
      latest.finished_at,
      latest.rows_fetched,
      latest.rows_written,
      latest.latest_duration_ms,
      latest.latest_rows_per_second,
      latest.throughput_basis
    FROM aggregates
    JOIN latest USING (phase)
    ORDER BY CASE aggregates.phase
      WHEN 'fetch_raw' THEN 1
      WHEN 'bulk_upsert' THEN 2
      WHEN 'finalize' THEN 3
      WHEN 'publish' THEN 4
      ELSE 9
    END
  ` as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    phase: String(row.phase) as MetaSyncPhaseTimingPhase,
    runCount: toNumber(row.run_count),
    timingScope: row.timing_scope ? String(row.timing_scope) : null,
    latestFinishedAt: normalizeTimestamp(row.finished_at),
    latestDurationMs: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.latest_duration_ms)),
    avgDurationMs: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.avg_duration_ms)),
    p50DurationMs: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.p50_duration_ms)),
    p95DurationMs: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.p95_duration_ms)),
    maxDurationMs: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.max_duration_ms)),
    throughputBasis:
      String(row.throughput_basis) === "rows_fetched" ? "rows_fetched" : "rows_written",
    latestRowsFetched: toNumber(row.rows_fetched),
    latestRowsWritten: toNumber(row.rows_written),
    latestRowsPerSecond: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.latest_rows_per_second)),
    p50RowsPerSecond: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.p50_rows_per_second)),
  }));
}

export async function listMetaSyncPhaseTimingSummariesByBusiness(input: {
  businessIds: string[];
  windowHours?: number;
}): Promise<Record<string, MetaSyncPhaseTimingSummary[]>> {
  const businessIds = Array.from(
    new Set(
      (input.businessIds ?? []).map((businessId) => String(businessId).trim()).filter(Boolean),
    ),
  );
  if (businessIds.length === 0) return {};
  await assertMetaRequestReadTablesReady(
    ["meta_sync_phase_timings"],
    "meta_sync_phase_timing_summaries_by_business",
  );
  const sql = getDbWithTimeout(30_000);
  const windowHours = Math.max(1, Math.trunc(input.windowHours ?? 24));
  const rows = await sql`
    WITH samples AS (
      SELECT
        business_id::text AS business_id,
        phase,
        timing_scope,
        rows_fetched,
        rows_written,
        finished_at,
        updated_at,
        GREATEST(
          EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000.0,
          1
        ) AS duration_ms,
        CASE
          WHEN phase = 'fetch_raw' THEN rows_fetched
          ELSE rows_written
        END AS throughput_rows,
        CASE
          WHEN phase = 'fetch_raw' THEN 'rows_fetched'
          ELSE 'rows_written'
        END AS throughput_basis
      FROM meta_sync_phase_timings
      WHERE business_id = ANY(${businessIds}::text[])
        AND status = 'succeeded'
        AND started_at IS NOT NULL
        AND finished_at IS NOT NULL
        AND updated_at >= now() - (${windowHours} * interval '1 hour')
    ),
    aggregates AS (
      SELECT
        business_id,
        phase,
        COUNT(*)::int AS run_count,
        AVG(duration_ms)::float8 AS avg_duration_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p50_duration_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p95_duration_ms,
        MAX(duration_ms)::float8 AS max_duration_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY CASE
            WHEN throughput_rows > 0 THEN throughput_rows / GREATEST(duration_ms / 1000.0, 0.001)
            ELSE NULL
          END
        )::float8 AS p50_rows_per_second
      FROM samples
      GROUP BY business_id, phase
    ),
    latest AS (
      SELECT DISTINCT ON (business_id, phase)
        business_id,
        phase,
        timing_scope,
        finished_at,
        rows_fetched,
        rows_written,
        throughput_basis,
        duration_ms::float8 AS latest_duration_ms,
        CASE
          WHEN throughput_rows > 0
            THEN throughput_rows / GREATEST(duration_ms / 1000.0, 0.001)
          ELSE NULL
        END::float8 AS latest_rows_per_second
      FROM samples
      ORDER BY business_id, phase, finished_at DESC, updated_at DESC
    )
    SELECT
      aggregates.business_id,
      aggregates.phase,
      aggregates.run_count,
      aggregates.avg_duration_ms,
      aggregates.p50_duration_ms,
      aggregates.p95_duration_ms,
      aggregates.max_duration_ms,
      aggregates.p50_rows_per_second,
      latest.timing_scope,
      latest.finished_at,
      latest.rows_fetched,
      latest.rows_written,
      latest.latest_duration_ms,
      latest.latest_rows_per_second,
      latest.throughput_basis
    FROM aggregates
    JOIN latest
      ON latest.business_id = aggregates.business_id
     AND latest.phase = aggregates.phase
    ORDER BY aggregates.business_id,
      CASE aggregates.phase
        WHEN 'fetch_raw' THEN 1
        WHEN 'bulk_upsert' THEN 2
        WHEN 'finalize' THEN 3
        WHEN 'publish' THEN 4
        ELSE 9
      END
  ` as Array<Record<string, unknown>>;

  return rows.reduce<Record<string, MetaSyncPhaseTimingSummary[]>>((accumulator, row) => {
    const businessId = String(row.business_id);
    const summary: MetaSyncPhaseTimingSummary = {
      phase: String(row.phase) as MetaSyncPhaseTimingPhase,
      runCount: toNumber(row.run_count),
      timingScope: row.timing_scope ? String(row.timing_scope) : null,
      latestFinishedAt: normalizeTimestamp(row.finished_at),
      latestDurationMs: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.latest_duration_ms)),
      avgDurationMs: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.avg_duration_ms)),
      p50DurationMs: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.p50_duration_ms)),
      p95DurationMs: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.p95_duration_ms)),
      maxDurationMs: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.max_duration_ms)),
      throughputBasis:
        String(row.throughput_basis) === "rows_fetched" ? "rows_fetched" : "rows_written",
      latestRowsFetched: toNumber(row.rows_fetched),
      latestRowsWritten: toNumber(row.rows_written),
      latestRowsPerSecond: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.latest_rows_per_second)),
      p50RowsPerSecond: roundMetaPhaseTimingMetric(normalizeNullableMetric(row.p50_rows_per_second)),
    };
    if (!accumulator[businessId]) accumulator[businessId] = [];
    accumulator[businessId].push(summary);
    return accumulator;
  }, {});
}

export async function getMetaSyncCheckpoint(input: {
  partitionId: string;
  checkpointScope: string;
  runId: string;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT *
    FROM meta_sync_checkpoints
    WHERE partition_id = ${input.partitionId}
      AND checkpoint_scope = ${input.checkpointScope}
      AND run_id = ${input.runId}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    partitionId: String(row.partition_id),
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    checkpointScope: String(row.checkpoint_scope),
    runId: row.run_id ? String(row.run_id) : null,
    phase: String(row.phase) as MetaSyncCheckpointRecord["phase"],
    status: String(row.status) as MetaSyncCheckpointRecord["status"],
    pageIndex: toNumber(row.page_index),
    nextPageUrl: row.next_page_url ? String(row.next_page_url) : null,
    providerCursor: row.provider_cursor ? String(row.provider_cursor) : null,
    rowsFetched: toNumber(row.rows_fetched),
    rowsWritten: toNumber(row.rows_written),
    lastSuccessfulEntityKey: row.last_successful_entity_key
      ? String(row.last_successful_entity_key)
      : null,
    lastResponseHeaders:
      row.last_response_headers && typeof row.last_response_headers === "object"
        ? (row.last_response_headers as Record<string, unknown>)
        : {},
    checkpointHash: row.checkpoint_hash ? String(row.checkpoint_hash) : null,
    attemptCount: toNumber(row.attempt_count),
    retryAfterAt: normalizeTimestamp(row.retry_after_at),
    leaseEpoch:
      row.lease_epoch == null ? null : toNumber(row.lease_epoch),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: normalizeTimestamp(row.lease_expires_at),
    startedAt: normalizeTimestamp(row.started_at),
    finishedAt: normalizeTimestamp(row.finished_at),
    createdAt: normalizeTimestamp(row.created_at) ?? undefined,
    updatedAt: normalizeTimestamp(row.updated_at) ?? undefined,
  } satisfies MetaSyncCheckpointRecord;
}

export async function getLatestMetaCheckpointForPartition(input: {
  partitionId: string;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT checkpoint_scope, phase, status, updated_at
    FROM meta_sync_checkpoints
    WHERE partition_id = ${input.partitionId}
    ORDER BY updated_at DESC
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    checkpointScope: row.checkpoint_scope ? String(row.checkpoint_scope) : null,
    phase: row.phase ? String(row.phase) : null,
    status: row.status ? String(row.status) : null,
    updatedAt: normalizeTimestamp(row.updated_at),
  };
}

export async function listMetaRawSnapshotsForRun(input: {
  partitionId: string;
  endpointName: string;
  runId: string;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  // Resume reads the receipt timeline for new rows and falls back to the
  // legacy column for pre-model ones. New canonical content carries no
  // partition_id — attribution lives on the receipt — so a partition-column
  // lookup alone would silently find nothing and report the run as having no
  // durable page, which surfaces as a checkpoint/raw mismatch and re-fetches
  // work that was already done.
  //
  // The receipt supplies the observation-scoped fields (page, cursor, status,
  // http status, request context) and the canonical row supplies the payload,
  // which is exactly how the two layers divide. The legacy arm is restricted to
  // `content_key IS NULL` so a new row can never be counted twice.
  return (sql`
    WITH resume_authority AS (
      -- Exactly ONE row per page. Receipts are append-only and deliberately
      -- retain every observation instant for point-in-time, so a retried page
      -- has two receipts and a superseded partition has a third — and resume
      -- validation rejects a duplicate page_index outright, which would break
      -- restore on exactly the runs that needed it most.
      --
      -- DISTINCT ON keeps the newest live receipt per page. The full timeline is
      -- untouched: this narrows the RESUME view, not the evidence.
      SELECT DISTINCT ON (receipt.page_index)
        receipt.snapshot_id,
        receipt.page_index,
        receipt.response_headers,
        receipt.provider_cursor,
        receipt.request_context,
        receipt.provider_http_status,
        receipt.status,
        receipt.observed_at
      FROM meta_raw_snapshot_observations receipt
      WHERE receipt.partition_id = ${input.partitionId}::uuid
        AND receipt.run_id = ${input.runId}
        AND receipt.endpoint_name = ${input.endpointName}
        -- A superseded page is retired evidence, not resumable work.
        AND receipt.status <> 'superseded'
      ORDER BY receipt.page_index, receipt.observed_at DESC, receipt.id DESC
    )
    SELECT
      snapshot.id,
      receipt.page_index,
      snapshot.payload_json,
      receipt.response_headers,
      receipt.provider_cursor,
      receipt.request_context,
      receipt.provider_http_status,
      receipt.status,
      receipt.observed_at AS fetched_at
    FROM resume_authority receipt
    JOIN meta_raw_snapshots snapshot ON snapshot.id = receipt.snapshot_id
    UNION ALL
    SELECT
      legacy.id,
      legacy.page_index,
      legacy.payload_json,
      legacy.response_headers,
      legacy.provider_cursor,
      legacy.request_context,
      legacy.provider_http_status,
      legacy.status,
      legacy.fetched_at
    FROM meta_raw_snapshots legacy
    WHERE legacy.content_key IS NULL
      AND legacy.partition_id = ${input.partitionId}::uuid
      AND legacy.run_id = ${input.runId}
      AND legacy.endpoint_name = ${input.endpointName}
    ORDER BY fetched_at ASC, id ASC
  ` as unknown) as Array<{
    id: string;
    page_index: number | null;
    payload_json: unknown;
    response_headers: Record<string, unknown> | null;
    provider_cursor: string | null;
    request_context: Record<string, unknown> | null;
    provider_http_status: number | null;
    status: string;
    fetched_at: string | null;
  }>;
}

/**
 * Supersede a partition's raw evidence.
 *
 * Under the two-layer model this is an EVENT, not a mutation: a new
 * `superseded` receipt is appended at the time it actually happened. Canonical
 * payload content is never touched, so
 *  - content shared with other partitions is unaffected;
 *  - earlier point-in-time truth is preserved — asking "what did this partition
 *    hold at t" before the supersede still answers correctly, which an in-place
 *    status flip would have destroyed.
 *
 * Legacy rows (written before the model, `content_key IS NULL`, carrying their
 * own `partition_id`) keep the original in-place behaviour, because they have
 * no receipts to append to. Both halves run, so a partition spanning the
 * cutover is fully superseded.
 */
export async function supersedeMetaRawSnapshotsForPartition(input: {
  partitionId: string;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  return runDbTransaction(async () => {
    const sql = getDb();
    const receiptRows = await sql`
      INSERT INTO meta_raw_snapshot_observations (
        snapshot_id, business_id, provider_account_id, partition_id, run_id,
        checkpoint_id, endpoint_name, entity_scope, page_index, provider_cursor,
        status, provider_http_status, request_context, response_headers,
        observed_at, first_observed_at, last_observed_at
      )
      -- DISTINCT ON: two receipts for the same page that differ only in status
      -- both collapse to one 'superseded' identity, and ON CONFLICT cannot
      -- arbitrate rows produced within a single statement.
      SELECT DISTINCT ON (
        source.snapshot_id, source.partition_id, source.run_id,
        source.checkpoint_id, source.page_index, source.provider_cursor
      )
        source.snapshot_id, source.business_id, source.provider_account_id,
        source.partition_id, source.run_id, source.checkpoint_id,
        source.endpoint_name, source.entity_scope, source.page_index,
        source.provider_cursor, 'superseded', source.provider_http_status,
        source.request_context, source.response_headers,
        now(), now(), now()
      FROM meta_raw_snapshot_observations source
      WHERE source.partition_id = ${input.partitionId}::uuid
        AND source.status <> 'superseded'
        AND NOT EXISTS (
          SELECT 1
          FROM meta_raw_snapshot_observations already
          WHERE already.snapshot_id = source.snapshot_id
            AND already.partition_id = source.partition_id
            AND already.status = 'superseded'
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    ` as Array<{ id: string }>;

    // Legacy rows have no receipts; keep the original in-place semantics for
    // them and only for them.
    const legacyRows = await sql`
      UPDATE meta_raw_snapshots
      SET status = 'superseded', updated_at = now()
      WHERE partition_id = ${input.partitionId}::uuid
        AND content_key IS NULL
        AND status <> 'superseded'
      RETURNING id
    ` as Array<{ id: string }>;

    return receiptRows.length + legacyRows.length;
  });
}

export async function deleteMetaSyncCheckpointsForPartition(input: {
  partitionId: string;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    DELETE FROM meta_sync_checkpoints
    WHERE partition_id = ${input.partitionId}::uuid
    RETURNING id
  ` as Array<{ id: string }>;
  return rows.length;
}

export async function heartbeatMetaPartitionLease(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  leaseMinutes?: number;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    UPDATE meta_sync_partitions partition
    SET
      lease_owner = ${input.workerId},
      lease_expires_at = now() + (${input.leaseMinutes ?? 5} || ' minutes')::interval,
      updated_at = now()
    WHERE partition.id = ${input.partitionId}
      AND partition.lease_owner = ${input.workerId}
      AND partition.lease_epoch = ${input.leaseEpoch}
      AND COALESCE(partition.lease_expires_at, now()) > now()
      AND EXISTS (
        SELECT 1
        FROM sync_runner_leases lease
        WHERE lease.business_id = partition.business_id
          AND lease.provider_scope = 'meta'
          AND lease.lease_owner = ${input.workerId}
          AND lease.lease_expires_at > now()
      )
    RETURNING partition.id AS id
  ` as Array<{ id: string }>;
  return rows.length > 0;
}

export async function releaseMetaLeasedPartitionsForWorker(input: {
  businessId: string;
  workerId: string;
  retryDelayMinutes?: number;
  lastError?: string | null;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    UPDATE meta_sync_partitions partition
    SET
      status = 'queued',
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = now(),
      last_error = COALESCE(
        ${input.lastError ?? null}::text,
        partition.last_error,
        'leased partition released automatically after worker exit'
      ),
      updated_at = now()
    WHERE partition.business_id = ${input.businessId}
      AND partition.lease_owner = ${input.workerId}
      AND partition.status = 'leased'
    RETURNING partition.id AS id
  ` as Array<{ id: string }>;
  return rows.length;
}

export async function upsertMetaSyncState(input: MetaSyncStateRecord) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  await sql`
    INSERT INTO meta_sync_state (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      scope,
      historical_target_start,
      historical_target_end,
      effective_target_start,
      effective_target_end,
      ready_through_date,
      last_successful_partition_date,
      latest_background_activity_at,
      latest_successful_sync_at,
      completed_days,
      dead_letter_count,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${input.scope},
      ${normalizeDate(input.historicalTargetStart)},
      ${normalizeDate(input.historicalTargetEnd)},
      ${normalizeDate(input.effectiveTargetStart)},
      ${normalizeDate(input.effectiveTargetEnd)},
      ${input.readyThroughDate ? normalizeDate(input.readyThroughDate) : null},
      ${input.lastSuccessfulPartitionDate ? normalizeDate(input.lastSuccessfulPartitionDate) : null},
      ${input.latestBackgroundActivityAt ?? null},
      ${input.latestSuccessfulSyncAt ?? null},
      ${input.completedDays},
      ${input.deadLetterCount},
      now()
    )
    ON CONFLICT (business_id, provider_account_id, scope)
    DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_sync_state.business_ref_id),
      provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_sync_state.provider_account_ref_id),
      historical_target_start = EXCLUDED.historical_target_start,
      historical_target_end = EXCLUDED.historical_target_end,
      effective_target_start = EXCLUDED.effective_target_start,
      effective_target_end = EXCLUDED.effective_target_end,
      ready_through_date = EXCLUDED.ready_through_date,
      last_successful_partition_date = EXCLUDED.last_successful_partition_date,
      latest_background_activity_at = EXCLUDED.latest_background_activity_at,
      latest_successful_sync_at = EXCLUDED.latest_successful_sync_at,
      completed_days = EXCLUDED.completed_days,
      dead_letter_count = EXCLUDED.dead_letter_count,
      updated_at = now()
  `;
}

/**
 * The canonical CONTENT identity of a raw snapshot.
 *
 * Deliberately excludes partition, run, checkpoint and cursor: those describe
 * WHO observed the payload, not what the payload is. It includes every scope
 * field that would otherwise collide across businesses, accounts, endpoints,
 * dates or pages, so two different things can never share one canonical row.
 *
 * Built in TypeScript and stored, rather than recomputed in SQL, for the same
 * reason the lineage hash is: jsonb reorders keys and JSON.stringify escaping
 * is not reproducible in PL/pgSQL, so a SQL-side rebuild would silently mis-key
 * some rows.
 */
export function buildMetaRawSnapshotContentKey(input: {
  businessId: string;
  providerAccountId: string;
  endpointName: string;
  entityScope: string;
  startDate: string;
  endDate: string;
  pageIndex?: number | null;
  payloadHash: string;
}): string {
  return [
    input.businessId,
    input.providerAccountId,
    input.endpointName,
    input.entityScope,
    normalizeDate(input.startDate),
    normalizeDate(input.endDate),
    String(input.pageIndex ?? -1),
    input.payloadHash,
    // Unit separator: a byte that cannot occur in any of the joined fields, so
    // adjacent components can never be re-partitioned into a different tuple
    // that hashes to the same key.
  ].join(String.fromCharCode(0x1f));
}

/**
 * Two-layer write: one immutable canonical content row, plus one append-only
 * observation receipt per (partition, run, checkpoint, page, cursor, status,
 * instant).
 *
 * Both happen in ONE transaction so a caller can never end up with content it
 * cannot attribute, or a receipt pointing at content that was rolled back. The
 * canonical content id is what is returned, because every existing typed
 * `source_snapshot_id` FK points at `meta_raw_snapshots(id)` and must keep
 * resolving unchanged.
 *
 * Concurrent identical content converges on one canonical row (the content
 * unique index arbitrates) while each distinct partition still records its own
 * receipt — that is what makes per-partition completion evidence survive
 * content sharing.
 */
export async function persistMetaRawSnapshot(input: MetaRawSnapshotRecord) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const refs = await resolveMetaRecordReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    accountCurrency: input.accountCurrency ?? null,
    accountTimezone: input.accountTimezone ?? null,
  });
  const contentKey = buildMetaRawSnapshotContentKey({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    endpointName: input.endpointName,
    entityScope: input.entityScope,
    startDate: input.startDate,
    endDate: input.endDate,
    pageIndex: input.pageIndex ?? null,
    payloadHash: input.payloadHash,
  });
  const observedAt = input.fetchedAt ?? null;

  return runDbTransaction(async () => {
    const sql = getDb();
    const contentRows = await sql`
      INSERT INTO meta_raw_snapshots (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        partition_id,
        checkpoint_id,
        run_id,
        endpoint_name,
        entity_scope,
        page_index,
        provider_cursor,
        start_date,
        end_date,
        account_timezone,
        account_currency,
        payload_json,
        payload_hash,
        content_key,
        request_context,
        response_headers,
        provider_http_status,
        status,
        fetched_at,
        first_observed_at,
        last_observed_at,
        updated_at
      )
      VALUES (
        ${input.businessId},
        ${refs.businessRefId},
        ${input.providerAccountId},
        ${refs.providerAccountRefId},
        -- Observation-scoped provenance is NULL on the content layer by
        -- construction. partition/checkpoint/run/cursor describe WHO observed
        -- this content and belong exclusively to the receipt; leaving them here
        -- would make shared content cascade-deletable from any one partition.
        NULL,
        NULL,
        NULL,
        ${input.endpointName},
        ${input.entityScope},
        ${input.pageIndex ?? null},
        NULL,
        ${normalizeDate(input.startDate)},
        ${normalizeDate(input.endDate)},
        ${input.accountTimezone},
        ${input.accountCurrency},
        ${JSON.stringify(input.payloadJson)}::jsonb,
        ${input.payloadHash},
        ${contentKey},
        ${JSON.stringify(input.requestContext ?? {})}::jsonb,
        ${JSON.stringify(input.responseHeaders ?? {})}::jsonb,
        ${input.providerHttpStatus},
        -- First-observation mirror only, kept so legacy column readers still
        -- see a status. It never participates in content identity and is never
        -- updated, so it is not lifecycle authority — the receipt timeline is.
        ${input.status},
        COALESCE(${observedAt}, now()),
        COALESCE(${observedAt}, now()),
        COALESCE(${observedAt}, now()),
        now()
      )
      ON CONFLICT (content_key) WHERE content_key IS NOT NULL
      DO UPDATE SET
        -- Content is immutable. fetched_at, first_observed_at and payload_json
        -- are never touched, so first-observation time survives and the
        -- canonical row keeps an exact earliest-known-at.
        last_observed_at = GREATEST(
          meta_raw_snapshots.last_observed_at,
          COALESCE(${observedAt}::timestamptz, now())
        ),
        observation_count = meta_raw_snapshots.observation_count + 1,
        updated_at = now()
      RETURNING id
    ` as Array<{ id: string }>;
    const snapshotId = contentRows[0]?.id ?? null;
    if (!snapshotId) return null;

    // The receipt. A repeat of the SAME observation heartbeats; a different
    // partition, run or instant is a distinct receipt and is never folded into
    // another.
    await sql`
      INSERT INTO meta_raw_snapshot_observations (
        snapshot_id,
        business_id,
        provider_account_id,
        partition_id,
        run_id,
        checkpoint_id,
        endpoint_name,
        entity_scope,
        page_index,
        provider_cursor,
        status,
        provider_http_status,
        request_context,
        response_headers,
        observed_at,
        first_observed_at,
        last_observed_at
      )
      VALUES (
        ${snapshotId}::uuid,
        ${input.businessId},
        ${input.providerAccountId},
        ${input.partitionId ?? null},
        ${input.runId ?? null},
        ${input.checkpointId ?? null},
        ${input.endpointName},
        ${input.entityScope},
        ${input.pageIndex ?? null},
        ${input.providerCursor ?? null},
        ${input.status},
        ${input.providerHttpStatus},
        ${JSON.stringify(input.requestContext ?? {})}::jsonb,
        ${JSON.stringify(input.responseHeaders ?? {})}::jsonb,
        COALESCE(${observedAt}, now()),
        COALESCE(${observedAt}, now()),
        COALESCE(${observedAt}, now())
      )
      ON CONFLICT (
        snapshot_id,
        COALESCE(partition_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(run_id, ''),
        COALESCE(checkpoint_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(page_index, -1),
        COALESCE(provider_cursor, ''),
        status,
        observed_at
      )
      DO UPDATE SET
        last_observed_at = GREATEST(
          meta_raw_snapshot_observations.last_observed_at,
          COALESCE(${observedAt}::timestamptz, now())
        ),
        observation_count = meta_raw_snapshot_observations.observation_count + 1,
        updated_at = now()
    `;

    return snapshotId;
  });
}

export async function getLatestMetaSyncHealth(input: {
  businessId: string;
  providerAccountId?: string | null;
  timeoutMs?: number;
}) {
  await assertMetaRequestReadTablesReady(
    ["meta_sync_runs", "meta_sync_partitions", "meta_sync_jobs"],
    "meta_latest_sync_health",
  );
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const [runRows, partitionRows, legacyRows] = await Promise.all([
    sql`
      SELECT
        id,
        provider_account_id,
        CASE
          WHEN lane = 'maintenance' AND scope = 'creative_daily' THEN 'incremental_recent'
          WHEN lane = 'maintenance' THEN 'today_refresh'
          ELSE 'initial_backfill'
        END AS sync_type,
        scope,
        partition_date AS start_date,
        partition_date AS end_date,
        'background_partition' AS trigger_source,
        created_at AS triggered_at,
        status,
        error_message AS last_error,
        NULL::double precision AS progress_percent,
        finished_at,
        started_at,
        updated_at
      FROM meta_sync_runs
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      ORDER BY updated_at DESC
      LIMIT 1
    `.catch(() => []) as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT
        id,
        provider_account_id,
        CASE
          WHEN lane = 'maintenance' AND source = 'today' THEN 'today_refresh'
          WHEN lane = 'maintenance' THEN 'incremental_recent'
          WHEN source = 'priority_window' THEN 'repair_window'
          ELSE 'initial_backfill'
        END AS sync_type,
        scope,
        partition_date AS start_date,
        partition_date AS end_date,
        source AS trigger_source,
        created_at AS triggered_at,
        status,
        last_error,
        NULL::double precision AS progress_percent,
        finished_at,
        started_at,
        updated_at
      FROM meta_sync_partitions
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      ORDER BY updated_at DESC
      LIMIT 1
    `.catch(() => []) as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT
        id,
        provider_account_id,
        sync_type,
        scope,
        start_date,
        end_date,
        trigger_source,
        triggered_at,
        status,
        last_error,
        progress_percent,
        finished_at,
        started_at,
        updated_at
      FROM meta_sync_jobs
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND trigger_source <> 'request_runtime'
      ORDER BY updated_at DESC
      LIMIT 1
    `.catch(() => []) as Promise<Array<Record<string, unknown>>>,
  ]);
  return runRows[0] ?? partitionRows[0] ?? legacyRows[0] ?? null;
}

export async function expireStaleMetaSyncJobs(input: {
  businessId?: string | null;
  staleAfterMinutes?: number;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const staleAfterMinutes = Math.max(10, Math.floor(input.staleAfterMinutes ?? 45));
  const rows = await sql`
    UPDATE meta_sync_jobs
    SET
      status = 'cancelled',
      last_error = COALESCE(last_error, 'Sync job expired after inactivity.'),
      finished_at = COALESCE(finished_at, now()),
      updated_at = now()
    WHERE status = 'running'
      AND (${input.businessId ?? null}::text IS NULL OR business_id = ${input.businessId ?? null})
      AND COALESCE(updated_at, started_at, triggered_at) < now() - (${staleAfterMinutes} || ' minutes')::interval
    RETURNING id
  ` as Array<{ id: string }>;
  return rows.length;
}

export async function hasBlockingMetaSyncJob(input: {
  businessId: string;
  syncTypes?: string[] | null;
  triggerSources?: string[] | null;
  excludeTriggerSources?: string[] | null;
  scopes?: string[] | null;
  lookbackMinutes?: number;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const lookbackMinutes = Math.max(5, Math.floor(input.lookbackMinutes ?? 90));
  const [jobRows, partitionRows] = await Promise.all([
    sql`
    SELECT id
    FROM meta_sync_jobs
    WHERE business_id = ${input.businessId}
      AND status = 'running'
      AND COALESCE(updated_at, started_at, triggered_at) > now() - (${lookbackMinutes} || ' minutes')::interval
      AND (
        ${input.syncTypes ?? null}::text[] IS NULL
        OR sync_type = ANY(${input.syncTypes ?? null}::text[])
      )
      AND (
        ${input.triggerSources ?? null}::text[] IS NULL
        OR trigger_source = ANY(${input.triggerSources ?? null}::text[])
      )
      AND (
        ${input.excludeTriggerSources ?? null}::text[] IS NULL
        OR NOT (trigger_source = ANY(${input.excludeTriggerSources ?? null}::text[]))
      )
      AND (
        ${input.scopes ?? null}::text[] IS NULL
        OR scope = ANY(${input.scopes ?? null}::text[])
      )
    LIMIT 1
  ` as unknown as Promise<Array<{ id: string }>>,
    sql`
      SELECT id
      FROM meta_sync_partitions
      WHERE business_id = ${input.businessId}
        AND status IN ('leased', 'running')
        AND updated_at > now() - (${lookbackMinutes} || ' minutes')::interval
        AND (
          ${input.scopes ?? null}::text[] IS NULL
          OR scope = ANY(${input.scopes ?? null}::text[])
        )
      LIMIT 1
    ` as unknown as Promise<Array<{ id: string }>>,
  ]);
  return jobRows.length > 0 || partitionRows.length > 0;
}

export async function getMetaSyncJobHealth(input: {
  businessId: string;
  staleAfterMinutes?: number;
}) {
  await assertMetaRequestReadTablesReady(
    ["meta_sync_jobs"],
    "meta_sync_job_health",
  );
  const sql = getDb();
  const staleAfterMinutes = Math.max(10, Math.floor(input.staleAfterMinutes ?? 45));
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'running')::int AS running_jobs,
      COUNT(*) FILTER (
        WHERE status = 'running'
          AND COALESCE(updated_at, started_at, triggered_at) < now() - (${staleAfterMinutes} || ' minutes')::interval
      )::int AS stale_running_jobs
    FROM meta_sync_jobs
    WHERE business_id = ${input.businessId}
  ` as Array<{
    running_jobs: number;
    stale_running_jobs: number;
  }>;
  return {
    runningJobs: rows[0]?.running_jobs ?? 0,
    staleRunningJobs: rows[0]?.stale_running_jobs ?? 0,
  };
}

export async function getMetaQueueHealth(input: {
  businessId: string;
  timeoutMs?: number;
}) {
  await assertMetaRequestReadTablesReady(
    ["meta_sync_partitions"],
    "meta_queue_health",
  );
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued') AS queue_depth,
      COUNT(*) FILTER (WHERE status IN ('leased', 'running')) AS leased_partitions,
      COUNT(*) FILTER (WHERE lane = 'core' AND status = 'queued') AS core_queue_depth,
      COUNT(*) FILTER (WHERE lane = 'core' AND status IN ('leased', 'running')) AS core_leased_partitions,
      COUNT(*) FILTER (
        WHERE lane = 'core'
          AND source IN ('historical', 'historical_recovery', 'initial_connect')
          AND status = 'queued'
      ) AS historical_core_queue_depth,
      COUNT(*) FILTER (
        WHERE lane = 'core'
          AND source IN ('historical', 'historical_recovery', 'initial_connect')
          AND status IN ('leased', 'running')
      ) AS historical_core_leased_partitions,
      COUNT(*) FILTER (WHERE lane = 'extended' AND status = 'queued') AS extended_queue_depth,
      COUNT(*) FILTER (WHERE lane = 'extended' AND status IN ('leased', 'running')) AS extended_leased_partitions,
      COUNT(*) FILTER (
        WHERE lane = 'extended'
          AND source IN ('recent', 'recent_recovery', 'repair_recent_day', 'today', 'today_observe', 'priority_window', 'finalize_day', 'request_runtime', 'manual_refresh')
          AND status = 'queued'
      ) AS extended_recent_queue_depth,
      COUNT(*) FILTER (
        WHERE lane = 'extended'
          AND source IN ('recent', 'recent_recovery', 'repair_recent_day', 'today', 'today_observe', 'priority_window', 'finalize_day', 'request_runtime', 'manual_refresh')
          AND status IN ('leased', 'running')
      ) AS extended_recent_leased_partitions,
      COUNT(*) FILTER (
        WHERE lane = 'extended'
          AND source IN ('historical', 'historical_recovery', 'initial_connect')
          AND status = 'queued'
      ) AS extended_historical_queue_depth,
      COUNT(*) FILTER (
        WHERE lane = 'extended'
          AND source IN ('historical', 'historical_recovery', 'initial_connect')
          AND status IN ('leased', 'running')
      ) AS extended_historical_leased_partitions,
      COUNT(*) FILTER (WHERE lane = 'maintenance' AND status = 'queued') AS maintenance_queue_depth,
      COUNT(*) FILTER (WHERE lane = 'maintenance' AND status IN ('leased', 'running')) AS maintenance_leased_partitions,
      COUNT(*) FILTER (WHERE status = 'failed') AS retryable_failed_partitions,
      COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_partitions,
      MIN(partition_date) FILTER (WHERE status = 'queued') AS oldest_queued_partition,
      MAX(updated_at) FILTER (WHERE lane = 'core') AS latest_core_activity_at,
      MAX(updated_at) FILTER (WHERE lane = 'extended') AS latest_extended_activity_at,
      MAX(updated_at) FILTER (WHERE lane = 'maintenance') AS latest_maintenance_activity_at
    FROM meta_sync_partitions
    WHERE business_id = ${input.businessId}
  ` as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  return {
    queueDepth: toNumber(row.queue_depth),
    leasedPartitions: toNumber(row.leased_partitions),
    coreQueueDepth: toNumber(row.core_queue_depth),
    coreLeasedPartitions: toNumber(row.core_leased_partitions),
    historicalCoreQueueDepth: toNumber(row.historical_core_queue_depth),
    historicalCoreLeasedPartitions: toNumber(row.historical_core_leased_partitions),
    extendedQueueDepth: toNumber(row.extended_queue_depth),
    extendedLeasedPartitions: toNumber(row.extended_leased_partitions),
    extendedRecentQueueDepth: toNumber(row.extended_recent_queue_depth),
    extendedRecentLeasedPartitions: toNumber(row.extended_recent_leased_partitions),
    extendedHistoricalQueueDepth: toNumber(row.extended_historical_queue_depth),
    extendedHistoricalLeasedPartitions: toNumber(row.extended_historical_leased_partitions),
    maintenanceQueueDepth: toNumber(row.maintenance_queue_depth),
    maintenanceLeasedPartitions: toNumber(row.maintenance_leased_partitions),
    retryableFailedPartitions: toNumber(row.retryable_failed_partitions),
    deadLetterPartitions: toNumber(row.dead_letter_partitions),
    oldestQueuedPartition: row.oldest_queued_partition ? normalizeDate(row.oldest_queued_partition) : null,
    latestCoreActivityAt: normalizeTimestamp(row.latest_core_activity_at),
    latestExtendedActivityAt: normalizeTimestamp(row.latest_extended_activity_at),
    latestMaintenanceActivityAt: normalizeTimestamp(row.latest_maintenance_activity_at),
  };
}

export interface MetaQueueCompositionSummary {
  historicalCoreQueued: number;
  maintenanceQueued: number;
  extendedRecentQueued: number;
  extendedHistoricalQueued: number;
}

export interface MetaQueueComposition {
  summary: MetaQueueCompositionSummary;
  statusCounts: Record<string, number>;
  laneSourceStatusCounts: Array<{
    lane: string;
    source: string;
    status: string;
    count: number;
  }>;
}

export async function getMetaQueueComposition(input: {
  businessId: string;
  timeoutMs?: number;
}): Promise<MetaQueueComposition> {
  await assertMetaRequestReadTablesReady(
    ["meta_sync_partitions"],
    "meta_queue_composition",
  );
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const [statusRows, breakdownRows] = (await Promise.all([
    sql`
      SELECT status, COUNT(*)::int AS count
      FROM meta_sync_partitions
      WHERE business_id = ${input.businessId}
      GROUP BY status
      ORDER BY status
    `,
    sql`
      SELECT lane, source, status, COUNT(*)::int AS count
      FROM meta_sync_partitions
      WHERE business_id = ${input.businessId}
      GROUP BY lane, source, status
      ORDER BY lane, source, status
    `,
  ])) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>];

  const normalizedBreakdown = breakdownRows.map((row) => ({
    lane: String(row.lane ?? ""),
    source: String(row.source ?? ""),
    status: String(row.status ?? ""),
    count: toNumber(row.count),
  }));

  return {
    summary: {
      historicalCoreQueued: normalizedBreakdown
        .filter(
          (row) =>
            row.lane === "core" &&
            row.status === "queued" &&
            ["historical", "historical_recovery", "initial_connect"].includes(row.source)
        )
        .reduce((sum, row) => sum + row.count, 0),
      maintenanceQueued: normalizedBreakdown
        .filter((row) => row.lane === "maintenance" && row.status === "queued")
        .reduce((sum, row) => sum + row.count, 0),
      extendedRecentQueued: normalizedBreakdown
        .filter(
          (row) =>
            row.lane === "extended" &&
            row.status === "queued" &&
            ["recent", "recent_recovery", "today", "priority_window", "request_runtime", "manual_refresh"].includes(
              row.source
            )
        )
        .reduce((sum, row) => sum + row.count, 0),
      extendedHistoricalQueued: normalizedBreakdown
        .filter(
          (row) =>
            row.lane === "extended" &&
            row.status === "queued" &&
            ["historical", "historical_recovery", "initial_connect"].includes(row.source)
        )
        .reduce((sum, row) => sum + row.count, 0),
    },
    statusCounts: Object.fromEntries(
      statusRows.map((row) => [String(row.status ?? "unknown"), toNumber(row.count)])
    ),
    laneSourceStatusCounts: normalizedBreakdown,
  };
}

export async function getMetaPartitionStatesForDate(input: {
  businessId: string;
  providerAccountId: string;
  lane: MetaSyncLane;
  partitionDate: string;
  scopes: MetaWarehouseScope[];
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT scope, status, source, finished_at
    FROM meta_sync_partitions
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND lane = ${input.lane}
      AND partition_date = ${normalizeDate(input.partitionDate)}
      AND scope = ANY(${input.scopes}::text[])
  ` as Array<Record<string, unknown>>;

  return new Map(
    rows.map((row) => [
      String(row.scope ?? ""),
      {
        status: String(row.status ?? ""),
        source: String(row.source ?? ""),
        finishedAt: normalizeTimestamp(row.finished_at),
      },
    ])
  );
}

export async function getMetaIncompleteCoreDates(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  limit?: number;
}) {
  return getMetaIncompleteCoverageDates({
    ...input,
    scopes: [...META_PRODUCT_CORE_COVERAGE_SCOPES],
  });
}

export async function getMetaIncompleteCoverageDates(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  scopes: MetaWarehouseScope[];
  limit?: number;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const scopes = Array.from(
    new Set(
      input.scopes.filter(
        (scope): scope is MetaWarehouseScope =>
          typeof scope === "string" && Boolean(META_DAILY_COVERAGE_TABLE_BY_SCOPE[scope])
      )
    )
  );
  if (scopes.length === 0) return [];

  const coverageCtes = scopes
    .map((scope) => {
      const tableName = META_DAILY_COVERAGE_TABLE_BY_SCOPE[scope];
      const alias = `${scope}_dates`;
      return `
      ${alias} AS (
        SELECT DISTINCT date::date AS day
        FROM ${tableName}
        WHERE business_id = $3
          AND ($4::text IS NULL OR provider_account_id = $4)
          AND date::date BETWEEN $1::date AND $2::date
        UNION
        SELECT DISTINCT partition_date::date AS day
        FROM meta_sync_partitions
        WHERE business_id = $3
          AND ($4::text IS NULL OR provider_account_id = $4)
          AND scope = '${scope}'
          AND status = 'succeeded'
          AND partition_date BETWEEN $1::date AND $2::date
      )`;
    })
    .join(",\n");
  const joins = scopes
    .map((scope) => {
      const alias = `${scope}_dates`;
      return `LEFT JOIN ${alias} ON ${alias}.day = target_dates.day`;
    })
    .join("\n      ");
  const missingCoveragePredicate = scopes
    .map((scope) => `${scope}_dates.day IS NULL`)
    .join("\n         OR ");
  const rows = await sql.query(
    `
      WITH target_dates AS (
        SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
      ),
      ${coverageCtes}
      SELECT target_dates.day::text AS partition_date
      FROM target_dates
      ${joins}
      WHERE ${missingCoveragePredicate}
      ORDER BY target_dates.day ASC
      LIMIT $5
    `,
    [
      normalizeDate(input.startDate),
      normalizeDate(input.endDate),
      input.businessId,
      input.providerAccountId ?? null,
      Math.max(1, input.limit ?? 100),
    ]
  ) as Array<Record<string, unknown>>;

  return rows
    .map((row) => normalizeDate(row.partition_date))
    .filter(Boolean);
}

export async function getMetaPartitionHealth(input: {
  businessId: string;
  providerAccountId?: string | null;
  scope?: MetaWarehouseScope | null;
  lane?: "core" | "extended" | "maintenance" | null;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued') AS queue_depth,
      COUNT(*) FILTER (WHERE status IN ('leased', 'running')) AS leased_partitions,
      COUNT(*) FILTER (WHERE status = 'failed') AS retryable_failed_partitions,
      COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_partitions,
      MIN(partition_date) FILTER (WHERE status = 'queued') AS oldest_queued_partition,
      MAX(updated_at) AS latest_activity_at
    FROM meta_sync_partitions
    WHERE business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      AND (${input.scope ?? null}::text IS NULL OR scope = ${input.scope ?? null})
      AND (${input.lane ?? null}::text IS NULL OR lane = ${input.lane ?? null})
  ` as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  return {
    queueDepth: toNumber(row.queue_depth),
    leasedPartitions: toNumber(row.leased_partitions),
    retryableFailedPartitions: toNumber(row.retryable_failed_partitions),
    deadLetterPartitions: toNumber(row.dead_letter_partitions),
    oldestQueuedPartition: row.oldest_queued_partition ? normalizeDate(row.oldest_queued_partition) : null,
    latestActivityAt: normalizeTimestamp(row.latest_activity_at),
  };
}

export async function requeueMetaRetryableFailedPartitions(input: {
  businessId: string;
  limit?: number;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    WITH candidates AS (
      SELECT partition.id
      FROM meta_sync_partitions partition
      LEFT JOIN LATERAL (
        SELECT run.error_class, run.error_message
        FROM meta_sync_runs run
        WHERE run.partition_id = partition.id
        ORDER BY run.updated_at DESC
        LIMIT 1
      ) latest_run ON true
      WHERE partition.business_id = ${input.businessId}
        AND partition.status = 'failed'
        AND COALESCE(partition.next_retry_at, now()) <= now()
        AND NOT (
          LOWER(COALESCE(latest_run.error_class, '')) = 'account_checkpoint'
          OR LOWER(COALESCE(partition.last_error, latest_run.error_message, '')) LIKE '%cannot access the app%'
          OR LOWER(COALESCE(partition.last_error, latest_run.error_message, '')) LIKE '%log in to www.facebook.com%'
          OR LOWER(COALESCE(partition.last_error, latest_run.error_message, '')) LIKE '%checkpoint%'
        )
      ORDER BY
        CASE source
          WHEN 'finalize_day' THEN 725
          WHEN 'priority_window' THEN 700
          WHEN 'repair_recent_day' THEN 690
          WHEN 'today_observe' THEN 660
          WHEN 'today' THEN 650
          WHEN 'request_runtime' THEN 625
          WHEN 'recent' THEN 600
          WHEN 'recent_recovery' THEN 550
          WHEN 'manual_refresh' THEN 525
          WHEN 'core_success' THEN 500
          WHEN 'initial_connect' THEN 250
          WHEN 'historical_recovery' THEN 200
          WHEN 'historical' THEN 150
          ELSE 100
        END DESC,
        partition_date DESC,
        updated_at ASC
      LIMIT ${Math.max(1, input.limit ?? 500)}
      FOR UPDATE OF partition SKIP LOCKED
    )
    UPDATE meta_sync_partitions partition
    SET
      status = 'queued',
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = now(),
      updated_at = now()
    FROM candidates
    WHERE partition.id = candidates.id
    RETURNING partition.id
  ` as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

type MetaCoverageResult = {
  completed_days: number;
  first_completed_date?: string | null;
  ready_through_date: string | null;
  latest_updated_at: string | null;
  total_rows: number;
};

type MetaRawSnapshotEndpointCoverage = {
  completed_days: number;
  first_completed_date?: string | null;
  ready_through_date: string | null;
};

async function getMetaCoverageForTable(input: {
  tableName: string;
  scope: MetaWarehouseScope;
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
}): Promise<MetaCoverageResult> {
  await assertMetaRequestReadTablesReady(
    [input.tableName, "meta_sync_partitions"],
    "meta_coverage",
  );
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const [rows, partitionRows] = await Promise.all([
    sql.query(
      `
        SELECT
          COUNT(DISTINCT date) AS completed_days,
          COALESCE(MIN(date), NULL) AS first_completed_date,
          COALESCE(MAX(date), NULL) AS ready_through_date,
          COALESCE(MAX(updated_at), NULL) AS latest_updated_at,
          COUNT(*) AS total_rows
        FROM ${input.tableName}
        WHERE business_id = $1
          AND date >= $2
          AND date <= $3
          AND ($4::text IS NULL OR provider_account_id = $4)
      `,
      [
        input.businessId,
        normalizeDate(input.startDate),
        normalizeDate(input.endDate),
        input.providerAccountId ?? null,
      ]
    ) as Promise<Array<Record<string, unknown>>>,
    sql.query(
      `
        SELECT
          COUNT(DISTINCT partition_date) AS completed_days,
          COALESCE(MIN(partition_date), NULL) AS first_completed_date,
          COALESCE(MAX(partition_date), NULL) AS ready_through_date,
          COALESCE(MAX(updated_at), NULL) AS latest_updated_at
        FROM meta_sync_partitions
        WHERE business_id = $1
          AND scope = $2
          AND partition_date >= $3
          AND partition_date <= $4
          AND status = 'succeeded'
          AND ($5::text IS NULL OR provider_account_id = $5)
      `,
      [
        input.businessId,
        input.scope,
        normalizeDate(input.startDate),
        normalizeDate(input.endDate),
        input.providerAccountId ?? null,
      ]
    ) as Promise<Array<Record<string, unknown>>>,
  ]);
  const row = rows[0] ?? {};
  const partitionRow = partitionRows[0] ?? {};
  const firstCompletedDate =
    [partitionRow.first_completed_date, row.first_completed_date]
      .filter(Boolean)
      .map((value) => normalizeDate(value))
      .sort((left, right) => left.localeCompare(right))[0] ?? null;
  return {
    completed_days: Math.max(toNumber(row.completed_days), toNumber(partitionRow.completed_days)),
    first_completed_date: firstCompletedDate,
    ready_through_date:
      partitionRow.ready_through_date || row.ready_through_date
        ? normalizeDate(partitionRow.ready_through_date ?? row.ready_through_date)
        : null,
    latest_updated_at:
      partitionRow.latest_updated_at || row.latest_updated_at
        ? normalizeTimestamp(partitionRow.latest_updated_at ?? row.latest_updated_at)
        : null,
    total_rows: toNumber(row.total_rows),
  };
}

export async function getMetaAccountDailyCoverage(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
}) {
  return getMetaCoverageForTable({
    tableName: "meta_account_daily",
    scope: "account_daily",
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    startDate: input.startDate,
    endDate: input.endDate,
    timeoutMs: input.timeoutMs,
  });
}

export async function getMetaCampaignDailyCoverage(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
}) {
  return getMetaCoverageForTable({
    tableName: "meta_campaign_daily",
    scope: "campaign_daily",
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    startDate: input.startDate,
    endDate: input.endDate,
    timeoutMs: input.timeoutMs,
  });
}

export async function getMetaAdSetDailyCoverage(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
}) {
  return getMetaCoverageForTable({
    tableName: "meta_adset_daily",
    scope: "adset_daily",
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    startDate: input.startDate,
    endDate: input.endDate,
    timeoutMs: input.timeoutMs,
  });
}

export async function getMetaAdDailyCoverage(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
}) {
  return getMetaCoverageForTable({
    tableName: "meta_ad_daily",
    scope: "ad_daily",
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    startDate: input.startDate,
    endDate: input.endDate,
    timeoutMs: input.timeoutMs,
  });
}

export async function getMetaCreativeDailyCoverage(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
}) {
  return getMetaCoverageForTable({
    tableName: "meta_creative_daily",
    scope: "creative_daily",
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    startDate: input.startDate,
    endDate: input.endDate,
    timeoutMs: input.timeoutMs,
  });
}

export async function getMetaAdDailyPreviewCoverage(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
}) {
  await assertMetaRequestReadTablesReady(
    ["meta_ad_daily"],
    "meta_ad_preview_coverage",
  );
  const sql = getDb();
  const rows = await sql`
    SELECT
      COUNT(*)::int AS total_rows,
      COUNT(*) FILTER (
        WHERE
          NULLIF(payload_json->>'preview_url', '') IS NOT NULL OR
          NULLIF(payload_json->>'thumbnail_url', '') IS NOT NULL OR
          NULLIF(payload_json->>'image_url', '') IS NOT NULL OR
          NULLIF(payload_json->'preview'->>'image_url', '') IS NOT NULL OR
          NULLIF(payload_json->'preview'->>'poster_url', '') IS NOT NULL OR
          NULLIF(payload_json->'preview'->>'video_url', '') IS NOT NULL
      )::int AS preview_ready_rows
    FROM meta_ad_daily
    WHERE business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      AND date::date BETWEEN ${normalizeDate(input.startDate)}::date AND ${normalizeDate(input.endDate)}::date
  ` as Array<{
    total_rows: number;
    preview_ready_rows: number;
  }>;
  const row = rows[0] ?? { total_rows: 0, preview_ready_rows: 0 };
  return {
    total_rows: Number(row.total_rows ?? 0),
    preview_ready_rows: Number(row.preview_ready_rows ?? 0),
  };
}

export async function getMetaCreativeMediaPreviewCoverage(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
}) {
  await assertMetaRequestReadTablesReady(
    ["meta_creative_daily", "meta_creative_media"],
    "meta_creative_media_preview_coverage",
  );
  const sql = getDb();
  const rows = await sql`
    SELECT
      COUNT(*)::int AS total_rows,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1
          FROM meta_creative_media media
          WHERE media.business_id = creative.business_id
            AND media.provider_account_id = creative.provider_account_id
            AND media.date = creative.date
            AND media.creative_id = creative.creative_id
            AND (
              NULLIF(media.preview_url, '') IS NOT NULL OR
              NULLIF(media.thumbnail_url, '') IS NOT NULL OR
              NULLIF(media.image_url, '') IS NOT NULL OR
              NULLIF(media.table_thumbnail_url, '') IS NOT NULL OR
              NULLIF(media.card_preview_url, '') IS NOT NULL OR
              NULLIF(media.video_url, '') IS NOT NULL OR
              NULLIF(media.poster_url, '') IS NOT NULL OR
              NULLIF(media.preview_html, '') IS NOT NULL OR
              NULLIF(media.payload_json->>'preview_url', '') IS NOT NULL OR
              NULLIF(media.payload_json->>'thumbnail_url', '') IS NOT NULL OR
              NULLIF(media.payload_json->>'image_url', '') IS NOT NULL OR
              NULLIF(media.payload_json->'preview'->>'image_url', '') IS NOT NULL OR
              NULLIF(media.payload_json->'preview'->>'poster_url', '') IS NOT NULL OR
              NULLIF(media.payload_json->'preview'->>'video_url', '') IS NOT NULL
            )
          )
      )::int AS preview_ready_rows
    FROM meta_creative_daily creative
    WHERE creative.business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR creative.provider_account_id = ${input.providerAccountId ?? null})
      AND creative.date::date BETWEEN ${normalizeDate(input.startDate)}::date AND ${normalizeDate(input.endDate)}::date
  ` as Array<{
    total_rows: number;
    preview_ready_rows: number;
  }>;
  const row = rows[0] ?? { total_rows: 0, preview_ready_rows: 0 };
  return {
    total_rows: Number(row.total_rows ?? 0),
    preview_ready_rows: Number(row.preview_ready_rows ?? 0),
  };
}

export async function getMetaRawSnapshotCoverageByEndpoint(input: {
  businessId: string;
  endpointNames: string[];
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
}): Promise<Map<string, MetaRawSnapshotEndpointCoverage>> {
  const endpointNames = Array.from(new Set(input.endpointNames.filter(Boolean)));
  if (endpointNames.length === 0) {
    return new Map<string, MetaRawSnapshotEndpointCoverage>();
  }

  await assertMetaRequestReadTablesReady(
    ["meta_raw_snapshots"],
    "meta_raw_snapshot_coverage",
  );
  const sql = getDb();
  const rows = await sql`
    SELECT
      endpoint_name,
      COUNT(DISTINCT start_date::date)::int AS completed_days,
      MIN(start_date::date)::text AS first_completed_date,
      MAX(start_date::date)::text AS ready_through_date
    FROM meta_raw_snapshots
    WHERE business_id = ${input.businessId}
      AND endpoint_name = ANY(${endpointNames}::text[])
      AND status = 'fetched'
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      AND start_date::date BETWEEN ${normalizeDate(input.startDate)}::date AND ${normalizeDate(input.endDate)}::date
      AND end_date::date BETWEEN ${normalizeDate(input.startDate)}::date AND ${normalizeDate(input.endDate)}::date
    GROUP BY endpoint_name
  ` as Array<{
    endpoint_name: string;
    completed_days: number;
    first_completed_date: string | null;
    ready_through_date: string | null;
  }>;

  const map = new Map<string, MetaRawSnapshotEndpointCoverage>();
  for (const endpointName of endpointNames) {
    map.set(endpointName, {
      completed_days: 0,
      first_completed_date: null,
      ready_through_date: null,
    });
  }
  for (const row of rows) {
    map.set(row.endpoint_name, {
      completed_days: Number(row.completed_days ?? 0),
      first_completed_date: row.first_completed_date ?? null,
      ready_through_date: row.ready_through_date ?? null,
    });
  }
  return map;
}

export async function getMetaBreakdownDailyCoverageByEndpoint(input: {
  businessId: string;
  endpointNames: string[];
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
}): Promise<Map<string, MetaRawSnapshotEndpointCoverage>> {
  const requestedEndpoints = Array.from(new Set(input.endpointNames.filter(Boolean)));
  const mappings = META_BREAKDOWN_ENDPOINT_COVERAGE_MAP.filter((mapping) =>
    requestedEndpoints.includes(mapping.endpointName)
  );
  const map = new Map<string, MetaRawSnapshotEndpointCoverage>();
  for (const endpointName of requestedEndpoints) {
    map.set(endpointName, {
      completed_days: 0,
      first_completed_date: null,
      ready_through_date: null,
    });
  }
  if (mappings.length === 0) return map;

  await assertMetaRequestReadTablesReady(
    ["meta_breakdown_daily", "meta_sync_partitions", "meta_sync_checkpoints", "meta_raw_snapshots"],
    "meta_breakdown_daily_endpoint_coverage",
  );
  const supportsTruthLifecycle = await hasMetaTruthLifecycleColumns();
  const truthPredicate = supportsTruthLifecycle
    ? "AND COALESCE(breakdown.truth_state, 'finalized') = 'finalized'"
    : "";
  const sql = getDb();
  const rows = await sql.query(
    `
      WITH requested AS (
        SELECT *
        FROM unnest($1::text[], $2::text[], $3::text[])
          AS requested(endpoint_name, breakdown_type, checkpoint_scope)
      ),
      coverage AS (
        SELECT
          requested.endpoint_name,
          breakdown.date::date AS day
        FROM requested
        JOIN meta_breakdown_daily breakdown
          ON breakdown.breakdown_type = requested.breakdown_type
        WHERE breakdown.business_id = $4
          AND ($5::text IS NULL OR breakdown.provider_account_id = $5)
          AND breakdown.date::date BETWEEN $6::date AND $7::date
          ${truthPredicate}
        UNION
        SELECT
          requested.endpoint_name,
          partition.partition_date::date AS day
        FROM requested
        JOIN meta_sync_partitions partition
          ON partition.business_id = $4
          AND ($5::text IS NULL OR partition.provider_account_id = $5)
          AND partition.partition_date::date BETWEEN $6::date AND $7::date
        JOIN meta_sync_checkpoints checkpoint
          ON checkpoint.partition_id = partition.id
          AND checkpoint.phase = 'finalize'
          AND checkpoint.status = 'succeeded'
          AND checkpoint.checkpoint_scope = requested.checkpoint_scope
        UNION
        SELECT
          requested.endpoint_name,
          snapshot.start_date::date AS day
        FROM requested
        JOIN meta_raw_snapshots snapshot
          ON snapshot.endpoint_name = requested.endpoint_name
        WHERE snapshot.business_id = $4
          AND ($5::text IS NULL OR snapshot.provider_account_id = $5)
          AND snapshot.status = 'fetched'
          AND snapshot.partition_id IS NULL
          AND snapshot.checkpoint_id IS NULL
          AND snapshot.run_id IS NULL
          AND snapshot.start_date::date BETWEEN $6::date AND $7::date
          AND snapshot.end_date::date BETWEEN $6::date AND $7::date
      )
      SELECT
        endpoint_name,
        COUNT(DISTINCT day)::int AS completed_days,
        MIN(day)::text AS first_completed_date,
        MAX(day)::text AS ready_through_date
      FROM coverage
      GROUP BY endpoint_name
    `,
    [
      mappings.map((mapping) => mapping.endpointName),
      mappings.map((mapping) => mapping.breakdownType),
      mappings.map((mapping) => mapping.checkpointScope),
      input.businessId,
      input.providerAccountId ?? null,
      normalizeDate(input.startDate),
      normalizeDate(input.endDate),
    ],
  ) as Array<{
    endpoint_name: string;
    completed_days: number;
    first_completed_date: string | null;
    ready_through_date: string | null;
  }>;

  for (const row of rows) {
    map.set(row.endpoint_name, {
      completed_days: Number(row.completed_days ?? 0),
      first_completed_date: row.first_completed_date ?? null,
      ready_through_date: row.ready_through_date ?? null,
    });
  }
  return map;
}

export type MetaRecoveryOutcome = "replayed" | "skipped_active_lease" | "no_matching_partitions";

export interface MetaRecoveryActionResult {
  outcome: MetaRecoveryOutcome;
  partitions: Array<{
    id: string;
    lane: string;
    scope: string;
    partitionDate: string;
  }>;
  matchedCount: number;
  changedCount: number;
  skippedActiveLeaseCount: number;
  replayableMatchedCount: number;
  terminalActionRequiredCount: number;
  unknownMatchedCount: number;
  manualTruthDefectCount: number;
  manualTruthDefectPartitions: Array<{
    id: string;
    scope: string;
    partitionDate: string;
    lastError: string | null;
  }>;
  actionRequiredPartitions: Array<{
    id: string;
    scope: string;
    source: string | null;
    partitionDate: string;
    lastError: string | null;
    errorClass: string | null;
    reasonCode: string;
  }>;
}

type MetaDeadLetterCandidateRow = {
  id: string;
  lane: string;
  scope: string;
  source: string | null;
  partition_date: string | Date;
  last_error: string | null;
  error_class: string | null;
  error_message: string | null;
};

export interface MetaDeadLetterRecoverySummary {
  total: number;
  replayableTransient: number;
  terminalActionRequired: number;
  unknown: number;
  latest: Array<{
    id: string;
    businessId: string;
    lane: string;
    scope: string;
    source: string | null;
    partitionDate: string;
    lastError: string | null;
    errorClass: string | null;
    recoveryKind: MetaDeadLetterRecoveryKind;
    actionRequired: boolean;
    reasonCode: string;
  }>;
}

function classifyMetaDeadLetterCandidate(
  row: Pick<MetaDeadLetterCandidateRow, "last_error" | "error_class" | "error_message">,
  options?: { partitionErrorOnly?: boolean },
) {
  const partitionError = row.last_error ?? null;
  return classifyMetaSyncFailure({
    errorClass: partitionError ? row.error_class : null,
    message: partitionError ?? (options?.partitionErrorOnly ? null : row.error_message ?? null),
  });
}

export interface MetaTerminalActionRequiredQuarantineResult {
  candidateCount: number;
  terminalMatchedCount: number;
  changedCount: number;
  partitions: Array<{
    id: string;
    lane: string;
    scope: string;
    source: string | null;
    partitionDate: string;
    reasonCode: string;
  }>;
}

export async function quarantineMetaTerminalActionRequiredPartitions(input: {
  businessId: string;
  scope?: MetaWarehouseScope | null;
  sources?: string[] | null;
  limit?: number;
}): Promise<MetaTerminalActionRequiredQuarantineResult> {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const candidateRows = await sql`
    SELECT
      partition.id,
      partition.lane,
      partition.scope,
      partition.source,
      partition.partition_date,
      partition.last_error,
      latest_run.error_class,
      latest_run.error_message
    FROM meta_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT run.error_class, run.error_message
      FROM meta_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.updated_at DESC
      LIMIT 1
    ) latest_run ON true
    WHERE partition.business_id = ${input.businessId}
      AND partition.status IN ('queued', 'failed')
      AND COALESCE(partition.lease_expires_at, now() - interval '1 second') <= now()
      AND (${input.scope ?? null}::text IS NULL OR partition.scope = ${input.scope ?? null})
      AND (${input.sources ?? null}::text[] IS NULL OR partition.source = ANY(${input.sources ?? null}::text[]))
    ORDER BY partition.updated_at ASC
    LIMIT ${Math.max(1, Math.min(input.limit ?? 500, 1000))}
  ` as MetaDeadLetterCandidateRow[];
  const classifiedRows = candidateRows.map((row) => ({
    row,
    classification: classifyMetaDeadLetterCandidate(row, { partitionErrorOnly: true }),
  }));
  const terminalRows = classifiedRows.filter(
    ({ classification }) =>
      classification.recoveryKind === "terminal_action_required",
  );
  const terminalIds = terminalRows.map(({ row }) => row.id);
  const terminalMessages = terminalRows.map(({ row, classification }) =>
    row.last_error ??
    row.error_message ??
    classification.reasonCode ??
    "Meta account checkpoint/login action required.",
  );
  const terminalClasses = terminalRows.map(({ classification }) =>
    classification.errorClass,
  );
  const updatedRows = terminalIds.length > 0
    ? await sql`
        WITH terminal(id, error_message, error_class) AS (
          SELECT * FROM unnest(
            ${terminalIds}::uuid[],
            ${terminalMessages}::text[],
            ${terminalClasses}::text[]
          )
        )
        UPDATE meta_sync_partitions partition
        SET
          status = 'dead_letter',
          lease_owner = NULL,
          lease_expires_at = NULL,
          next_retry_at = NULL,
          last_error = COALESCE(
            NULLIF(terminal.error_message, ''),
            NULLIF(partition.last_error, ''),
            'Meta account checkpoint/login action required.'
          ),
          finished_at = COALESCE(partition.finished_at, now()),
          updated_at = now()
        FROM terminal
        WHERE partition.id = terminal.id
          AND partition.business_id = ${input.businessId}
          AND partition.status IN ('queued', 'failed')
          AND COALESCE(partition.lease_expires_at, now() - interval '1 second') <= now()
        RETURNING
          partition.id,
          partition.lane,
          partition.scope,
          partition.source,
          partition.partition_date,
          terminal.error_class
      ` as Array<Record<string, unknown>>
    : [];
  return {
    candidateCount: candidateRows.length,
    terminalMatchedCount: terminalRows.length,
    changedCount: updatedRows.length,
    partitions: updatedRows.map((row) => ({
      id: String(row.id),
      lane: String(row.lane),
      scope: String(row.scope),
      source: row.source == null ? null : String(row.source),
      partitionDate: normalizeDate(row.partition_date),
      reasonCode: "meta_account_checkpoint",
    })),
  };
}

function normalizeMetaRecoveryKinds(kinds: MetaDeadLetterRecoveryKind[] | null | undefined) {
  return kinds && kinds.length > 0
    ? new Set<MetaDeadLetterRecoveryKind>(kinds)
    : new Set<MetaDeadLetterRecoveryKind>([
        "replayable_transient",
        "unknown",
      ]);
}

export async function replayMetaDeadLetterPartitions(input: {
  businessId: string;
  scope?: MetaWarehouseScope | null;
  sources?: string[] | null;
  recoveryKinds?: MetaDeadLetterRecoveryKind[] | null;
}): Promise<MetaRecoveryActionResult> {
  // Replay is a NEW-WORK transition: it moves dead-letter partitions back to
  // queued, and the worker then calls the provider for them. It was reachable
  // with no lane check, no capacity check and no selection check at all, so a
  // revoked account's dead letters could be revived and resynced by an operator
  // action — or by an automated recovery — long after the user removed it.
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_dead_letter_replay", { fresh: true });
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const matchedRows = await sql`
    SELECT
      partition.id,
      partition.lane,
      partition.scope,
      partition.source,
      partition.partition_date,
      partition.last_error,
      latest_run.error_class,
      latest_run.error_message
    FROM meta_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT run.error_class, run.error_message
      FROM meta_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.updated_at DESC
      LIMIT 1
    ) latest_run ON true
    WHERE partition.business_id = ${input.businessId}
      AND partition.status = 'dead_letter'
      -- CURRENTLY selected only. A dead letter for a deselected account stays a
      -- dead letter: terminalising already-started work is allowed, reviving it
      -- is not.
      AND EXISTS (
        SELECT 1 FROM business_provider_accounts binding
        WHERE binding.business_id = partition.business_id
          AND binding.provider = 'meta'
          AND binding.provider_account_id = partition.provider_account_id
          AND binding.is_selected
      )
      AND (${input.scope ?? null}::text IS NULL OR partition.scope = ${input.scope ?? null})
      AND (${input.sources ?? null}::text[] IS NULL OR partition.source = ANY(${input.sources ?? null}::text[]))
  ` as MetaDeadLetterCandidateRow[];
  const allowedKinds = normalizeMetaRecoveryKinds(input.recoveryKinds);
  const classifiedRows = matchedRows.map((row) => ({
    row,
    classification: classifyMetaDeadLetterCandidate(row),
  }));
  const eligibleRows = classifiedRows
    .filter(({ classification }) => allowedKinds.has(classification.recoveryKind))
    .map(({ row }) => row);
  const eligibleIds = eligibleRows.map((row) => row.id);
  const skippedActiveLeaseRows = eligibleIds.length > 0
    ? await sql`
        SELECT id
        FROM meta_sync_partitions
        WHERE id = ANY(${eligibleIds}::uuid[])
          AND business_id = ${input.businessId}
          AND status = 'dead_letter'
          AND COALESCE(lease_expires_at, now() - interval '1 second') > now()
      ` as Array<{ id: string }>
    : [];
  const rows = eligibleIds.length > 0
    ? await sql`
    UPDATE meta_sync_partitions
    SET
      status = 'queued',
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = NULL,
      source = CASE
        WHEN lane = 'extended' THEN 'historical_recovery'
        ELSE source
      END,
      last_error = NULL,
      updated_at = now()
    WHERE id = ANY(${eligibleIds}::uuid[])
      AND business_id = ${input.businessId}
      AND status = 'dead_letter'
      AND COALESCE(lease_expires_at, now() - interval '1 second') <= now()
      -- Selection is re-checked BY THE UPDATE, not before it.
      --
      -- The candidate SELECT and this UPDATE were separate statements, so a
      -- revocation landing between them requeued work for an account the user
      -- had just deselected — the SELECT saw it selected, the UPDATE never
      -- looked again. Making the predicate part of the write closes the window
      -- entirely: a deselected partition simply does not match.
      AND EXISTS (
        SELECT 1 FROM business_provider_accounts binding
        WHERE binding.business_id = meta_sync_partitions.business_id
          AND binding.provider = 'meta'
          AND binding.provider_account_id = meta_sync_partitions.provider_account_id
          AND binding.is_selected
      )
    RETURNING id, lane, scope, partition_date
      ` as Array<Record<string, unknown>>
    : [];
  const partitions = rows.map((row) => ({
    id: String(row.id),
    lane: String(row.lane),
    scope: String(row.scope),
    partitionDate: normalizeDate(row.partition_date),
  }));
  if (skippedActiveLeaseRows.length > 0) {
    await recordSyncReclaimEvents({
      providerScope: "meta",
      businessId: input.businessId,
      partitionIds: skippedActiveLeaseRows.map((row) => row.id),
      eventType: "skipped_active_lease",
      detail: "Replay skipped because the partition still has an active lease.",
    }).catch(() => null);
  }
  return {
    outcome:
      partitions.length > 0
        ? "replayed"
        : skippedActiveLeaseRows.length > 0
          ? "skipped_active_lease"
          : "no_matching_partitions",
    partitions,
    matchedCount: matchedRows.length,
    changedCount: partitions.length,
    skippedActiveLeaseCount: skippedActiveLeaseRows.length,
    replayableMatchedCount: classifiedRows.filter(
      ({ classification }) => classification.recoveryKind === "replayable_transient"
    ).length,
    terminalActionRequiredCount: classifiedRows.filter(
      ({ classification }) => classification.recoveryKind === "terminal_action_required"
    ).length,
    unknownMatchedCount: classifiedRows.filter(
      ({ classification }) => classification.recoveryKind === "unknown"
    ).length,
    manualTruthDefectCount: matchedRows.filter((row) =>
      /finalized truth validation failed/i.test(String(row.last_error ?? ""))
    ).length,
    manualTruthDefectPartitions: matchedRows
      .filter((row) =>
        /finalized truth validation failed/i.test(String(row.last_error ?? ""))
      )
      .map((row) => ({
        id: row.id,
        scope: row.scope,
        partitionDate: normalizeDate(row.partition_date),
        lastError: row.last_error,
      })),
    actionRequiredPartitions: classifiedRows
      .filter(({ classification }) => classification.recoveryKind === "terminal_action_required")
      .map(({ row, classification }) => ({
        id: row.id,
        scope: row.scope,
        source: row.source,
        partitionDate: normalizeDate(row.partition_date),
        lastError: row.last_error,
        errorClass: row.error_class,
        reasonCode: classification.reasonCode,
      })),
  };
}

export async function getMetaDeadLetterRecoverySummary(input: {
  businessId: string;
  limit?: number;
}): Promise<MetaDeadLetterRecoverySummary> {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT
      partition.id,
      partition.business_id,
      partition.lane,
      partition.scope,
      partition.source,
      partition.partition_date,
      partition.last_error,
      latest_run.error_class,
      latest_run.error_message
    FROM meta_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT run.error_class, run.error_message
      FROM meta_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.updated_at DESC
      LIMIT 1
    ) latest_run ON true
    WHERE partition.business_id = ${input.businessId}
      AND partition.status = 'dead_letter'
    ORDER BY partition.updated_at DESC
  ` as Array<MetaDeadLetterCandidateRow & { business_id: string }>;

  const classifiedRows = rows.map((row) => ({
    row,
    classification: classifyMetaDeadLetterCandidate(row),
  }));
  const latest = classifiedRows.slice(0, Math.max(1, Math.min(input.limit ?? 20, 100))).map(({ row, classification }) => {
    return {
      id: row.id,
      businessId: row.business_id,
      lane: row.lane,
      scope: row.scope,
      source: row.source,
      partitionDate: normalizeDate(row.partition_date),
      lastError: row.last_error,
      errorClass: row.error_class,
      recoveryKind: classification.recoveryKind,
      actionRequired: classification.actionRequired,
      reasonCode: classification.reasonCode,
    };
  });

  return {
    total: classifiedRows.length,
    replayableTransient: classifiedRows.filter(({ classification }) => classification.recoveryKind === "replayable_transient").length,
    terminalActionRequired: classifiedRows.filter(({ classification }) => classification.recoveryKind === "terminal_action_required").length,
    unknown: classifiedRows.filter(({ classification }) => classification.recoveryKind === "unknown").length,
    latest,
  };
}

export async function getMetaSyncState(input: {
  businessId: string;
  providerAccountId?: string | null;
  scope: MetaWarehouseScope;
}) {
  await assertMetaRequestReadTablesReady(
    ["meta_sync_state"],
    "meta_sync_state",
  );
  const sql = getDb();
  const rows = await sql`
    SELECT
      business_id,
      provider_account_id,
      scope,
      historical_target_start,
      historical_target_end,
      effective_target_start,
      effective_target_end,
      ready_through_date,
      last_successful_partition_date,
      latest_background_activity_at,
      latest_successful_sync_at,
      completed_days,
      dead_letter_count,
      updated_at
    FROM meta_sync_state
    WHERE business_id = ${input.businessId}
      AND scope = ${input.scope}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
    ORDER BY updated_at DESC
  ` as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    scope: String(row.scope) as MetaWarehouseScope,
    historicalTargetStart: normalizeDate(row.historical_target_start),
    historicalTargetEnd: normalizeDate(row.historical_target_end),
    effectiveTargetStart: normalizeDate(row.effective_target_start),
    effectiveTargetEnd: normalizeDate(row.effective_target_end),
    readyThroughDate: row.ready_through_date ? normalizeDate(row.ready_through_date) : null,
    lastSuccessfulPartitionDate: row.last_successful_partition_date
      ? normalizeDate(row.last_successful_partition_date)
      : null,
    latestBackgroundActivityAt: normalizeTimestamp(row.latest_background_activity_at),
    latestSuccessfulSyncAt: normalizeTimestamp(row.latest_successful_sync_at),
    completedDays: toNumber(row.completed_days),
    deadLetterCount: toNumber(row.dead_letter_count),
    updatedAt: normalizeTimestamp(row.updated_at) ?? undefined,
  })) as MetaSyncStateRecord[];
}

export async function getMetaAccountDailyStats(input: {
  businessId: string;
  providerAccountId?: string | null;
}) {
  await assertMetaRequestReadTablesReady(
    ["meta_account_daily"],
    "meta_account_daily_stats",
  );
  const sql = getDb();
  const rows = await sql`
    SELECT
      COUNT(*)::int AS row_count,
      MIN(date)::text AS first_date,
      MAX(date)::text AS last_date
    FROM meta_account_daily
    WHERE business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
  ` as Array<{
    row_count: number;
    first_date: string | null;
    last_date: string | null;
  }>;
  return rows[0] ?? { row_count: 0, first_date: null, last_date: null };
}

export async function getLatestMetaRawSnapshot(input: {
  businessId: string;
  providerAccountId: string;
  endpointName: string;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT
      id,
      fetched_at,
      status,
      account_timezone,
      account_currency,
      payload_json
    FROM meta_raw_snapshots
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND endpoint_name = ${input.endpointName}
    ORDER BY fetched_at DESC
    LIMIT 1
  ` as Array<{
    id: string;
    fetched_at: string;
    status: string;
    account_timezone: string | null;
    account_currency: string | null;
    payload_json: unknown;
  }>;
  return rows[0] ?? null;
}

export async function refreshMetaAccountDailyOverviewSummary(
  rows: MetaAccountDailyRow[],
) {
  if (rows.length === 0) return;
  await refreshOverviewSummaryMaterializationFromMetaAccountRows(rows).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[meta-warehouse] overview summary refresh failed", {
      businessId: rows[0]?.businessId ?? null,
      message,
    });
  });
}

export async function upsertMetaAccountDailyRows(
  rows: MetaAccountDailyRow[],
  options: {
    skipOverviewSummaryRefresh?: boolean;
  } = {},
) {
  if (rows.length === 0) return;
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const supportsTruthLifecycle = await hasMetaTruthLifecycleColumns();
  for (const chunk of chunkRows(rows)) {
    const businessRefIds = await resolveBusinessReferenceIds(
      chunk.map((row) => row.businessId),
    );
    const providerAccountRefIds = await ensureProviderAccountReferenceIds({
      provider: "meta",
      accounts: chunk.map((row) => ({
        externalAccountId: row.providerAccountId,
        accountName: row.accountName,
        currency: row.accountCurrency,
        timezone: row.accountTimezone,
      })),
    });
    const values: unknown[] = [];
    const placeholders = chunk
      .map((row, index) => {
        const offset = index * (supportsTruthLifecycle ? 26 : 21);
        values.push(
          row.businessId,
          businessRefIds.get(row.businessId) ?? null,
          row.providerAccountId,
          providerAccountRefIds.get(row.providerAccountId) ?? null,
          normalizeDate(row.date),
          row.accountName,
          row.accountTimezone,
          row.accountCurrency,
          row.spend,
          row.impressions,
          row.clicks,
          row.reach,
          row.frequency,
          row.conversions,
          row.revenue,
          row.roas,
          row.cpa,
          row.ctr,
          row.cpc,
          row.sourceSnapshotId,
          row.metricSchemaVersion ?? META_CANONICAL_METRIC_SCHEMA_VERSION,
        );
        if (supportsTruthLifecycle) {
          values.push(
            row.truthState ?? "finalized",
            row.truthVersion ?? 1,
            row.finalizedAt ?? null,
            row.validationStatus ?? "passed",
            row.sourceRunId ?? null
          );
          return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12},$${offset + 13},$${offset + 14},$${offset + 15},$${offset + 16},$${offset + 17},$${offset + 18},$${offset + 19},$${offset + 20},$${offset + 21},$${offset + 22},$${offset + 23},$${offset + 24},$${offset + 25},$${offset + 26},now())`;
        }
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12},$${offset + 13},$${offset + 14},$${offset + 15},$${offset + 16},$${offset + 17},$${offset + 18},$${offset + 19},$${offset + 20},$${offset + 21},now())`;
      })
      .join(", ");
    const query = supportsTruthLifecycle
      ? `
        INSERT INTO meta_account_daily (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          date,
          account_name,
          account_timezone,
          account_currency,
          spend,
          impressions,
          clicks,
          reach,
          frequency,
          conversions,
          revenue,
          roas,
          cpa,
          ctr,
          cpc,
          source_snapshot_id,
          metric_schema_version,
          truth_state,
          truth_version,
          finalized_at,
          validation_status,
          source_run_id,
          updated_at
        )
        VALUES ${placeholders}
        ON CONFLICT (business_id, provider_account_id, date) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_account_daily.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_account_daily.provider_account_ref_id),
          account_name = EXCLUDED.account_name,
          account_timezone = EXCLUDED.account_timezone,
          account_currency = EXCLUDED.account_currency,
          spend = EXCLUDED.spend,
          impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks,
          reach = EXCLUDED.reach,
          frequency = EXCLUDED.frequency,
          conversions = EXCLUDED.conversions,
          revenue = EXCLUDED.revenue,
          roas = EXCLUDED.roas,
          cpa = EXCLUDED.cpa,
          ctr = EXCLUDED.ctr,
          cpc = EXCLUDED.cpc,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          metric_schema_version = EXCLUDED.metric_schema_version,
          truth_state = EXCLUDED.truth_state,
          truth_version = CASE
            WHEN meta_account_daily.truth_state = EXCLUDED.truth_state
              AND COALESCE(meta_account_daily.validation_status, 'passed') = COALESCE(EXCLUDED.validation_status, 'passed')
              THEN GREATEST(COALESCE(meta_account_daily.truth_version, 1), COALESCE(EXCLUDED.truth_version, 1))
            ELSE GREATEST(COALESCE(meta_account_daily.truth_version, 1), COALESCE(EXCLUDED.truth_version, 1)) + 1
          END,
          finalized_at = EXCLUDED.finalized_at,
          validation_status = EXCLUDED.validation_status,
          source_run_id = EXCLUDED.source_run_id,
          updated_at = now()
      `
      : `
        INSERT INTO meta_account_daily (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          date,
          account_name,
          account_timezone,
          account_currency,
          spend,
          impressions,
          clicks,
          reach,
          frequency,
          conversions,
          revenue,
          roas,
          cpa,
          ctr,
          cpc,
          source_snapshot_id,
          metric_schema_version,
          updated_at
        )
        VALUES ${placeholders}
        ON CONFLICT (business_id, provider_account_id, date) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_account_daily.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_account_daily.provider_account_ref_id),
          account_name = EXCLUDED.account_name,
          account_timezone = EXCLUDED.account_timezone,
          account_currency = EXCLUDED.account_currency,
          spend = EXCLUDED.spend,
          impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks,
          reach = EXCLUDED.reach,
          frequency = EXCLUDED.frequency,
          conversions = EXCLUDED.conversions,
          revenue = EXCLUDED.revenue,
          roas = EXCLUDED.roas,
          cpa = EXCLUDED.cpa,
          ctr = EXCLUDED.ctr,
          cpc = EXCLUDED.cpc,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          metric_schema_version = EXCLUDED.metric_schema_version,
          updated_at = now()
      `;
    await sql.query(query, values);
  }
  if (!options.skipOverviewSummaryRefresh) {
    await refreshMetaAccountDailyOverviewSummary(rows);
  }
}

/**
 * Explicit, fail-closed control over current-config history side effects.
 *
 * `upsertMetaCampaignDailyRows` / `upsertMetaAdSetDailyRows` append the row's
 * CURRENT config payload into `meta_*_config_history` after every daily upsert.
 * That is correct for a current-day caller, but a historical backfill writes the
 * same current inventory under each backfilled effective date, fabricating
 * config history and amplifying storage by the size of the wave.
 *
 * Historical fact writers pass `appendConfigHistory: false` to keep metrics and
 * dimension enrichment while suppressing the false history append. The default
 * stays `true`, so every existing caller is unchanged.
 */
export interface MetaDailyWriteOptions {
  appendConfigHistory?: boolean;
}

export async function upsertMetaCampaignDailyRows(
  rows: MetaCampaignDailyRow[],
  options?: MetaDailyWriteOptions,
) {
  if (rows.length === 0) return;
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const supportsTruthLifecycle = await hasMetaTruthLifecycleColumns();
  for (const chunk of chunkRows(rows, 200)) {
    const referenceContext = await resolveMetaChunkReferenceContext(
      chunk.map((row) => ({
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        accountCurrency: row.accountCurrency,
        accountTimezone: row.accountTimezone,
      })),
    );
    const values: unknown[] = [];
    const placeholders = chunk
      .map((row, index) => {
        const offset = index * (supportsTruthLifecycle ? 44 : 39);
        values.push(
          row.businessId,
          referenceContext.businessRefIds.get(row.businessId) ?? null,
          row.providerAccountId,
          referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          normalizeDate(row.date),
          row.campaignId,
          row.campaignNameCurrent,
          row.campaignNameHistorical,
          row.campaignStatus,
          row.objective,
          row.buyingType,
          row.optimizationGoal,
          row.customEventType ?? null,
          row.bidStrategyType,
          row.bidValue,
          row.bidValueFormat,
          row.dailyBudget,
          row.lifetimeBudget,
          row.isBudgetMixed,
          row.isConfigMixed,
          row.isOptimizationGoalMixed,
          row.isCustomEventTypeMixed ?? false,
          row.isBidStrategyMixed,
          row.isBidValueMixed,
          row.accountTimezone,
          row.accountCurrency,
          row.spend,
          row.impressions,
          row.clicks,
          row.reach,
          row.frequency,
          row.conversions,
          row.revenue,
          row.roas,
          row.cpa,
          row.ctr,
          row.cpc,
          row.sourceSnapshotId,
          row.metricSchemaVersion ?? META_CANONICAL_METRIC_SCHEMA_VERSION,
        );
        if (supportsTruthLifecycle) {
          values.push(
            row.truthState ?? "finalized",
            row.truthVersion ?? 1,
            row.finalizedAt ?? null,
            row.validationStatus ?? "passed",
            row.sourceRunId ?? null
          );
          return buildSqlValueTuple(offset, 44);
        }
        return buildSqlValueTuple(offset, 39);
      })
      .join(", ");
    const query = supportsTruthLifecycle
      ? `
      INSERT INTO meta_campaign_daily (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        date,
        campaign_id,
        campaign_name_current,
        campaign_name_historical,
        campaign_status,
        objective,
        buying_type,
        optimization_goal,
        custom_event_type,
        bid_strategy_type,
        bid_value,
        bid_value_format,
        daily_budget,
        lifetime_budget,
        is_budget_mixed,
        is_config_mixed,
        is_optimization_goal_mixed,
        is_custom_event_type_mixed,
        is_bid_strategy_mixed,
        is_bid_value_mixed,
        account_timezone,
        account_currency,
        spend,
        impressions,
        clicks,
        reach,
        frequency,
        conversions,
        revenue,
        roas,
        cpa,
        ctr,
        cpc,
        source_snapshot_id,
        metric_schema_version,
        truth_state,
        truth_version,
        finalized_at,
        validation_status,
        source_run_id,
        updated_at
      )
      VALUES ${placeholders}
      ON CONFLICT (business_id, provider_account_id, date, campaign_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_campaign_daily.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_campaign_daily.provider_account_ref_id),
        campaign_name_current = EXCLUDED.campaign_name_current,
        campaign_name_historical = EXCLUDED.campaign_name_historical,
        campaign_status = EXCLUDED.campaign_status,
        objective = COALESCE(EXCLUDED.objective, meta_campaign_daily.objective),
        buying_type = EXCLUDED.buying_type,
        optimization_goal = COALESCE(EXCLUDED.optimization_goal, meta_campaign_daily.optimization_goal),
        custom_event_type = COALESCE(EXCLUDED.custom_event_type, meta_campaign_daily.custom_event_type),
        bid_strategy_type = COALESCE(EXCLUDED.bid_strategy_type, meta_campaign_daily.bid_strategy_type),
        bid_value = COALESCE(EXCLUDED.bid_value, meta_campaign_daily.bid_value),
        bid_value_format = COALESCE(EXCLUDED.bid_value_format, meta_campaign_daily.bid_value_format),
        daily_budget = COALESCE(EXCLUDED.daily_budget, meta_campaign_daily.daily_budget),
        lifetime_budget = COALESCE(EXCLUDED.lifetime_budget, meta_campaign_daily.lifetime_budget),
        is_budget_mixed = EXCLUDED.is_budget_mixed OR meta_campaign_daily.is_budget_mixed,
        is_config_mixed = EXCLUDED.is_config_mixed OR meta_campaign_daily.is_config_mixed,
        is_optimization_goal_mixed = EXCLUDED.is_optimization_goal_mixed OR meta_campaign_daily.is_optimization_goal_mixed,
        is_custom_event_type_mixed = EXCLUDED.is_custom_event_type_mixed OR meta_campaign_daily.is_custom_event_type_mixed,
        is_bid_strategy_mixed = EXCLUDED.is_bid_strategy_mixed OR meta_campaign_daily.is_bid_strategy_mixed,
        is_bid_value_mixed = EXCLUDED.is_bid_value_mixed OR meta_campaign_daily.is_bid_value_mixed,
        account_timezone = EXCLUDED.account_timezone,
        account_currency = EXCLUDED.account_currency,
        spend = EXCLUDED.spend,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        reach = EXCLUDED.reach,
        frequency = EXCLUDED.frequency,
        conversions = EXCLUDED.conversions,
        revenue = EXCLUDED.revenue,
        roas = EXCLUDED.roas,
        cpa = EXCLUDED.cpa,
        ctr = EXCLUDED.ctr,
        cpc = EXCLUDED.cpc,
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        metric_schema_version = EXCLUDED.metric_schema_version,
        truth_state = EXCLUDED.truth_state,
        truth_version = CASE
          WHEN meta_campaign_daily.truth_state = EXCLUDED.truth_state
            AND COALESCE(meta_campaign_daily.validation_status, 'passed') = COALESCE(EXCLUDED.validation_status, 'passed')
            THEN GREATEST(COALESCE(meta_campaign_daily.truth_version, 1), COALESCE(EXCLUDED.truth_version, 1))
          ELSE GREATEST(COALESCE(meta_campaign_daily.truth_version, 1), COALESCE(EXCLUDED.truth_version, 1)) + 1
        END,
        finalized_at = EXCLUDED.finalized_at,
        validation_status = EXCLUDED.validation_status,
        source_run_id = EXCLUDED.source_run_id,
        updated_at = now()
    `
      : `
      INSERT INTO meta_campaign_daily (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        date,
        campaign_id,
        campaign_name_current,
        campaign_name_historical,
        campaign_status,
        objective,
        buying_type,
        optimization_goal,
        custom_event_type,
        bid_strategy_type,
        bid_value,
        bid_value_format,
        daily_budget,
        lifetime_budget,
        is_budget_mixed,
        is_config_mixed,
        is_optimization_goal_mixed,
        is_custom_event_type_mixed,
        is_bid_strategy_mixed,
        is_bid_value_mixed,
        account_timezone,
        account_currency,
        spend,
        impressions,
        clicks,
        reach,
        frequency,
        conversions,
        revenue,
        roas,
        cpa,
        ctr,
        cpc,
        source_snapshot_id,
        metric_schema_version,
        updated_at
      )
      VALUES ${placeholders}
      ON CONFLICT (business_id, provider_account_id, date, campaign_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_campaign_daily.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_campaign_daily.provider_account_ref_id),
        campaign_name_current = EXCLUDED.campaign_name_current,
        campaign_name_historical = EXCLUDED.campaign_name_historical,
        campaign_status = EXCLUDED.campaign_status,
        objective = COALESCE(EXCLUDED.objective, meta_campaign_daily.objective),
        buying_type = EXCLUDED.buying_type,
        optimization_goal = COALESCE(EXCLUDED.optimization_goal, meta_campaign_daily.optimization_goal),
        custom_event_type = COALESCE(EXCLUDED.custom_event_type, meta_campaign_daily.custom_event_type),
        bid_strategy_type = COALESCE(EXCLUDED.bid_strategy_type, meta_campaign_daily.bid_strategy_type),
        bid_value = COALESCE(EXCLUDED.bid_value, meta_campaign_daily.bid_value),
        bid_value_format = COALESCE(EXCLUDED.bid_value_format, meta_campaign_daily.bid_value_format),
        daily_budget = COALESCE(EXCLUDED.daily_budget, meta_campaign_daily.daily_budget),
        lifetime_budget = COALESCE(EXCLUDED.lifetime_budget, meta_campaign_daily.lifetime_budget),
        is_budget_mixed = EXCLUDED.is_budget_mixed OR meta_campaign_daily.is_budget_mixed,
        is_config_mixed = EXCLUDED.is_config_mixed OR meta_campaign_daily.is_config_mixed,
        is_optimization_goal_mixed = EXCLUDED.is_optimization_goal_mixed OR meta_campaign_daily.is_optimization_goal_mixed,
        is_custom_event_type_mixed = EXCLUDED.is_custom_event_type_mixed OR meta_campaign_daily.is_custom_event_type_mixed,
        is_bid_strategy_mixed = EXCLUDED.is_bid_strategy_mixed OR meta_campaign_daily.is_bid_strategy_mixed,
        is_bid_value_mixed = EXCLUDED.is_bid_value_mixed OR meta_campaign_daily.is_bid_value_mixed,
        account_timezone = EXCLUDED.account_timezone,
        account_currency = EXCLUDED.account_currency,
        spend = EXCLUDED.spend,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        reach = EXCLUDED.reach,
        frequency = EXCLUDED.frequency,
        conversions = EXCLUDED.conversions,
        revenue = EXCLUDED.revenue,
        roas = EXCLUDED.roas,
        cpa = EXCLUDED.cpa,
        ctr = EXCLUDED.ctr,
        cpc = EXCLUDED.cpc,
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        metric_schema_version = EXCLUDED.metric_schema_version,
        updated_at = now()
    `;
    await sql.query(query, values);
    await Promise.all([
      upsertMetaCampaignDimensionRows(chunk, referenceContext),
      ...(options?.appendConfigHistory === false
        ? []
        : [appendMetaCampaignConfigHistoryRows(chunk, referenceContext)]),
    ]);
  }
}

export async function upsertMetaAdSetDailyRows(
  rows: MetaAdSetDailyRow[],
  options?: MetaDailyWriteOptions,
) {
  if (rows.length === 0) return;
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const supportsTruthLifecycle = await hasMetaTruthLifecycleColumns();
  for (const chunk of chunkRows(rows, 200)) {
    const referenceContext = await resolveMetaChunkReferenceContext(
      chunk.map((row) => ({
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        accountCurrency: row.accountCurrency,
        accountTimezone: row.accountTimezone,
      })),
    );
    const values: unknown[] = [];
    const placeholders = chunk
      .map((row, index) => {
        const offset = index * (supportsTruthLifecycle ? 45 : 40);
        values.push(
          row.businessId,
          referenceContext.businessRefIds.get(row.businessId) ?? null,
          row.providerAccountId,
          referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          normalizeDate(row.date),
          row.campaignId,
          row.adsetId,
          row.adsetNameCurrent,
          row.adsetNameHistorical,
          row.adsetStatus,
          row.optimizationGoal,
          row.customEventType ?? null,
          row.pixelId ?? null,
          row.customConversionId ?? null,
          row.promotedObjectJson == null
            ? null
            : JSON.stringify(row.promotedObjectJson),
          row.bidStrategyType,
          row.bidValue,
          row.bidValueFormat,
          row.dailyBudget,
          row.lifetimeBudget,
          row.isBudgetMixed,
          row.isConfigMixed,
          row.isOptimizationGoalMixed,
          row.isBidStrategyMixed,
          row.isBidValueMixed,
          row.accountTimezone,
          row.accountCurrency,
          row.spend,
          row.impressions,
          row.clicks,
          row.reach,
          row.frequency,
          row.conversions,
          row.revenue,
          row.roas,
          row.cpa,
          row.ctr,
          row.cpc,
          row.sourceSnapshotId,
          row.metricSchemaVersion ?? META_CANONICAL_METRIC_SCHEMA_VERSION,
        );
        if (supportsTruthLifecycle) {
          values.push(
            row.truthState ?? "finalized",
            row.truthVersion ?? 1,
            row.finalizedAt ?? null,
            row.validationStatus ?? "passed",
            row.sourceRunId ?? null
          );
          return buildSqlValueTuple(offset, 45, { 15: "::jsonb" });
        }
        return buildSqlValueTuple(offset, 40, { 15: "::jsonb" });
      })
      .join(", ");
    const query = supportsTruthLifecycle
      ? `
      INSERT INTO meta_adset_daily (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        date,
        campaign_id,
        adset_id,
        adset_name_current,
        adset_name_historical,
        adset_status,
        optimization_goal,
        custom_event_type,
        pixel_id,
        custom_conversion_id,
        promoted_object_json,
        bid_strategy_type,
        bid_value,
        bid_value_format,
        daily_budget,
        lifetime_budget,
        is_budget_mixed,
        is_config_mixed,
        is_optimization_goal_mixed,
        is_bid_strategy_mixed,
        is_bid_value_mixed,
        account_timezone,
        account_currency,
        spend,
        impressions,
        clicks,
        reach,
        frequency,
        conversions,
        revenue,
        roas,
        cpa,
        ctr,
        cpc,
        source_snapshot_id,
        metric_schema_version,
        truth_state,
        truth_version,
        finalized_at,
        validation_status,
        source_run_id,
        updated_at
      )
      VALUES ${placeholders}
      ON CONFLICT (business_id, provider_account_id, date, adset_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_adset_daily.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_adset_daily.provider_account_ref_id),
        campaign_id = EXCLUDED.campaign_id,
        adset_name_current = EXCLUDED.adset_name_current,
        adset_name_historical = EXCLUDED.adset_name_historical,
        adset_status = EXCLUDED.adset_status,
        optimization_goal = COALESCE(EXCLUDED.optimization_goal, meta_adset_daily.optimization_goal),
        custom_event_type = COALESCE(EXCLUDED.custom_event_type, meta_adset_daily.custom_event_type),
        pixel_id = COALESCE(EXCLUDED.pixel_id, meta_adset_daily.pixel_id),
        custom_conversion_id = COALESCE(EXCLUDED.custom_conversion_id, meta_adset_daily.custom_conversion_id),
        promoted_object_json = COALESCE(EXCLUDED.promoted_object_json, meta_adset_daily.promoted_object_json),
        bid_strategy_type = COALESCE(EXCLUDED.bid_strategy_type, meta_adset_daily.bid_strategy_type),
        bid_value = COALESCE(EXCLUDED.bid_value, meta_adset_daily.bid_value),
        bid_value_format = COALESCE(EXCLUDED.bid_value_format, meta_adset_daily.bid_value_format),
        daily_budget = COALESCE(EXCLUDED.daily_budget, meta_adset_daily.daily_budget),
        lifetime_budget = COALESCE(EXCLUDED.lifetime_budget, meta_adset_daily.lifetime_budget),
        is_budget_mixed = EXCLUDED.is_budget_mixed OR meta_adset_daily.is_budget_mixed,
        is_config_mixed = EXCLUDED.is_config_mixed OR meta_adset_daily.is_config_mixed,
        is_optimization_goal_mixed = EXCLUDED.is_optimization_goal_mixed OR meta_adset_daily.is_optimization_goal_mixed,
        is_bid_strategy_mixed = EXCLUDED.is_bid_strategy_mixed OR meta_adset_daily.is_bid_strategy_mixed,
        is_bid_value_mixed = EXCLUDED.is_bid_value_mixed OR meta_adset_daily.is_bid_value_mixed,
        account_timezone = EXCLUDED.account_timezone,
        account_currency = EXCLUDED.account_currency,
        spend = EXCLUDED.spend,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        reach = EXCLUDED.reach,
        frequency = EXCLUDED.frequency,
        conversions = EXCLUDED.conversions,
        revenue = EXCLUDED.revenue,
        roas = EXCLUDED.roas,
        cpa = EXCLUDED.cpa,
        ctr = EXCLUDED.ctr,
        cpc = EXCLUDED.cpc,
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        metric_schema_version = EXCLUDED.metric_schema_version,
        truth_state = EXCLUDED.truth_state,
        truth_version = CASE
          WHEN meta_adset_daily.truth_state = EXCLUDED.truth_state
            AND COALESCE(meta_adset_daily.validation_status, 'passed') = COALESCE(EXCLUDED.validation_status, 'passed')
            THEN GREATEST(COALESCE(meta_adset_daily.truth_version, 1), COALESCE(EXCLUDED.truth_version, 1))
          ELSE GREATEST(COALESCE(meta_adset_daily.truth_version, 1), COALESCE(EXCLUDED.truth_version, 1)) + 1
        END,
        finalized_at = EXCLUDED.finalized_at,
        validation_status = EXCLUDED.validation_status,
        source_run_id = EXCLUDED.source_run_id,
        updated_at = now()
    `
      : `
      INSERT INTO meta_adset_daily (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        date,
        campaign_id,
        adset_id,
        adset_name_current,
        adset_name_historical,
        adset_status,
        optimization_goal,
        custom_event_type,
        pixel_id,
        custom_conversion_id,
        promoted_object_json,
        bid_strategy_type,
        bid_value,
        bid_value_format,
        daily_budget,
        lifetime_budget,
        is_budget_mixed,
        is_config_mixed,
        is_optimization_goal_mixed,
        is_bid_strategy_mixed,
        is_bid_value_mixed,
        account_timezone,
        account_currency,
        spend,
        impressions,
        clicks,
        reach,
        frequency,
        conversions,
        revenue,
        roas,
        cpa,
        ctr,
        cpc,
        source_snapshot_id,
        metric_schema_version,
        updated_at
      )
      VALUES ${placeholders}
      ON CONFLICT (business_id, provider_account_id, date, adset_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_adset_daily.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_adset_daily.provider_account_ref_id),
        campaign_id = EXCLUDED.campaign_id,
        adset_name_current = EXCLUDED.adset_name_current,
        adset_name_historical = EXCLUDED.adset_name_historical,
        adset_status = EXCLUDED.adset_status,
        optimization_goal = COALESCE(EXCLUDED.optimization_goal, meta_adset_daily.optimization_goal),
        custom_event_type = COALESCE(EXCLUDED.custom_event_type, meta_adset_daily.custom_event_type),
        pixel_id = COALESCE(EXCLUDED.pixel_id, meta_adset_daily.pixel_id),
        custom_conversion_id = COALESCE(EXCLUDED.custom_conversion_id, meta_adset_daily.custom_conversion_id),
        promoted_object_json = COALESCE(EXCLUDED.promoted_object_json, meta_adset_daily.promoted_object_json),
        bid_strategy_type = COALESCE(EXCLUDED.bid_strategy_type, meta_adset_daily.bid_strategy_type),
        bid_value = COALESCE(EXCLUDED.bid_value, meta_adset_daily.bid_value),
        bid_value_format = COALESCE(EXCLUDED.bid_value_format, meta_adset_daily.bid_value_format),
        daily_budget = COALESCE(EXCLUDED.daily_budget, meta_adset_daily.daily_budget),
        lifetime_budget = COALESCE(EXCLUDED.lifetime_budget, meta_adset_daily.lifetime_budget),
        is_budget_mixed = EXCLUDED.is_budget_mixed OR meta_adset_daily.is_budget_mixed,
        is_config_mixed = EXCLUDED.is_config_mixed OR meta_adset_daily.is_config_mixed,
        is_optimization_goal_mixed = EXCLUDED.is_optimization_goal_mixed OR meta_adset_daily.is_optimization_goal_mixed,
        is_bid_strategy_mixed = EXCLUDED.is_bid_strategy_mixed OR meta_adset_daily.is_bid_strategy_mixed,
        is_bid_value_mixed = EXCLUDED.is_bid_value_mixed OR meta_adset_daily.is_bid_value_mixed,
        account_timezone = EXCLUDED.account_timezone,
        account_currency = EXCLUDED.account_currency,
        spend = EXCLUDED.spend,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        reach = EXCLUDED.reach,
        frequency = EXCLUDED.frequency,
        conversions = EXCLUDED.conversions,
        revenue = EXCLUDED.revenue,
        roas = EXCLUDED.roas,
        cpa = EXCLUDED.cpa,
        ctr = EXCLUDED.ctr,
        cpc = EXCLUDED.cpc,
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        metric_schema_version = EXCLUDED.metric_schema_version,
        updated_at = now()
    `;
    await sql.query(query, values);
    await Promise.all([
      upsertMetaAdSetDimensionRows(chunk, referenceContext),
      ...(options?.appendConfigHistory === false
        ? []
        : [appendMetaAdSetConfigHistoryRows(chunk, referenceContext)]),
    ]);
  }
}

/**
 * Typed campaign and adset config history for the account's CURRENT, provisional
 * day — written directly, not as a side effect of a daily fact write.
 *
 * The `appendConfigHistory` option on the daily writers could never fire. Those
 * writers run only when `truthState === "finalized"`, and current evidence is
 * permitted only on the account's own local today declared PROVISIONAL. The two
 * conditions are mutually exclusive, so `appendConfigHistory: true` was dead at
 * every call site and `meta_campaign_config_history` /
 * `meta_adset_config_history` received nothing at all.
 *
 * Even had it fired, every row would have been dropped: `captured_at` is part of
 * the arbiter, `buildMetaHistoryCapturedAt` returns null without a real
 * observation time, and on a provisional day `finalizedAt` is null and nothing
 * ever set `configObservedAt`.
 *
 * So this writer takes the real observation timestamp from the config receipt
 * that produced the rows and stamps it onto them. It uses the SAME canonical
 * semantic records and the SAME `buildMetaConfigHistoryFingerprint` as the daily
 * path, so a row written here and a row written by a finalized replay coalesce
 * on identity rather than duplicating.
 *
 * Errors are NOT swallowed. A config-history write that fails silently is
 * indistinguishable from one that had nothing to write, which is exactly how
 * this surface stayed empty without anyone noticing.
 */
/**
 * Advisory-lock namespace for config-history transitions.
 *
 * The decision "is this a new configuration?" is a read-then-insert. Two
 * observations of the same entity arriving concurrently both read the same
 * latest fingerprint, so an A -> B -> A sequence could lose the revert entirely:
 * the B writer and the second A writer both see A as latest, B is written, and
 * the return to A is skipped as unchanged. Serialising per ENTITY — not per
 * account, which would make a large account's writes single-file — makes the
 * decision and the insert one atomic step.
 */
const META_CONFIG_HISTORY_TRANSITION_LOCK_NAMESPACE = 0x4d434648;

/** A config receipt that is complete enough to record a transition from. */
export interface MetaConfigReceiptEvidence {
  /** The provider returned every page for this level. */
  complete: boolean;
  /** When THIS level's response was observed. */
  observedAt: string;
}

export async function appendMetaCurrentConfigHistory(input: {
  campaignRows: MetaCampaignDailyRow[];
  adsetRows: MetaAdSetDailyRow[];
  /**
   * The campaign receipt. Its `observedAt` stamps campaign rows only.
   *
   * Campaign and adset configuration come from two separate provider responses,
   * observed at two different instants. Stamping the campaign receipt's
   * timestamp onto adset history recorded when the CAMPAIGNS were fetched as
   * when the AD SETS were — and `captured_at` is part of the arbiter, so the
   * error decides whether a genuine adset transition coalesces or appends.
   */
  campaignReceipt: MetaConfigReceiptEvidence;
  /** The adset receipt. Its `observedAt` stamps adset rows only. */
  adsetReceipt: MetaConfigReceiptEvidence;
}): Promise<{
  campaignRowsWritten: number;
  adsetRowsWritten: number;
  campaignSkippedIncompleteReceipt: boolean;
  adsetSkippedIncompleteReceipt: boolean;
}> {
  const campaignObservedAt = normalizeTimestamp(input.campaignReceipt.observedAt);
  const adsetObservedAt = normalizeTimestamp(input.adsetReceipt.observedAt);
  if (!campaignObservedAt || !adsetObservedAt) {
    throw new Error(
      `meta_current_config_history_requires_observed_at: campaign=${String(
        input.campaignReceipt.observedAt,
      )} adset=${String(input.adsetReceipt.observedAt)}`,
    );
  }
  if (input.campaignRows.length === 0 && input.adsetRows.length === 0) {
    return {
      campaignRowsWritten: 0,
      adsetRowsWritten: 0,
      campaignSkippedIncompleteReceipt: false,
      adsetSkippedIncompleteReceipt: false,
    };
  }
  await assertMetaMutationTablesReady("meta_warehouse");

  // A PARTIAL receipt is not evidence of a configuration change.
  //
  // If the provider returned three of five pages, the entities on the missing
  // pages are absent from `rows` — and absence is indistinguishable from
  // deletion to anything reading this history later. Worse, a partial page set
  // whose entities happen to be unchanged writes nothing and looks identical to
  // a complete unchanged observation. Config history therefore records only
  // complete observations, and says so when it declines.
  const campaignRows = input.campaignReceipt.complete
    ? input.campaignRows.map((row) => ({ ...row, configObservedAt: campaignObservedAt }))
    : [];
  const adsetRows = input.adsetReceipt.complete
    ? input.adsetRows.map((row) => ({ ...row, configObservedAt: adsetObservedAt }))
    : [];

  let campaignRowsWritten = 0;
  for (const chunk of chunkRows(campaignRows, 200)) {
    campaignRowsWritten += await runDbTransaction(async () => {
      await lockMetaConfigHistoryEntities(
        chunk.map((row) => `campaign:${row.businessId}:${row.providerAccountId}:${row.campaignId}`),
      );
      const referenceContext = await resolveMetaChunkReferenceContext(
        chunk.map((row) => ({
          businessId: row.businessId,
          providerAccountId: row.providerAccountId,
          accountCurrency: row.accountCurrency,
          accountTimezone: row.accountTimezone,
        })),
      );
      // The SKIP-UNCHANGED decision, made here under the lock.
      //
      // It used to live in a BEFORE INSERT trigger. Without it an unchanged
      // configuration observed hourly appends hourly — `captured_at` is part of
      // the arbiter, so the same fingerprint at a new instant is a new row, and
      // that is exactly the growth that made these tables ~22 GB. Made inside
      // the same transaction that holds the entity locks, the read and the
      // insert are one atomic step rather than the trigger's race.
      const changed = await filterMetaConfigTransitions(chunk, {
        table: "meta_campaign_config_history",
        entityColumn: "campaign_id",
        entityIdOf: (row) => row.campaignId,
      });
      // EXACT count, from RETURNING. Reporting `chunk.length` counted rows the
      // arbiter rejected as though they had been written, so a surface that
      // never appended anything still reported progress.
      return appendMetaCampaignConfigHistoryRows(changed, referenceContext);
    });
  }
  let adsetRowsWritten = 0;
  for (const chunk of chunkRows(adsetRows, 200)) {
    adsetRowsWritten += await runDbTransaction(async () => {
      await lockMetaConfigHistoryEntities(
        chunk.map((row) => `adset:${row.businessId}:${row.providerAccountId}:${row.adsetId}`),
      );
      const referenceContext = await resolveMetaChunkReferenceContext(
        chunk.map((row) => ({
          businessId: row.businessId,
          providerAccountId: row.providerAccountId,
          accountCurrency: row.accountCurrency,
          accountTimezone: row.accountTimezone,
        })),
      );
      const changed = await filterMetaConfigTransitions(chunk, {
        table: "meta_adset_config_history",
        entityColumn: "adset_id",
        entityIdOf: (row) => row.adsetId,
      });
      return appendMetaAdSetConfigHistoryRows(changed, referenceContext);
    });
  }
  return {
    campaignRowsWritten,
    adsetRowsWritten,
    campaignSkippedIncompleteReceipt: !input.campaignReceipt.complete,
    adsetSkippedIncompleteReceipt: !input.adsetReceipt.complete,
  };
}


/**
 * Drop rows whose configuration is unchanged from the entity's current latest.
 *
 * The equivalent of the trigger this replaces, with the two things the trigger
 * lacked: it runs inside the transaction that already holds the per-entity
 * advisory locks, so no concurrent writer can insert between the read and the
 * insert; and it orders by `(captured_at DESC, id DESC)`, so two rows at the
 * same instant resolve deterministically instead of by whichever the planner
 * reached first.
 *
 * An out-of-order observation is still recorded: it is compared against the
 * CURRENT latest, and a genuinely different configuration is a transition
 * whenever it was observed.
 */
async function filterMetaConfigTransitions<TRow>(
  rows: TRow[],
  options: {
    table: "meta_campaign_config_history" | "meta_adset_config_history";
    entityColumn: "campaign_id" | "adset_id";
    entityIdOf: (row: TRow) => string;
  },
): Promise<TRow[]> {
  if (rows.length === 0) return rows;
  const sql = getDb();
  const businessId = (rows[0] as { businessId: string }).businessId;
  const providerAccountId = (rows[0] as { providerAccountId: string })
    .providerAccountId;
  const entityIds = Array.from(new Set(rows.map(options.entityIdOf)));

  const latest = (await sql.query(
    `SELECT DISTINCT ON (${options.entityColumn})
            ${options.entityColumn} AS entity_id, config_fingerprint
     FROM ${options.table}
     WHERE business_id = $1
       AND provider_account_id = $2
       AND ${options.entityColumn} = ANY($3::text[])
     ORDER BY ${options.entityColumn}, captured_at DESC, id DESC`,
    [businessId, providerAccountId, entityIds],
  )) as Array<{ entity_id: string; config_fingerprint: string }>;
  const latestByEntity = new Map(
    latest.map((row) => [row.entity_id, row.config_fingerprint]),
  );

  return rows.filter((row) => {
    const fingerprint = buildMetaConfigHistoryFingerprint(
      row as never,
    );
    return latestByEntity.get(options.entityIdOf(row)) !== fingerprint;
  });
}

/**
 * Take one transaction-scoped advisory lock per entity, in a stable order.
 *
 * Sorted so two writers holding overlapping entity sets acquire them in the
 * same sequence and cannot deadlock against each other.
 */
async function lockMetaConfigHistoryEntities(keys: string[]) {
  const sql = getDb();
  const ordered = Array.from(new Set(keys)).sort();
  for (const key of ordered) {
    await sql`
      SELECT pg_advisory_xact_lock(
        ${META_CONFIG_HISTORY_TRANSITION_LOCK_NAMESPACE}::int,
        hashtext(${key})
      )
    `;
  }
}

export async function replaceMetaAccountDailySlice(input: {
  rows: MetaAccountDailyRow[];
  proof: MetaFinalizationCompletenessProof;
  skipOverviewSummaryRefresh?: boolean;
}) {
  if (input.rows.length === 0) return;
  const slice = {
    businessId: input.rows[0]!.businessId,
    providerAccountId: input.rows[0]!.providerAccountId,
    date: normalizeDate(input.rows[0]!.date),
    scope: "account",
  } as const;
  assertMetaFinalizationCompletenessProof(input.proof, slice);
  await upsertMetaAccountDailyRows(input.rows, {
    skipOverviewSummaryRefresh: input.skipOverviewSummaryRefresh,
  });
}

export async function replaceMetaCampaignDailySlice(input: {
  rows: MetaCampaignDailyRow[];
  proof: MetaFinalizationCompletenessProof;
  /** See MetaDailyWriteOptions: historical replays must not append config history. */
  appendConfigHistory?: boolean;
}) {
  if (input.rows.length === 0) return;
  const slice = {
    businessId: input.rows[0]!.businessId,
    providerAccountId: input.rows[0]!.providerAccountId,
    date: normalizeDate(input.rows[0]!.date),
    scope: "campaign",
  } as const;
  assertMetaFinalizationCompletenessProof(input.proof, slice);
  await runInTransaction(async () => {
    const sql = getDb();
    await upsertMetaCampaignDailyRows(input.rows, {
      appendConfigHistory: input.appendConfigHistory,
    });
    const campaignIds = input.rows.map((row) => row.campaignId);
    await sql`
      DELETE FROM meta_campaign_daily
      WHERE business_id = ${slice.businessId}
        AND provider_account_id = ${slice.providerAccountId}
        AND date = ${slice.date}::date
        AND NOT (campaign_id = ANY(${campaignIds}::text[]))
    `;
  });
}

export async function replaceMetaAdSetDailySlice(input: {
  rows: MetaAdSetDailyRow[];
  proof: MetaFinalizationCompletenessProof;
  /** See MetaDailyWriteOptions: historical replays must not append config history. */
  appendConfigHistory?: boolean;
}) {
  if (input.rows.length === 0) return;
  const slice = {
    businessId: input.rows[0]!.businessId,
    providerAccountId: input.rows[0]!.providerAccountId,
    date: normalizeDate(input.rows[0]!.date),
    scope: "adset",
  } as const;
  assertMetaFinalizationCompletenessProof(input.proof, slice);
  await runInTransaction(async () => {
    const sql = getDb();
    await upsertMetaAdSetDailyRows(input.rows, {
      appendConfigHistory: input.appendConfigHistory,
    });
    const adsetIds = input.rows.map((row) => row.adsetId);
    await sql`
      DELETE FROM meta_adset_daily
      WHERE business_id = ${slice.businessId}
        AND provider_account_id = ${slice.providerAccountId}
        AND date = ${slice.date}::date
        AND NOT (adset_id = ANY(${adsetIds}::text[]))
    `;
  });
}

export async function replaceMetaAdDailySlice(input: {
  rows: MetaAdDailyRow[];
  proof: MetaFinalizationCompletenessProof;
}) {
  if (input.rows.length === 0) return;
  const slice = {
    businessId: input.rows[0]!.businessId,
    providerAccountId: input.rows[0]!.providerAccountId,
    date: normalizeDate(input.rows[0]!.date),
    scope: "ad",
  } as const;
  assertMetaFinalizationCompletenessProof(input.proof, slice);
  await runInTransaction(async () => {
    const sql = getDb();
    await upsertMetaAdDailyRows(input.rows);
    const adIds = input.rows.map((row) => row.adId);
    await sql`
      DELETE FROM meta_ad_daily
      WHERE business_id = ${slice.businessId}
        AND provider_account_id = ${slice.providerAccountId}
        AND date = ${slice.date}::date
        AND NOT (ad_id = ANY(${adIds}::text[]))
    `;
  });
}

export async function replaceMetaBreakdownDailySlice(input: {
  slice: {
    businessId: string;
    providerAccountId: string;
    date: string;
    breakdownType: MetaBreakdownType;
  };
  rows: MetaBreakdownDailyRow[];
  proof: MetaFinalizationCompletenessProof;
}) {
  const slice = {
    businessId: input.slice.businessId,
    providerAccountId: input.slice.providerAccountId,
    date: normalizeDate(input.slice.date),
    breakdownType: input.slice.breakdownType,
    scope: "breakdown",
  } as const;
  assertMetaFinalizationCompletenessProof(input.proof, slice);
  for (const row of input.rows) {
    if (
      row.businessId !== slice.businessId ||
      row.providerAccountId !== slice.providerAccountId ||
      normalizeDate(row.date) !== slice.date ||
      row.breakdownType !== slice.breakdownType
    ) {
      throw new Error("meta_breakdown_slice_mismatch");
    }
  }
  await runInTransaction(async () => {
    const sql = getDb();
    await sql`
      DELETE FROM meta_breakdown_daily
      WHERE business_id = ${slice.businessId}
        AND provider_account_id = ${slice.providerAccountId}
        AND date = ${slice.date}::date
        AND breakdown_type = ${slice.breakdownType}
    `;
    if (input.rows.length > 0) {
      await upsertMetaBreakdownDailyRows(input.rows);
    }
  });
}

export async function upsertMetaBreakdownDailyRows(rows: MetaBreakdownDailyRow[]) {
  if (rows.length === 0) return;
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  for (const chunk of chunkRows(rows, 250)) {
    const referenceContext = await resolveMetaChunkReferenceContext(
      chunk.map((row) => ({
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        accountCurrency: row.accountCurrency,
        accountTimezone: row.accountTimezone,
      })),
    );
    const values: unknown[] = [];
    const placeholders = chunk.map((row, index) => {
      const offset = index * 27;
      values.push(
        row.businessId,
        referenceContext.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
        normalizeDate(row.date),
        row.breakdownType,
        row.breakdownKey,
        row.breakdownLabel,
        row.accountTimezone,
        row.accountCurrency,
        row.spend,
        row.impressions,
        row.clicks,
        row.reach,
        row.frequency,
        row.conversions,
        row.revenue,
        row.roas,
        row.cpa,
        row.ctr,
        row.cpc,
        row.sourceSnapshotId,
        row.truthState ?? "finalized",
        row.truthVersion ?? 1,
        row.finalizedAt ?? null,
        row.validationStatus ?? "passed",
        row.sourceRunId ?? null,
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12},$${offset + 13},$${offset + 14},$${offset + 15},$${offset + 16},$${offset + 17},$${offset + 18},$${offset + 19},$${offset + 20},$${offset + 21},$${offset + 22},$${offset + 23},$${offset + 24},$${offset + 25},$${offset + 26},$${offset + 27},now())`;
    }).join(", ");
    await sql.query(
      `INSERT INTO meta_breakdown_daily (
        business_id, business_ref_id, provider_account_id, provider_account_ref_id, date, breakdown_type, breakdown_key, breakdown_label,
        account_timezone, account_currency, spend, impressions, clicks, reach, frequency,
        conversions, revenue, roas, cpa, ctr, cpc, source_snapshot_id, truth_state, truth_version,
        finalized_at, validation_status, source_run_id, updated_at
      ) VALUES ${placeholders}
      ON CONFLICT (business_id, provider_account_id, date, breakdown_type, breakdown_key) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_breakdown_daily.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_breakdown_daily.provider_account_ref_id),
        breakdown_label = EXCLUDED.breakdown_label,
        account_timezone = EXCLUDED.account_timezone,
        account_currency = EXCLUDED.account_currency,
        spend = EXCLUDED.spend,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        reach = EXCLUDED.reach,
        frequency = EXCLUDED.frequency,
        conversions = EXCLUDED.conversions,
        revenue = EXCLUDED.revenue,
        roas = EXCLUDED.roas,
        cpa = EXCLUDED.cpa,
        ctr = EXCLUDED.ctr,
        cpc = EXCLUDED.cpc,
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        truth_state = EXCLUDED.truth_state,
        truth_version = EXCLUDED.truth_version,
        finalized_at = EXCLUDED.finalized_at,
        validation_status = EXCLUDED.validation_status,
        source_run_id = EXCLUDED.source_run_id,
        updated_at = now()`,
      values
    );
  }
}

function buildMetaConfigHistoryFingerprint(input: {
  objective?: string | null;
  optimizationGoal?: string | null;
  customEventType?: string | null;
  pixelId?: string | null;
  customConversionId?: string | null;
  promotedObject?: unknown;
  bidStrategyType?: string | null;
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
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        objective: input.objective ?? null,
        optimizationGoal: input.optimizationGoal ?? null,
        customEventType: input.customEventType ?? null,
        pixelId: input.pixelId ?? null,
        customConversionId: input.customConversionId ?? null,
        promotedObject: input.promotedObject ?? null,
        bidStrategyType: input.bidStrategyType ?? null,
        bidValue: input.bidValue ?? null,
        bidValueFormat: input.bidValueFormat ?? null,
        dailyBudget: input.dailyBudget ?? null,
        lifetimeBudget: input.lifetimeBudget ?? null,
        isBudgetMixed: Boolean(input.isBudgetMixed),
        isConfigMixed: Boolean(input.isConfigMixed),
        isOptimizationGoalMixed: Boolean(input.isOptimizationGoalMixed),
        isCustomEventTypeMixed: Boolean(input.isCustomEventTypeMixed),
        isBidStrategyMixed: Boolean(input.isBidStrategyMixed),
        isBidValueMixed: Boolean(input.isBidValueMixed),
      }),
    )
    .digest("hex");
}

/**
 * When this configuration was actually observed.
 *
 * `captured_at` is part of the config-history arbiter
 * `(business, account, campaign, fingerprint, captured_at)`, so it decides
 * whether a repeat coalesces or appends. The old fallback —
 * `${date}T00:00:00.000Z` — is a synthetic midnight that was never an
 * observation: it made every row for a day claim the same instant, so two
 * genuinely different observations on one day collapsed into one, and a
 * configuration observed at 14:00 was recorded as having been true since
 * midnight.
 *
 * Returns null when there is no real observation time. Callers must skip the
 * row rather than invent one; an unrecorded observation is recoverable, a
 * fabricated timestamp is not.
 */
function buildMetaHistoryCapturedAt(row: {
  date: string;
  finalizedAt?: string | null;
  configObservedAt?: string | null;
}): string | null {
  return (
    normalizeTimestamp(row.configObservedAt) ??
    normalizeTimestamp(row.finalizedAt) ??
    null
  );
}

async function upsertMetaCampaignDimensionRows(
  rows: MetaCampaignDailyRow[],
  referenceContext: {
    businessRefIds: Map<string, string>;
    providerAccountRefIds: Map<string, string>;
  },
) {
  if (rows.length === 0) return;
  const sql = getDb();
  for (const chunk of chunkRows(rows, 150)) {
    const values: unknown[] = [];
    const placeholders = chunk.map((row, index) => {
      const offset = index * 12;
      values.push(
        row.businessId,
        referenceContext.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId,
        row.campaignNameCurrent,
        row.campaignNameHistorical,
        row.campaignStatus,
        row.buyingType,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        normalizeTimestamp(row.updatedAt) ??
          buildMetaHistoryCapturedAt(row) ??
          new Date().toISOString(),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10}::timestamptz,$${offset + 11}::timestamptz,$${offset + 12}::timestamptz,now(),now())`;
    }).join(", ");

    await sql.query(
      `
        INSERT INTO meta_campaign_dimensions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          campaign_name_current,
          campaign_name_historical,
          campaign_status,
          buying_type,
          first_seen_at,
          last_seen_at,
          source_updated_at,
          created_at,
          updated_at
        )
        VALUES ${placeholders}
        ON CONFLICT (business_id, provider_account_id, campaign_id) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_campaign_dimensions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_campaign_dimensions.provider_account_ref_id),
          campaign_name_current = EXCLUDED.campaign_name_current,
          campaign_name_historical = EXCLUDED.campaign_name_historical,
          campaign_status = EXCLUDED.campaign_status,
          buying_type = EXCLUDED.buying_type,
          first_seen_at = LEAST(COALESCE(meta_campaign_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(COALESCE(meta_campaign_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
          source_updated_at = GREATEST(COALESCE(meta_campaign_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
          updated_at = now()
      `,
      values,
    );
  }
}

async function appendMetaCampaignConfigHistoryRows(
  rows: MetaCampaignDailyRow[],
  referenceContext: {
    businessRefIds: Map<string, string>;
    providerAccountRefIds: Map<string, string>;
  },
): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = getDb();
  let inserted = 0;
  for (const chunk of chunkRows(rows, 150)) {
    const values: unknown[] = [];
    const filtered = chunk
      .map((row) => stripIncompleteConstrainedBidFields(row))
      .filter((row) =>
        row.objective != null ||
        row.optimizationGoal != null ||
        row.customEventType != null ||
        row.bidStrategyType != null ||
        row.bidValue != null ||
        row.dailyBudget != null ||
        row.lifetimeBudget != null ||
        row.isBudgetMixed ||
        row.isConfigMixed ||
        row.isOptimizationGoalMixed ||
        Boolean(row.isCustomEventTypeMixed) ||
        row.isBidStrategyMixed ||
        row.isBidValueMixed,
      )
      // No real observation time, no config-history row. captured_at is part of
      // the arbiter, so inventing one would fabricate the very fact this table
      // records.
      .filter((row) => buildMetaHistoryCapturedAt(row) != null);
    const placeholders = filtered
      .map((row, index) => {
        const offset = index * 24;
        const capturedAt = buildMetaHistoryCapturedAt(row) as string;
        values.push(
          row.businessId,
          referenceContext.businessRefIds.get(row.businessId) ?? null,
          row.providerAccountId,
          referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          row.campaignId,
          buildMetaConfigHistoryFingerprint(row),
          row.objective,
          row.optimizationGoal,
          row.customEventType ?? null,
          row.bidStrategyType,
          row.bidValue,
          row.bidValueFormat,
          row.dailyBudget,
          row.lifetimeBudget,
          row.isBudgetMixed,
          row.isConfigMixed,
          row.isOptimizationGoalMixed,
          row.isCustomEventTypeMixed ?? false,
          row.isBidStrategyMixed,
          row.isBidValueMixed,
          row.sourceSnapshotId,
          capturedAt,
          normalizeDate(row.date),
          normalizeDate(row.date),
        );
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12},$${offset + 13},$${offset + 14},$${offset + 15},$${offset + 16},$${offset + 17},$${offset + 18},$${offset + 19},$${offset + 20},'warehouse_daily',$${offset + 21},$${offset + 22}::timestamptz,$${offset + 23}::date,$${offset + 24}::date,now())`;
      })
      .join(", ");

    if (!placeholders) continue;
    const insertedRows = (await sql.query(
      `
        INSERT INTO meta_campaign_config_history (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          config_fingerprint,
          objective,
          optimization_goal,
          custom_event_type,
          bid_strategy_type,
          bid_value,
          bid_value_format,
          daily_budget,
          lifetime_budget,
          is_budget_mixed,
          is_config_mixed,
          is_optimization_goal_mixed,
          is_custom_event_type_mixed,
          is_bid_strategy_mixed,
          is_bid_value_mixed,
          source_kind,
          source_snapshot_id,
          captured_at,
          effective_from,
          effective_to,
          created_at
        )
        VALUES ${placeholders}
        ON CONFLICT (business_id, provider_account_id, campaign_id, config_fingerprint, captured_at) DO NOTHING
        RETURNING id
      `,
      values,
    )) as Array<{ id: string }> | undefined;
    inserted += Array.isArray(insertedRows) ? insertedRows.length : 0;
  }
  return inserted;
}

async function upsertMetaAdSetDimensionRows(
  rows: MetaAdSetDailyRow[],
  referenceContext: {
    businessRefIds: Map<string, string>;
    providerAccountRefIds: Map<string, string>;
  },
) {
  if (rows.length === 0) return;
  const sql = getDb();
  for (const chunk of chunkRows(rows, 150)) {
    const values: unknown[] = [];
    const placeholders = chunk.map((row, index) => {
      const offset = index * 12;
      values.push(
        row.businessId,
        referenceContext.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId,
        row.adsetId,
        row.adsetNameCurrent,
        row.adsetNameHistorical,
        row.adsetStatus,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        normalizeTimestamp(row.updatedAt) ??
          buildMetaHistoryCapturedAt(row) ??
          new Date().toISOString(),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10}::timestamptz,$${offset + 11}::timestamptz,$${offset + 12}::timestamptz,now(),now())`;
    }).join(", ");

    await sql.query(
      `
        INSERT INTO meta_adset_dimensions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          adset_id,
          adset_name_current,
          adset_name_historical,
          adset_status,
          first_seen_at,
          last_seen_at,
          source_updated_at,
          created_at,
          updated_at
        )
        VALUES ${placeholders}
        ON CONFLICT (business_id, provider_account_id, adset_id) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_adset_dimensions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_adset_dimensions.provider_account_ref_id),
          campaign_id = EXCLUDED.campaign_id,
          adset_name_current = EXCLUDED.adset_name_current,
          adset_name_historical = EXCLUDED.adset_name_historical,
          adset_status = EXCLUDED.adset_status,
          first_seen_at = LEAST(COALESCE(meta_adset_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(COALESCE(meta_adset_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
          source_updated_at = GREATEST(COALESCE(meta_adset_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
          updated_at = now()
      `,
      values,
    );
  }
}

async function appendMetaAdSetConfigHistoryRows(
  rows: MetaAdSetDailyRow[],
  referenceContext: {
    businessRefIds: Map<string, string>;
    providerAccountRefIds: Map<string, string>;
  },
): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = getDb();
  let inserted = 0;
  for (const chunk of chunkRows(rows, 150)) {
    const values: unknown[] = [];
    const filtered = chunk
      .map((row) => stripIncompleteConstrainedBidFields(row))
      .filter((row) =>
        row.optimizationGoal != null ||
        row.customEventType != null ||
        row.pixelId != null ||
        row.customConversionId != null ||
        row.promotedObjectJson != null ||
        row.bidStrategyType != null ||
        row.bidValue != null ||
        row.dailyBudget != null ||
        row.lifetimeBudget != null ||
        row.isBudgetMixed ||
        row.isConfigMixed ||
        row.isOptimizationGoalMixed ||
        row.isBidStrategyMixed ||
        row.isBidValueMixed,
      )
      .filter((row) => buildMetaHistoryCapturedAt(row) != null);

    const placeholders = filtered.map((row, index) => {
      const offset = index * 26;
      const capturedAt = buildMetaHistoryCapturedAt(row) as string;
      values.push(
        row.businessId,
        referenceContext.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId,
        row.adsetId,
        buildMetaConfigHistoryFingerprint({
          optimizationGoal: row.optimizationGoal,
          customEventType: row.customEventType,
          pixelId: row.pixelId,
          customConversionId: row.customConversionId,
          promotedObject: row.promotedObjectJson,
          bidStrategyType: row.bidStrategyType,
          bidValue: row.bidValue,
          bidValueFormat: row.bidValueFormat,
          dailyBudget: row.dailyBudget,
          lifetimeBudget: row.lifetimeBudget,
          isBudgetMixed: row.isBudgetMixed,
          isConfigMixed: row.isConfigMixed,
          isOptimizationGoalMixed: row.isOptimizationGoalMixed,
          isBidStrategyMixed: row.isBidStrategyMixed,
          isBidValueMixed: row.isBidValueMixed,
        }),
        row.optimizationGoal,
        row.customEventType ?? null,
        row.pixelId ?? null,
        row.customConversionId ?? null,
        row.promotedObjectJson == null
          ? null
          : JSON.stringify(row.promotedObjectJson),
        row.bidStrategyType,
        row.bidValue,
        row.bidValueFormat,
        row.dailyBudget,
        row.lifetimeBudget,
        row.isBudgetMixed,
        row.isConfigMixed,
        row.isOptimizationGoalMixed,
        row.isBidStrategyMixed,
        row.isBidValueMixed,
        row.sourceSnapshotId,
        capturedAt,
        normalizeDate(row.date),
        normalizeDate(row.date),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12}::jsonb,$${offset + 13},$${offset + 14},$${offset + 15},$${offset + 16},$${offset + 17},$${offset + 18},$${offset + 19},$${offset + 20},$${offset + 21},$${offset + 22},'warehouse_daily',$${offset + 23},$${offset + 24}::timestamptz,$${offset + 25}::date,$${offset + 26}::date,now())`;
    }).join(", ");

    if (!placeholders) continue;
    const insertedRows = (await sql.query(
      `
        INSERT INTO meta_adset_config_history (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          adset_id,
          config_fingerprint,
          optimization_goal,
          custom_event_type,
          pixel_id,
          custom_conversion_id,
          promoted_object_json,
          bid_strategy_type,
          bid_value,
          bid_value_format,
          daily_budget,
          lifetime_budget,
          is_budget_mixed,
          is_config_mixed,
          is_optimization_goal_mixed,
          is_bid_strategy_mixed,
          is_bid_value_mixed,
          source_kind,
          source_snapshot_id,
          captured_at,
          effective_from,
          effective_to,
          created_at
        )
        VALUES ${placeholders}
        ON CONFLICT (business_id, provider_account_id, adset_id, config_fingerprint, captured_at) DO NOTHING
        RETURNING id
      `,
      values,
    )) as Array<{ id: string }> | undefined;
    inserted += Array.isArray(insertedRows) ? insertedRows.length : 0;
  }
  return inserted;
}

async function upsertMetaAdDimensionRows(
  rows: MetaAdDailyRow[],
  referenceContext: {
    businessRefIds: Map<string, string>;
    providerAccountRefIds: Map<string, string>;
  },
) {
  if (rows.length === 0) return;
  const sql = getDb();
  for (const chunk of chunkRows(rows, 150)) {
    const values: unknown[] = [];
    const placeholders = chunk.map((row, index) => {
      const offset = index * 14;
      const projectionJson =
        row.payloadJson && typeof row.payloadJson === "object"
          ? JSON.stringify(stripMetaCreativeMediaPayload(row.payloadJson))
          : "{}";
      const creativeId =
        row.payloadJson && typeof row.payloadJson === "object" && "creative_id" in (row.payloadJson as Record<string, unknown>)
          ? String((row.payloadJson as Record<string, unknown>).creative_id ?? "")
          : "";
      values.push(
        row.businessId,
        referenceContext.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId,
        row.adsetId,
        row.adId,
        row.adNameCurrent,
        row.adNameHistorical,
        row.adStatus,
        creativeId || null,
        projectionJson,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        normalizeTimestamp(row.updatedAt) ??
          buildMetaHistoryCapturedAt(row) ??
          new Date().toISOString(),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12}::jsonb,$${offset + 13}::timestamptz,$${offset + 13}::timestamptz,$${offset + 14}::timestamptz,now(),now())`;
    }).join(", ");

    await sql.query(
      `
        INSERT INTO meta_ad_dimensions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          adset_id,
          ad_id,
          ad_name_current,
          ad_name_historical,
          ad_status,
          creative_id,
          projection_json,
          first_seen_at,
          last_seen_at,
          source_updated_at,
          created_at,
          updated_at
        )
        VALUES ${placeholders}
        ON CONFLICT (business_id, provider_account_id, ad_id) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_ad_dimensions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_ad_dimensions.provider_account_ref_id),
          campaign_id = EXCLUDED.campaign_id,
          adset_id = EXCLUDED.adset_id,
          ad_name_current = EXCLUDED.ad_name_current,
          ad_name_historical = EXCLUDED.ad_name_historical,
          ad_status = EXCLUDED.ad_status,
          creative_id = COALESCE(EXCLUDED.creative_id, meta_ad_dimensions.creative_id),
          projection_json = EXCLUDED.projection_json,
          first_seen_at = LEAST(COALESCE(meta_ad_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(COALESCE(meta_ad_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
          source_updated_at = GREATEST(COALESCE(meta_ad_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
          updated_at = now()
      `,
      values,
    );
  }
}

async function upsertMetaCreativeDimensionRows(
  rows: MetaCreativeDailyRow[],
  referenceContext: {
    businessRefIds: Map<string, string>;
    providerAccountRefIds: Map<string, string>;
  },
) {
  if (rows.length === 0) return;
  const sql = getDb();
  for (const chunk of chunkRows(rows, 150)) {
    const values: unknown[] = [];
    const placeholders = chunk.map((row, index) => {
      const offset = index * 17;
      const projectionJson =
        row.payloadJson && typeof row.payloadJson === "object"
          ? JSON.stringify(stripMetaCreativeMediaPayload(row.payloadJson))
          : "{}";
      values.push(
        row.businessId,
        referenceContext.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId,
        row.adsetId,
        row.adId,
        row.creativeId,
        row.creativeName,
        row.headline,
        row.primaryText,
        row.destinationUrl,
        row.thumbnailUrl,
        row.assetType,
        projectionJson,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        normalizeTimestamp(row.updatedAt) ??
          buildMetaHistoryCapturedAt(row) ??
          new Date().toISOString(),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12},$${offset + 13},$${offset + 14},$${offset + 15}::jsonb,$${offset + 16}::timestamptz,$${offset + 16}::timestamptz,$${offset + 17}::timestamptz,now(),now())`;
    }).join(", ");

    await sql.query(
      `
        INSERT INTO meta_creative_dimensions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          adset_id,
          ad_id,
          creative_id,
          creative_name,
          headline,
          primary_text,
          destination_url,
          thumbnail_url,
          asset_type,
          projection_json,
          first_seen_at,
          last_seen_at,
          source_updated_at,
          created_at,
          updated_at
        )
        VALUES ${placeholders}
        ON CONFLICT (business_id, provider_account_id, creative_id) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_creative_dimensions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_creative_dimensions.provider_account_ref_id),
          campaign_id = EXCLUDED.campaign_id,
          adset_id = EXCLUDED.adset_id,
          ad_id = EXCLUDED.ad_id,
          creative_name = EXCLUDED.creative_name,
          headline = EXCLUDED.headline,
          primary_text = EXCLUDED.primary_text,
          destination_url = EXCLUDED.destination_url,
          thumbnail_url = EXCLUDED.thumbnail_url,
          asset_type = EXCLUDED.asset_type,
          projection_json = EXCLUDED.projection_json,
          first_seen_at = LEAST(COALESCE(meta_creative_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(COALESCE(meta_creative_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
          source_updated_at = GREATEST(COALESCE(meta_creative_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
          updated_at = now()
      `,
      values,
    );
  }
}

export async function upsertMetaAdDailyRows(rows: MetaAdDailyRow[]) {
  if (rows.length === 0) return;
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  for (const chunk of chunkRows(rows, 150)) {
    const referenceContext = await resolveMetaChunkReferenceContext(
      chunk.map((row) => ({
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        accountCurrency: row.accountCurrency,
        accountTimezone: row.accountTimezone,
      })),
    );
    const values: unknown[] = [];
    const placeholders = chunk
      .map((row, index) => {
        const offset = index * 40;
        values.push(
          row.businessId,
          referenceContext.businessRefIds.get(row.businessId) ?? null,
          row.providerAccountId,
          referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          normalizeDate(row.date),
          row.campaignId,
          row.adsetId,
          row.adId,
          row.adNameCurrent,
          row.adNameHistorical,
          row.adStatus,
          row.destinationUrl ?? null,
          row.destinationUrlRaw ?? null,
          row.destinationUrlSource ?? null,
          row.destinationUrlConfidence ?? null,
          row.ctaType ?? null,
          row.objectStoryId ?? null,
          row.effectiveObjectStoryId ?? null,
          row.accountTimezone,
          row.accountCurrency,
          row.spend,
          row.impressions,
          row.clicks,
          row.reach,
          row.frequency,
          row.conversions,
          row.revenue,
          row.roas,
          row.cpa,
          row.ctr,
          row.cpc,
          row.linkClicks ?? 0,
          row.sourceSnapshotId,
          row.truthState ?? "finalized",
          row.truthVersion ?? 1,
          row.finalizedAt ?? null,
          row.validationStatus ?? "passed",
          row.sourceRunId ?? null,
          row.metricSchemaVersion ?? META_CANONICAL_METRIC_SCHEMA_VERSION,
          JSON.stringify(row.payloadJson ?? null)
        );
        return buildSqlValueTuple(offset, 40, { 40: "::jsonb" });
      })
      .join(", ");
    await sql.query(
      `
      INSERT INTO meta_ad_daily (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        date,
        campaign_id,
        adset_id,
        ad_id,
        ad_name_current,
        ad_name_historical,
        ad_status,
        destination_url,
        destination_url_raw,
        destination_url_source,
        destination_url_confidence,
        cta_type,
        object_story_id,
        effective_object_story_id,
        account_timezone,
        account_currency,
        spend,
        impressions,
        clicks,
        reach,
        frequency,
        conversions,
        revenue,
        roas,
        cpa,
        ctr,
        cpc,
        link_clicks,
        source_snapshot_id,
        truth_state,
        truth_version,
        finalized_at,
        validation_status,
        source_run_id,
        metric_schema_version,
        payload_json,
        updated_at
      )
      VALUES ${placeholders}
      ON CONFLICT (business_id, provider_account_id, date, ad_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_ad_daily.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_ad_daily.provider_account_ref_id),
        campaign_id = EXCLUDED.campaign_id,
        adset_id = EXCLUDED.adset_id,
        ad_name_current = EXCLUDED.ad_name_current,
        ad_name_historical = EXCLUDED.ad_name_historical,
        ad_status = EXCLUDED.ad_status,
        destination_url = COALESCE(EXCLUDED.destination_url, meta_ad_daily.destination_url),
        destination_url_raw = COALESCE(EXCLUDED.destination_url_raw, meta_ad_daily.destination_url_raw),
        destination_url_source = COALESCE(EXCLUDED.destination_url_source, meta_ad_daily.destination_url_source),
        destination_url_confidence = COALESCE(EXCLUDED.destination_url_confidence, meta_ad_daily.destination_url_confidence),
        cta_type = COALESCE(EXCLUDED.cta_type, meta_ad_daily.cta_type),
        object_story_id = COALESCE(EXCLUDED.object_story_id, meta_ad_daily.object_story_id),
        effective_object_story_id = COALESCE(EXCLUDED.effective_object_story_id, meta_ad_daily.effective_object_story_id),
        account_timezone = EXCLUDED.account_timezone,
        account_currency = EXCLUDED.account_currency,
        spend = EXCLUDED.spend,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        reach = EXCLUDED.reach,
        frequency = EXCLUDED.frequency,
        conversions = EXCLUDED.conversions,
        revenue = EXCLUDED.revenue,
        roas = EXCLUDED.roas,
        cpa = EXCLUDED.cpa,
        ctr = EXCLUDED.ctr,
        cpc = EXCLUDED.cpc,
        link_clicks = COALESCE(EXCLUDED.link_clicks, 0, meta_ad_daily.link_clicks),
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        truth_state = EXCLUDED.truth_state,
        truth_version = CASE
          WHEN meta_ad_daily.truth_state = EXCLUDED.truth_state
            AND COALESCE(meta_ad_daily.validation_status, 'passed') = COALESCE(EXCLUDED.validation_status, 'passed')
            THEN GREATEST(COALESCE(meta_ad_daily.truth_version, 1), COALESCE(EXCLUDED.truth_version, 1))
          ELSE GREATEST(COALESCE(meta_ad_daily.truth_version, 1), COALESCE(EXCLUDED.truth_version, 1)) + 1
        END,
        finalized_at = EXCLUDED.finalized_at,
        validation_status = EXCLUDED.validation_status,
        source_run_id = COALESCE(EXCLUDED.source_run_id, meta_ad_daily.source_run_id),
        metric_schema_version = EXCLUDED.metric_schema_version,
        payload_json = EXCLUDED.payload_json,
        updated_at = now()
    `,
      values
    );
    await upsertMetaAdDimensionRows(chunk, referenceContext);
  }
}

function coalesceText(current: string | null | undefined, next: string | null | undefined) {
  return current ?? next ?? null;
}

function coalesceNumber(current: number | null | undefined, next: number | null | undefined) {
  return current ?? next ?? null;
}

function pickEarliestDateLike(current: string | null | undefined, next: string | null | undefined) {
  if (!current) return next ?? null;
  if (!next) return current;
  const currentTime = Date.parse(current);
  const nextTime = Date.parse(next);
  if (!Number.isFinite(currentTime)) return next;
  if (!Number.isFinite(nextTime)) return current;
  return nextTime < currentTime ? next : current;
}

function recomputeCreativeDailyDerivedMetrics(row: MetaCreativeDailyRow) {
  row.frequency = row.reach > 0 ? row.impressions / row.reach : row.frequency;
  row.roas = row.spend > 0 ? row.revenue / row.spend : 0;
  row.cpa = row.conversions > 0 ? row.spend / row.conversions : null;
  row.ctr = row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null;
  row.cpc = row.clicks > 0 ? row.spend / row.clicks : null;
  return row;
}

function mergeMetaCreativeDailyRowsForUpsert(rows: MetaCreativeDailyRow[]) {
  const mergedRows = new Map<string, MetaCreativeDailyRow>();
  for (const row of rows) {
    const key = [
      row.businessId,
      row.providerAccountId,
      normalizeDate(row.date),
      row.creativeId,
    ].join("\u0000");
    const existing = mergedRows.get(key);
    if (!existing) {
      mergedRows.set(key, { ...row, date: normalizeDate(row.date) });
      continue;
    }

    existing.campaignId = coalesceText(existing.campaignId, row.campaignId);
    existing.adsetId = coalesceText(existing.adsetId, row.adsetId);
    existing.adId = coalesceText(existing.adId, row.adId);
    existing.creativeName = coalesceText(existing.creativeName, row.creativeName);
    existing.headline = coalesceText(existing.headline, row.headline);
    existing.primaryText = coalesceText(existing.primaryText, row.primaryText);
    existing.descriptionText = coalesceText(existing.descriptionText, row.descriptionText);
    existing.destinationUrl = coalesceText(existing.destinationUrl, row.destinationUrl);
    existing.destinationUrlRaw = coalesceText(existing.destinationUrlRaw, row.destinationUrlRaw);
    existing.destinationUrlSource = coalesceText(existing.destinationUrlSource, row.destinationUrlSource);
    existing.destinationUrlConfidence = coalesceText(existing.destinationUrlConfidence, row.destinationUrlConfidence);
    existing.ctaType = coalesceText(existing.ctaType, row.ctaType);
    existing.objectStoryId = coalesceText(existing.objectStoryId, row.objectStoryId);
    existing.effectiveObjectStoryId = coalesceText(existing.effectiveObjectStoryId, row.effectiveObjectStoryId);
    existing.thumbnailUrl = coalesceText(existing.thumbnailUrl, row.thumbnailUrl);
    existing.assetType = coalesceText(existing.assetType, row.assetType);
    existing.accountTimezone = existing.accountTimezone || row.accountTimezone;
    existing.accountCurrency = existing.accountCurrency || row.accountCurrency;
    existing.spend += row.spend;
    existing.impressions += row.impressions;
    existing.clicks += row.clicks;
    existing.reach += row.reach;
    existing.conversions += row.conversions;
    existing.revenue += row.revenue;
    existing.linkClicks = (existing.linkClicks ?? 0) + (row.linkClicks ?? 0);
    existing.outboundClicks = (existing.outboundClicks ?? 0) + (row.outboundClicks ?? 0);
    existing.sourceSnapshotId = coalesceText(existing.sourceSnapshotId, row.sourceSnapshotId);
    existing.sourceRunId = coalesceText(existing.sourceRunId, row.sourceRunId);
    existing.metricSchemaVersion = existing.metricSchemaVersion ?? row.metricSchemaVersion;
    existing.launchDate = pickEarliestDateLike(existing.launchDate, row.launchDate);
    existing.firstSeenAt = pickEarliestDateLike(existing.firstSeenAt, row.firstSeenAt);
    existing.firstSpendAt = pickEarliestDateLike(existing.firstSpendAt, row.firstSpendAt);
    existing.effectiveStatus = coalesceText(existing.effectiveStatus, row.effectiveStatus);
    existing.objective = coalesceText(existing.objective, row.objective);
    existing.attributionSetting = coalesceText(existing.attributionSetting, row.attributionSetting);
    existing.qualityRanking = coalesceText(existing.qualityRanking, row.qualityRanking);
    existing.engagementRateRanking = coalesceText(existing.engagementRateRanking, row.engagementRateRanking);
    existing.conversionRateRanking = coalesceText(existing.conversionRateRanking, row.conversionRateRanking);
    existing.bidStrategy = coalesceText(existing.bidStrategy, row.bidStrategy);
    existing.optimizationGoal = coalesceText(existing.optimizationGoal, row.optimizationGoal);
    existing.campaignDailyBudget = coalesceNumber(existing.campaignDailyBudget, row.campaignDailyBudget);
    existing.adsetDailyBudget = coalesceNumber(existing.adsetDailyBudget, row.adsetDailyBudget);
    existing.campaignLifetimeBudget = coalesceNumber(existing.campaignLifetimeBudget, row.campaignLifetimeBudget);
    existing.adsetLifetimeBudget = coalesceNumber(existing.adsetLifetimeBudget, row.adsetLifetimeBudget);
    existing.creativeDeliveryType = coalesceText(existing.creativeDeliveryType, row.creativeDeliveryType);
    existing.creativeVisualFormat = coalesceText(existing.creativeVisualFormat, row.creativeVisualFormat);
    existing.creativePrimaryType = coalesceText(existing.creativePrimaryType, row.creativePrimaryType);
    existing.creativeSecondaryType = coalesceText(existing.creativeSecondaryType, row.creativeSecondaryType);
    existing.imageHash = coalesceText(existing.imageHash, row.imageHash);
    existing.payloadJson = existing.payloadJson ?? row.payloadJson;
    recomputeCreativeDailyDerivedMetrics(existing);
  }
  return [...mergedRows.values()];
}

export async function upsertMetaCreativeDailyRows(rows: MetaCreativeDailyRow[]) {
  if (rows.length === 0) return;
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rowsForUpsert = mergeMetaCreativeDailyRowsForUpsert(rows);
  for (const chunk of chunkRows(rowsForUpsert, 150)) {
    const referenceContext = await resolveMetaChunkReferenceContext(
      chunk.map((row) => ({
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        accountCurrency: row.accountCurrency,
        accountTimezone: row.accountTimezone,
      })),
    );
    const values: unknown[] = [];
    const placeholders = chunk
      .map((row, index) => {
        const offset = index * 61;
        const normalizedRowDate = normalizeDate(row.date);
        const launchDate = row.launchDate ? normalizeDate(row.launchDate) : null;
        const firstSeenAt =
          normalizeTimestamp(row.firstSeenAt) ??
          (launchDate ? `${launchDate}T00:00:00.000Z` : `${normalizedRowDate}T00:00:00.000Z`);
        const firstSpendAt =
          normalizeTimestamp(row.firstSpendAt) ??
          (Number(row.spend ?? 0) > 0 ? `${normalizedRowDate}T00:00:00.000Z` : null);
        values.push(
          row.businessId,
          referenceContext.businessRefIds.get(row.businessId) ?? null,
          row.providerAccountId,
          referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          normalizedRowDate,
          row.campaignId,
          row.adsetId,
          row.adId,
          row.creativeId,
          row.creativeName,
          row.headline,
          row.primaryText,
          row.descriptionText ?? null,
          row.destinationUrl,
          row.destinationUrlRaw ?? null,
          row.destinationUrlSource ?? null,
          row.destinationUrlConfidence ?? null,
          row.ctaType ?? null,
          row.objectStoryId ?? null,
          row.effectiveObjectStoryId ?? null,
          row.thumbnailUrl,
          row.assetType,
          row.accountTimezone,
          row.accountCurrency,
          row.spend,
          row.impressions,
          row.clicks,
          row.reach ?? 0,
          row.frequency ?? null,
          row.conversions,
          row.revenue,
          row.roas,
          row.cpa ?? null,
          row.ctr,
          row.cpc,
          row.linkClicks ?? 0,
          row.outboundClicks ?? 0,
          row.sourceSnapshotId,
          row.sourceRunId ?? null,
          row.metricSchemaVersion ?? META_CANONICAL_METRIC_SCHEMA_VERSION,
          launchDate,
          firstSeenAt,
          firstSpendAt,
          row.effectiveStatus ?? null,
          row.objective ?? null,
          row.attributionSetting ?? null,
          row.qualityRanking ?? null,
          row.engagementRateRanking ?? null,
          row.conversionRateRanking ?? null,
          row.bidStrategy ?? null,
          row.optimizationGoal ?? null,
          row.campaignDailyBudget ?? null,
          row.adsetDailyBudget ?? null,
          row.campaignLifetimeBudget ?? null,
          row.adsetLifetimeBudget ?? null,
          row.creativeDeliveryType ?? null,
          row.creativeVisualFormat ?? null,
          row.creativePrimaryType ?? null,
          row.creativeSecondaryType ?? null,
          row.imageHash ?? null,
          JSON.stringify(stripMetaCreativeMediaPayload(row.payloadJson ?? null))
        );
        return buildSqlValueTuple(offset, 61, { 61: "::jsonb" });
      })
      .join(", ");

    await sql.query(
      `
      INSERT INTO meta_creative_daily (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        date,
        campaign_id,
        adset_id,
        ad_id,
        creative_id,
        creative_name,
        headline,
        primary_text,
        description_text,
        destination_url,
        destination_url_raw,
        destination_url_source,
        destination_url_confidence,
        cta_type,
        object_story_id,
        effective_object_story_id,
        thumbnail_url,
        asset_type,
        account_timezone,
        account_currency,
        spend,
        impressions,
        clicks,
        reach,
        frequency,
        conversions,
        revenue,
        roas,
        cpa,
        ctr,
        cpc,
        link_clicks,
        outbound_clicks,
        source_snapshot_id,
        source_run_id,
        metric_schema_version,
        launch_date,
        first_seen_at,
        first_spend_at,
        effective_status,
        objective,
        attribution_setting,
        quality_ranking,
        engagement_rate_ranking,
        conversion_rate_ranking,
        bid_strategy,
        optimization_goal,
        campaign_daily_budget,
        adset_daily_budget,
        campaign_lifetime_budget,
        adset_lifetime_budget,
        creative_delivery_type,
        creative_visual_format,
        creative_primary_type,
        creative_secondary_type,
        image_hash,
        payload_json,
        updated_at
      )
      VALUES ${placeholders}
      ON CONFLICT (business_id, provider_account_id, date, creative_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_creative_daily.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_creative_daily.provider_account_ref_id),
        campaign_id = EXCLUDED.campaign_id,
        adset_id = EXCLUDED.adset_id,
        ad_id = EXCLUDED.ad_id,
        creative_name = EXCLUDED.creative_name,
        headline = EXCLUDED.headline,
        primary_text = EXCLUDED.primary_text,
        description_text = EXCLUDED.description_text,
        destination_url = EXCLUDED.destination_url,
        destination_url_raw = COALESCE(EXCLUDED.destination_url_raw, meta_creative_daily.destination_url_raw),
        destination_url_source = COALESCE(EXCLUDED.destination_url_source, meta_creative_daily.destination_url_source),
        destination_url_confidence = COALESCE(EXCLUDED.destination_url_confidence, meta_creative_daily.destination_url_confidence),
        cta_type = COALESCE(EXCLUDED.cta_type, meta_creative_daily.cta_type),
        object_story_id = COALESCE(EXCLUDED.object_story_id, meta_creative_daily.object_story_id),
        effective_object_story_id = COALESCE(EXCLUDED.effective_object_story_id, meta_creative_daily.effective_object_story_id),
        thumbnail_url = EXCLUDED.thumbnail_url,
        asset_type = EXCLUDED.asset_type,
        account_timezone = EXCLUDED.account_timezone,
        account_currency = EXCLUDED.account_currency,
        spend = EXCLUDED.spend,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        reach = EXCLUDED.reach,
        frequency = EXCLUDED.frequency,
        conversions = EXCLUDED.conversions,
        revenue = EXCLUDED.revenue,
        roas = EXCLUDED.roas,
        cpa = EXCLUDED.cpa,
        ctr = EXCLUDED.ctr,
        cpc = EXCLUDED.cpc,
        link_clicks = COALESCE(EXCLUDED.link_clicks, meta_creative_daily.link_clicks),
        outbound_clicks = COALESCE(EXCLUDED.outbound_clicks, meta_creative_daily.outbound_clicks),
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        source_run_id = COALESCE(EXCLUDED.source_run_id, meta_creative_daily.source_run_id),
        metric_schema_version = EXCLUDED.metric_schema_version,
        launch_date = COALESCE(EXCLUDED.launch_date, meta_creative_daily.launch_date),
        first_seen_at = LEAST(COALESCE(meta_creative_daily.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
        first_spend_at = CASE
          WHEN EXCLUDED.first_spend_at IS NULL THEN meta_creative_daily.first_spend_at
          ELSE LEAST(COALESCE(meta_creative_daily.first_spend_at, EXCLUDED.first_spend_at), EXCLUDED.first_spend_at)
        END,
        effective_status = COALESCE(EXCLUDED.effective_status, meta_creative_daily.effective_status),
        objective = COALESCE(EXCLUDED.objective, meta_creative_daily.objective),
        attribution_setting = COALESCE(EXCLUDED.attribution_setting, meta_creative_daily.attribution_setting),
        quality_ranking = COALESCE(EXCLUDED.quality_ranking, meta_creative_daily.quality_ranking),
        engagement_rate_ranking = COALESCE(EXCLUDED.engagement_rate_ranking, meta_creative_daily.engagement_rate_ranking),
        conversion_rate_ranking = COALESCE(EXCLUDED.conversion_rate_ranking, meta_creative_daily.conversion_rate_ranking),
        bid_strategy = COALESCE(EXCLUDED.bid_strategy, meta_creative_daily.bid_strategy),
        optimization_goal = COALESCE(EXCLUDED.optimization_goal, meta_creative_daily.optimization_goal),
        campaign_daily_budget = COALESCE(EXCLUDED.campaign_daily_budget, meta_creative_daily.campaign_daily_budget),
        adset_daily_budget = COALESCE(EXCLUDED.adset_daily_budget, meta_creative_daily.adset_daily_budget),
        campaign_lifetime_budget = COALESCE(EXCLUDED.campaign_lifetime_budget, meta_creative_daily.campaign_lifetime_budget),
        adset_lifetime_budget = COALESCE(EXCLUDED.adset_lifetime_budget, meta_creative_daily.adset_lifetime_budget),
        creative_delivery_type = COALESCE(EXCLUDED.creative_delivery_type, meta_creative_daily.creative_delivery_type),
        creative_visual_format = COALESCE(EXCLUDED.creative_visual_format, meta_creative_daily.creative_visual_format),
        creative_primary_type = COALESCE(EXCLUDED.creative_primary_type, meta_creative_daily.creative_primary_type),
        creative_secondary_type = COALESCE(EXCLUDED.creative_secondary_type, meta_creative_daily.creative_secondary_type),
        image_hash = COALESCE(EXCLUDED.image_hash, meta_creative_daily.image_hash),
        payload_json = EXCLUDED.payload_json,
        updated_at = now()
    `,
      values
    );
    await upsertMetaCreativeDimensionRows(chunk, referenceContext);
  }
}

export async function upsertMetaCreativeMediaRows(rows: MetaCreativeMediaRow[]) {
  if (rows.length === 0) return;
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  for (const chunk of chunkRows(rows, 150)) {
    const referenceContext = await resolveMetaChunkReferenceContext(
      chunk.map((row) => ({
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        accountCurrency: "USD",
        accountTimezone: "UTC",
      })),
    );
    const values: unknown[] = [];
    const placeholders = chunk
      .map((row, index) => {
        const offset = index * 21;
        values.push(
          row.businessId,
          referenceContext.businessRefIds.get(row.businessId) ?? null,
          row.providerAccountId,
          referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          normalizeDate(row.date),
          row.campaignId ?? null,
          row.adsetId ?? null,
          row.adId ?? null,
          row.creativeId,
          row.previewUrl ?? null,
          row.thumbnailUrl ?? null,
          row.imageUrl ?? null,
          row.tableThumbnailUrl ?? null,
          row.cardPreviewUrl ?? null,
          row.videoUrl ?? null,
          row.posterUrl ?? null,
          row.previewHtml ?? null,
          row.mediaCacheKey ?? null,
          row.imageHash ?? null,
          JSON.stringify(row.payloadJson ?? {}),
          row.sourceRunId ?? null,
        );
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12},$${offset + 13},$${offset + 14},$${offset + 15},$${offset + 16},$${offset + 17},$${offset + 18},$${offset + 19},$${offset + 20}::jsonb,$${offset + 21},now())`;
      })
      .join(", ");

    await sql.query(
      `
        INSERT INTO meta_creative_media (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          date,
          campaign_id,
          adset_id,
          ad_id,
          creative_id,
          preview_url,
          thumbnail_url,
          image_url,
          table_thumbnail_url,
          card_preview_url,
          video_url,
          poster_url,
          preview_html,
          media_cache_key,
          image_hash,
          payload_json,
          source_run_id,
          updated_at
        )
        VALUES ${placeholders}
        ON CONFLICT (business_id, provider_account_id, date, creative_id, (COALESCE(ad_id, ''))) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_creative_media.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_creative_media.provider_account_ref_id),
          campaign_id = EXCLUDED.campaign_id,
          adset_id = EXCLUDED.adset_id,
          ad_id = EXCLUDED.ad_id,
          preview_url = EXCLUDED.preview_url,
          thumbnail_url = EXCLUDED.thumbnail_url,
          image_url = EXCLUDED.image_url,
          table_thumbnail_url = EXCLUDED.table_thumbnail_url,
          card_preview_url = EXCLUDED.card_preview_url,
          video_url = EXCLUDED.video_url,
          poster_url = EXCLUDED.poster_url,
          preview_html = EXCLUDED.preview_html,
          media_cache_key = EXCLUDED.media_cache_key,
          image_hash = COALESCE(EXCLUDED.image_hash, meta_creative_media.image_hash),
          payload_json = EXCLUDED.payload_json,
          source_run_id = COALESCE(EXCLUDED.source_run_id, meta_creative_media.source_run_id),
          updated_at = now()
      `,
      values,
    );
  }
}

export async function getMetaAccountDailyRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  includeProvisional?: boolean;
}): Promise<MetaAccountDailyRow[]> {
  await assertMetaRequestReadTablesReady(
    ["meta_account_daily"],
    "meta_account_daily_range",
  );
  const sql = getDb();
  const supportsTruthLifecycle = await hasMetaTruthLifecycleColumns();
  const rows = supportsTruthLifecycle
    ? await sql`
    SELECT
      business_id,
      provider_account_id,
      date::text AS date,
      account_name,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      source_snapshot_id,
      metric_schema_version,
      truth_state,
      truth_version,
      finalized_at,
      validation_status,
      source_run_id,
      created_at,
      updated_at
    FROM meta_account_daily
    WHERE business_id = ${input.businessId}
      AND date >= ${normalizeDate(input.startDate)}
      AND date <= ${normalizeDate(input.endDate)}
      AND (
        ${input.providerAccountIds ?? null}::text[] IS NULL
        OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
      )
      AND (
        ${input.includeProvisional ?? false}::boolean = TRUE
        OR truth_state IS NULL
        OR truth_state = 'finalized'
      )
    ORDER BY date ASC, provider_account_id ASC
  `
    : typeof sql.query === "function"
      ? await sql.query(
      `
    SELECT
      business_id,
      provider_account_id,
      date::text AS date,
      account_name,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      source_snapshot_id,
      metric_schema_version,
      created_at,
      updated_at
    FROM meta_account_daily
    WHERE business_id = $1
      AND date >= $2
      AND date <= $3
      AND ($4::text[] IS NULL OR provider_account_id = ANY($4::text[]))
    ORDER BY date ASC, provider_account_id ASC
  `,
      [input.businessId, normalizeDate(input.startDate), normalizeDate(input.endDate), input.providerAccountIds ?? null]
    )
      : await sql`
    SELECT
      business_id,
      provider_account_id,
      date::text AS date,
      account_name,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      source_snapshot_id,
      metric_schema_version,
      created_at,
      updated_at
    FROM meta_account_daily
    WHERE business_id = ${input.businessId}
      AND date >= ${normalizeDate(input.startDate)}
      AND date <= ${normalizeDate(input.endDate)}
      AND (
        ${input.providerAccountIds ?? null}::text[] IS NULL
        OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
      )
    ORDER BY date ASC, provider_account_id ASC
  `;
  const typedRows = rows as Array<{
    business_id: string;
    provider_account_id: string;
    date: string;
    account_name: string | null;
    account_timezone: string;
    account_currency: string;
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
    source_snapshot_id: string | null;
    metric_schema_version?: number | null;
    truth_state?: string | null;
    truth_version?: number | null;
    finalized_at?: string | null;
    validation_status?: string | null;
    source_run_id?: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return typedRows.map((row) => ({
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    date: normalizeDate(row.date),
    accountName: row.account_name,
    accountTimezone: row.account_timezone,
    accountCurrency: row.account_currency,
    spend: Number(row.spend ?? 0),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    reach: Number(row.reach ?? 0),
    frequency: row.frequency == null ? null : Number(row.frequency),
    conversions: Number(row.conversions ?? 0),
    revenue: Number(row.revenue ?? 0),
    roas: Number(row.roas ?? 0),
    cpa: row.cpa == null ? null : Number(row.cpa),
    ctr: row.ctr == null ? null : Number(row.ctr),
    cpc: row.cpc == null ? null : Number(row.cpc),
    sourceSnapshotId: row.source_snapshot_id,
    metricSchemaVersion:
      row.metric_schema_version == null
        ? undefined
        : Number(row.metric_schema_version),
    truthState: row.truth_state == null ? undefined : (row.truth_state as MetaAccountDailyRow["truthState"]),
    truthVersion: row.truth_version == null ? undefined : Number(row.truth_version),
    finalizedAt: row.finalized_at,
    validationStatus:
      row.validation_status == null
        ? undefined
        : (row.validation_status as MetaAccountDailyRow["validationStatus"]),
    sourceRunId: row.source_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getMetaCheckpointHealth(input: {
  businessId: string;
  providerAccountId?: string | null;
}) {
  await assertMetaRequestReadTablesReady(
    ["meta_sync_checkpoints"],
    "meta_checkpoint_health",
  );
  const sql = getDb();
  const rows = await sql`
    SELECT
      checkpoint_scope,
      phase,
      status,
      page_index,
      updated_at,
      COUNT(*) FILTER (WHERE status = 'failed') OVER ()::int AS checkpoint_failures
    FROM meta_sync_checkpoints
    WHERE business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
    ORDER BY updated_at DESC
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) {
    return {
      latestCheckpointScope: null,
      latestCheckpointPhase: null,
      latestCheckpointStatus: null,
      latestCheckpointUpdatedAt: null,
      checkpointLagMinutes: null,
      lastSuccessfulPageIndex: null,
      resumeCapable: false,
      checkpointFailures: 0,
    };
  }
  const updatedAt = normalizeTimestamp(row.updated_at);
  const lagMinutes =
    updatedAt && Number.isFinite(new Date(updatedAt).getTime())
      ? Math.max(0, Math.round((Date.now() - new Date(updatedAt).getTime()) / 60_000))
      : null;
  return {
    latestCheckpointScope: row.checkpoint_scope ? String(row.checkpoint_scope) : null,
    latestCheckpointPhase: row.phase ? String(row.phase) : null,
    latestCheckpointStatus: row.status ? String(row.status) : null,
    latestCheckpointUpdatedAt: updatedAt,
    checkpointLagMinutes: lagMinutes,
    lastSuccessfulPageIndex: toNumber(row.page_index),
    resumeCapable:
      row.status != null &&
      ["pending", "running", "failed"].includes(String(row.status)),
    checkpointFailures: toNumber(row.checkpoint_failures),
  };
}

export async function getMetaDirtyRecentDates(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  slowPathDates?: string[] | null;
}): Promise<MetaDirtyRecentDateRow[]> {
  await assertMetaRequestReadTablesReady(
    [
      "meta_account_daily",
      "meta_campaign_daily",
      "meta_adset_daily",
      "meta_breakdown_daily",
      "meta_sync_partitions",
      "meta_sync_checkpoints",
    ],
    "meta_dirty_recent_dates",
  );
  const sql = getDb();
  const supportsTruthLifecycle = await hasMetaTruthLifecycleColumns();
  const fastRows = supportsTruthLifecycle
    ? await sql`
    WITH campaign_totals AS (
      SELECT
        provider_account_id,
        date,
        COUNT(DISTINCT campaign_id)::int AS campaign_count,
        BOOL_AND(COALESCE(truth_state, 'finalized') = 'finalized') AS campaigns_finalized
      FROM meta_campaign_daily
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
      GROUP BY provider_account_id, date
    ),
    adset_totals AS (
      SELECT
        provider_account_id,
        date,
        COUNT(DISTINCT adset_id)::int AS adset_count,
        BOOL_AND(COALESCE(truth_state, 'finalized') = 'finalized') AS adsets_finalized
      FROM meta_adset_daily
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
      GROUP BY provider_account_id, date
    ),
    breakdown_coverage AS (
      SELECT
        provider_account_id,
        date,
        breakdown_type
      FROM meta_breakdown_daily
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
        AND COALESCE(truth_state, 'finalized') = 'finalized'
      UNION
      SELECT
        partition.provider_account_id,
        partition.partition_date AS date,
        CASE checkpoint.checkpoint_scope
          WHEN 'breakdown:age,gender' THEN 'age'
          WHEN 'breakdown:country' THEN 'country'
          WHEN 'breakdown:publisher_platform,platform_position,impression_device' THEN 'placement'
          ELSE NULL
        END AS breakdown_type
      FROM meta_sync_partitions partition
      JOIN meta_sync_checkpoints checkpoint
        ON checkpoint.partition_id = partition.id
      WHERE partition.business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR partition.provider_account_id = ${input.providerAccountId ?? null})
        AND partition.partition_date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
        AND checkpoint.phase = 'finalize'
        AND checkpoint.status = 'succeeded'
        AND checkpoint.checkpoint_scope = ANY(${Array.from(META_BREAKDOWN_CHECKPOINT_SCOPES)}::text[])
    ),
    breakdown_totals AS (
      SELECT
        provider_account_id,
        date,
        COUNT(DISTINCT breakdown_type)::int AS finalized_breakdown_type_count
      FROM breakdown_coverage
      WHERE breakdown_type IS NOT NULL
      GROUP BY provider_account_id, date
    )
    SELECT
      account.date::text AS date,
      account.provider_account_id,
      COALESCE(campaign_totals.campaign_count, 0) AS campaign_count,
      COALESCE(adset_totals.adset_count, 0) AS adset_count,
      COALESCE(account.truth_state, 'finalized') AS account_truth_state,
      COALESCE(account.validation_status, 'passed') AS account_validation_status,
      COALESCE(campaign_totals.campaigns_finalized, false) AS campaigns_finalized,
      COALESCE(adset_totals.adsets_finalized, false) AS adsets_finalized,
      COALESCE(breakdown_totals.finalized_breakdown_type_count, 0) AS finalized_breakdown_type_count
    FROM meta_account_daily account
    LEFT JOIN campaign_totals
      ON campaign_totals.provider_account_id = account.provider_account_id
      AND campaign_totals.date = account.date
    LEFT JOIN adset_totals
      ON adset_totals.provider_account_id = account.provider_account_id
      AND adset_totals.date = account.date
    LEFT JOIN breakdown_totals
      ON breakdown_totals.provider_account_id = account.provider_account_id
      AND breakdown_totals.date = account.date
    WHERE account.business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR account.provider_account_id = ${input.providerAccountId ?? null})
      AND account.date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
    ORDER BY account.date DESC, account.provider_account_id ASC
  `
    : typeof sql.query === "function"
      ? await sql.query(
      `
    WITH campaign_totals AS (
      SELECT
        provider_account_id,
        date,
        COUNT(DISTINCT campaign_id)::int AS campaign_count
      FROM meta_campaign_daily
      WHERE business_id = $1
        AND ($2::text IS NULL OR provider_account_id = $2)
        AND date BETWEEN $3 AND $4
      GROUP BY provider_account_id, date
    ),
    adset_totals AS (
      SELECT
        provider_account_id,
        date,
        COUNT(DISTINCT adset_id)::int AS adset_count
      FROM meta_adset_daily
      WHERE business_id = $1
        AND ($2::text IS NULL OR provider_account_id = $2)
        AND date BETWEEN $3 AND $4
      GROUP BY provider_account_id, date
    ),
    breakdown_coverage AS (
      SELECT
        provider_account_id,
        date,
        breakdown_type
      FROM meta_breakdown_daily
      WHERE business_id = $1
        AND ($2::text IS NULL OR provider_account_id = $2)
        AND date BETWEEN $3 AND $4
      UNION
      SELECT
        partition.provider_account_id,
        partition.partition_date AS date,
        ${META_BREAKDOWN_CHECKPOINT_SCOPE_TO_TYPE_SQL} AS breakdown_type
      FROM meta_sync_partitions partition
      JOIN meta_sync_checkpoints checkpoint
        ON checkpoint.partition_id = partition.id
      WHERE partition.business_id = $1
        AND ($2::text IS NULL OR partition.provider_account_id = $2)
        AND partition.partition_date BETWEEN $3 AND $4
        AND checkpoint.phase = 'finalize'
        AND checkpoint.status = 'succeeded'
        AND checkpoint.checkpoint_scope IN (
          'breakdown:age,gender',
          'breakdown:country',
          'breakdown:publisher_platform,platform_position,impression_device'
        )
    ),
    breakdown_totals AS (
      SELECT
        provider_account_id,
        date,
        COUNT(DISTINCT breakdown_type)::int AS finalized_breakdown_type_count
      FROM breakdown_coverage
      WHERE breakdown_type IS NOT NULL
      GROUP BY provider_account_id, date
    )
    SELECT
      account.date::text AS date,
      account.provider_account_id,
      COALESCE(campaign_totals.campaign_count, 0) AS campaign_count,
      COALESCE(adset_totals.adset_count, 0) AS adset_count,
      'finalized' AS account_truth_state,
      'passed' AS account_validation_status,
      true AS campaigns_finalized,
      true AS adsets_finalized,
      COALESCE(breakdown_totals.finalized_breakdown_type_count, 0) AS finalized_breakdown_type_count
    FROM meta_account_daily account
    LEFT JOIN campaign_totals
      ON campaign_totals.provider_account_id = account.provider_account_id
      AND campaign_totals.date = account.date
    LEFT JOIN adset_totals
      ON adset_totals.provider_account_id = account.provider_account_id
      AND adset_totals.date = account.date
    LEFT JOIN breakdown_totals
      ON breakdown_totals.provider_account_id = account.provider_account_id
      AND breakdown_totals.date = account.date
    WHERE account.business_id = $1
      AND ($2::text IS NULL OR account.provider_account_id = $2)
      AND account.date BETWEEN $3 AND $4
    ORDER BY account.date DESC, account.provider_account_id ASC
  `,
      [input.businessId, input.providerAccountId ?? null, normalizeDate(input.startDate), normalizeDate(input.endDate)]
    )
      : await sql`
    WITH campaign_totals AS (
      SELECT
        provider_account_id,
        date,
        COUNT(DISTINCT campaign_id)::int AS campaign_count
      FROM meta_campaign_daily
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
      GROUP BY provider_account_id, date
    ),
    adset_totals AS (
      SELECT
        provider_account_id,
        date,
        COUNT(DISTINCT adset_id)::int AS adset_count
      FROM meta_adset_daily
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
      GROUP BY provider_account_id, date
    ),
    breakdown_coverage AS (
      SELECT
        provider_account_id,
        date,
        breakdown_type
      FROM meta_breakdown_daily
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
      UNION
      SELECT
        partition.provider_account_id,
        partition.partition_date AS date,
        CASE checkpoint.checkpoint_scope
          WHEN 'breakdown:age,gender' THEN 'age'
          WHEN 'breakdown:country' THEN 'country'
          WHEN 'breakdown:publisher_platform,platform_position,impression_device' THEN 'placement'
          ELSE NULL
        END AS breakdown_type
      FROM meta_sync_partitions partition
      JOIN meta_sync_checkpoints checkpoint
        ON checkpoint.partition_id = partition.id
      WHERE partition.business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR partition.provider_account_id = ${input.providerAccountId ?? null})
        AND partition.partition_date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
        AND checkpoint.phase = 'finalize'
        AND checkpoint.status = 'succeeded'
        AND checkpoint.checkpoint_scope = ANY(${Array.from(META_BREAKDOWN_CHECKPOINT_SCOPES)}::text[])
    ),
    breakdown_totals AS (
      SELECT
        provider_account_id,
        date,
        COUNT(DISTINCT breakdown_type)::int AS finalized_breakdown_type_count
      FROM breakdown_coverage
      WHERE breakdown_type IS NOT NULL
      GROUP BY provider_account_id, date
    )
    SELECT
      account.date::text AS date,
      account.provider_account_id,
      COALESCE(campaign_totals.campaign_count, 0) AS campaign_count,
      COALESCE(adset_totals.adset_count, 0) AS adset_count,
      'finalized' AS account_truth_state,
      'passed' AS account_validation_status,
      true AS campaigns_finalized,
      true AS adsets_finalized,
      COALESCE(breakdown_totals.finalized_breakdown_type_count, 0) AS finalized_breakdown_type_count
    FROM meta_account_daily account
    LEFT JOIN campaign_totals
      ON campaign_totals.provider_account_id = account.provider_account_id
      AND campaign_totals.date = account.date
    LEFT JOIN adset_totals
      ON adset_totals.provider_account_id = account.provider_account_id
      AND adset_totals.date = account.date
    LEFT JOIN breakdown_totals
      ON breakdown_totals.provider_account_id = account.provider_account_id
      AND breakdown_totals.date = account.date
    WHERE account.business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR account.provider_account_id = ${input.providerAccountId ?? null})
      AND account.date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
    ORDER BY account.date DESC, account.provider_account_id ASC
  `;
  const typedFastRows = fastRows as Array<Record<string, unknown>>;
  const slowPathDateSet = new Set(
    (input.slowPathDates ?? []).map((date) => normalizeDate(date)),
  );
  const suspiciousKeys = new Set<string>();
  const dirtyRows = new Map<string, MetaDirtyRecentDateRow>();

  for (const row of typedFastRows) {
    const date = String(row.date);
    const providerAccountId = String(row.provider_account_id);
    const reasons = new Set<MetaDirtyRecentReason>();
    if (String(row.account_truth_state ?? "finalized") !== "finalized") {
      reasons.add("non_finalized");
    }
    if (!Boolean(row.campaigns_finalized) || !Boolean(row.adsets_finalized)) {
      reasons.add("non_finalized");
    }
    if (String(row.account_validation_status ?? "passed") !== "passed") {
      reasons.add("validation_failed");
    }
    if (Number(row.campaign_count ?? 0) <= 0) {
      reasons.add("missing_campaign");
    }
    if (Number(row.adset_count ?? 0) <= 0) {
      reasons.add("missing_adset");
    }
    if (
      Number(row.finalized_breakdown_type_count ?? 0) <
      META_EXPECTED_FINALIZED_BREAKDOWN_TYPES.length
    ) {
      reasons.add("missing_breakdown");
    }

    const key = `${providerAccountId}:${date}`;
    if (reasons.size > 0) {
      suspiciousKeys.add(key);
      const reasonList = Array.from(reasons);
      const severity: MetaDirtyRecentSeverity = reasonList.some((reason) =>
        reason === "non_finalized" || reason === "validation_failed",
      )
        ? "critical"
        : reasonList.some(
            (reason) => reason === "missing_campaign" || reason === "missing_adset",
          )
          ? "high"
          : "low";
      dirtyRows.set(key, {
        providerAccountId,
        date,
        ...deriveMetaDirtyRecentFlags({
          reasons: reasonList,
          severity,
        }),
      });
    } else if (slowPathDateSet.has(date)) {
      suspiciousKeys.add(key);
    }
  }

  const slowPathPairs = Array.from(suspiciousKeys).map((key) => {
    const [providerAccountId, date] = key.split(":");
    return { providerAccountId, date };
  });
  if (slowPathPairs.length === 0) {
    return Array.from(dirtyRows.values()).sort((left, right) =>
      `${right.date}:${left.providerAccountId}`.localeCompare(
        `${left.date}:${right.providerAccountId}`,
      ),
    );
  }

  const slowProviders = Array.from(
    new Set(slowPathPairs.map((row) => row.providerAccountId)),
  );
  const slowDates = Array.from(new Set(slowPathPairs.map((row) => row.date)));
  const slowRows = typeof sql.query === "function"
    ? await sql.query(
        `
      WITH campaign_totals AS (
        SELECT
          provider_account_id,
          date,
          ROUND(SUM(spend)::numeric, 2) AS campaign_spend
        FROM meta_campaign_daily
        WHERE business_id = $1
          AND provider_account_id = ANY($2::text[])
          AND date = ANY($3::date[])
        GROUP BY provider_account_id, date
      )
      SELECT
        account.date::text AS date,
        account.provider_account_id,
        account.spend AS account_spend,
        COALESCE(campaign_totals.campaign_spend, 0) AS campaign_spend
      FROM meta_account_daily account
      LEFT JOIN campaign_totals
        ON campaign_totals.provider_account_id = account.provider_account_id
        AND campaign_totals.date = account.date
      WHERE account.business_id = $1
        AND account.provider_account_id = ANY($2::text[])
        AND account.date = ANY($3::date[])
    `,
        [input.businessId, slowProviders, slowDates],
      )
    : await sql`
      WITH campaign_totals AS (
        SELECT
          provider_account_id,
          date,
          ROUND(SUM(spend)::numeric, 2) AS campaign_spend
        FROM meta_campaign_daily
        WHERE business_id = ${input.businessId}
          AND provider_account_id = ANY(${slowProviders}::text[])
          AND date = ANY(${slowDates}::date[])
        GROUP BY provider_account_id, date
      )
      SELECT
        account.date::text AS date,
        account.provider_account_id,
        account.spend AS account_spend,
        COALESCE(campaign_totals.campaign_spend, 0) AS campaign_spend
      FROM meta_account_daily account
      LEFT JOIN campaign_totals
        ON campaign_totals.provider_account_id = account.provider_account_id
        AND campaign_totals.date = account.date
      WHERE account.business_id = ${input.businessId}
        AND account.provider_account_id = ANY(${slowProviders}::text[])
        AND account.date = ANY(${slowDates}::date[])
    `;
  const typedSlowRows = slowRows as Array<Record<string, unknown>>;

  for (const row of typedSlowRows) {
    const providerAccountId = String(row.provider_account_id);
    const date = String(row.date);
    const key = `${providerAccountId}:${date}`;
    const accountSpend = Number(row.account_spend ?? 0);
    const campaignSpend = Number(row.campaign_spend ?? 0);
    if (withinToleranceForDirtyDate(accountSpend, campaignSpend)) continue;
    const existing = dirtyRows.get(key);
    const reasons = new Set<MetaDirtyRecentReason>(existing?.reasons ?? []);
    reasons.add("spend_drift");
    if (looksLikeTinyStaleSpend(accountSpend, campaignSpend)) {
      reasons.add("tiny_stale_spend");
    }
    dirtyRows.set(key, {
      providerAccountId,
      date,
      ...deriveMetaDirtyRecentFlags({
        reasons: Array.from(reasons),
        severity: existing
          ? mergeDirtySeverity(existing.severity, "high")
          : "high",
      }),
    });
  }

  return Array.from(dirtyRows.values()).sort((left, right) =>
    `${right.date}:${left.providerAccountId}`.localeCompare(
      `${left.date}:${right.providerAccountId}`,
    ),
  );
}

export async function getMetaRecentAuthoritativeSliceGuard(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  source: MetaSyncPartitionSource;
  cooldownMinutes?: number;
  successCooldownMinutes?: number;
  failureLookbackHours?: number;
}): Promise<MetaRecentAuthoritativeSliceGuard> {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const cooldownMinutes = Math.max(1, Math.floor(input.cooldownMinutes ?? 15));
  const successCooldownMinutes = Math.max(
    cooldownMinutes,
    Math.floor(input.successCooldownMinutes ?? 30),
  );
  const failureLookbackHours = Math.max(
    1,
    Math.floor(input.failureLookbackHours ?? 24),
  );
  const rows = typeof sql.query === "function"
    ? await sql.query(
        `
      SELECT
        COALESCE(
          (
            SELECT source
            FROM meta_sync_partitions
            WHERE business_id = $1
              AND provider_account_id = $2
              AND partition_date = $3::date
              AND lane = 'maintenance'
              AND scope = ANY($8::text[])
              AND status IN ('queued', 'leased', 'running')
              AND source IN ('finalize_day', 'repair_recent_day', 'today_observe')
            ORDER BY
              CASE source
                WHEN 'finalize_day' THEN 725
                WHEN 'repair_recent_day' THEN 690
                WHEN 'today_observe' THEN 660
                ELSE 0
              END DESC,
              updated_at DESC
            LIMIT 1
          ),
          NULL
        ) AS active_source,
        MAX(COALESCE(started_at, updated_at, created_at)) FILTER (
          WHERE source = $4
            AND status IN ('queued', 'leased', 'running', 'failed', 'dead_letter')
            AND COALESCE(started_at, updated_at, created_at) > now() - ($5 || ' minutes')::interval
        ) AS last_same_source_attempt_at,
        MAX(COALESCE(finished_at, updated_at, created_at)) FILTER (
          WHERE source = $4
            AND status = 'succeeded'
            AND COALESCE(finished_at, updated_at, created_at) > now() - ($6 || ' minutes')::interval
        ) AS last_same_source_success_at,
        COUNT(*) FILTER (
          WHERE source IN ('finalize_day', 'repair_recent_day')
            AND status IN ('failed', 'dead_letter')
            AND COALESCE(finished_at, updated_at, created_at) > now() - ($7 || ' hours')::interval
        )::int AS repeated_failures_24h
      FROM meta_sync_partitions
      WHERE business_id = $1
        AND provider_account_id = $2
        AND partition_date = $3::date
        AND lane = 'maintenance'
        AND scope = ANY($8::text[])
    `,
        [
          input.businessId,
          input.providerAccountId,
          normalizeDate(input.date),
          input.source,
          cooldownMinutes,
          successCooldownMinutes,
          failureLookbackHours,
          Array.from(META_AUTHORITATIVE_CORE_SCOPES),
        ],
      )
    : await sql`
      SELECT
        COALESCE(
          (
            SELECT source
            FROM meta_sync_partitions
            WHERE business_id = ${input.businessId}
              AND provider_account_id = ${input.providerAccountId}
              AND partition_date = ${normalizeDate(input.date)}::date
              AND lane = 'maintenance'
              AND scope = ANY(${Array.from(META_AUTHORITATIVE_CORE_SCOPES)}::text[])
              AND status IN ('queued', 'leased', 'running')
              AND source IN ('finalize_day', 'repair_recent_day', 'today_observe')
            ORDER BY
              CASE source
                WHEN 'finalize_day' THEN 725
                WHEN 'repair_recent_day' THEN 690
                WHEN 'today_observe' THEN 660
                ELSE 0
              END DESC,
              updated_at DESC
            LIMIT 1
          ),
          NULL
        ) AS active_source,
        MAX(COALESCE(started_at, updated_at, created_at)) FILTER (
          WHERE source = ${input.source}
            AND status IN ('queued', 'leased', 'running', 'failed', 'dead_letter')
            AND COALESCE(started_at, updated_at, created_at) > now() - (${cooldownMinutes} || ' minutes')::interval
        ) AS last_same_source_attempt_at,
        MAX(COALESCE(finished_at, updated_at, created_at)) FILTER (
          WHERE source = ${input.source}
            AND status = 'succeeded'
            AND COALESCE(finished_at, updated_at, created_at) > now() - (${successCooldownMinutes} || ' minutes')::interval
        ) AS last_same_source_success_at,
        COUNT(*) FILTER (
          WHERE source IN ('finalize_day', 'repair_recent_day')
            AND status IN ('failed', 'dead_letter')
            AND COALESCE(finished_at, updated_at, created_at) > now() - (${failureLookbackHours} || ' hours')::interval
        )::int AS repeated_failures_24h
      FROM meta_sync_partitions
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND partition_date = ${normalizeDate(input.date)}::date
        AND lane = 'maintenance'
        AND scope = ANY(${Array.from(META_AUTHORITATIVE_CORE_SCOPES)}::text[])
    `;
  const row = (rows as Array<Record<string, unknown>>)[0] ?? {};
  const activeAuthoritativeSource = row.active_source
    ? (String(row.active_source) as MetaSyncPartitionSource)
    : null;
  return {
    activeAuthoritativeSource,
    activeAuthoritativePriority: metaSourcePriority(activeAuthoritativeSource),
    lastSameSourceAttemptAt: normalizeTimestamp(row.last_same_source_attempt_at),
    lastSameSourceSuccessAt: normalizeTimestamp(row.last_same_source_success_at),
    repeatedFailures24h: toNumber(row.repeated_failures_24h),
  };
}

export async function getMetaCampaignDailyRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  campaignIds?: string[] | null;
  includeProvisional?: boolean;
}): Promise<MetaCampaignDailyRow[]> {
  await assertMetaRequestReadTablesReady(
    ["meta_campaign_daily"],
    "meta_campaign_daily_range",
  );
  const sql = getDb();
  const supportsTruthLifecycle = await hasMetaTruthLifecycleColumns();
  const rows = supportsTruthLifecycle
    ? await sql`
    SELECT
      business_id,
      provider_account_id,
      date::text AS date,
      campaign_id,
      campaign_name_current,
      campaign_name_historical,
      campaign_status,
      objective,
      buying_type,
      optimization_goal,
      custom_event_type,
      bid_strategy_type,
      bid_value,
      bid_value_format,
      daily_budget,
      lifetime_budget,
      is_budget_mixed,
      is_config_mixed,
      is_optimization_goal_mixed,
      is_custom_event_type_mixed,
      is_bid_strategy_mixed,
      is_bid_value_mixed,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      source_snapshot_id,
      metric_schema_version,
      truth_state,
      truth_version,
      finalized_at,
      validation_status,
      source_run_id,
      created_at,
      updated_at
    FROM meta_campaign_daily
    WHERE business_id = ${input.businessId}
      AND date >= ${normalizeDate(input.startDate)}
      AND date <= ${normalizeDate(input.endDate)}
      AND (
        ${input.providerAccountIds ?? null}::text[] IS NULL
        OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
      )
      AND (
        ${input.campaignIds ?? null}::text[] IS NULL
        OR campaign_id = ANY(${input.campaignIds ?? null}::text[])
      )
      AND (
        ${input.includeProvisional ?? false}::boolean = TRUE
        OR truth_state IS NULL
        OR truth_state = 'finalized'
      )
    ORDER BY date ASC, provider_account_id ASC, campaign_id ASC
  `
    : typeof sql.query === "function"
      ? await sql.query(
      `
    SELECT
      business_id,
      provider_account_id,
      date::text AS date,
      campaign_id,
      campaign_name_current,
      campaign_name_historical,
      campaign_status,
      objective,
      buying_type,
      optimization_goal,
      custom_event_type,
      bid_strategy_type,
      bid_value,
      bid_value_format,
      daily_budget,
      lifetime_budget,
      is_budget_mixed,
      is_config_mixed,
      is_optimization_goal_mixed,
      is_custom_event_type_mixed,
      is_bid_strategy_mixed,
      is_bid_value_mixed,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      source_snapshot_id,
      metric_schema_version,
      created_at,
      updated_at
    FROM meta_campaign_daily
    WHERE business_id = $1
      AND date >= $2
      AND date <= $3
      AND ($4::text[] IS NULL OR provider_account_id = ANY($4::text[]))
      AND ($5::text[] IS NULL OR campaign_id = ANY($5::text[]))
    ORDER BY date ASC, provider_account_id ASC, campaign_id ASC
  `,
      [
        input.businessId,
        normalizeDate(input.startDate),
        normalizeDate(input.endDate),
        input.providerAccountIds ?? null,
        input.campaignIds ?? null,
      ]
    )
      : await sql`
    SELECT
      business_id,
      provider_account_id,
      date::text AS date,
      campaign_id,
      campaign_name_current,
      campaign_name_historical,
      campaign_status,
      objective,
      buying_type,
      optimization_goal,
      custom_event_type,
      bid_strategy_type,
      bid_value,
      bid_value_format,
      daily_budget,
      lifetime_budget,
      is_budget_mixed,
      is_config_mixed,
      is_optimization_goal_mixed,
      is_custom_event_type_mixed,
      is_bid_strategy_mixed,
      is_bid_value_mixed,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      source_snapshot_id,
      metric_schema_version,
      created_at,
      updated_at
    FROM meta_campaign_daily
    WHERE business_id = ${input.businessId}
      AND date >= ${normalizeDate(input.startDate)}
      AND date <= ${normalizeDate(input.endDate)}
      AND (
        ${input.providerAccountIds ?? null}::text[] IS NULL
        OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
      )
      AND (
        ${input.campaignIds ?? null}::text[] IS NULL
        OR campaign_id = ANY(${input.campaignIds ?? null}::text[])
      )
    ORDER BY date ASC, provider_account_id ASC, campaign_id ASC
  `;
  const typedRows = rows as Array<{
    business_id: string;
    provider_account_id: string;
    date: string;
    campaign_id: string;
    campaign_name_current: string | null;
    campaign_name_historical: string | null;
    campaign_status: string | null;
    objective: string | null;
    buying_type: string | null;
    optimization_goal: string | null;
    custom_event_type: string | null;
    bid_strategy_type: string | null;
    bid_value: number | null;
    bid_value_format: "currency" | "roas" | null;
    daily_budget: number | null;
    lifetime_budget: number | null;
    is_budget_mixed: boolean;
    is_config_mixed: boolean;
    is_optimization_goal_mixed: boolean;
    is_custom_event_type_mixed: boolean;
    is_bid_strategy_mixed: boolean;
    is_bid_value_mixed: boolean;
    account_timezone: string;
    account_currency: string;
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
    source_snapshot_id: string | null;
    metric_schema_version?: number | null;
    truth_state?: string | null;
    truth_version?: number | null;
    finalized_at?: string | null;
    validation_status?: string | null;
    source_run_id?: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return typedRows.map((row) => ({
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    date: normalizeDate(row.date),
    campaignId: row.campaign_id,
    campaignNameCurrent: row.campaign_name_current,
    campaignNameHistorical: row.campaign_name_historical,
    campaignStatus: row.campaign_status,
    objective: row.objective,
    buyingType: row.buying_type,
    optimizationGoal: row.optimization_goal,
    customEventType: row.custom_event_type,
    bidStrategyType: row.bid_strategy_type,
    bidStrategyLabel: formatBidStrategyLabel(row.bid_strategy_type),
    manualBidAmount: deriveManualBidAmount(row.bid_value, row.bid_value_format),
    bidValue: row.bid_value == null ? null : Number(row.bid_value),
    bidValueFormat: row.bid_value_format,
    dailyBudget: row.daily_budget == null ? null : Number(row.daily_budget),
    lifetimeBudget: row.lifetime_budget == null ? null : Number(row.lifetime_budget),
    isBudgetMixed: Boolean(row.is_budget_mixed),
    isConfigMixed: Boolean(row.is_config_mixed),
    isOptimizationGoalMixed: Boolean(row.is_optimization_goal_mixed),
    isCustomEventTypeMixed: Boolean(row.is_custom_event_type_mixed),
    isBidStrategyMixed: Boolean(row.is_bid_strategy_mixed),
    isBidValueMixed: Boolean(row.is_bid_value_mixed),
    accountTimezone: row.account_timezone,
    accountCurrency: row.account_currency,
    spend: Number(row.spend ?? 0),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    reach: Number(row.reach ?? 0),
    frequency: row.frequency == null ? null : Number(row.frequency),
    conversions: Number(row.conversions ?? 0),
    revenue: Number(row.revenue ?? 0),
    roas: Number(row.roas ?? 0),
    cpa: row.cpa == null ? null : Number(row.cpa),
    ctr: row.ctr == null ? null : Number(row.ctr),
    cpc: row.cpc == null ? null : Number(row.cpc),
    sourceSnapshotId: row.source_snapshot_id,
    metricSchemaVersion:
      row.metric_schema_version == null
        ? undefined
        : Number(row.metric_schema_version),
    truthState: row.truth_state == null ? undefined : (row.truth_state as MetaCampaignDailyRow["truthState"]),
    truthVersion: row.truth_version == null ? undefined : Number(row.truth_version),
    finalizedAt: row.finalized_at,
    validationStatus:
      row.validation_status == null
        ? undefined
        : (row.validation_status as MetaCampaignDailyRow["validationStatus"]),
    sourceRunId: row.source_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getMetaAdSetDailyRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  campaignIds?: string[] | null;
  includeProvisional?: boolean;
}): Promise<MetaAdSetDailyRow[]> {
  await assertMetaRequestReadTablesReady(
    ["meta_adset_daily"],
    "meta_adset_daily_range",
  );
  const sql = getDb();
  const supportsTruthLifecycle = await hasMetaTruthLifecycleColumns();
  const rows = supportsTruthLifecycle
    ? await sql`
    SELECT
      business_id,
      provider_account_id,
      date::text AS date,
      campaign_id,
      adset_id,
      adset_name_current,
      adset_name_historical,
      adset_status,
      optimization_goal,
      custom_event_type,
      pixel_id,
      custom_conversion_id,
      promoted_object_json,
      bid_strategy_type,
      bid_value,
      bid_value_format,
      daily_budget,
      lifetime_budget,
      is_budget_mixed,
      is_config_mixed,
      is_optimization_goal_mixed,
      is_bid_strategy_mixed,
      is_bid_value_mixed,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      source_snapshot_id,
      metric_schema_version,
      truth_state,
      truth_version,
      finalized_at,
      validation_status,
      source_run_id,
      created_at,
      updated_at
    FROM meta_adset_daily
    WHERE business_id = ${input.businessId}
      AND date >= ${normalizeDate(input.startDate)}
      AND date <= ${normalizeDate(input.endDate)}
      AND (
        ${input.providerAccountIds ?? null}::text[] IS NULL
        OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
      )
      AND (
        ${input.campaignIds ?? null}::text[] IS NULL
        OR campaign_id = ANY(${input.campaignIds ?? null}::text[])
      )
      AND (
        ${input.includeProvisional ?? false}::boolean = TRUE
        OR truth_state IS NULL
        OR truth_state = 'finalized'
      )
    ORDER BY date ASC, provider_account_id ASC, campaign_id ASC, adset_id ASC
  `
    : typeof sql.query === "function"
      ? await sql.query(
      `
    SELECT
      business_id,
      provider_account_id,
      date::text AS date,
      campaign_id,
      adset_id,
      adset_name_current,
      adset_name_historical,
      adset_status,
      optimization_goal,
      custom_event_type,
      pixel_id,
      custom_conversion_id,
      promoted_object_json,
      bid_strategy_type,
      bid_value,
      bid_value_format,
      daily_budget,
      lifetime_budget,
      is_budget_mixed,
      is_config_mixed,
      is_optimization_goal_mixed,
      is_bid_strategy_mixed,
      is_bid_value_mixed,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      source_snapshot_id,
      metric_schema_version,
      created_at,
      updated_at
    FROM meta_adset_daily
    WHERE business_id = $1
      AND date >= $2
      AND date <= $3
      AND ($4::text[] IS NULL OR provider_account_id = ANY($4::text[]))
      AND ($5::text[] IS NULL OR campaign_id = ANY($5::text[]))
    ORDER BY date ASC, provider_account_id ASC, campaign_id ASC, adset_id ASC
  `,
      [input.businessId, normalizeDate(input.startDate), normalizeDate(input.endDate), input.providerAccountIds ?? null, input.campaignIds ?? null]
    )
      : await sql`
    SELECT
      business_id,
      provider_account_id,
      date,
      campaign_id,
      adset_id,
      adset_name_current,
      adset_name_historical,
      adset_status,
      optimization_goal,
      custom_event_type,
      pixel_id,
      custom_conversion_id,
      promoted_object_json,
      bid_strategy_type,
      bid_value,
      bid_value_format,
      daily_budget,
      lifetime_budget,
      is_budget_mixed,
      is_config_mixed,
      is_optimization_goal_mixed,
      is_bid_strategy_mixed,
      is_bid_value_mixed,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      source_snapshot_id,
      metric_schema_version,
      created_at,
      updated_at
    FROM meta_adset_daily
    WHERE business_id = ${input.businessId}
      AND date >= ${normalizeDate(input.startDate)}
      AND date <= ${normalizeDate(input.endDate)}
      AND (
        ${input.providerAccountIds ?? null}::text[] IS NULL
        OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
      )
      AND (
        ${input.campaignIds ?? null}::text[] IS NULL
        OR campaign_id = ANY(${input.campaignIds ?? null}::text[])
      )
    ORDER BY date ASC, provider_account_id ASC, campaign_id ASC, adset_id ASC
  `;
  const typedRows = rows as Array<{
    business_id: string;
    provider_account_id: string;
    date: string;
    campaign_id: string | null;
    adset_id: string;
    adset_name_current: string | null;
    adset_name_historical: string | null;
    adset_status: string | null;
    optimization_goal: string | null;
    custom_event_type: string | null;
    pixel_id: string | null;
    custom_conversion_id: string | null;
    promoted_object_json: unknown;
    bid_strategy_type: string | null;
    bid_value: number | null;
    bid_value_format: "currency" | "roas" | null;
    daily_budget: number | null;
    lifetime_budget: number | null;
    is_budget_mixed: boolean;
    is_config_mixed: boolean;
    is_optimization_goal_mixed: boolean;
    is_bid_strategy_mixed: boolean;
    is_bid_value_mixed: boolean;
    account_timezone: string;
    account_currency: string;
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
    source_snapshot_id: string | null;
    metric_schema_version?: number | null;
    truth_state?: string | null;
    truth_version?: number | null;
    finalized_at?: string | null;
    validation_status?: string | null;
    source_run_id?: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return typedRows.map((row) => ({
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    date: normalizeDate(row.date),
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    adsetNameCurrent: row.adset_name_current,
    adsetNameHistorical: row.adset_name_historical,
    adsetStatus: row.adset_status,
    optimizationGoal: row.optimization_goal,
    customEventType: row.custom_event_type,
    pixelId: row.pixel_id,
    customConversionId: row.custom_conversion_id,
    promotedObjectJson: row.promoted_object_json,
    bidStrategyType: row.bid_strategy_type,
    bidStrategyLabel: formatBidStrategyLabel(row.bid_strategy_type),
    manualBidAmount: deriveManualBidAmount(row.bid_value, row.bid_value_format),
    bidValue: row.bid_value == null ? null : Number(row.bid_value),
    bidValueFormat: row.bid_value_format,
    dailyBudget: row.daily_budget == null ? null : Number(row.daily_budget),
    lifetimeBudget: row.lifetime_budget == null ? null : Number(row.lifetime_budget),
    isBudgetMixed: Boolean(row.is_budget_mixed),
    isConfigMixed: Boolean(row.is_config_mixed),
    isOptimizationGoalMixed: Boolean(row.is_optimization_goal_mixed),
    isBidStrategyMixed: Boolean(row.is_bid_strategy_mixed),
    isBidValueMixed: Boolean(row.is_bid_value_mixed),
    accountTimezone: row.account_timezone,
    accountCurrency: row.account_currency,
    spend: Number(row.spend ?? 0),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    reach: Number(row.reach ?? 0),
    frequency: row.frequency == null ? null : Number(row.frequency),
    conversions: Number(row.conversions ?? 0),
    revenue: Number(row.revenue ?? 0),
    roas: Number(row.roas ?? 0),
    cpa: row.cpa == null ? null : Number(row.cpa),
    ctr: row.ctr == null ? null : Number(row.ctr),
    cpc: row.cpc == null ? null : Number(row.cpc),
    sourceSnapshotId: row.source_snapshot_id,
    metricSchemaVersion:
      row.metric_schema_version == null
        ? undefined
        : Number(row.metric_schema_version),
    truthState: row.truth_state == null ? undefined : (row.truth_state as MetaAdSetDailyRow["truthState"]),
    truthVersion: row.truth_version == null ? undefined : Number(row.truth_version),
    finalizedAt: row.finalized_at,
    validationStatus:
      row.validation_status == null
        ? undefined
        : (row.validation_status as MetaAdSetDailyRow["validationStatus"]),
    sourceRunId: row.source_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getMetaBreakdownDailyRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  breakdownTypes?: MetaBreakdownType[] | null;
  includeProvisional?: boolean;
}): Promise<MetaBreakdownDailyRow[]> {
  await assertMetaRequestReadTablesReady(
    ["meta_breakdown_daily"],
    "meta_breakdown_daily_range",
  );
  const sql = getDb();
  const rows = await sql`
    SELECT
      business_id,
      provider_account_id,
      date,
      breakdown_type,
      breakdown_key,
      breakdown_label,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      source_snapshot_id,
      truth_state,
      truth_version,
      finalized_at,
      validation_status,
      source_run_id,
      created_at,
      updated_at
    FROM meta_breakdown_daily
    WHERE business_id = ${input.businessId}
      AND date BETWEEN ${normalizeDate(input.startDate)} AND ${normalizeDate(input.endDate)}
      AND (
        ${input.providerAccountIds ?? null}::text[] IS NULL
        OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
      )
      AND (
        ${input.breakdownTypes ?? null}::text[] IS NULL
        OR breakdown_type = ANY(${input.breakdownTypes ?? null}::text[])
      )
      AND (
        ${input.includeProvisional ?? false}::boolean = TRUE
        OR COALESCE(truth_state, 'finalized') IN ('finalized', 'finalized_verified')
      )
    ORDER BY date ASC, provider_account_id ASC, breakdown_type ASC, breakdown_key ASC
  ` as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    date: String(row.date),
    breakdownType: String(row.breakdown_type) as MetaBreakdownType,
    breakdownKey: String(row.breakdown_key),
    breakdownLabel: String(row.breakdown_label),
    accountTimezone: String(row.account_timezone),
    accountCurrency: String(row.account_currency),
    spend: Number(row.spend ?? 0),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    reach: Number(row.reach ?? 0),
    frequency: row.frequency == null ? null : Number(row.frequency),
    conversions: Number(row.conversions ?? 0),
    revenue: Number(row.revenue ?? 0),
    roas: Number(row.roas ?? 0),
    cpa: row.cpa == null ? null : Number(row.cpa),
    ctr: row.ctr == null ? null : Number(row.ctr),
    cpc: row.cpc == null ? null : Number(row.cpc),
    sourceSnapshotId: row.source_snapshot_id ? String(row.source_snapshot_id) : null,
    truthState: row.truth_state == null ? undefined : (String(row.truth_state) as MetaBreakdownDailyRow["truthState"]),
    truthVersion: row.truth_version == null ? undefined : Number(row.truth_version),
    finalizedAt: row.finalized_at ? String(row.finalized_at) : null,
    validationStatus: row.validation_status == null ? undefined : (String(row.validation_status) as MetaBreakdownDailyRow["validationStatus"]),
    sourceRunId: row.source_run_id ? String(row.source_run_id) : null,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  }));
}

export async function getMetaAdDailyRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
}): Promise<MetaAdDailyRow[]> {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT
      business_id,
      provider_account_id,
      date,
      campaign_id,
      adset_id,
      ad_id,
      ad_name_current,
      ad_name_historical,
      ad_status,
      destination_url,
      destination_url_raw,
      destination_url_source,
      destination_url_confidence,
      cta_type,
      object_story_id,
      effective_object_story_id,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      link_clicks,
      source_snapshot_id,
      truth_state,
      truth_version,
      finalized_at,
      validation_status,
      source_run_id,
      metric_schema_version,
      payload_json,
      created_at,
      updated_at
    FROM meta_ad_daily
    WHERE business_id = ${input.businessId}
      AND date >= ${normalizeDate(input.startDate)}
      AND date <= ${normalizeDate(input.endDate)}
      AND (
        ${input.providerAccountIds ?? null}::text[] IS NULL
        OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
      )
    ORDER BY date ASC, provider_account_id ASC, ad_id ASC
  ` as Array<{
    business_id: string;
    provider_account_id: string;
    date: string;
    campaign_id: string | null;
    adset_id: string | null;
    ad_id: string;
    ad_name_current: string | null;
    ad_name_historical: string | null;
    ad_status: string | null;
    destination_url: string | null;
    destination_url_raw: string | null;
    destination_url_source: string | null;
    destination_url_confidence: string | null;
    cta_type: string | null;
    object_story_id: string | null;
    effective_object_story_id: string | null;
    account_timezone: string;
    account_currency: string;
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
    link_clicks: number | null;
    source_snapshot_id: string | null;
    truth_state?: string | null;
    truth_version?: number | null;
    finalized_at?: string | null;
    validation_status?: string | null;
    source_run_id: string | null;
    metric_schema_version: number | null;
    payload_json: unknown;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    date: normalizeDate(row.date),
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    adId: row.ad_id,
    adNameCurrent: row.ad_name_current,
    adNameHistorical: row.ad_name_historical,
    adStatus: row.ad_status,
    destinationUrl: row.destination_url,
    destinationUrlRaw: row.destination_url_raw,
    destinationUrlSource: row.destination_url_source,
    destinationUrlConfidence: row.destination_url_confidence as MetaAdDailyRow["destinationUrlConfidence"],
    ctaType: row.cta_type,
    objectStoryId: row.object_story_id,
    effectiveObjectStoryId: row.effective_object_story_id,
    accountTimezone: row.account_timezone,
    accountCurrency: row.account_currency,
    spend: Number(row.spend ?? 0),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    reach: Number(row.reach ?? 0),
    frequency: row.frequency == null ? null : Number(row.frequency),
    conversions: Number(row.conversions ?? 0),
    revenue: Number(row.revenue ?? 0),
    roas: Number(row.roas ?? 0),
    cpa: row.cpa == null ? null : Number(row.cpa),
    ctr: row.ctr == null ? null : Number(row.ctr),
    cpc: row.cpc == null ? null : Number(row.cpc),
    linkClicks: row.link_clicks == null ? null : Number(row.link_clicks),
    outboundClicks: payloadMetricNumber(row.payload_json, "outbound_clicks"),
    landingPageViews: payloadMetricNumber(row.payload_json, "landing_page_views"),
    addToCart: payloadMetricNumber(row.payload_json, "add_to_cart"),
    initiateCheckout: payloadMetricNumber(row.payload_json, "initiate_checkout"),
    viewContent: payloadMetricNumber(row.payload_json, "view_content"),
    leads: payloadMetricNumber(row.payload_json, "leads"),
    postEngagement: payloadMetricNumber(row.payload_json, "post_engagement"),
    thruplayActions: payloadThruplayActions(row.payload_json),
    videoViews3s: payloadVideoViews3s(row.payload_json, Number(row.impressions ?? 0)),
    sourceSnapshotId: row.source_snapshot_id,
    truthState:
      row.truth_state == null
        ? undefined
        : (String(row.truth_state) as MetaAdDailyRow["truthState"]),
    truthVersion:
      row.truth_version == null ? undefined : Number(row.truth_version),
    finalizedAt: normalizeTimestamp(row.finalized_at),
    validationStatus:
      row.validation_status == null
        ? undefined
        : (String(row.validation_status) as MetaAdDailyRow["validationStatus"]),
    sourceRunId: row.source_run_id,
    metricSchemaVersion:
      row.metric_schema_version == null
        ? undefined
        : Number(row.metric_schema_version),
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getMetaCreativeDailyRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
}): Promise<MetaCreativeDailyRow[]> {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    SELECT
      business_id,
      provider_account_id,
      date,
      campaign_id,
      adset_id,
      ad_id,
      creative_id,
      creative_name,
      headline,
      primary_text,
      description_text,
      destination_url,
      destination_url_raw,
      destination_url_source,
      destination_url_confidence,
      cta_type,
      object_story_id,
      effective_object_story_id,
      thumbnail_url,
      asset_type,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      reach,
      frequency,
      conversions,
      revenue,
      roas,
      cpa,
      ctr,
      cpc,
      link_clicks,
      outbound_clicks,
      source_snapshot_id,
      source_run_id,
      metric_schema_version,
      launch_date,
      first_seen_at,
      first_spend_at,
      effective_status,
      objective,
      attribution_setting,
      quality_ranking,
      engagement_rate_ranking,
      conversion_rate_ranking,
      bid_strategy,
      optimization_goal,
      campaign_daily_budget,
      adset_daily_budget,
      campaign_lifetime_budget,
      adset_lifetime_budget,
      creative_delivery_type,
      creative_visual_format,
      creative_primary_type,
      creative_secondary_type,
      image_hash,
      payload_json,
      created_at,
      updated_at
    FROM meta_creative_daily
    WHERE business_id = ${input.businessId}
      AND date >= ${normalizeDate(input.startDate)}
      AND date <= ${normalizeDate(input.endDate)}
      AND (
        ${input.providerAccountIds ?? null}::text[] IS NULL
        OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
      )
    ORDER BY date ASC, provider_account_id ASC, creative_id ASC
  ` as Array<{
    business_id: string;
    provider_account_id: string;
    date: string;
    campaign_id: string | null;
    adset_id: string | null;
    ad_id: string | null;
    creative_id: string;
    creative_name: string | null;
    headline: string | null;
    primary_text: string | null;
    description_text: string | null;
    destination_url: string | null;
    destination_url_raw: string | null;
    destination_url_source: string | null;
    destination_url_confidence: string | null;
    cta_type: string | null;
    object_story_id: string | null;
    effective_object_story_id: string | null;
    thumbnail_url: string | null;
    asset_type: string | null;
    account_timezone: string;
    account_currency: string;
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
    link_clicks: number | null;
    outbound_clicks: number | null;
    source_snapshot_id: string | null;
    source_run_id: string | null;
    metric_schema_version: number | null;
    launch_date: string | null;
    first_seen_at: string | null;
    first_spend_at: string | null;
    effective_status: string | null;
    objective: string | null;
    attribution_setting: string | null;
    quality_ranking: string | null;
    engagement_rate_ranking: string | null;
    conversion_rate_ranking: string | null;
    bid_strategy: string | null;
    optimization_goal: string | null;
    campaign_daily_budget: number | null;
    adset_daily_budget: number | null;
    campaign_lifetime_budget: number | null;
    adset_lifetime_budget: number | null;
    creative_delivery_type: string | null;
    creative_visual_format: string | null;
    creative_primary_type: string | null;
    creative_secondary_type: string | null;
    image_hash: string | null;
    payload_json: unknown;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    date: normalizeDate(row.date),
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    adId: row.ad_id,
    creativeId: row.creative_id,
    creativeName: row.creative_name,
    headline: row.headline,
    primaryText: row.primary_text,
    descriptionText: row.description_text,
    destinationUrl: row.destination_url,
    destinationUrlRaw: row.destination_url_raw,
    destinationUrlSource: row.destination_url_source,
    destinationUrlConfidence: row.destination_url_confidence as MetaCreativeDailyRow["destinationUrlConfidence"],
    ctaType: row.cta_type,
    objectStoryId: row.object_story_id,
    effectiveObjectStoryId: row.effective_object_story_id,
    thumbnailUrl: row.thumbnail_url,
    assetType: row.asset_type,
    accountTimezone: row.account_timezone,
    accountCurrency: row.account_currency,
    spend: Number(row.spend ?? 0),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    reach: Number(row.reach ?? 0),
    frequency: row.frequency == null ? null : Number(row.frequency),
    conversions: Number(row.conversions ?? 0),
    revenue: Number(row.revenue ?? 0),
    roas: Number(row.roas ?? 0),
    cpa: row.cpa == null ? null : Number(row.cpa),
    ctr: row.ctr == null ? null : Number(row.ctr),
    cpc: row.cpc == null ? null : Number(row.cpc),
    linkClicks: row.link_clicks == null ? null : Number(row.link_clicks),
    outboundClicks: row.outbound_clicks == null ? null : Number(row.outbound_clicks),
    landingPageViews: payloadMetricNumber(row.payload_json, "landing_page_views"),
    addToCart: payloadMetricNumber(row.payload_json, "add_to_cart"),
    initiateCheckout: payloadMetricNumber(row.payload_json, "initiate_checkout"),
    sourceSnapshotId: row.source_snapshot_id,
    sourceRunId: row.source_run_id,
    metricSchemaVersion:
      row.metric_schema_version == null
        ? undefined
        : Number(row.metric_schema_version),
    launchDate: row.launch_date ? normalizeDate(row.launch_date) : null,
    firstSeenAt: normalizeTimestamp(row.first_seen_at),
    firstSpendAt: normalizeTimestamp(row.first_spend_at),
    effectiveStatus: row.effective_status,
    objective: row.objective,
    attributionSetting: row.attribution_setting,
    qualityRanking: row.quality_ranking,
    engagementRateRanking: row.engagement_rate_ranking,
    conversionRateRanking: row.conversion_rate_ranking,
    bidStrategy: row.bid_strategy,
    optimizationGoal: row.optimization_goal,
    campaignDailyBudget: toNullableNumber(row.campaign_daily_budget),
    adsetDailyBudget: toNullableNumber(row.adset_daily_budget),
    campaignLifetimeBudget: toNullableNumber(row.campaign_lifetime_budget),
    adsetLifetimeBudget: toNullableNumber(row.adset_lifetime_budget),
    creativeDeliveryType: row.creative_delivery_type,
    creativeVisualFormat: row.creative_visual_format,
    creativePrimaryType: row.creative_primary_type,
    creativeSecondaryType: row.creative_secondary_type,
    imageHash: row.image_hash,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getMetaCreativeMediaRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  creativeIds?: string[] | null;
  adIds?: string[] | null;
}): Promise<MetaCreativeMediaRow[]> {
  await assertMetaRequestReadTablesReady(
    ["meta_creative_media"],
    "meta_creative_media_range",
  );
  const sql = getDb();
  const rows = await sql`
    SELECT
      business_id,
      provider_account_id,
      date,
      campaign_id,
      adset_id,
      ad_id,
      creative_id,
      preview_url,
      thumbnail_url,
      image_url,
      table_thumbnail_url,
      card_preview_url,
      video_url,
      poster_url,
      preview_html,
      media_cache_key,
      image_hash,
      payload_json,
      source_run_id,
      created_at,
      updated_at
    FROM meta_creative_media
    WHERE business_id = ${input.businessId}
      AND date >= ${normalizeDate(input.startDate)}
      AND date <= ${normalizeDate(input.endDate)}
      AND (
        ${input.providerAccountIds ?? null}::text[] IS NULL
        OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
      )
      AND (
        ${input.creativeIds ?? null}::text[] IS NULL
        OR creative_id = ANY(${input.creativeIds ?? null}::text[])
      )
      AND (
        ${input.adIds ?? null}::text[] IS NULL
        OR ad_id = ANY(${input.adIds ?? null}::text[])
      )
    ORDER BY date ASC, provider_account_id ASC, creative_id ASC, ad_id ASC
  ` as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    date: normalizeDate(row.date),
    campaignId: row.campaign_id == null ? null : String(row.campaign_id),
    adsetId: row.adset_id == null ? null : String(row.adset_id),
    adId: row.ad_id == null ? null : String(row.ad_id),
    creativeId: String(row.creative_id),
    previewUrl: row.preview_url == null ? null : String(row.preview_url),
    thumbnailUrl: row.thumbnail_url == null ? null : String(row.thumbnail_url),
    imageUrl: row.image_url == null ? null : String(row.image_url),
    tableThumbnailUrl: row.table_thumbnail_url == null ? null : String(row.table_thumbnail_url),
    cardPreviewUrl: row.card_preview_url == null ? null : String(row.card_preview_url),
    videoUrl: row.video_url == null ? null : String(row.video_url),
    posterUrl: row.poster_url == null ? null : String(row.poster_url),
    previewHtml: row.preview_html == null ? null : String(row.preview_html),
    mediaCacheKey: row.media_cache_key == null ? null : String(row.media_cache_key),
    imageHash: row.image_hash == null ? null : String(row.image_hash),
    payloadJson: row.payload_json,
    sourceRunId: row.source_run_id == null ? null : String(row.source_run_id),
    createdAt: row.created_at == null ? undefined : String(row.created_at),
    updatedAt: row.updated_at == null ? undefined : String(row.updated_at),
  }));
}

type MetaIntegrityAggregate = {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
};

function aggregateMetaIntegrityRows<T extends MetaWarehouseMetricSet>(rows: T[]) {
  return rows.reduce<MetaIntegrityAggregate>(
    (acc, row) => {
      acc.spend += Number(row.spend ?? 0);
      acc.impressions += Number(row.impressions ?? 0);
      acc.clicks += Number(row.clicks ?? 0);
      acc.conversions += Number(row.conversions ?? 0);
      acc.revenue += Number(row.revenue ?? 0);
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 },
  );
}

function buildMetaIntegrityDelta(input: {
  account?: number | null;
  campaign?: number | null;
  adset?: number | null;
  ad?: number | null;
  creative?: number | null;
}) {
  return {
    account: input.account ?? null,
    campaign: input.campaign ?? null,
    adset: input.adset ?? null,
    ad: input.ad ?? null,
    creative: input.creative ?? null,
  };
}

function deriveMetaIntegrityProvenanceState(input: {
  sourceRunIds: Array<string | null | undefined>;
  metricSchemaVersions: Array<number | null | undefined>;
}) {
  const normalizedRunIds = input.sourceRunIds.filter((value) => value != null && String(value).trim().length > 0);
  const missingRunIds =
    input.sourceRunIds.length > 0 && normalizedRunIds.length < input.sourceRunIds.length;
  const normalizedSchemaVersions = input.metricSchemaVersions
    .map((value) => (value == null ? null : Number(value)))
    .filter((value): value is number => value != null && Number.isFinite(value));
  const hasLegacySchema = normalizedSchemaVersions.some(
    (value) => value < META_CANONICAL_METRIC_SCHEMA_VERSION,
  );
  if (hasLegacySchema) return "legacy_schema" as const;
  if (missingRunIds && normalizedRunIds.length > 0) return "mixed" as const;
  if (missingRunIds) return "missing_source_run" as const;
  if (normalizedRunIds.length === 0) return "unverified" as const;
  return "authoritative" as const;
}

const META_INTEGRITY_METRICS = [
  "spend",
  "impressions",
  "clicks",
  "conversions",
  "revenue",
] as const;

export async function getMetaWarehouseIntegrityIncidents(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  persistReconciliationEvents?: boolean;
}) {
  const [accountRows, campaignRows, adsetRows, adRows, creativeRows, canonicalDriftRows] =
    await Promise.all([
      getMetaAccountDailyRange({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        providerAccountIds: input.providerAccountIds,
        includeProvisional: true,
      }),
      getMetaCampaignDailyRange({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        providerAccountIds: input.providerAccountIds,
        includeProvisional: true,
      }),
      getMetaAdSetDailyRange({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        providerAccountIds: input.providerAccountIds,
        includeProvisional: true,
      }),
      getMetaAdDailyRange({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        providerAccountIds: input.providerAccountIds,
      }),
      getMetaCreativeDailyRange({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        providerAccountIds: input.providerAccountIds,
      }),
      getMetaCanonicalDriftIncidents({
        businessId: input.businessId,
        sinceHours: Math.max(
          24,
          Math.ceil(
            (new Date(`${normalizeDate(input.endDate)}T23:59:59.999Z`).getTime() -
              new Date(`${normalizeDate(input.startDate)}T00:00:00.000Z`).getTime()) /
              3_600_000,
          ) + 24,
        ),
      }).catch(() => []),
    ]);

  const grouped = new Map<
    string,
    {
      providerAccountId: string;
      date: string;
      account: MetaAccountDailyRow[];
      campaign: MetaCampaignDailyRow[];
      adset: MetaAdSetDailyRow[];
      ad: MetaAdDailyRow[];
      creative: MetaCreativeDailyRow[];
    }
  >();

  const ensureGroup = (providerAccountId: string, date: string) => {
    const key = `${providerAccountId}:${date}`;
    const existing = grouped.get(key);
    if (existing) return existing;
    const next = {
      providerAccountId,
      date,
      account: [],
      campaign: [],
      adset: [],
      ad: [],
      creative: [],
    };
    grouped.set(key, next);
    return next;
  };

  for (const row of accountRows) ensureGroup(row.providerAccountId, row.date).account.push(row);
  for (const row of campaignRows) ensureGroup(row.providerAccountId, row.date).campaign.push(row);
  for (const row of adsetRows) ensureGroup(row.providerAccountId, row.date).adset.push(row);
  for (const row of adRows) ensureGroup(row.providerAccountId, row.date).ad.push(row);
  for (const row of creativeRows) ensureGroup(row.providerAccountId, row.date).creative.push(row);

  const incidents: MetaWarehouseIntegrityIncident[] = [];
  const canonicalDriftKeys = new Map(
    canonicalDriftRows.map((row) => [
      `${row.providerAccountId}:${row.date}`,
      row,
    ]),
  );

  for (const group of grouped.values()) {
    const accountTotals = aggregateMetaIntegrityRows(group.account);
    const campaignTotals = aggregateMetaIntegrityRows(group.campaign);
    const adsetTotals = aggregateMetaIntegrityRows(group.adset);
    const adTotals = aggregateMetaIntegrityRows(group.ad);
    const creativeTotals = aggregateMetaIntegrityRows(group.creative);

    const provenanceState = deriveMetaIntegrityProvenanceState({
      sourceRunIds: [
        ...group.account.map((row) => row.sourceRunId),
        ...group.campaign.map((row) => row.sourceRunId),
        ...group.adset.map((row) => row.sourceRunId),
        ...group.ad.map((row) => row.sourceRunId),
        ...group.creative.map((row) => row.sourceRunId),
      ],
      metricSchemaVersions: [
        ...group.account.map((row) => row.metricSchemaVersion),
        ...group.campaign.map((row) => row.metricSchemaVersion),
        ...group.adset.map((row) => row.metricSchemaVersion),
        ...group.ad.map((row) => row.metricSchemaVersion),
        ...group.creative.map((row) => row.metricSchemaVersion),
      ],
    });

    const metricDelta: Record<string, ReturnType<typeof buildMetaIntegrityDelta>> = {};
    const metricsCompared = new Set<string>();
    const secondaryMetricsCompared = new Set<string>();
    let suspectedCause = "";
    let severity: MetaWarehouseIntegrityIncident["severity"] = "info";
    let repairRecommended = false;
    let blockingSurface: "core" | "secondary" | "source" | null = null;

    const hasAccountRows = group.account.length > 0;
    const hasCampaignRows = group.campaign.length > 0;
    const hasAdsetRows = group.adset.length > 0;
    const hasAdRows = group.ad.length > 0;

    if (hasAccountRows && !hasCampaignRows) {
      severity = "error";
      suspectedCause = "missing_campaign_rollup";
      repairRecommended = true;
      blockingSurface = "core";
    } else if (!hasAccountRows && hasCampaignRows) {
      severity = "error";
      suspectedCause = "missing_account_rollup";
      repairRecommended = true;
      blockingSurface = "core";
    }

    for (const metric of META_INTEGRITY_METRICS) {
      const accountValue = accountTotals[metric];
      const campaignValue = campaignTotals[metric];
      const adsetValue = adsetTotals[metric];
      const adValue = adTotals[metric];
      const creativeValue = creativeTotals[metric];
      const hasCoreRows =
        group.account.length > 0 ||
        group.campaign.length > 0 ||
        group.adset.length > 0 ||
        group.ad.length > 0;
      if (!hasCoreRows) continue;
      const equalCampaign =
        !hasCampaignRows || withinToleranceForDirtyDate(accountValue, campaignValue);
      const equalAdset =
        !hasAdsetRows || withinToleranceForDirtyDate(accountValue, adsetValue);
      const equalAd = !hasAdRows || withinToleranceForDirtyDate(accountValue, adValue);
      if (!equalCampaign) {
        metricDelta[metric] = buildMetaIntegrityDelta({
          account: accountValue,
          campaign: hasCampaignRows ? campaignValue : null,
          adset: hasAdsetRows ? adsetValue : null,
          ad: hasAdRows ? adValue : null,
          creative: group.creative.length === 0 ? null : creativeValue,
        });
        metricsCompared.add(metric);
        severity = "error";
        suspectedCause ||= "cross_surface_drift";
        repairRecommended = true;
        blockingSurface = "core";
      }
      if ((hasAdsetRows && !equalAdset) || (hasAdRows && !equalAd)) {
        metricDelta[metric] = buildMetaIntegrityDelta({
          account: accountValue,
          campaign: hasCampaignRows ? campaignValue : null,
          adset: hasAdsetRows ? adsetValue : null,
          ad: hasAdRows ? adValue : null,
          creative: group.creative.length === 0 ? null : creativeValue,
        });
        secondaryMetricsCompared.add(metric);
        if (severity !== "error") severity = "warning";
        suspectedCause ||= "secondary_surface_drift";
        blockingSurface ||= "secondary";
      }
    }

    if (hasCampaignRows && !hasAdsetRows) {
      if (severity !== "error") severity = "warning";
      suspectedCause ||= "secondary_surface_gap";
      blockingSurface ||= "secondary";
    }
    if (hasCampaignRows && !hasAdRows) {
      if (severity !== "error") severity = "warning";
      suspectedCause ||= "secondary_surface_gap";
      blockingSurface ||= "secondary";
    }

    const creativeLinkClicks = group.creative.reduce(
      (sum, row) => sum + Number(row.linkClicks ?? 0),
      0,
    );
    if (
      group.creative.length > 0 &&
      creativeLinkClicks > 0 &&
      withinToleranceForDirtyDate(creativeTotals.clicks, creativeLinkClicks) &&
      creativeRows.some(
        (row) =>
          row.providerAccountId === group.providerAccountId &&
          row.date === group.date &&
          Number(row.metricSchemaVersion ?? 1) < META_CANONICAL_METRIC_SCHEMA_VERSION,
      )
    ) {
      metricDelta.clicks = buildMetaIntegrityDelta({
        account: accountTotals.clicks,
        campaign: group.campaign.length === 0 ? null : campaignTotals.clicks,
        adset: group.adset.length === 0 ? null : adsetTotals.clicks,
        ad: group.ad.length === 0 ? null : adTotals.clicks,
        creative: creativeTotals.clicks,
      });
      metricsCompared.add("clicks");
      severity = severity === "error" ? "error" : "warning";
      suspectedCause ||= "legacy_click_semantics";
      blockingSurface ||= "secondary";
    }

    if (provenanceState === "missing_source_run" || provenanceState === "mixed") {
      severity = "error";
      suspectedCause ||= "missing_provenance";
      repairRecommended = true;
      blockingSurface = "core";
    } else if (provenanceState === "legacy_schema") {
      severity = severity === "error" ? "error" : "warning";
      suspectedCause ||= "legacy_metric_schema";
      if (severity === "error") repairRecommended = true;
    }

    const canonicalDrift = canonicalDriftKeys.get(
      `${group.providerAccountId}:${group.date}`,
    );
    if (!suspectedCause && canonicalDrift) {
      severity = "warning";
      suspectedCause = "canonical_source_drift";
      blockingSurface = "source";
    }

    if (!suspectedCause) continue;

    const incident: MetaWarehouseIntegrityIncident = {
      businessId: input.businessId,
      providerAccountId: group.providerAccountId,
      date: group.date,
      scope: "system",
      severity,
      metricsCompared: Array.from(
        new Set([...metricsCompared, ...secondaryMetricsCompared]),
      ),
      delta: metricDelta,
      provenanceState,
      repairRecommended,
      repairStatus: "pending",
      suspectedCause,
      details: {
        blockingSurface,
        coreMetricsCompared: Array.from(metricsCompared),
        secondaryMetricsCompared: Array.from(secondaryMetricsCompared),
        rowCounts: {
          account: group.account.length,
          campaign: group.campaign.length,
          adset: group.adset.length,
          ad: group.ad.length,
          creative: group.creative.length,
        },
        canonicalDrift: canonicalDrift
          ? {
              sourceSpend: canonicalDrift.sourceSpend,
              warehouseAccountSpend: canonicalDrift.warehouseAccountSpend,
              warehouseCampaignSpend: canonicalDrift.warehouseCampaignSpend,
              occurrenceCount: canonicalDrift.occurrenceCount,
              latestCreatedAt: canonicalDrift.latestCreatedAt,
            }
          : null,
      },
    };
    incidents.push(incident);

    if (input.persistReconciliationEvents !== false) {
      await createMetaAuthoritativeReconciliationEvent({
        businessId: input.businessId,
        providerAccountId: group.providerAccountId,
        day: group.date,
        surface: "account_daily",
        eventKind: `integrity:${suspectedCause}`,
        severity,
        sourceSpend: accountTotals.spend,
        warehouseAccountSpend: accountTotals.spend,
        warehouseCampaignSpend: campaignTotals.spend,
        toleranceApplied: Math.max(0.01, Math.abs(accountTotals.spend) * 0.001),
        result:
          severity === "error"
            ? "repair_required"
            : suspectedCause === "canonical_source_drift"
              ? "passed"
              : "failed",
        detailsJson: {
          provenanceState,
          metricsCompared: Array.from(
            new Set([...metricsCompared, ...secondaryMetricsCompared]),
          ),
          delta: metricDelta,
          suspectedCause,
          blockingSurface,
          repairRecommended,
          canonicalDrift:
            canonicalDrift != null
              ? {
                  sourceSpend: canonicalDrift.sourceSpend,
                  warehouseAccountSpend: canonicalDrift.warehouseAccountSpend,
                  warehouseCampaignSpend: canonicalDrift.warehouseCampaignSpend,
                  occurrenceCount: canonicalDrift.occurrenceCount,
                  latestCreatedAt: canonicalDrift.latestCreatedAt,
                }
              : null,
        },
      }).catch(() => undefined);
    }
  }

  incidents.sort((left, right) =>
    `${left.date}:${left.providerAccountId}`.localeCompare(
      `${right.date}:${right.providerAccountId}`,
    ),
  );

  return incidents;
}

export async function getMetaCanonicalDriftIncidents(input: {
  businessId: string;
  sinceHours?: number;
}) {
  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const sinceHours = Math.max(1, input.sinceHours ?? 24);
  const rows = await sql`
    SELECT
      provider_account_id,
      day,
      source_spend,
      warehouse_account_spend,
      warehouse_campaign_spend,
      COUNT(*)::int AS occurrence_count,
      MAX(created_at) AS latest_created_at
    FROM meta_authoritative_reconciliation_events
    WHERE business_id = ${input.businessId}
      AND event_kind = 'totals_mismatch'
      AND created_at >= now() - (${sinceHours}::text || ' hours')::interval
    GROUP BY
      provider_account_id,
      day,
      source_spend,
      warehouse_account_spend,
      warehouse_campaign_spend
    ORDER BY MAX(created_at) DESC, provider_account_id ASC, day ASC
  ` as Array<{
    provider_account_id: string;
    day: string | Date;
    source_spend: number | null;
    warehouse_account_spend: number | null;
    warehouse_campaign_spend: number | null;
    occurrence_count: number | string;
    latest_created_at: string | Date | null;
  }>;

  return rows.map((row) => ({
    providerAccountId: String(row.provider_account_id),
    date: normalizeDate(row.day),
    sourceSpend: toNumber(row.source_spend),
    warehouseAccountSpend: toNumber(row.warehouse_account_spend),
    warehouseCampaignSpend: toNumber(row.warehouse_campaign_spend),
    occurrenceCount: toNumber(row.occurrence_count),
    latestCreatedAt: normalizeTimestamp(row.latest_created_at),
    signature: [
      String(row.provider_account_id),
      normalizeDate(row.day),
      toNumber(row.source_spend).toFixed(2),
      toNumber(row.warehouse_account_spend).toFixed(2),
      toNumber(row.warehouse_campaign_spend).toFixed(2),
    ].join(":"),
  }));
}

export async function getMetaRawSnapshotsForWindow(input: {
  businessId: string;
  endpointNames: string[];
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
}) {
  const endpointNames = Array.from(new Set(input.endpointNames.filter(Boolean)));
  if (endpointNames.length === 0) return [];

  await assertMetaMutationTablesReady("meta_warehouse");
  const sql = getDb();
  const rows = await sql`
    WITH ranked AS (
      SELECT
        id,
        business_id,
        provider_account_id,
        endpoint_name,
        entity_scope,
        start_date,
        end_date,
        account_timezone,
        account_currency,
        payload_json,
        payload_hash,
        request_context,
        provider_http_status,
        status,
        fetched_at,
        created_at,
        updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY provider_account_id, endpoint_name, start_date, end_date
          ORDER BY fetched_at DESC, created_at DESC
        ) AS row_num
      FROM meta_raw_snapshots
      WHERE business_id = ${input.businessId}
        AND endpoint_name = ANY(${endpointNames}::text[])
        AND start_date >= ${normalizeDate(input.startDate)}
        AND end_date <= ${normalizeDate(input.endDate)}
        AND (
          ${input.providerAccountIds ?? null}::text[] IS NULL
          OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[])
        )
    )
    SELECT
      id,
      business_id,
      provider_account_id,
      endpoint_name,
      entity_scope,
      start_date,
      end_date,
      account_timezone,
      account_currency,
      payload_json,
      payload_hash,
      request_context,
      provider_http_status,
      status,
      fetched_at,
      created_at,
      updated_at
    FROM ranked
    WHERE row_num = 1
    ORDER BY start_date ASC, provider_account_id ASC, endpoint_name ASC
  ` as Array<{
    id: string;
    business_id: string;
    provider_account_id: string;
    endpoint_name: string;
    entity_scope: string;
    start_date: string;
    end_date: string;
    account_timezone: string | null;
    account_currency: string | null;
    payload_json: unknown;
    payload_hash: string;
    request_context: Record<string, unknown> | null;
    provider_http_status: number | null;
    status: MetaRawSnapshotRecord["status"];
    fetched_at: string;
    created_at: string;
    updated_at: string;
  }>;
  return rows;
}
