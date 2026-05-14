/**
 * lib/api/meta.ts
 *
 * Server-only service layer for the Meta Ads platform.
 * All functions are async and call the Meta Graph API directly.
 * Intended for use in Server Components and API route handlers.
 *
 * Import pattern: import { getCampaigns, ... } from "@/lib/api/meta";
 *
 * Boundary rule:
 * - Non-today campaign/adset UI surfaces must be warehouse-backed.
 * - meta_config_snapshots reads are allowed only for today/live helpers here.
 * - Historical snapshot analysis for AI/recommendations lives outside this module.
 */

import { getDb } from "@/lib/db";
import {
  appendMetaConfigSnapshots,
  readLatestMetaConfigSnapshots,
  readPreviousDifferentMetaConfigDiffs,
} from "@/lib/meta/config-snapshots";
import {
  buildConfigSnapshotPayload,
  summarizeCampaignConfig,
  type MetaConfigSnapshotPayload,
} from "@/lib/meta/configuration";
import {
  createMetaAuthoritativeReconciliationEvent,
  createMetaAuthoritativeSliceVersion,
  createMetaAuthoritativeSourceManifest,
  buildMetaSyncCheckpointHash,
  getMetaSyncCheckpoint,
  heartbeatMetaPartitionLease,
  listMetaRawSnapshotsForRun,
  publishMetaAuthoritativeSliceVersion,
  buildMetaRawSnapshotHash,
  createMetaSyncJob,
  persistMetaRawSnapshot,
  deleteMetaSyncCheckpointsForPartition,
  replaceMetaAccountDailySlice,
  replaceMetaAdDailySlice,
  replaceMetaAdSetDailySlice,
  replaceMetaBreakdownDailySlice,
  replaceMetaCampaignDailySlice,
  refreshMetaAccountDailyOverviewSummary,
  updateMetaAuthoritativeSliceVersion,
  updateMetaAuthoritativeSourceManifest,
  upsertMetaSyncCheckpoint,
  updateMetaSyncJob,
  supersedeMetaRawSnapshotsForPartition,
  upsertMetaAccountDailyRows,
  upsertMetaAdDailyRows,
  upsertMetaAdSetDailyRows,
  upsertMetaCampaignDailyRows,
  upsertMetaBreakdownDailyRows,
  upsertMetaSyncPhaseTiming,
} from "@/lib/meta/warehouse";
import type {
  MetaAccountDailyRow,
  MetaAdDailyRow,
  MetaAdSetDailyRow,
  MetaCampaignDailyRow,
  MetaRawSnapshotStatus,
  MetaSyncCheckpointRecord,
  MetaSyncLane,
  MetaSyncPhaseTimingPhase,
  MetaSyncPhaseTimingRecord,
  MetaSyncType,
  MetaWarehouseTruthState,
  MetaWarehouseValidationStatus,
  MetaWarehouseScope,
} from "@/lib/meta/warehouse-types";
import { createMetaFinalizationCompletenessProof } from "@/lib/meta/finalization-proof";
import { isMetaAuthoritativeFinalizationV2EnabledForBusiness } from "@/lib/meta/authoritative-finalization-config";
import { getMetaAccountContext } from "@/lib/meta/account-context";
import { logRuntimeInfo, logRuntimeWarn } from "@/lib/runtime-logging";

// ── Core metric interface ─────────────────────────────────────────────────────

/**
 * The canonical metric shape for every Meta entity (campaign, ad set, breakdown).
 * Currency fields (spend, revenue, cpa, cpm) use .toFixed(2) precision at the
 * display layer. The raw numbers here are already rounded to 2 decimal places.
 */
export interface MetaMetricsData {
  spend: number;       // USD, rounded to 2 dp
  purchases: number;   // integer count
  revenue: number;     // USD, rounded to 2 dp
  roas: number;        // ratio, rounded to 2 dp
  cpa: number;         // USD per purchase, rounded to 2 dp
  ctr: number;         // percent (e.g. 1.23 = 1.23%), rounded to 2 dp
  cpm: number;         // USD per 1000 impressions, rounded to 2 dp
  impressions: number; // integer count
  clicks: number;      // integer count
}

function sumRowSpend(rows: Array<{ spend: number }>) {
  return r2(rows.reduce((sum, row) => sum + Number(row.spend ?? 0), 0));
}

type MetaAccountCoreSubStageName =
  | "syncMetaAccountCoreWarehouseDay.restore_raw_pages"
  | "syncMetaAccountCoreWarehouseDay.fetch_source_pages"
  | "syncMetaAccountCoreWarehouseDay.fetch_remote_configs"
  | "syncMetaAccountCoreWarehouseDay.fetch_source_account_spend"
  | "syncMetaAccountCoreWarehouseDay.read_latest_config_snapshots"
  | "syncMetaAccountCoreWarehouseDay.build_daily_rows"
  | "syncMetaAccountCoreWarehouseDay.create_authoritative_manifest"
  | "syncMetaAccountCoreWarehouseDay.create_slice_versions"
  | "syncMetaAccountCoreWarehouseDay.write_account_daily"
  | "syncMetaAccountCoreWarehouseDay.write_campaign_daily"
  | "syncMetaAccountCoreWarehouseDay.write_adset_daily"
  | "syncMetaAccountCoreWarehouseDay.write_ad_daily"
  | "syncMetaAccountCoreWarehouseDay.persist_campaign_config_snapshots"
  | "syncMetaAccountCoreWarehouseDay.append_adset_config_snapshots"
  | "syncMetaAccountCoreWarehouseDay.refresh_overview_summary"
  | "syncMetaAccountCoreWarehouseDay.finalize_phase_timings";

type MetaAccountCoreSubStageTaggedError = Error & {
  metaAccountCoreSubStage?: MetaAccountCoreSubStageName;
};

function tagMetaAccountCoreSubStageError(
  error: unknown,
  stage: MetaAccountCoreSubStageName,
) {
  if (
    error instanceof Error &&
    !(error as MetaAccountCoreSubStageTaggedError).metaAccountCoreSubStage
  ) {
    (error as MetaAccountCoreSubStageTaggedError).metaAccountCoreSubStage = stage;
  }
  return error;
}

function buildMetaAccountCoreSubStagePayload(input: {
  businessId: string;
  providerAccountId: string | null;
  partitionId: string;
  scope: string;
  lane: MetaSyncLane;
  source: string;
  day: string;
  durationMs: number;
  stage: MetaAccountCoreSubStageName;
  ok: boolean;
  errorMessage?: string | null;
}) {
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    partitionId: input.partitionId,
    scope: input.scope,
    lane: input.lane,
    source: input.source,
    day: input.day,
    durationMs: input.durationMs,
    stage: input.stage,
    ok: input.ok,
    errorMessage: input.errorMessage ?? null,
  };
}

async function captureMetaAccountCoreSubStage<T>(input: {
  businessId: string;
  providerAccountId: string;
  partitionId: string;
  scope: string;
  lane: MetaSyncLane;
  source: string;
  day: string;
  stage: MetaAccountCoreSubStageName;
  run: () => Promise<T>;
}) {
  const startedAt = Date.now();
  try {
    const result = await input.run();
    logRuntimeInfo("meta-sync", "partition_stage", buildMetaAccountCoreSubStagePayload({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      partitionId: input.partitionId,
      scope: input.scope,
      lane: input.lane,
      source: input.source,
      day: input.day,
      durationMs: Date.now() - startedAt,
      stage: input.stage,
      ok: true,
    }));
    return result;
  } catch (error) {
    const taggedError = tagMetaAccountCoreSubStageError(error, input.stage);
    const errorMessage =
      taggedError instanceof Error ? taggedError.message : String(taggedError);
    logRuntimeWarn("meta-sync", "partition_stage_failed", buildMetaAccountCoreSubStagePayload({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      partitionId: input.partitionId,
      scope: input.scope,
      lane: input.lane,
      source: input.source,
      day: input.day,
      durationMs: Date.now() - startedAt,
      stage: input.stage,
      ok: false,
      errorMessage,
    }));
    throw taggedError;
  }
}

export interface MetaCampaignData extends MetaMetricsData {
  id: string;
  accountId?: string;
  name: string;
  status: string; // "ACTIVE" | "PAUSED" | "ARCHIVED" | "UNKNOWN"
  objective?: string | null;
  buyingType?: string | null;
  budgetLevel?: "campaign" | "adset" | null;
  optimizationGoal: string | null;
  customEventType?: string | null;
  isCustomEventTypeMixed?: boolean;
  bidStrategyType: string | null;
  bidStrategyLabel: string | null;
  manualBidAmount: number | null;
  previousManualBidAmount?: number | null;
  bidValue: number | null;
  bidValueFormat: "currency" | "roas" | null;
  previousBidValue?: number | null;
  previousBidValueFormat?: "currency" | "roas" | null;
  previousBidValueCapturedAt?: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  previousDailyBudget?: number | null;
  previousLifetimeBudget?: number | null;
  previousBudgetCapturedAt?: string | null;
  isBudgetMixed: boolean;
  isConfigMixed: boolean;
  isOptimizationGoalMixed?: boolean;
  isBidStrategyMixed?: boolean;
  isBidValueMixed?: boolean;
}

export interface MetaAdSetData extends MetaMetricsData {
  id: string;
  accountId?: string;
  name: string;
  campaignId: string;
  status: string;
  budgetLevel?: "campaign" | "adset" | null;
  dailyBudget: number | null;    // USD, null when lifetime budget is used
  lifetimeBudget: number | null; // USD, null when daily budget is used
  optimizationGoal: string | null;
  customEventType?: string | null;
  pixelId?: string | null;
  customConversionId?: string | null;
  promotedObject?: unknown;
  bidStrategyType: string | null;
  bidStrategyLabel: string | null;
  manualBidAmount: number | null;
  previousManualBidAmount?: number | null;
  bidValue: number | null;
  bidValueFormat: "currency" | "roas" | null;
  previousBidValue?: number | null;
  previousBidValueFormat?: "currency" | "roas" | null;
  previousBidValueCapturedAt?: string | null;
  isBudgetMixed: boolean;
  previousDailyBudget?: number | null;
  previousLifetimeBudget?: number | null;
  previousBudgetCapturedAt?: string | null;
  isConfigMixed: boolean;
  isOptimizationGoalMixed?: boolean;
  isCustomEventTypeMixed?: boolean;
  isBidStrategyMixed?: boolean;
  isBidValueMixed?: boolean;
  /** CTR (Link click-through rate) — inline_link_click_ctr from Meta API. Null for warehouse data. */
  inlineLinkClickCtr?: number | null;
  linkClicks?: number | null;
  addToCart?: number | null;
  initiateCheckout?: number | null;
  viewContent?: number | null;
  leads?: number | null;
  reach?: number | null;
  frequency?: number | null;
}

export interface MetaBreakdownRow extends MetaMetricsData {
  key: string;   // stable identifier for de-duplication
  label: string; // human-readable display string
}

// ── Internal raw API types ────────────────────────────────────────────────────

interface MetaActionValue {
  action_type: string;
  value: string;
}

interface RawCampaignInsight {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  ctr?: string;
  cpm?: string;
  impressions?: string;
  clicks?: string;
  actions?: MetaActionValue[];
  action_values?: MetaActionValue[];
  purchase_roas?: MetaActionValue[];
}

interface RawCampaign {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  objective?: string;
  buying_type?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  bid_amount?: string;
  bid_constraints?: {
    roas_average_floor?: string;
  };
}

const META_CAMPAIGN_CONFIG_FIELDS =
  "id,name,objective,effective_status,status,buying_type,daily_budget,lifetime_budget,bid_strategy,bid_amount,bid_constraints{roas_average_floor}";

interface RawAdSetInsight {
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  spend?: string;
  ctr?: string;
  inline_link_click_ctr?: string;
  cpm?: string;
  impressions?: string;
  clicks?: string;
  actions?: MetaActionValue[];
  action_values?: MetaActionValue[];
  purchase_roas?: MetaActionValue[];
}

interface RawAdSet {
  id: string;
  name: string;
  campaign_id?: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  bid_strategy?: string;
  bid_amount?: string;
  bid_constraints?: {
    roas_average_floor?: string;
  };
  promoted_object?: {
    pixel_id?: string;
    custom_event_type?: string;
    custom_conversion_id?: string;
    [key: string]: unknown;
  } | null;
}

interface RawAdInsight {
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  reach?: string;
  frequency?: string;
  spend?: string;
  ctr?: string;
  cpm?: string;
  impressions?: string;
  clicks?: string;
  actions?: MetaActionValue[];
  action_values?: MetaActionValue[];
  purchase_roas?: MetaActionValue[];
}

interface RawAd {
  id: string;
  name?: string;
  effective_status?: string;
  status?: string;
  adset_id?: string;
  campaign_id?: string;
}

interface RawBreakdownInsight {
  age?: string;
  gender?: string;
  country?: string;
  region?: string;
  publisher_platform?: string;
  platform_position?: string;
  impression_device?: string;
  spend?: string;
  clicks?: string;
  impressions?: string;
  ctr?: string;
  cpm?: string;
  actions?: MetaActionValue[];
  action_values?: MetaActionValue[];
  purchase_roas?: MetaActionValue[];
}

interface MetaGraphCollectionResponse<TItem> {
  data?: TItem[];
  paging?: {
    next?: string;
  };
}

// ── Credential resolution ─────────────────────────────────────────────────────

export interface MetaCredentials {
  businessId: string;
  accessToken: string;
  accountIds: string[];
  currency: string; // ISO 4217 code from the primary ad account (e.g. "USD", "EUR", "TRY")
  accountProfiles: Record<
    string,
    {
      currency: string;
      timezone: string | null;
      name: string | null;
    }
  >;
}

const META_ACCOUNT_PROFILE_TIMEOUT_MS = 8_000;

function readPositiveEnvNumber(name: string, fallback: number) {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const META_FETCH_TIMEOUT_MS = readPositiveEnvNumber("META_FETCH_TIMEOUT_MS", 90_000);
const META_FETCH_HEARTBEAT_INTERVAL_MS = readPositiveEnvNumber(
  "META_FETCH_HEARTBEAT_INTERVAL_MS",
  30_000
);
const DEFAULT_META_PARTITION_LEASE_MINUTES = readPositiveEnvNumber(
  "META_PARTITION_LEASE_MINUTES",
  15
);

function normalizeMetaApiDate(value: string): string {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  throw new Error(`Invalid Meta date input: ${value}`);
}

/**
 * Resolve the Meta access token and assigned ad account IDs for a business.
 * Returns null when the integration is missing, disconnected, or has no
 * assigned accounts — callers should treat null as "show empty state".
 */
export async function resolveMetaCredentials(
  businessId: string
): Promise<MetaCredentials | null> {
  const context = await getMetaAccountContext(businessId).catch(() => null);
  const accessToken = context?.accessToken;
  const accountIds = context?.accountIds ?? [];
  if (!accessToken || accountIds.length === 0) return null;

  return {
    businessId,
    accessToken,
    accountIds,
    currency: context?.currency ?? "USD",
    accountProfiles: context?.accountProfiles ?? {},
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function parseAction(arr: MetaActionValue[] | undefined, type: string): number {
  if (!Array.isArray(arr)) return 0;
  const found = arr.find((a) => a.action_type === type);
  return found ? parseFloat(found.value) || 0 : 0;
}

function parseNum(input: string | undefined): number {
  return input ? parseFloat(input) || 0 : 0;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function withinMetaTruthTolerance(sourceValue: number, warehouseValue: number) {
  const tolerance = Math.max(0.01, Math.abs(sourceValue) * 0.001);
  return Math.abs(sourceValue - warehouseValue) <= tolerance;
}

async function resetMetaPartitionFreshState(partitionId: string) {
  await supersedeMetaRawSnapshotsForPartition({ partitionId });
  await deleteMetaSyncCheckpointsForPartition({ partitionId });
}

async function fetchMetaAccountDaySpend(input: {
  accountId: string;
  accessToken: string;
  since: string;
  until: string;
}) {
  const url = new URL(`https://graph.facebook.com/v25.0/${input.accountId}/insights`);
  url.searchParams.set("level", "account");
  url.searchParams.set("fields", "spend");
  url.searchParams.set(
    "time_range",
    JSON.stringify({ since: input.since, until: input.until }),
  );
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("access_token", input.accessToken);
  const res = await fetch(url.toString(), {
    cache: "no-store",
    signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`meta_account_aggregate_fetch_failed:${res.status}`);
  }
  const json = (await res.json()) as MetaGraphCollectionResponse<{ spend?: string }>;
  return r2(parseNum(json.data?.[0]?.spend));
}

function buildAccountDailyRowFromCampaignRows(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountName: string | null;
  accountTimezone: string;
  accountCurrency: string;
  sourceSnapshotId: string | null;
  truthState: MetaWarehouseTruthState;
  truthVersion: number;
  finalizedAt: string | null;
  validationStatus: MetaWarehouseValidationStatus;
  sourceRunId: string | null;
  campaignRows: MetaCampaignDailyRow[];
}): MetaAccountDailyRow {
  const totals = input.campaignRows.reduce(
    (acc, row) => {
      acc.spend += row.spend;
      acc.impressions += row.impressions;
      acc.clicks += row.clicks;
      acc.reach += row.reach;
      acc.conversions += row.conversions;
      acc.revenue += row.revenue;
      return acc;
    },
    {
      spend: 0,
      impressions: 0,
      clicks: 0,
      reach: 0,
      conversions: 0,
      revenue: 0,
    },
  );
  const roas = totals.spend > 0 ? r2(totals.revenue / totals.spend) : 0;
  const cpa = totals.conversions > 0 ? r2(totals.spend / totals.conversions) : null;
  const ctr = totals.impressions > 0 ? r2((totals.clicks / totals.impressions) * 100) : null;
  const cpc = totals.clicks > 0 ? r2(totals.spend / totals.clicks) : null;
  const frequency = totals.reach > 0 ? r2(totals.impressions / totals.reach) : null;
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    date: input.date,
    accountName: input.accountName,
    accountTimezone: input.accountTimezone,
    accountCurrency: input.accountCurrency,
    spend: r2(totals.spend),
    impressions: totals.impressions,
    clicks: totals.clicks,
    reach: totals.reach,
    frequency,
    conversions: totals.conversions,
    revenue: r2(totals.revenue),
    roas,
    cpa,
    ctr,
    cpc,
    sourceSnapshotId: input.sourceSnapshotId,
    truthState: input.truthState,
    truthVersion: input.truthVersion,
    finalizedAt: input.finalizedAt,
    validationStatus: input.validationStatus,
    sourceRunId: input.sourceRunId,
  };
}

function applyConfigPayloadToDailyRow<
  T extends {
    objective?: string | null;
    optimizationGoal?: string | null;
    customEventType?: string | null;
    pixelId?: string | null;
    customConversionId?: string | null;
    promotedObjectJson?: unknown;
    bidStrategyType?: string | null;
    bidStrategyLabel?: string | null;
    manualBidAmount?: number | null;
    bidValue?: number | null;
    bidValueFormat?: "currency" | "roas" | null;
    dailyBudget?: number | null;
    lifetimeBudget?: number | null;
    isBudgetMixed?: boolean;
    isConfigMixed?: boolean;
    isOptimizationGoalMixed?: boolean;
    isCustomEventTypeMixed?: boolean;
    isBidStrategyMixed?: boolean;
    isBidValueMixed?: boolean;
  },
>(row: T, payload: MetaConfigSnapshotPayload): T {
  return {
    ...row,
    objective: payload.objective ?? row.objective ?? null,
    optimizationGoal: payload.optimizationGoal,
    customEventType: payload.customEventType,
    pixelId: payload.pixelId,
    customConversionId: payload.customConversionId,
    promotedObjectJson: payload.promotedObject,
    bidStrategyType: payload.bidStrategyType,
    bidStrategyLabel: payload.bidStrategyLabel,
    manualBidAmount: payload.manualBidAmount,
    bidValue: payload.bidValue,
    bidValueFormat: payload.bidValueFormat,
    dailyBudget: payload.dailyBudget,
    lifetimeBudget: payload.lifetimeBudget,
    isBudgetMixed: Boolean(payload.isBudgetMixed),
    isConfigMixed: Boolean(payload.isConfigMixed),
    isOptimizationGoalMixed: Boolean(payload.isOptimizationGoalMixed),
    isCustomEventTypeMixed: Boolean(payload.isCustomEventTypeMixed),
    isBidStrategyMixed: Boolean(payload.isBidStrategyMixed),
    isBidValueMixed: Boolean(payload.isBidValueMixed),
  };
}

function buildMetaAdSetConfigPayload(input: {
  campaignId: string;
  adset?: RawAdSet | null;
  campaignConfig?: RawCampaign | null;
  latestSnapshot?: MetaConfigSnapshotPayload | null;
  latestCampaignSnapshot?: MetaConfigSnapshotPayload | null;
}) {
  const usesCampaignBidFallback =
    input.adset?.bid_strategy == null &&
    input.adset?.bid_amount == null &&
    input.adset?.bid_constraints?.roas_average_floor == null &&
    (input.campaignConfig?.bid_strategy != null ||
      input.campaignConfig?.bid_amount != null ||
      input.campaignConfig?.bid_constraints?.roas_average_floor != null);
  const effectiveBidStrategy =
    input.adset?.bid_strategy ??
    input.latestSnapshot?.bidStrategyType ??
    input.latestCampaignSnapshot?.bidStrategyType ??
    input.campaignConfig?.bid_strategy ??
    null;
  const effectiveManualBid =
    input.adset?.bid_amount != null
      ? parseNum(input.adset.bid_amount)
      : input.latestSnapshot?.manualBidAmount != null
        ? input.latestSnapshot.manualBidAmount
        : input.latestCampaignSnapshot?.manualBidAmount != null
          ? input.latestCampaignSnapshot.manualBidAmount
          : input.campaignConfig?.bid_amount != null
            ? parseNum(input.campaignConfig.bid_amount)
            : null;
  const effectiveTargetRoas =
    input.adset?.bid_constraints?.roas_average_floor != null
      ? parseNum(input.adset.bid_constraints.roas_average_floor)
      : input.latestSnapshot?.bidValueFormat === "roas" &&
          input.latestSnapshot.bidValue != null
        ? input.latestSnapshot.bidValue
        : input.latestCampaignSnapshot?.bidValueFormat === "roas" &&
            input.latestCampaignSnapshot.bidValue != null
          ? input.latestCampaignSnapshot.bidValue
          : input.campaignConfig?.bid_constraints?.roas_average_floor != null
            ? parseNum(input.campaignConfig.bid_constraints.roas_average_floor)
            : null;
  const effectiveDailyBudget =
    input.adset?.daily_budget != null
      ? parseNum(input.adset.daily_budget)
      : input.latestSnapshot?.dailyBudget != null
        ? input.latestSnapshot.dailyBudget
        : input.latestCampaignSnapshot?.dailyBudget != null
          ? input.latestCampaignSnapshot.dailyBudget
          : input.campaignConfig?.daily_budget != null
            ? parseNum(input.campaignConfig.daily_budget)
            : null;
  const effectiveLifetimeBudget =
    input.adset?.lifetime_budget != null
      ? parseNum(input.adset.lifetime_budget)
      : input.latestSnapshot?.lifetimeBudget != null
        ? input.latestSnapshot.lifetimeBudget
        : input.latestCampaignSnapshot?.lifetimeBudget != null
          ? input.latestCampaignSnapshot.lifetimeBudget
          : input.campaignConfig?.lifetime_budget != null
            ? parseNum(input.campaignConfig.lifetime_budget)
            : null;

  return {
    payload: buildConfigSnapshotPayload({
      campaignId: input.campaignId,
      optimizationGoal:
        input.adset?.optimization_goal ??
        input.latestSnapshot?.optimizationGoal ??
        input.latestCampaignSnapshot?.optimizationGoal ??
        null,
      customEventType:
        input.adset?.promoted_object?.custom_event_type ??
        input.latestSnapshot?.customEventType ??
        null,
      pixelId:
        input.adset?.promoted_object?.pixel_id ??
        input.latestSnapshot?.pixelId ??
        null,
      customConversionId:
        input.adset?.promoted_object?.custom_conversion_id ??
        input.latestSnapshot?.customConversionId ??
        null,
      promotedObject:
        input.adset?.promoted_object ??
        input.latestSnapshot?.promotedObject ??
        null,
      bidStrategy: effectiveBidStrategy,
      manualBidAmount: effectiveManualBid,
      targetRoas: effectiveTargetRoas,
      dailyBudget: effectiveDailyBudget,
      lifetimeBudget: effectiveLifetimeBudget,
    }),
    usesCampaignBidFallback,
  };
}

function buildMetaCampaignDailyConfigRow(input: {
  campaignRow: MetaCampaignDailyRow;
  campaignConfig?: RawCampaign | null;
  latestCampaignSnapshot?: MetaConfigSnapshotPayload | null;
  adsetPayloads: MetaConfigSnapshotPayload[];
}): MetaCampaignDailyRow {
  const campaignSummary = summarizeCampaignConfig({
    campaignId: input.campaignRow.campaignId,
    campaignDailyBudget:
      input.campaignConfig?.daily_budget != null
        ? parseNum(input.campaignConfig.daily_budget)
        : null,
    campaignLifetimeBudget:
      input.campaignConfig?.lifetime_budget != null
        ? parseNum(input.campaignConfig.lifetime_budget)
        : null,
    campaignBidStrategy: input.campaignConfig?.bid_strategy ?? null,
    campaignManualBidAmount:
      input.campaignConfig?.bid_amount != null
        ? parseNum(input.campaignConfig.bid_amount)
        : null,
    targetRoas:
      input.campaignConfig?.bid_constraints?.roas_average_floor != null
        ? parseNum(input.campaignConfig.bid_constraints.roas_average_floor)
        : null,
    adsets: input.adsetPayloads,
  });

  return applyConfigPayloadToDailyRow(
    {
      ...input.campaignRow,
      objective:
        input.campaignRow.objective ??
        input.latestCampaignSnapshot?.objective ??
        null,
      buyingType:
        input.campaignRow.buyingType ??
        input.campaignConfig?.buying_type ??
        null,
    },
    {
      ...campaignSummary,
      optimizationGoal:
        campaignSummary.optimizationGoal ??
        input.latestCampaignSnapshot?.optimizationGoal ??
        null,
      customEventType:
        campaignSummary.customEventType ??
        input.latestCampaignSnapshot?.customEventType ??
        null,
      bidStrategyType:
        campaignSummary.bidStrategyType ??
        input.latestCampaignSnapshot?.bidStrategyType ??
        null,
      bidStrategyLabel:
        campaignSummary.bidStrategyLabel ??
        input.latestCampaignSnapshot?.bidStrategyLabel ??
        null,
      manualBidAmount:
        campaignSummary.manualBidAmount ??
        input.latestCampaignSnapshot?.manualBidAmount ??
        null,
      bidValue:
        campaignSummary.bidValue ??
        input.latestCampaignSnapshot?.bidValue ??
        null,
      bidValueFormat:
        campaignSummary.bidValueFormat ??
        input.latestCampaignSnapshot?.bidValueFormat ??
        null,
      dailyBudget:
        campaignSummary.dailyBudget ??
        input.latestCampaignSnapshot?.dailyBudget ??
        null,
      lifetimeBudget:
        campaignSummary.lifetimeBudget ??
        input.latestCampaignSnapshot?.lifetimeBudget ??
        null,
      isBudgetMixed:
        Boolean(campaignSummary.isBudgetMixed) ||
        Boolean(input.latestCampaignSnapshot?.isBudgetMixed),
      isConfigMixed:
        Boolean(campaignSummary.isConfigMixed) ||
        Boolean(input.latestCampaignSnapshot?.isConfigMixed),
      isOptimizationGoalMixed:
        Boolean(campaignSummary.isOptimizationGoalMixed) ||
        Boolean(input.latestCampaignSnapshot?.isOptimizationGoalMixed),
      isCustomEventTypeMixed:
        Boolean(campaignSummary.isCustomEventTypeMixed) ||
        Boolean(input.latestCampaignSnapshot?.isCustomEventTypeMixed),
      isBidStrategyMixed:
        Boolean(campaignSummary.isBidStrategyMixed) ||
        Boolean(input.latestCampaignSnapshot?.isBidStrategyMixed),
      isBidValueMixed:
        Boolean(campaignSummary.isBidValueMixed) ||
        Boolean(input.latestCampaignSnapshot?.isBidValueMixed),
    }
  );
}

async function fetchPagedCollection<TItem>(initialUrl: string): Promise<TItem[]> {
  const rows: TItem[] = [];
  let nextUrl: string | null = initialUrl;
  let pageCount = 0;

  while (nextUrl && pageCount < 20) {
    const res = await fetch(nextUrl, { cache: "no-store" });
    if (!res.ok) break;
    const json = (await res.json()) as MetaGraphCollectionResponse<TItem>;
    rows.push(...(json.data ?? []));
    nextUrl = json.paging?.next ?? null;
    pageCount += 1;
  }

  return rows;
}

function getTodayIsoForTimeZone(timeZone?: string | null): string {
  if (!timeZone) return new Date().toISOString().slice(0, 10);
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

function inferRequestSyncType(
  since: string,
  until: string,
  referenceToday?: string | null
): MetaSyncType {
  const normalizedSince = normalizeMetaApiDate(since);
  const normalizedUntil = normalizeMetaApiDate(until);
  if (normalizedSince === normalizedUntil) {
    return normalizedSince === (referenceToday ?? "").slice(0, 10)
      ? "today_refresh"
      : "repair_window";
  }
  const start = new Date(`${normalizedSince}T00:00:00Z`).getTime();
  const end = new Date(`${normalizedUntil}T00:00:00Z`).getTime();
  const daySpan = Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(1, Math.round((end - start) / 86_400_000) + 1)
    : 1;
  if (daySpan <= 7) return "incremental_recent";
  return "repair_window";
}

function isSingleDayWindow(since: string, until: string) {
  return normalizeMetaApiDate(since) === normalizeMetaApiDate(until);
}

function isCurrentDayForTimezone(date: string, timeZone?: string | null) {
  return normalizeMetaApiDate(date) === getTodayIsoForTimeZone(timeZone);
}

function resolveMetaAuthoritativeSourceWindowKind(input: {
  day: string;
  referenceToday: string;
  source?: string | null;
}) {
  const normalizedDay = normalizeMetaApiDate(input.day);
  const normalizedReferenceToday = normalizeMetaApiDate(input.referenceToday);
  if (normalizedDay === normalizedReferenceToday) {
    return "today" as const;
  }
  const yesterday = new Date(`${normalizedReferenceToday}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const normalizedYesterday = yesterday.toISOString().slice(0, 10);
  if (normalizedDay === normalizedYesterday) {
    return "d_minus_1" as const;
  }
  if (
    (input.source ?? "").includes("historical") ||
    (input.source ?? "") === "initial_connect" ||
    (input.source ?? "") === "manual_refresh"
  ) {
    return "historical" as const;
  }
  return "recent_repair" as const;
}

async function withMetaSyncJob<T>(input: {
  credentials: MetaCredentials;
  accountId: string;
  scope: MetaWarehouseScope;
  since: string;
  until: string;
  run: () => Promise<T>;
}) {
  const normalizedSince = normalizeMetaApiDate(input.since);
  const normalizedUntil = normalizeMetaApiDate(input.until);
  const accountTimezone =
    input.credentials.accountProfiles[input.accountId]?.timezone ?? null;
  const syncJobId = await createMetaSyncJob({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    syncType: inferRequestSyncType(
      normalizedSince,
      normalizedUntil,
      getTodayIsoForTimeZone(accountTimezone)
    ),
    scope: input.scope,
    startDate: normalizedSince,
    endDate: normalizedUntil,
    status: "running",
    progressPercent: 5,
    triggerSource: "request_runtime",
    retryCount: 0,
    lastError: null,
    startedAt: new Date().toISOString(),
  });

  try {
    const result = await input.run();
    if (syncJobId) {
      await updateMetaSyncJob({
        id: syncJobId,
        status: "succeeded",
        progressPercent: 100,
        finishedAt: new Date().toISOString(),
      });
    }
    return result;
  } catch (error) {
    if (syncJobId) {
      await updateMetaSyncJob({
        id: syncJobId,
        status: "failed",
        progressPercent: 100,
        lastError: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

async function recordMetaRawSnapshot(input: {
  credentials: MetaCredentials;
  accountId: string;
  endpointName: string;
  entityScope: string;
  partitionId?: string | null;
  checkpointId?: string | null;
  runId?: string | null;
  pageIndex?: number | null;
  providerCursor?: string | null;
  since: string;
  until: string;
  payload: unknown;
  status: MetaRawSnapshotStatus;
  providerHttpStatus?: number | null;
  requestContext?: Record<string, unknown>;
  responseHeaders?: Record<string, unknown>;
}) {
  const normalizedSince = normalizeMetaApiDate(input.since);
  const normalizedUntil = normalizeMetaApiDate(input.until);
  const profile = input.credentials.accountProfiles[input.accountId];
  return persistMetaRawSnapshot({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId ?? null,
    checkpointId: input.checkpointId ?? null,
    runId: input.runId ?? null,
    endpointName: input.endpointName,
    entityScope: input.entityScope,
    pageIndex: input.pageIndex ?? null,
    providerCursor: input.providerCursor ?? null,
    startDate: normalizedSince,
    endDate: normalizedUntil,
    accountTimezone: profile?.timezone ?? null,
    accountCurrency: profile?.currency ?? input.credentials.currency,
    payloadJson: input.payload,
    payloadHash: buildMetaRawSnapshotHash({
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      endpointName: input.endpointName,
      startDate: normalizedSince,
      endDate: normalizedUntil,
      payload: input.payload,
    }),
    requestContext: input.requestContext ?? {},
    responseHeaders: input.responseHeaders ?? {},
    providerHttpStatus: input.providerHttpStatus ?? null,
    status: input.status,
  });
}

/**
 * Derive the full MetaMetricsData object from raw Meta API fields.
 * Revenue falls back to spend × purchase_roas when action_values is absent.
 */
function buildMetrics(input: {
  spend_str?: string;
  ctr_str?: string;
  cpm_str?: string;
  impressions_str?: string;
  clicks_str?: string;
  actions?: MetaActionValue[];
  action_values?: MetaActionValue[];
  purchase_roas?: MetaActionValue[];
}): MetaMetricsData {
  const spend = parseNum(input.spend_str);
  const purchases = parseAction(input.actions, "purchase");
  const revenueFromValues = parseAction(input.action_values, "purchase");
  const purchaseRoasVal = parseAction(input.purchase_roas, "omni_purchase");
  const revenue =
    revenueFromValues > 0 ? revenueFromValues : spend * purchaseRoasVal;
  const roas = spend > 0 ? revenue / spend : 0;
  const cpa = purchases > 0 ? spend / purchases : 0;

  return {
    spend: r2(spend),
    purchases: Math.round(purchases),
    revenue: r2(revenue),
    roas: r2(roas),
    cpa: r2(cpa),
    ctr: r2(parseNum(input.ctr_str)),
    cpm: r2(parseNum(input.cpm_str)),
    impressions: Math.round(parseNum(input.impressions_str)),
    clicks: Math.round(parseNum(input.clicks_str)),
  };
}

export interface MetaBusinessUsageSummary {
  raw: string | null;
  maxPercent: number;
}

export interface MetaBulkCoreSyncResult {
  accountRowsWritten: number;
  campaignRowsWritten: number;
  adsetRowsWritten: number;
  adRowsWritten: number;
  positiveSpendAdIds: string[];
  pageCount: number;
  restoredPageCount: number;
  throttleCount: number;
  lastUsagePercent: number;
  memoryInstrumentation?: {
    maxHeapUsedBytes: number;
    maxRowsBuffered: number;
    flushThresholdRows: number;
    oversizeWarning: boolean;
  };
  incompleteTruthCounts?: {
    campaigns: number;
    adsets: number;
  };
}

const META_BULK_PAGE_LIMIT = 1000;
const META_USAGE_THROTTLE_THRESHOLD = 85;
const META_USAGE_THROTTLE_SLEEP_MS = 15_000;
const META_MEMORY_FLUSH_THRESHOLD_ROWS = Number(process.env.META_MEMORY_FLUSH_THRESHOLD_ROWS ?? 20_000) || 20_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUsageMaxPercent(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.reduce((max, item) => Math.max(max, parseUsageMaxPercent(item)), 0);
  if (value && typeof value === "object") {
    return Object.values(value).reduce((max, item) => Math.max(max, parseUsageMaxPercent(item)), 0);
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    try {
      return parseUsageMaxPercent(JSON.parse(value));
    } catch {
      return 0;
    }
  }
  return 0;
}

function parseMetaBusinessUsageHeader(headers: Headers): MetaBusinessUsageSummary {
  const raw = headers.get("x-business-use-case-usage");
  if (!raw) return { raw: null, maxPercent: 0 };
  return {
    raw,
    maxPercent: parseUsageMaxPercent(raw),
  };
}

function getMetaBulkCoreEndpointName() {
  return "ad_insights_bulk";
}

function buildMetaBulkCoreInsightsUrl(input: {
  accountId: string;
  accessToken: string;
  since: string;
  until: string;
}) {
  const url = new URL(`https://graph.facebook.com/v25.0/${input.accountId}/insights`);
  url.searchParams.set("level", "ad");
  url.searchParams.set(
    "fields",
    "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,reach,frequency,spend,ctr,cpm,impressions,clicks,actions,action_values,purchase_roas"
  );
  url.searchParams.set("time_range", JSON.stringify({ since: input.since, until: input.until }));
  url.searchParams.set("limit", String(META_BULK_PAGE_LIMIT));
  url.searchParams.set("access_token", input.accessToken);
  return url.toString();
}

function buildMetaBreakdownInsightsUrl(input: {
  accountId: string;
  accessToken: string;
  since: string;
  until: string;
  breakdowns: string;
  positiveSpendAdIds: string[];
}) {
  const url = new URL(`https://graph.facebook.com/v25.0/${input.accountId}/insights`);
  url.searchParams.set("level", "ad");
  url.searchParams.set(
    "fields",
    "ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,spend,ctr,cpm,impressions,clicks,actions,action_values,purchase_roas"
  );
  url.searchParams.set("breakdowns", input.breakdowns);
  url.searchParams.set("time_range", JSON.stringify({ since: input.since, until: input.until }));
  url.searchParams.set("limit", String(META_BULK_PAGE_LIMIT));
  if (input.positiveSpendAdIds.length > 0 && input.positiveSpendAdIds.length <= 200) {
    url.searchParams.set(
      "filtering",
      JSON.stringify([{ field: "ad.id", operator: "IN", value: input.positiveSpendAdIds }])
    );
  }
  url.searchParams.set("access_token", input.accessToken);
  return url.toString();
}

function startMetaFetchHeartbeat(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  leaseMinutes: number;
}) {
  return setInterval(() => {
    void heartbeatMetaPartitionLease({
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      leaseMinutes: input.leaseMinutes,
    }).catch(() => null);
  }, META_FETCH_HEARTBEAT_INTERVAL_MS);
}

async function heartbeatOwnedMetaPartitionLeaseOrThrow(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  leaseMinutes: number;
}) {
  const ok = await heartbeatMetaPartitionLease({
    partitionId: input.partitionId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    leaseMinutes: input.leaseMinutes,
  });
  if (!ok) {
    throw new Error("lease_conflict:lease_heartbeat_rejected");
  }
}

async function upsertOwnedMetaCheckpointOrThrow(input: MetaSyncCheckpointRecord) {
  const checkpointId = await upsertMetaSyncCheckpoint(input);
  if (input.leaseOwner && !checkpointId) {
    throw new Error("lease_conflict:checkpoint_write_rejected");
  }
  return checkpointId;
}

function buildMetaPhaseTimingScope(input: {
  phase: MetaSyncPhaseTimingPhase;
  scope: string;
}) {
  return `${input.phase}:${input.scope}`;
}

async function upsertOwnedMetaPhaseTimingOrThrow(input: MetaSyncPhaseTimingRecord) {
  const timingId = await upsertMetaSyncPhaseTiming(input);
  if (input.leaseOwner && !timingId) {
    throw new Error("lease_conflict:phase_timing_write_rejected");
  }
  return timingId;
}

async function fetchMetaPagedJson<TItem>(url: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";
    if (
      name === "AbortError" ||
      name === "TimeoutError" ||
      /timed out|abort|aborted/i.test(message)
    ) {
      throw new Error(`Meta request timed out after ${META_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  }
  const json = (await response.json().catch(() => ({}))) as MetaGraphCollectionResponse<TItem> & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(json.error?.message ?? `Meta request failed with status ${response.status}`);
  }
  return {
    response,
    json,
  } as {
    response: Response;
    json: MetaGraphCollectionResponse<TItem> & { error?: { message?: string } };
  };
}

type MetaAggregateTotals = {
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  conversions: number;
  revenue: number;
};

function createEmptyTotals(): MetaAggregateTotals {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    reach: 0,
    conversions: 0,
    revenue: 0,
  };
}

function accumulateAdInsight(
  row: RawAdInsight,
  target: MetaAggregateTotals & {
    name?: string | null;
    campaignId?: string | null;
    adsetId?: string | null;
    status?: string | null;
    frequencySum?: number;
    frequencyWeight?: number;
    payloadJson?: unknown;
  }
) {
  const metrics = buildMetrics({
    spend_str: row.spend,
    ctr_str: row.ctr,
    cpm_str: row.cpm,
    impressions_str: row.impressions,
    clicks_str: row.clicks,
    actions: row.actions,
    action_values: row.action_values,
    purchase_roas: row.purchase_roas,
  });
  target.spend = r2(target.spend + metrics.spend);
  target.impressions += metrics.impressions;
  target.clicks += metrics.clicks;
  target.reach += Math.round(parseNum(row.reach ?? row.impressions));
  target.conversions += metrics.purchases;
  target.revenue = r2(target.revenue + metrics.revenue);
  const frequency = parseNum(row.frequency);
  if (frequency > 0 && metrics.impressions > 0) {
    target.frequencySum = (target.frequencySum ?? 0) + frequency * metrics.impressions;
    target.frequencyWeight = (target.frequencyWeight ?? 0) + metrics.impressions;
  }
}

function deriveWarehouseMetrics(input: MetaAggregateTotals & { frequencySum?: number; frequencyWeight?: number }) {
  const frequency =
    (input.frequencyWeight ?? 0) > 0
      ? r2((input.frequencySum ?? 0) / Math.max(1, input.frequencyWeight ?? 0))
      : null;
  const ctr = input.impressions > 0 ? r2((input.clicks / input.impressions) * 100) : null;
  const cpc = input.clicks > 0 ? r2(input.spend / input.clicks) : null;
  const cpa = input.conversions > 0 ? r2(input.spend / input.conversions) : null;
  const roas = input.spend > 0 ? r2(input.revenue / input.spend) : 0;
  return {
    frequency,
    ctr,
    cpc,
    cpa,
    roas,
  };
}

function applyAdInsightRowsToAggregates(
  rows: RawAdInsight[],
  aggregates: {
    account: MetaAggregateTotals & { frequencySum?: number; frequencyWeight?: number };
    campaigns: Map<string, MetaAggregateTotals & { name?: string | null; status?: string | null; frequencySum?: number; frequencyWeight?: number }>;
    adsets: Map<string, MetaAggregateTotals & { campaignId?: string | null; name?: string | null; status?: string | null; frequencySum?: number; frequencyWeight?: number }>;
    ads: Map<string, MetaAggregateTotals & { campaignId?: string | null; adsetId?: string | null; name?: string | null; status?: string | null; reach?: number; frequencySum?: number; frequencyWeight?: number; payloadJson?: unknown }>;
  }
) {
  for (const row of rows) {
    const campaignId = row.campaign_id ?? "";
    const adsetId = row.adset_id ?? "";
    const adId = row.ad_id ?? "";
    accumulateAdInsight(row, aggregates.account);
    if (campaignId) {
      const target =
        aggregates.campaigns.get(campaignId) ??
        (createEmptyTotals() as MetaAggregateTotals & {
          name?: string | null;
          status?: string | null;
          frequencySum?: number;
          frequencyWeight?: number;
        });
      target.name = row.campaign_name ?? target.name ?? null;
      accumulateAdInsight(row, target);
      aggregates.campaigns.set(campaignId, target);
    }
    if (adsetId) {
      const target =
        aggregates.adsets.get(adsetId) ??
        (createEmptyTotals() as MetaAggregateTotals & {
          campaignId?: string | null;
          name?: string | null;
          status?: string | null;
          frequencySum?: number;
          frequencyWeight?: number;
        });
      target.name = row.adset_name ?? target.name ?? null;
      target.campaignId = campaignId || target.campaignId || null;
      accumulateAdInsight(row, target);
      aggregates.adsets.set(adsetId, target);
    }
    if (adId) {
      const target =
        aggregates.ads.get(adId) ??
        (createEmptyTotals() as MetaAggregateTotals & {
          campaignId?: string | null;
          adsetId?: string | null;
          name?: string | null;
          status?: string | null;
          reach?: number;
          frequencySum?: number;
          frequencyWeight?: number;
          payloadJson?: unknown;
        });
      target.name = row.ad_name ?? target.name ?? null;
      target.campaignId = campaignId || target.campaignId || null;
      target.adsetId = adsetId || target.adsetId || null;
      target.payloadJson = row;
      accumulateAdInsight(row, target);
      aggregates.ads.set(adId, target);
    }
  }
}

function ensureCampaignAggregate(
  aggregates: {
    campaigns: Map<string, MetaAggregateTotals & { name?: string | null; status?: string | null; frequencySum?: number; frequencyWeight?: number }>;
  },
  campaignId: string,
  options?: {
    name?: string | null;
    status?: string | null;
  }
) {
  if (!campaignId) return;
  const target =
    aggregates.campaigns.get(campaignId) ??
    (createEmptyTotals() as MetaAggregateTotals & {
      name?: string | null;
      status?: string | null;
      frequencySum?: number;
      frequencyWeight?: number;
    });
  target.name = target.name ?? options?.name ?? null;
  target.status = target.status ?? options?.status ?? null;
  aggregates.campaigns.set(campaignId, target);
}

function ensureAdSetAggregate(
  aggregates: {
    adsets: Map<string, MetaAggregateTotals & { campaignId?: string | null; name?: string | null; status?: string | null; frequencySum?: number; frequencyWeight?: number }>;
  },
  adsetId: string,
  options?: {
    campaignId?: string | null;
    name?: string | null;
    status?: string | null;
  }
) {
  if (!adsetId) return;
  const target =
    aggregates.adsets.get(adsetId) ??
    (createEmptyTotals() as MetaAggregateTotals & {
      campaignId?: string | null;
      name?: string | null;
      status?: string | null;
      frequencySum?: number;
      frequencyWeight?: number;
    });
  target.campaignId = target.campaignId ?? options?.campaignId ?? null;
  target.name = target.name ?? options?.name ?? null;
  target.status = target.status ?? options?.status ?? null;
  aggregates.adsets.set(adsetId, target);
}

function seedMissingMetaEntitiesFromConfigs(
  aggregates: {
    campaigns: Map<string, MetaAggregateTotals & { name?: string | null; status?: string | null; frequencySum?: number; frequencyWeight?: number }>;
    adsets: Map<string, MetaAggregateTotals & { campaignId?: string | null; name?: string | null; status?: string | null; frequencySum?: number; frequencyWeight?: number }>;
  },
  input: {
    campaignConfigs: Map<string, RawCampaign>;
    adsetConfigs: Map<string, RawAdSet>;
  }
) {
  for (const [campaignId, campaign] of input.campaignConfigs.entries()) {
    ensureCampaignAggregate(aggregates, campaignId, {
      name: campaign.name ?? null,
      status: campaign.effective_status ?? campaign.status ?? null,
    });
  }

  for (const [adsetId, adset] of input.adsetConfigs.entries()) {
    ensureAdSetAggregate(aggregates, adsetId, {
      campaignId: adset.campaign_id ?? null,
      name: adset.name ?? null,
      status: adset.effective_status ?? adset.status ?? null,
    });
    if (adset.campaign_id) {
      const campaign = input.campaignConfigs.get(adset.campaign_id) ?? null;
      ensureCampaignAggregate(aggregates, adset.campaign_id, {
        name: campaign?.name ?? null,
        status:
          campaign?.effective_status ??
          campaign?.status ??
          null,
      });
    }
  }
}

function collectIncompleteCampaignTruth(input: {
  rows: MetaCampaignDailyRow[];
  campaignConfigs: Map<string, RawCampaign>;
}) {
  return input.rows
    .map((row) => {
      const config = input.campaignConfigs.get(row.campaignId);
      if (!config) return null;
      const missingFields: string[] = [];
      if (config.objective != null && row.objective == null) missingFields.push("objective");
      if (
        (config.bid_strategy != null || config.bid_amount != null || config.bid_constraints?.roas_average_floor != null) &&
        row.bidStrategyLabel == null
      ) {
        missingFields.push("bidStrategyLabel");
      }
      if (
        (config.daily_budget != null || config.lifetime_budget != null) &&
        row.dailyBudget == null &&
        row.lifetimeBudget == null
      ) {
        missingFields.push("budget");
      }
      if (missingFields.length === 0) return null;
      return {
        campaignId: row.campaignId,
        campaignName: row.campaignNameCurrent ?? row.campaignNameHistorical ?? null,
        missingFields,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

function collectIncompleteAdSetTruth(input: {
  rows: MetaAdSetDailyRow[];
  adsetConfigs: Map<string, RawAdSet>;
  campaignConfigs: Map<string, RawCampaign>;
}) {
  return input.rows
    .map((row) => {
      const adsetConfig = input.adsetConfigs.get(row.adsetId) ?? null;
      const campaignConfig = row.campaignId ? input.campaignConfigs.get(row.campaignId) ?? null : null;
      if (!adsetConfig && !campaignConfig) return null;
      const missingFields: string[] = [];
      if (adsetConfig?.optimization_goal != null && row.optimizationGoal == null) {
        missingFields.push("optimizationGoal");
      }
      if (
        (
          adsetConfig?.bid_strategy != null ||
          adsetConfig?.bid_amount != null ||
          adsetConfig?.bid_constraints?.roas_average_floor != null ||
          campaignConfig?.bid_strategy != null ||
          campaignConfig?.bid_amount != null ||
          campaignConfig?.bid_constraints?.roas_average_floor != null
        ) &&
        row.bidStrategyLabel == null
      ) {
        missingFields.push("bidStrategyLabel");
      }
      if (
        (
          adsetConfig?.daily_budget != null ||
          adsetConfig?.lifetime_budget != null ||
          campaignConfig?.daily_budget != null ||
          campaignConfig?.lifetime_budget != null
        ) &&
        row.dailyBudget == null &&
        row.lifetimeBudget == null
      ) {
        missingFields.push("budget");
      }
      if (missingFields.length === 0) return null;
      return {
        adsetId: row.adsetId,
        adsetName: row.adsetNameCurrent ?? row.adsetNameHistorical ?? null,
        missingFields,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

export async function syncMetaAccountCoreWarehouseDay(input: {
  credentials: MetaCredentials;
  accountId: string;
  day: string;
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  attemptCount: number;
  leaseMinutes?: number;
  freshStart?: boolean;
  truthState?: MetaWarehouseTruthState;
  lane?: MetaSyncLane;
  sourceRunId?: string | null;
  source?: string | null;
}) : Promise<MetaBulkCoreSyncResult> {
  const normalizedDay = normalizeMetaApiDate(input.day);
  const profile = input.credentials.accountProfiles[input.accountId];
  const accountToday = getTodayIsoForTimeZone(profile?.timezone ?? "UTC");
  const truthState =
    input.truthState ?? (normalizedDay === accountToday ? "provisional" : "finalized");
  const finalizedAt = truthState === "finalized" ? new Date().toISOString() : null;
  const validationStatus: MetaWarehouseValidationStatus =
    truthState === "finalized" ? "passed" : "pending";
  const sourceRunId = input.sourceRunId ?? input.partitionId;
  const authoritativeFinalizationV2Enabled =
    truthState === "finalized" &&
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(
      input.credentials.businessId,
    );
  const checkpointScope = "core_ad_insights";
  const partitionScope = "account_daily";
  const partitionLane = input.lane ?? "core";
  const partitionSource = input.source ?? "core_success";
  const endpointName = getMetaBulkCoreEndpointName();
  if (input.freshStart) {
    await resetMetaPartitionFreshState(input.partitionId);
  }
  const checkpoint = input.freshStart
    ? null
    : await getMetaSyncCheckpoint({
        partitionId: input.partitionId,
        checkpointScope,
        runId: sourceRunId,
      });
  let restoredPages: Awaited<ReturnType<typeof listMetaRawSnapshotsForRun>> = [];
  const aggregates = {
    account: createEmptyTotals() as MetaAggregateTotals & { frequencySum?: number; frequencyWeight?: number },
    campaigns: new Map<string, MetaAggregateTotals & { name?: string | null; status?: string | null; frequencySum?: number; frequencyWeight?: number }>(),
    adsets: new Map<string, MetaAggregateTotals & { campaignId?: string | null; name?: string | null; status?: string | null; frequencySum?: number; frequencyWeight?: number }>(),
    ads: new Map<string, MetaAggregateTotals & { campaignId?: string | null; adsetId?: string | null; name?: string | null; status?: string | null; reach?: number; frequencySum?: number; frequencyWeight?: number; payloadJson?: unknown }>(),
  };
  let maxHeapUsedBytes = process.memoryUsage().heapUsed;
  let maxRowsBuffered = 0;

  function captureMemorySnapshot() {
    const heapUsed = process.memoryUsage().heapUsed;
    maxHeapUsedBytes = Math.max(maxHeapUsedBytes, heapUsed);
    const rowsBuffered =
      aggregates.campaigns.size + aggregates.adsets.size + aggregates.ads.size;
    maxRowsBuffered = Math.max(maxRowsBuffered, rowsBuffered);
  }

  let rowsFetchedTotal = 0;
  let latestSnapshotId: string | null = null;
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.restore_raw_pages",
    run: async () => {
      restoredPages = input.freshStart
        ? []
        : await listMetaRawSnapshotsForRun({
            partitionId: input.partitionId,
            endpointName,
            runId: sourceRunId,
          });
      for (const rawPage of restoredPages) {
        const payload = Array.isArray(rawPage.payload_json)
          ? (rawPage.payload_json as RawAdInsight[])
          : [];
        applyAdInsightRowsToAggregates(payload, aggregates);
        captureMemorySnapshot();
      }
      rowsFetchedTotal = restoredPages.reduce((sum, page) => {
        const payload = Array.isArray(page.payload_json) ? page.payload_json.length : 0;
        return sum + payload;
      }, 0);
      latestSnapshotId = restoredPages.at(-1)?.id ?? null;
    },
  });

  let nextPageUrl: string | null =
    checkpoint?.nextPageUrl ??
    buildMetaBulkCoreInsightsUrl({
      accountId: input.accountId,
      accessToken: input.credentials.accessToken,
      since: normalizedDay,
      until: normalizedDay,
    });
  let pageIndex = checkpoint?.pageIndex ?? restoredPages.length;
  let throttleCount = 0;
  let lastUsagePercent = 0;
  const coreCheckpointStartedAt = checkpoint?.startedAt ?? new Date().toISOString();
  const fetchTimingScope = buildMetaPhaseTimingScope({
    phase: "fetch_raw",
    scope: checkpointScope,
  });
  const bulkUpsertTimingScope = buildMetaPhaseTimingScope({
    phase: "bulk_upsert",
    scope: checkpointScope,
  });
  const finalizeTimingScope = buildMetaPhaseTimingScope({
    phase: "finalize",
    scope: checkpointScope,
  });
  const publishTimingScope = buildMetaPhaseTimingScope({
    phase: "publish",
    scope: "core_authoritative",
  });

  await upsertOwnedMetaCheckpointOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    checkpointScope,
    runId: sourceRunId,
    phase: "fetch_raw",
    status: "running",
    pageIndex,
    nextPageUrl,
    providerCursor: checkpoint?.providerCursor ?? null,
    rowsFetched: checkpoint?.rowsFetched ?? restoredPages.reduce((sum, page) => {
      const payload = Array.isArray(page.payload_json) ? page.payload_json.length : 0;
      return sum + payload;
    }, 0),
    rowsWritten: 0,
    lastSuccessfulEntityKey: checkpoint?.lastSuccessfulEntityKey ?? null,
    lastResponseHeaders: checkpoint?.lastResponseHeaders ?? {},
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    leaseExpiresAt: null,
    startedAt: coreCheckpointStartedAt,
  });
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: fetchTimingScope,
    runId: sourceRunId,
    phase: "fetch_raw",
    status: "running",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: 0,
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: coreCheckpointStartedAt,
  });
  const bulkUpsertStartedAt = new Date().toISOString();
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: bulkUpsertTimingScope,
    runId: sourceRunId,
    phase: "bulk_upsert",
    status: "running",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: 0,
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: bulkUpsertStartedAt,
  });

  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.fetch_source_pages",
    run: async () => {
      while (nextPageUrl) {
        await heartbeatOwnedMetaPartitionLeaseOrThrow({
          partitionId: input.partitionId,
          workerId: input.workerId,
          leaseEpoch: input.leaseEpoch,
          leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
        });
        const fetchHeartbeat = startMetaFetchHeartbeat({
          partitionId: input.partitionId,
          workerId: input.workerId,
          leaseEpoch: input.leaseEpoch,
          leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
        });
        let pageResult: {
          response: Response;
          json: MetaGraphCollectionResponse<RawAdInsight> & { error?: { message?: string } };
        };
        try {
          pageResult = await fetchMetaPagedJson<RawAdInsight>(nextPageUrl);
        } finally {
          clearInterval(fetchHeartbeat);
        }
        const response = pageResult.response;
        const json = pageResult.json;
        const rows = json.data ?? [];
        const usageSummary = parseMetaBusinessUsageHeader(response.headers);
        lastUsagePercent = Math.max(lastUsagePercent, usageSummary.maxPercent);
        const checkpointId = await upsertOwnedMetaCheckpointOrThrow({
          partitionId: input.partitionId,
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          checkpointScope,
          runId: sourceRunId,
          phase: "fetch_raw",
          status: "running",
          pageIndex,
          nextPageUrl: json.paging?.next ?? null,
          providerCursor: json.paging?.next ?? null,
          rowsFetched: rowsFetchedTotal + rows.length,
          rowsWritten: 0,
          lastSuccessfulEntityKey:
            rows.at(-1)?.ad_id ?? rows.at(-1)?.adset_id ?? rows.at(-1)?.campaign_id ?? null,
          lastResponseHeaders: {
            "x-business-use-case-usage": usageSummary.raw,
          },
          checkpointHash: buildMetaSyncCheckpointHash({
            partitionId: input.partitionId,
            checkpointScope,
            phase: "fetch_raw",
            pageIndex,
            nextPageUrl: json.paging?.next ?? null,
            providerCursor: json.paging?.next ?? null,
          }),
          attemptCount: input.attemptCount,
          leaseEpoch: input.leaseEpoch,
          leaseOwner: input.workerId,
          startedAt: checkpoint?.startedAt ?? new Date().toISOString(),
        });
        await upsertOwnedMetaPhaseTimingOrThrow({
          partitionId: input.partitionId,
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          timingScope: fetchTimingScope,
          runId: sourceRunId,
          phase: "fetch_raw",
          status: "running",
          rowsFetched: rowsFetchedTotal + rows.length,
          rowsWritten: 0,
          attemptCount: input.attemptCount,
          leaseEpoch: input.leaseEpoch,
          leaseOwner: input.workerId,
          startedAt: coreCheckpointStartedAt,
        });
        latestSnapshotId = await recordMetaRawSnapshot({
          credentials: input.credentials,
          accountId: input.accountId,
          endpointName,
          entityScope: "ad",
          since: normalizedDay,
          until: normalizedDay,
          payload: rows,
          status: "fetched",
          providerHttpStatus: response.status,
          requestContext: {
            level: "ad",
            source: "bulk_core_sync",
            pageIndex,
          },
          partitionId: input.partitionId,
          checkpointId,
          runId: sourceRunId,
          pageIndex,
          providerCursor: json.paging?.next ?? null,
          responseHeaders: {
            "x-business-use-case-usage": usageSummary.raw,
          },
        });
        applyAdInsightRowsToAggregates(rows, aggregates);
        captureMemorySnapshot();
        rowsFetchedTotal += rows.length;
        nextPageUrl = json.paging?.next ?? null;
        pageIndex += 1;
        if (usageSummary.maxPercent >= META_USAGE_THROTTLE_THRESHOLD && nextPageUrl) {
          throttleCount += 1;
          await sleep(META_USAGE_THROTTLE_SLEEP_MS);
        }
      }
    },
  });
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: fetchTimingScope,
    runId: sourceRunId,
    phase: "fetch_raw",
    status: "succeeded",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: 0,
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: coreCheckpointStartedAt,
    finishedAt: new Date().toISOString(),
  });
  let campaignStatuses = new Map<string, string>();
  let adsetConfigs = new Map<string, RawAdSet>();
  let campaignConfigs = new Map<string, RawCampaign>();
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.fetch_remote_configs",
    run: async () => {
      [campaignStatuses, adsetConfigs, campaignConfigs] = await Promise.all([
        fetchCampaignStatuses(
          input.credentials,
          input.accountId,
          input.credentials.accessToken,
        ).catch(() => new Map<string, string>()),
        fetchMetaAdSetConfigs(
          input.accountId,
          input.credentials.accessToken,
        ).catch(() => new Map<string, RawAdSet>()),
        fetchMetaCampaignConfigs(
          input.credentials,
          input.accountId,
          input.credentials.accessToken,
        ).catch(() => new Map<string, RawCampaign>()),
      ]);
    },
  });
  let sourceAccountSpend: number | null = null;
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.fetch_source_account_spend",
    run: async () => {
      sourceAccountSpend =
        truthState === "finalized"
          ? await fetchMetaAccountDaySpend({
              accountId: input.accountId,
              accessToken: input.credentials.accessToken,
              since: normalizedDay,
              until: normalizedDay,
            })
          : null;
    },
  });
  let campaignIds: string[] = [];
  let adsetIds: string[] = [];
  let latestCampaignSnapshots = new Map<string, MetaConfigSnapshotPayload>();
  let latestAdsetSnapshots = new Map<string, MetaConfigSnapshotPayload>();
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.read_latest_config_snapshots",
    run: async () => {
      seedMissingMetaEntitiesFromConfigs(aggregates, {
        campaignConfigs,
        adsetConfigs,
      });
      campaignIds = Array.from(aggregates.campaigns.keys());
      adsetIds = Array.from(aggregates.adsets.keys());
      [latestCampaignSnapshots, latestAdsetSnapshots] = await Promise.all([
        campaignIds.length > 0
          ? readLatestMetaConfigSnapshots({
              businessId: input.credentials.businessId,
              entityLevel: "campaign",
              entityIds: campaignIds,
            })
          : Promise.resolve(new Map<string, MetaConfigSnapshotPayload>()),
        adsetIds.length > 0
          ? readLatestMetaConfigSnapshots({
              businessId: input.credentials.businessId,
              entityLevel: "adset",
              entityIds: adsetIds,
            })
          : Promise.resolve(new Map<string, MetaConfigSnapshotPayload>()),
      ]);
    },
  });
  let sourceSnapshotId: string | null = latestSnapshotId;
  let adsetPayloadsByCampaign = new Map<string, MetaConfigSnapshotPayload[]>();
  let adsetRows: MetaAdSetDailyRow[] = [];
  let campaignRows: MetaCampaignDailyRow[] = [];
  let adRows: MetaAdDailyRow[] = [];
  let accountRows: MetaAccountDailyRow[] = [];
  let zeroSpendFinalizedDay = false;
  let canonicalSourceDrift:
    | {
        sourceSpend: number;
        rebuiltAccountSpend: number;
        rebuiltCampaignSpend: number;
        toleranceApplied: number;
      }
    | null = null;
  let accountProof: ReturnType<typeof createMetaFinalizationCompletenessProof> | null = null;
  let campaignProof: ReturnType<typeof createMetaFinalizationCompletenessProof> | null = null;
  let adsetProof: ReturnType<typeof createMetaFinalizationCompletenessProof> | null = null;
  let adProof: ReturnType<typeof createMetaFinalizationCompletenessProof> | null = null;
  let incompleteCampaignTruth: ReturnType<typeof collectIncompleteCampaignTruth> = [];
  let incompleteAdSetTruth: ReturnType<typeof collectIncompleteAdSetTruth> = [];
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.build_daily_rows",
    run: async () => {
      sourceSnapshotId = latestSnapshotId;
      adsetPayloadsByCampaign = new Map<string, MetaConfigSnapshotPayload[]>();
      adsetRows = Array.from(aggregates.adsets.entries()).map(([adsetId, value]): MetaAdSetDailyRow => {
        const metrics = deriveWarehouseMetrics(value);
        const campaignId = value.campaignId ?? null;
        const campaignConfig = campaignId ? campaignConfigs.get(campaignId) ?? null : null;
        const adsetConfig = adsetConfigs.get(adsetId) ?? null;
        const configPayload = buildMetaAdSetConfigPayload({
          campaignId: campaignId ?? "",
          adset: adsetConfig,
          campaignConfig,
          latestSnapshot: latestAdsetSnapshots.get(adsetId) ?? null,
          latestCampaignSnapshot: campaignId
            ? latestCampaignSnapshots.get(campaignId) ?? null
            : null,
        }).payload;
        if (campaignId) {
          const payloads = adsetPayloadsByCampaign.get(campaignId);
          if (payloads) payloads.push(configPayload);
          else adsetPayloadsByCampaign.set(campaignId, [configPayload]);
        }
        const baseRow: MetaAdSetDailyRow = {
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          date: normalizedDay,
          campaignId,
          adsetId,
          adsetNameCurrent: value.name ?? adsetConfig?.name ?? null,
          adsetNameHistorical: value.name ?? adsetConfig?.name ?? null,
          adsetStatus: adsetConfig?.effective_status ?? adsetConfig?.status ?? null,
          optimizationGoal: null,
          bidStrategyType: null,
          bidStrategyLabel: null,
          manualBidAmount: null,
          bidValue: null,
          bidValueFormat: null,
          dailyBudget: null,
          lifetimeBudget: null,
          isBudgetMixed: false,
          isConfigMixed: false,
          isOptimizationGoalMixed: false,
          isBidStrategyMixed: false,
          isBidValueMixed: false,
          accountTimezone: profile?.timezone ?? "UTC",
          accountCurrency: profile?.currency ?? input.credentials.currency,
          spend: value.spend,
          impressions: value.impressions,
          clicks: value.clicks,
          reach: value.reach || value.impressions,
          frequency: metrics.frequency,
          conversions: value.conversions,
          revenue: value.revenue,
          roas: metrics.roas,
          cpa: metrics.cpa,
          ctr: metrics.ctr,
          cpc: metrics.cpc,
          sourceSnapshotId,
          truthState,
          truthVersion: 1,
          finalizedAt,
          validationStatus,
          sourceRunId,
        };
        return applyConfigPayloadToDailyRow(baseRow, configPayload);
      });
      campaignRows = Array.from(aggregates.campaigns.entries()).map(([campaignId, value]) => {
        const metrics = deriveWarehouseMetrics(value);
        return buildMetaCampaignDailyConfigRow({
          campaignRow: {
            businessId: input.credentials.businessId,
            providerAccountId: input.accountId,
            date: normalizedDay,
            campaignId,
            campaignNameCurrent: value.name ?? null,
            campaignNameHistorical: value.name ?? null,
            campaignStatus: campaignStatuses.get(campaignId) ?? null,
            objective:
              campaignConfigs.get(campaignId)?.objective ??
              latestCampaignSnapshots.get(campaignId)?.objective ??
              null,
            buyingType: campaignConfigs.get(campaignId)?.buying_type ?? null,
            optimizationGoal: null,
            bidStrategyType: null,
            bidStrategyLabel: null,
            manualBidAmount: null,
            bidValue: null,
            bidValueFormat: null,
            dailyBudget: null,
            lifetimeBudget: null,
            isBudgetMixed: false,
            isConfigMixed: false,
            isOptimizationGoalMixed: false,
            isBidStrategyMixed: false,
            isBidValueMixed: false,
            accountTimezone: profile?.timezone ?? "UTC",
            accountCurrency: profile?.currency ?? input.credentials.currency,
            spend: value.spend,
            impressions: value.impressions,
            clicks: value.clicks,
            reach: value.reach || value.impressions,
            frequency: metrics.frequency,
            conversions: value.conversions,
            revenue: value.revenue,
            roas: metrics.roas,
            cpa: metrics.cpa,
            ctr: metrics.ctr,
            cpc: metrics.cpc,
            sourceSnapshotId,
            truthState,
            truthVersion: 1,
            finalizedAt,
            validationStatus,
            sourceRunId,
          },
          campaignConfig: campaignConfigs.get(campaignId) ?? null,
          latestCampaignSnapshot: latestCampaignSnapshots.get(campaignId) ?? null,
          adsetPayloads: adsetPayloadsByCampaign.get(campaignId) ?? [],
        });
      });
      adRows = Array.from(aggregates.ads.entries()).map(([adId, value]) => {
        const metrics = deriveWarehouseMetrics(value);
        return {
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          date: normalizedDay,
          campaignId: value.campaignId ?? null,
          adsetId: value.adsetId ?? null,
          adId,
          adNameCurrent: value.name ?? null,
          adNameHistorical: value.name ?? null,
          adStatus: null,
          accountTimezone: profile?.timezone ?? "UTC",
          accountCurrency: profile?.currency ?? input.credentials.currency,
          spend: value.spend,
          impressions: value.impressions,
          clicks: value.clicks,
          reach: value.reach || value.impressions,
          frequency: metrics.frequency,
          conversions: value.conversions,
          revenue: value.revenue,
          roas: metrics.roas,
          cpa: metrics.cpa,
          ctr: metrics.ctr,
          cpc: metrics.cpc,
          linkClicks: 0,
          sourceSnapshotId,
          payloadJson: value.payloadJson ?? null,
          truthState,
          truthVersion: 1,
          finalizedAt,
          validationStatus,
          sourceRunId,
        };
      });
      accountRows = [
        buildAccountDailyRowFromCampaignRows({
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          date: normalizedDay,
          accountName: profile?.name ?? null,
          accountTimezone: profile?.timezone ?? "UTC",
          accountCurrency: profile?.currency ?? input.credentials.currency,
          sourceSnapshotId,
          truthState,
          truthVersion: 1,
          finalizedAt,
          validationStatus,
          sourceRunId,
          campaignRows,
        }),
      ];
      zeroSpendFinalizedDay =
        truthState === "finalized" && sourceAccountSpend != null
          ? withinMetaTruthTolerance(sourceAccountSpend, 0)
          : false;
      if (truthState === "finalized") {
        const finalizedSourceAccountSpend = sourceAccountSpend ?? 0;
        const rebuiltAccountSpend = accountRows[0]?.spend ?? 0;
        const rebuiltCampaignSpend = r2(
          campaignRows.reduce((sum, row) => sum + row.spend, 0),
        );
        if (
          !withinMetaTruthTolerance(finalizedSourceAccountSpend, rebuiltAccountSpend) ||
          !withinMetaTruthTolerance(finalizedSourceAccountSpend, rebuiltCampaignSpend)
        ) {
          canonicalSourceDrift = {
            sourceSpend: finalizedSourceAccountSpend,
            rebuiltAccountSpend,
            rebuiltCampaignSpend,
            toleranceApplied: Math.max(
              0.01,
              Math.abs(finalizedSourceAccountSpend) * 0.001,
            ),
          };
          console.warn("[meta-sync] canonical_source_drift_detected", {
            businessId: input.credentials.businessId,
            providerAccountId: input.accountId,
            date: normalizedDay,
            ...canonicalSourceDrift,
          });
        }
      }
      accountProof = truthState === "finalized"
        ? createMetaFinalizationCompletenessProof({
            businessId: input.credentials.businessId,
            providerAccountId: input.accountId,
            date: normalizedDay,
            scope: "account",
            sourceRunId,
            complete: accountRows.length === 1 && (campaignRows.length > 0 || zeroSpendFinalizedDay),
            validationStatus,
          })
        : null;
      campaignProof = truthState === "finalized"
        ? createMetaFinalizationCompletenessProof({
            businessId: input.credentials.businessId,
            providerAccountId: input.accountId,
            date: normalizedDay,
            scope: "campaign",
            sourceRunId,
            complete: campaignRows.length > 0 || zeroSpendFinalizedDay,
            validationStatus,
          })
        : null;
      adsetProof = truthState === "finalized" && adsetRows.length > 0
        ? createMetaFinalizationCompletenessProof({
            businessId: input.credentials.businessId,
            providerAccountId: input.accountId,
            date: normalizedDay,
            scope: "adset",
            sourceRunId,
            complete: true,
            validationStatus,
          })
        : null;
      adProof = truthState === "finalized"
        ? createMetaFinalizationCompletenessProof({
            businessId: input.credentials.businessId,
            providerAccountId: input.accountId,
            date: normalizedDay,
            scope: "ad",
            sourceRunId,
            complete: adRows.length > 0 || zeroSpendFinalizedDay,
            validationStatus,
          })
        : null;
    },
  });
  let sourceManifestId: string | null = null;
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.create_authoritative_manifest",
    run: async () => {
      const sourceManifest =
        authoritativeFinalizationV2Enabled
          ? await createMetaAuthoritativeSourceManifest({
              businessId: input.credentials.businessId,
              providerAccountId: input.accountId,
              day: normalizedDay,
              surface: "account_daily",
              accountTimezone: profile?.timezone ?? "UTC",
              sourceKind:
                input.source ??
                (input.freshStart ? "finalize_day" : "recent"),
              sourceWindowKind: resolveMetaAuthoritativeSourceWindowKind({
                day: normalizedDay,
                referenceToday: accountToday,
                source: input.source,
              }),
              runId: sourceRunId,
              fetchStatus: "completed",
              freshStartApplied: Boolean(input.freshStart),
              checkpointResetApplied: Boolean(input.freshStart),
              rawSnapshotWatermark: sourceSnapshotId,
              sourceSpend: sourceAccountSpend,
              validationBasisVersion: "meta-authoritative-finalization-v2",
              metaJson: {
                partitionId: input.partitionId,
                workerId: input.workerId,
                restoredPageCount: restoredPages.length,
                rowsFetchedTotal,
              },
              startedAt: coreCheckpointStartedAt,
              completedAt: new Date().toISOString(),
            })
          : null;
      sourceManifestId = sourceManifest?.id ?? null;
    },
  });
  let accountSliceVersionId: string | null = null;
  let campaignSliceVersionId: string | null = null;
  let adsetSliceVersionId: string | null = null;
  let adSliceVersionId: string | null = null;
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.create_slice_versions",
    run: async () => {
      const accountSliceVersion =
        authoritativeFinalizationV2Enabled
          ? await createMetaAuthoritativeSliceVersion({
              businessId: input.credentials.businessId,
              providerAccountId: input.accountId,
              day: normalizedDay,
              surface: "account_daily",
              manifestId: sourceManifestId,
              state: "finalizing",
              truthState,
              validationStatus: "pending",
              status: "staging",
              stagedRowCount: accountRows.length,
              aggregatedSpend: accountRows[0]?.spend ?? 0,
              validationSummary: {},
              sourceRunId,
              stageStartedAt: new Date().toISOString(),
            })
          : null;
      accountSliceVersionId = accountSliceVersion?.id ?? null;
      const campaignSliceVersion =
        authoritativeFinalizationV2Enabled
          ? await createMetaAuthoritativeSliceVersion({
              businessId: input.credentials.businessId,
              providerAccountId: input.accountId,
              day: normalizedDay,
              surface: "campaign_daily",
              manifestId: sourceManifestId,
              state: "finalizing",
              truthState,
              validationStatus: "pending",
              status: "staging",
              stagedRowCount: campaignRows.length,
              aggregatedSpend: sumRowSpend(campaignRows),
              validationSummary: {},
              sourceRunId,
              stageStartedAt: new Date().toISOString(),
            })
          : null;
      campaignSliceVersionId = campaignSliceVersion?.id ?? null;
      const adsetSliceVersion =
        authoritativeFinalizationV2Enabled
          ? await createMetaAuthoritativeSliceVersion({
              businessId: input.credentials.businessId,
              providerAccountId: input.accountId,
              day: normalizedDay,
              surface: "adset_daily",
              manifestId: sourceManifestId,
              state: "finalizing",
              truthState,
              validationStatus: adsetRows.length > 0 ? "pending" : "passed",
              status: "staging",
              stagedRowCount: adsetRows.length,
              aggregatedSpend: sumRowSpend(adsetRows),
              validationSummary: {},
              sourceRunId,
              stageStartedAt: new Date().toISOString(),
            })
          : null;
      adsetSliceVersionId = adsetSliceVersion?.id ?? null;
      const adSliceVersion =
        authoritativeFinalizationV2Enabled
          ? await createMetaAuthoritativeSliceVersion({
              businessId: input.credentials.businessId,
              providerAccountId: input.accountId,
              day: normalizedDay,
              surface: "ad_daily",
              manifestId: sourceManifestId,
              state: "finalizing",
              truthState,
              validationStatus: "pending",
              status: "staging",
              stagedRowCount: adRows.length,
              aggregatedSpend: sumRowSpend(adRows),
              validationSummary: {},
              sourceRunId,
              stageStartedAt: new Date().toISOString(),
            })
          : null;
      adSliceVersionId = adSliceVersion?.id ?? null;

      incompleteCampaignTruth = collectIncompleteCampaignTruth({
        rows: campaignRows,
        campaignConfigs,
      });
      incompleteAdSetTruth = collectIncompleteAdSetTruth({
        rows: adsetRows,
        adsetConfigs,
        campaignConfigs,
      });
      if (incompleteCampaignTruth.length > 0 || incompleteAdSetTruth.length > 0) {
        if (authoritativeFinalizationV2Enabled) {
          await Promise.all([
            sourceManifestId
              ? updateMetaAuthoritativeSourceManifest({
                  manifestId: sourceManifestId,
                  fetchStatus: "failed",
                })
              : Promise.resolve(null),
            accountSliceVersionId
              ? updateMetaAuthoritativeSliceVersion({
                  sliceVersionId: accountSliceVersionId,
                  state: "failed",
                  validationStatus: "failed",
                  status: "failed",
                })
              : Promise.resolve(null),
            campaignSliceVersionId
              ? updateMetaAuthoritativeSliceVersion({
                  sliceVersionId: campaignSliceVersionId,
                  state: "failed",
                  validationStatus: "failed",
                  status: "failed",
                })
              : Promise.resolve(null),
            adsetSliceVersionId
              ? updateMetaAuthoritativeSliceVersion({
                  sliceVersionId: adsetSliceVersionId,
                  state: "failed",
                  validationStatus: "failed",
                  status: "failed",
                })
              : Promise.resolve(null),
            adSliceVersionId
              ? updateMetaAuthoritativeSliceVersion({
                  sliceVersionId: adSliceVersionId,
                  state: "failed",
                  validationStatus: "failed",
                  status: "failed",
                })
              : Promise.resolve(null),
            createMetaAuthoritativeReconciliationEvent({
              businessId: input.credentials.businessId,
              providerAccountId: input.accountId,
              day: normalizedDay,
              surface: "account_daily",
              sliceVersionId: accountSliceVersionId,
              manifestId: sourceManifestId,
              eventKind: "incomplete_truth",
              severity: "error",
              sourceSpend: sourceAccountSpend,
              warehouseAccountSpend: accountRows[0]?.spend ?? 0,
              warehouseCampaignSpend: sumRowSpend(campaignRows),
              toleranceApplied: 0.001,
              result: "failed",
              detailsJson: {
                incompleteCampaignTruth,
                incompleteAdSetTruth,
              },
            }),
          ]);
        }
        console.warn("[meta-sync] incomplete_core_truth_detected", {
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          date: normalizedDay,
          campaignCount: incompleteCampaignTruth.length,
          adsetCount: incompleteAdSetTruth.length,
          campaignSample: incompleteCampaignTruth.slice(0, 5),
          adsetSample: incompleteAdSetTruth.slice(0, 5),
        });
        throw new Error(
          `Meta core truth incomplete for ${normalizedDay}: campaigns=${incompleteCampaignTruth.length}, adsets=${incompleteAdSetTruth.length}`
        );
      }
    },
  });

  await upsertOwnedMetaCheckpointOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    checkpointScope,
    runId: sourceRunId,
    phase: "bulk_upsert",
    status: "running",
    pageIndex,
    nextPageUrl: null,
    providerCursor: null,
    rowsFetched: rowsFetchedTotal,
    rowsWritten: 0,
    lastSuccessfulEntityKey: adRows.at(-1)?.adId ?? adsetRows.at(-1)?.adsetId ?? campaignRows.at(-1)?.campaignId ?? null,
    lastResponseHeaders: checkpoint?.lastResponseHeaders ?? {},
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: coreCheckpointStartedAt,
  });

  await heartbeatOwnedMetaPartitionLeaseOrThrow({
    partitionId: input.partitionId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
  });
  try {
    await captureMetaAccountCoreSubStage({
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      partitionId: input.partitionId,
      scope: partitionScope,
      lane: partitionLane,
      source: partitionSource,
      day: normalizedDay,
      stage: "syncMetaAccountCoreWarehouseDay.write_account_daily",
      run: async () => {
        if (truthState === "finalized") {
          if (accountProof) {
            await replaceMetaAccountDailySlice({
              rows: accountRows,
              proof: accountProof,
              skipOverviewSummaryRefresh: true,
            });
          } else {
            await upsertMetaAccountDailyRows(accountRows, {
              skipOverviewSummaryRefresh: true,
            });
          }
        }
      },
    });
    await heartbeatOwnedMetaPartitionLeaseOrThrow({
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
    });
    await captureMetaAccountCoreSubStage({
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      partitionId: input.partitionId,
      scope: partitionScope,
      lane: partitionLane,
      source: partitionSource,
      day: normalizedDay,
      stage: "syncMetaAccountCoreWarehouseDay.write_campaign_daily",
      run: async () => {
        if (truthState === "finalized") {
          if (campaignProof) {
            await replaceMetaCampaignDailySlice({ rows: campaignRows, proof: campaignProof });
          } else {
            await upsertMetaCampaignDailyRows(campaignRows);
          }
        }
      },
    });
    await heartbeatOwnedMetaPartitionLeaseOrThrow({
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
    });
    await captureMetaAccountCoreSubStage({
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      partitionId: input.partitionId,
      scope: partitionScope,
      lane: partitionLane,
      source: partitionSource,
      day: normalizedDay,
      stage: "syncMetaAccountCoreWarehouseDay.write_adset_daily",
      run: async () => {
        if (truthState === "finalized") {
          if (adsetProof) {
            await replaceMetaAdSetDailySlice({ rows: adsetRows, proof: adsetProof });
          } else if (adsetRows.length > 0) {
            await upsertMetaAdSetDailyRows(adsetRows);
          }
        }
      },
    });
    await heartbeatOwnedMetaPartitionLeaseOrThrow({
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
    });
    await captureMetaAccountCoreSubStage({
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      partitionId: input.partitionId,
      scope: partitionScope,
      lane: partitionLane,
      source: partitionSource,
      day: normalizedDay,
      stage: "syncMetaAccountCoreWarehouseDay.write_ad_daily",
      run: async () => {
        if (truthState === "finalized") {
          if (adProof) {
            await replaceMetaAdDailySlice({ rows: adRows, proof: adProof });
          } else if (adRows.length > 0) {
            await upsertMetaAdDailyRows(adRows);
          }
        }
      },
    });
  } catch (error) {
    if (authoritativeFinalizationV2Enabled) {
      await Promise.all([
        sourceManifestId
          ? updateMetaAuthoritativeSourceManifest({
              manifestId: sourceManifestId,
              fetchStatus: "failed",
            })
          : Promise.resolve(null),
        accountSliceVersionId
          ? updateMetaAuthoritativeSliceVersion({
              sliceVersionId: accountSliceVersionId,
              state: "failed",
              validationStatus: "failed",
              status: "failed",
            })
          : Promise.resolve(null),
        campaignSliceVersionId
          ? updateMetaAuthoritativeSliceVersion({
              sliceVersionId: campaignSliceVersionId,
              state: "failed",
              validationStatus: "failed",
              status: "failed",
            })
          : Promise.resolve(null),
        adsetSliceVersionId
          ? updateMetaAuthoritativeSliceVersion({
              sliceVersionId: adsetSliceVersionId,
              state: "failed",
              validationStatus: "failed",
              status: "failed",
            })
          : Promise.resolve(null),
        adSliceVersionId
          ? updateMetaAuthoritativeSliceVersion({
              sliceVersionId: adSliceVersionId,
              state: "failed",
              validationStatus: "failed",
              status: "failed",
            })
          : Promise.resolve(null),
        createMetaAuthoritativeReconciliationEvent({
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          day: normalizedDay,
          surface: "account_daily",
          sliceVersionId: accountSliceVersionId,
          manifestId: sourceManifestId,
          eventKind: "publish_failed",
          severity: "error",
          sourceSpend: sourceAccountSpend,
          warehouseAccountSpend: accountRows[0]?.spend ?? 0,
          warehouseCampaignSpend: sumRowSpend(campaignRows),
          toleranceApplied: 0.001,
          result: "failed",
          detailsJson: {
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      ]);
    }
    throw error;
  }
  await heartbeatOwnedMetaPartitionLeaseOrThrow({
    partitionId: input.partitionId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
  });
  let persistedCampaignConfigCount = 0;
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.persist_campaign_config_snapshots",
    run: async () => {
      persistedCampaignConfigCount =
        truthState === "finalized"
          ? await persistMetaCampaignConfigSnapshots({
              businessId: input.credentials.businessId,
              accountId: input.accountId,
              campaignConfigs,
              entityIds: campaignRows.map((row) => row.campaignId),
            })
          : 0;
    },
  });
  if (truthState === "finalized" && campaignRows.length > 0 && persistedCampaignConfigCount === 0) {
    console.warn("[meta-config-snapshots] campaign_config_snapshots_missing", {
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      date: normalizedDay,
      campaignRowCount: campaignRows.length,
      fetchedCampaignConfigCount: campaignConfigs.size,
    });
  }
  let adsetSnapshotRows: Array<{
    businessId: string;
    accountId: string;
    entityLevel: "adset";
    entityId: string;
    payload: MetaConfigSnapshotPayload;
  }> = [];
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.append_adset_config_snapshots",
    run: async () => {
      adsetSnapshotRows = adsetRows
        .map((row) => {
          const campaignConfig =
            row.campaignId != null ? campaignConfigs.get(row.campaignId) ?? null : null;
          const adsetConfig = adsetConfigs.get(row.adsetId) ?? null;
          if (!adsetConfig && !campaignConfig) return null;
          return {
            businessId: input.credentials.businessId,
            accountId: input.accountId,
            entityLevel: "adset" as const,
            entityId: row.adsetId,
            payload: buildMetaAdSetConfigPayload({
              campaignId: row.campaignId ?? "",
              adset: adsetConfig,
              campaignConfig,
            }).payload,
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
      if (truthState === "finalized" && adsetSnapshotRows.length > 0) {
        await appendMetaConfigSnapshots(adsetSnapshotRows);
      }
    },
  });
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.refresh_overview_summary",
    run: async () => {
      if (truthState === "finalized" && accountRows.length > 0) {
        await refreshMetaAccountDailyOverviewSummary(accountRows);
      }
    },
  });
  const bulkRowsWritten =
    (truthState === "finalized"
      ? accountRows.length + campaignRows.length + adsetRows.length + adRows.length
      : 0) +
    persistedCampaignConfigCount +
    (truthState === "finalized" ? adsetSnapshotRows.length : 0);
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: bulkUpsertTimingScope,
    runId: sourceRunId,
    phase: "bulk_upsert",
    status: "succeeded",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: bulkRowsWritten,
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: bulkUpsertStartedAt,
    finishedAt: new Date().toISOString(),
  });
  await heartbeatOwnedMetaPartitionLeaseOrThrow({
    partitionId: input.partitionId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
  });
  if (authoritativeFinalizationV2Enabled) {
    const publishStartedAt = new Date().toISOString();
    await upsertOwnedMetaPhaseTimingOrThrow({
      partitionId: input.partitionId,
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      timingScope: publishTimingScope,
      runId: sourceRunId,
      phase: "publish",
      status: "running",
      rowsFetched: rowsFetchedTotal,
      rowsWritten: 0,
      attemptCount: input.attemptCount,
      leaseEpoch: input.leaseEpoch,
      leaseOwner: input.workerId,
      startedAt: publishStartedAt,
    });
    const accountSpend = accountRows[0]?.spend ?? 0;
    const campaignSpend = sumRowSpend(campaignRows);
    const driftForEvent = canonicalSourceDrift as {
      sourceSpend: number;
      rebuiltAccountSpend: number;
      rebuiltCampaignSpend: number;
      toleranceApplied: number;
    } | null;
    const reconciliationEventInput = driftForEvent != null
      ? (() => {
          const drift = driftForEvent;
          return {
            businessId: input.credentials.businessId,
            providerAccountId: input.accountId,
            day: normalizedDay,
            surface: "account_daily" as const,
            sliceVersionId: accountSliceVersionId,
            manifestId: sourceManifestId,
            eventKind: "totals_mismatch" as const,
            severity: "error" as const,
            sourceSpend: drift.sourceSpend,
            warehouseAccountSpend: drift.rebuiltAccountSpend,
            warehouseCampaignSpend: drift.rebuiltCampaignSpend,
            toleranceApplied: drift.toleranceApplied,
            result: "repair_required" as const,
            detailsJson: {
              sourceSpend: drift.sourceSpend,
              rebuiltAccountSpend: drift.rebuiltAccountSpend,
              rebuiltCampaignSpend: drift.rebuiltCampaignSpend,
              toleranceApplied: drift.toleranceApplied,
              zeroSpendFinalizedDay,
              canonicalPublished: true,
            },
          };
        })()
      : {
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          day: normalizedDay,
          surface: "account_daily" as const,
          sliceVersionId: accountSliceVersionId,
          manifestId: sourceManifestId,
          eventKind: "validation_passed" as const,
          severity: "info" as const,
          sourceSpend: sourceAccountSpend,
          warehouseAccountSpend: accountSpend,
          warehouseCampaignSpend: campaignSpend,
          toleranceApplied: Math.max(
            0.01,
            Math.abs(Number(sourceAccountSpend ?? 0)) * 0.001,
          ),
          result: "passed" as const,
          detailsJson: {
            zeroSpendFinalizedDay,
          },
        };
    await Promise.all([
      sourceManifestId
        ? updateMetaAuthoritativeSourceManifest({
            manifestId: sourceManifestId,
            fetchStatus: "completed",
            sourceSpend: sourceAccountSpend,
          })
        : Promise.resolve(null),
      accountSliceVersionId
          ? updateMetaAuthoritativeSliceVersion({
              sliceVersionId: accountSliceVersionId,
              state: "finalized_verified",
              validationStatus: "passed",
              status: "validated",
              stageCompletedAt: new Date().toISOString(),
              validationSummary: {
                sourceSpend: sourceAccountSpend,
                rebuiltAccountSpend: accountSpend,
                rebuiltCampaignSpend: campaignSpend,
                sourceDriftDetected: Boolean(canonicalSourceDrift),
                sourceDrift: canonicalSourceDrift,
              },
            })
        : Promise.resolve(null),
      campaignSliceVersionId
        ? updateMetaAuthoritativeSliceVersion({
            sliceVersionId: campaignSliceVersionId,
            state: "finalized_verified",
            validationStatus: "passed",
            status: "validated",
            stageCompletedAt: new Date().toISOString(),
            validationSummary: {
              sourceSpend: sourceAccountSpend,
              rebuiltCampaignSpend: campaignSpend,
              sourceDriftDetected: Boolean(canonicalSourceDrift),
              sourceDrift: canonicalSourceDrift,
            },
          })
        : Promise.resolve(null),
      adsetSliceVersionId
        ? updateMetaAuthoritativeSliceVersion({
            sliceVersionId: adsetSliceVersionId,
            state: "finalized_verified",
            validationStatus: adsetRows.length > 0 ? "passed" : "passed",
            status: "validated",
            stageCompletedAt: new Date().toISOString(),
            validationSummary: {
              sourceSpend: sourceAccountSpend,
              rebuiltAdsetSpend: sumRowSpend(adsetRows),
              sourceDriftDetected: Boolean(canonicalSourceDrift),
              sourceDrift: canonicalSourceDrift,
            },
          })
        : Promise.resolve(null),
      adSliceVersionId
        ? updateMetaAuthoritativeSliceVersion({
            sliceVersionId: adSliceVersionId,
            state: "finalized_verified",
            validationStatus: "passed",
            status: "validated",
            stageCompletedAt: new Date().toISOString(),
            validationSummary: {
              sourceSpend: sourceAccountSpend,
              rebuiltAdSpend: sumRowSpend(adRows),
              sourceDriftDetected: Boolean(canonicalSourceDrift),
              sourceDrift: canonicalSourceDrift,
            },
          })
        : Promise.resolve(null),
      createMetaAuthoritativeReconciliationEvent(reconciliationEventInput),
    ]);

    if (accountSliceVersionId) {
      await publishMetaAuthoritativeSliceVersion({
        businessId: input.credentials.businessId,
        providerAccountId: input.accountId,
        day: normalizedDay,
        surface: "account_daily",
        sliceVersionId: accountSliceVersionId,
        publishedByRunId: sourceRunId,
        publicationReason: input.freshStart ? "authoritative_refresh" : "authoritative_finalize",
        publishStartedAt,
      });
    }
    if (campaignSliceVersionId) {
      await publishMetaAuthoritativeSliceVersion({
        businessId: input.credentials.businessId,
        providerAccountId: input.accountId,
        day: normalizedDay,
        surface: "campaign_daily",
        sliceVersionId: campaignSliceVersionId,
        publishedByRunId: sourceRunId,
        publicationReason: input.freshStart ? "authoritative_refresh" : "authoritative_finalize",
        publishStartedAt,
      });
    }
    if (adsetSliceVersionId) {
      await publishMetaAuthoritativeSliceVersion({
        businessId: input.credentials.businessId,
        providerAccountId: input.accountId,
        day: normalizedDay,
        surface: "adset_daily",
        sliceVersionId: adsetSliceVersionId,
        publishedByRunId: sourceRunId,
        publicationReason: input.freshStart ? "authoritative_refresh" : "authoritative_finalize",
        publishStartedAt,
      });
    }
    if (adSliceVersionId) {
      await publishMetaAuthoritativeSliceVersion({
        businessId: input.credentials.businessId,
        providerAccountId: input.accountId,
        day: normalizedDay,
        surface: "ad_daily",
        sliceVersionId: adSliceVersionId,
        publishedByRunId: sourceRunId,
        publicationReason: input.freshStart ? "authoritative_refresh" : "authoritative_finalize",
        publishStartedAt,
      });
    }
    const publishedSurfaceCount = [
      accountSliceVersionId,
      campaignSliceVersionId,
      adsetSliceVersionId,
      adSliceVersionId,
    ].filter(Boolean).length;
    await upsertOwnedMetaPhaseTimingOrThrow({
      partitionId: input.partitionId,
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      timingScope: publishTimingScope,
      runId: sourceRunId,
      phase: "publish",
      status: "succeeded",
      rowsFetched: rowsFetchedTotal,
      rowsWritten: publishedSurfaceCount,
      attemptCount: input.attemptCount,
      leaseEpoch: input.leaseEpoch,
      leaseOwner: input.workerId,
      startedAt: publishStartedAt,
      finishedAt: new Date().toISOString(),
    });
  }

  let positiveSpendAdIds: string[] = [];
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.finalize_phase_timings",
    run: async () => {
      const finalizeStartedAt = new Date().toISOString();
      await upsertOwnedMetaPhaseTimingOrThrow({
        partitionId: input.partitionId,
        businessId: input.credentials.businessId,
        providerAccountId: input.accountId,
        timingScope: finalizeTimingScope,
        runId: sourceRunId,
        phase: "finalize",
        status: "running",
        rowsFetched: rowsFetchedTotal,
        rowsWritten: 0,
        attemptCount: input.attemptCount,
        leaseEpoch: input.leaseEpoch,
        leaseOwner: input.workerId,
        startedAt: finalizeStartedAt,
      });
      const [accountDailyCheckpoint, adsetDailyCheckpoint, adDailyCheckpoint] = await Promise.all([
        getMetaSyncCheckpoint({
          partitionId: input.partitionId,
          checkpointScope: "account_daily",
          runId: sourceRunId,
        }),
        getMetaSyncCheckpoint({
          partitionId: input.partitionId,
          checkpointScope: "adset_daily",
          runId: sourceRunId,
        }),
        getMetaSyncCheckpoint({
          partitionId: input.partitionId,
          checkpointScope: "ad_daily",
          runId: sourceRunId,
        }),
      ]);

      await heartbeatOwnedMetaPartitionLeaseOrThrow({
        partitionId: input.partitionId,
        workerId: input.workerId,
        leaseEpoch: input.leaseEpoch,
        leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
      });
      await Promise.all([
        upsertOwnedMetaCheckpointOrThrow({
          partitionId: input.partitionId,
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          checkpointScope: "account_daily",
          runId: sourceRunId,
          phase: "finalize",
          status: "succeeded",
          pageIndex,
          nextPageUrl: null,
          providerCursor: null,
          rowsFetched: rowsFetchedTotal,
          rowsWritten: truthState === "finalized" ? accountRows.length : 0,
          lastSuccessfulEntityKey: null,
          lastResponseHeaders: checkpoint?.lastResponseHeaders ?? {},
          attemptCount: input.attemptCount,
          leaseEpoch: input.leaseEpoch,
          leaseOwner: input.workerId,
          startedAt: accountDailyCheckpoint?.startedAt ?? coreCheckpointStartedAt,
          finishedAt: new Date().toISOString(),
        }),
        upsertOwnedMetaCheckpointOrThrow({
          partitionId: input.partitionId,
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          checkpointScope: "ad_daily",
          runId: sourceRunId,
          phase: "finalize",
          status: "succeeded",
          pageIndex,
          nextPageUrl: null,
          providerCursor: null,
          rowsFetched: rowsFetchedTotal,
          rowsWritten: truthState === "finalized" ? adRows.length : 0,
          lastSuccessfulEntityKey: adRows.at(-1)?.adId ?? null,
          lastResponseHeaders: checkpoint?.lastResponseHeaders ?? {},
          attemptCount: input.attemptCount,
          leaseEpoch: input.leaseEpoch,
          leaseOwner: input.workerId,
          startedAt: adDailyCheckpoint?.startedAt ?? coreCheckpointStartedAt,
          finishedAt: new Date().toISOString(),
        }),
        upsertOwnedMetaCheckpointOrThrow({
          partitionId: input.partitionId,
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          checkpointScope: "adset_daily",
          runId: sourceRunId,
          phase: "finalize",
          status: "succeeded",
          pageIndex,
          nextPageUrl: null,
          providerCursor: null,
          rowsFetched: rowsFetchedTotal,
          rowsWritten: truthState === "finalized" ? adsetRows.length : 0,
          lastSuccessfulEntityKey: adsetRows.at(-1)?.adsetId ?? null,
          lastResponseHeaders: checkpoint?.lastResponseHeaders ?? {},
          attemptCount: input.attemptCount,
          leaseEpoch: input.leaseEpoch,
          leaseOwner: input.workerId,
          startedAt: adsetDailyCheckpoint?.startedAt ?? coreCheckpointStartedAt,
          finishedAt: new Date().toISOString(),
        }),
      ]);
      positiveSpendAdIds = adRows.filter((row) => row.spend > 0).map((row) => row.adId);
      await heartbeatOwnedMetaPartitionLeaseOrThrow({
        partitionId: input.partitionId,
        workerId: input.workerId,
        leaseEpoch: input.leaseEpoch,
        leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
      });
      await upsertOwnedMetaCheckpointOrThrow({
        partitionId: input.partitionId,
        businessId: input.credentials.businessId,
        providerAccountId: input.accountId,
        checkpointScope,
        runId: sourceRunId,
        phase: "finalize",
        status: "succeeded",
        pageIndex,
        nextPageUrl: null,
        providerCursor: null,
        rowsFetched: rowsFetchedTotal,
        rowsWritten: accountRows.length + campaignRows.length + adsetRows.length + adRows.length,
        lastSuccessfulEntityKey: positiveSpendAdIds.at(-1) ?? adRows.at(-1)?.adId ?? null,
        lastResponseHeaders: checkpoint?.lastResponseHeaders ?? {},
        attemptCount: input.attemptCount,
        leaseEpoch: input.leaseEpoch,
        leaseOwner: input.workerId,
        startedAt: coreCheckpointStartedAt,
        finishedAt: new Date().toISOString(),
      });
      await upsertOwnedMetaPhaseTimingOrThrow({
        partitionId: input.partitionId,
        businessId: input.credentials.businessId,
        providerAccountId: input.accountId,
        timingScope: finalizeTimingScope,
        runId: sourceRunId,
        phase: "finalize",
        status: "succeeded",
        rowsFetched: rowsFetchedTotal,
        rowsWritten: 4,
        attemptCount: input.attemptCount,
        leaseEpoch: input.leaseEpoch,
        leaseOwner: input.workerId,
        startedAt: finalizeStartedAt,
        finishedAt: new Date().toISOString(),
      });
    },
  });
  const oversizeWarning = maxRowsBuffered >= META_MEMORY_FLUSH_THRESHOLD_ROWS;
  if (oversizeWarning) {
    console.warn("[meta-sync] core_memory_threshold_reached", {
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      partitionId: input.partitionId,
      maxHeapUsedBytes,
      maxRowsBuffered,
      flushThresholdRows: META_MEMORY_FLUSH_THRESHOLD_ROWS,
    });
  }

  return {
    accountRowsWritten: accountRows.length,
    campaignRowsWritten: campaignRows.length,
    adsetRowsWritten: adsetRows.length,
    adRowsWritten: adRows.length,
    positiveSpendAdIds,
    pageCount: pageIndex,
    restoredPageCount: restoredPages.length,
    throttleCount,
    lastUsagePercent,
    memoryInstrumentation: {
      maxHeapUsedBytes,
      maxRowsBuffered,
      flushThresholdRows: META_MEMORY_FLUSH_THRESHOLD_ROWS,
      oversizeWarning,
    },
    incompleteTruthCounts: {
      campaigns: incompleteCampaignTruth.length,
      adsets: incompleteAdSetTruth.length,
    },
  };
}

function getMetaBreakdownTypeFromInput(
  breakdowns: string,
): "age" | "country" | "placement" {
  if (breakdowns === "breakdown_age" || breakdowns === "age,gender") return "age";
  if (breakdowns === "breakdown_country" || breakdowns === "country") return "country";
  return "placement";
}

function buildMetaBreakdownIdentity(
  breakdownType: "age" | "country" | "placement",
  row: RawBreakdownInsight,
) {
  if (breakdownType === "age") {
    const age = String(row.age ?? "unknown");
    return { breakdownKey: age, breakdownLabel: age };
  }
  if (breakdownType === "country") {
    const country = String(row.country ?? "unknown");
    return { breakdownKey: country, breakdownLabel: country };
  }
  const parts = [row.publisher_platform, row.platform_position, row.impression_device]
    .filter(Boolean)
    .map((value) => String(value));
  const label = parts.join(" • ") || "Unknown";
  const key = parts.join("|") || "unknown";
  return { breakdownKey: key, breakdownLabel: label };
}

function buildMetaBreakdownDailyRows(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  accountCurrency: string;
  breakdownType: "age" | "country" | "placement";
  rows: RawBreakdownInsight[];
  sourceRunId: string;
}) {
  const byKey = new Map<string, {
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
    breakdownLabel: string;
  }>();
  for (const row of input.rows) {
    const identity = buildMetaBreakdownIdentity(input.breakdownType, row);
    const metrics = buildMetrics({
      spend_str: row.spend,
      ctr_str: row.ctr,
      impressions_str: row.impressions,
      clicks_str: row.clicks,
      actions: row.actions,
      action_values: row.action_values,
      purchase_roas: row.purchase_roas,
    });
    const existing = byKey.get(identity.breakdownKey);
    if (existing) {
      existing.spend = r2(existing.spend + metrics.spend);
      existing.impressions += metrics.impressions;
      existing.clicks += metrics.clicks;
      existing.conversions += metrics.purchases;
      existing.revenue = r2(existing.revenue + metrics.revenue);
      existing.roas = existing.spend > 0 ? r2(existing.revenue / existing.spend) : 0;
      existing.cpa = existing.conversions > 0 ? r2(existing.spend / existing.conversions) : null;
      existing.ctr = existing.impressions > 0 ? r2((existing.clicks / existing.impressions) * 100) : null;
      existing.cpc = existing.clicks > 0 ? r2(existing.spend / existing.clicks) : null;
    } else {
      byKey.set(identity.breakdownKey, {
        breakdownLabel: identity.breakdownLabel,
        spend: metrics.spend,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        reach: 0,
        frequency: null,
        conversions: metrics.purchases,
        revenue: metrics.revenue,
        roas: metrics.roas,
        cpa: metrics.cpa || null,
        ctr: metrics.ctr || null,
        cpc: metrics.clicks > 0 ? r2(metrics.spend / metrics.clicks) : null,
      });
    }
  }
  return Array.from(byKey.entries()).map(([breakdownKey, metrics]) => ({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    date: input.date,
    breakdownType: input.breakdownType,
    breakdownKey,
    breakdownLabel: metrics.breakdownLabel,
    accountTimezone: input.accountTimezone,
    accountCurrency: input.accountCurrency,
    spend: metrics.spend,
    impressions: metrics.impressions,
    clicks: metrics.clicks,
    reach: metrics.reach,
    frequency: metrics.frequency,
    conversions: metrics.conversions,
    revenue: metrics.revenue,
    roas: metrics.roas,
    cpa: metrics.cpa,
    ctr: metrics.ctr,
    cpc: metrics.cpc,
    sourceSnapshotId: null,
    truthState: "finalized" as const,
    truthVersion: 1,
    finalizedAt: new Date().toISOString(),
    validationStatus: "passed" as const,
    sourceRunId: input.sourceRunId,
  }));
}

export async function syncMetaAccountBreakdownWarehouseDay(input: {
  credentials: MetaCredentials;
  accountId: string;
  day: string;
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  attemptCount: number;
  breakdowns: string;
  endpointName: string;
  positiveSpendAdIds: string[];
  source?: string;
  publishAuthoritativeSurface?: boolean;
  referenceToday?: string | null;
  leaseMinutes?: number;
}) {
  const normalizedDay = normalizeMetaApiDate(input.day);
  const checkpointScope = `breakdown:${input.breakdowns}`;
  const sourceRunId = input.partitionId;
  const profile = input.credentials.accountProfiles[input.accountId];
  const authoritativeFinalizationV2Enabled =
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(
      input.credentials.businessId,
    );
  const referenceToday =
    normalizeMetaApiDate(
      input.referenceToday ??
        getTodayIsoForTimeZone(profile?.timezone ?? null),
    );
  const restoredRows: RawBreakdownInsight[] = [];
  const checkpoint = await getMetaSyncCheckpoint({
    partitionId: input.partitionId,
    checkpointScope,
    runId: sourceRunId,
  });
  let nextPageUrl: string | null =
    checkpoint?.nextPageUrl ??
    buildMetaBreakdownInsightsUrl({
      accountId: input.accountId,
      accessToken: input.credentials.accessToken,
      since: normalizedDay,
      until: normalizedDay,
      breakdowns: input.breakdowns,
      positiveSpendAdIds: input.positiveSpendAdIds,
    });
  let pageIndex = checkpoint?.pageIndex ?? 0;
  let rowsFetchedTotal = checkpoint?.rowsFetched ?? 0;
  const fetchTimingScope = buildMetaPhaseTimingScope({
    phase: "fetch_raw",
    scope: checkpointScope,
  });
  const bulkUpsertTimingScope = buildMetaPhaseTimingScope({
    phase: "bulk_upsert",
    scope: checkpointScope,
  });
  const finalizeTimingScope = buildMetaPhaseTimingScope({
    phase: "finalize",
    scope: checkpointScope,
  });
  const fetchStartedAt = checkpoint?.startedAt ?? new Date().toISOString();

  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: fetchTimingScope,
    runId: sourceRunId,
    phase: "fetch_raw",
    status: "running",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: 0,
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: fetchStartedAt,
  });

  while (nextPageUrl) {
    await heartbeatOwnedMetaPartitionLeaseOrThrow({
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
    });
    const fetchHeartbeat = startMetaFetchHeartbeat({
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
    });
    let pageResult: {
      response: Response;
      json: MetaGraphCollectionResponse<RawBreakdownInsight> & { error?: { message?: string } };
    };
    try {
      pageResult = await fetchMetaPagedJson<RawBreakdownInsight>(nextPageUrl);
    } finally {
      clearInterval(fetchHeartbeat);
    }
    const response = pageResult.response;
    const json = pageResult.json;
    const usageSummary = parseMetaBusinessUsageHeader(response.headers);
    const rows = json.data ?? [];
    const checkpointId = await upsertOwnedMetaCheckpointOrThrow({
      partitionId: input.partitionId,
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      checkpointScope,
      runId: sourceRunId,
      phase: "fetch_raw",
      status: "running",
      pageIndex,
      nextPageUrl: json.paging?.next ?? null,
      providerCursor: json.paging?.next ?? null,
      rowsFetched: rowsFetchedTotal + rows.length,
      rowsWritten: 0,
      lastSuccessfulEntityKey: null,
      lastResponseHeaders: {
        "x-business-use-case-usage": usageSummary.raw,
      },
      attemptCount: input.attemptCount,
      leaseEpoch: input.leaseEpoch,
      leaseOwner: input.workerId,
      startedAt: fetchStartedAt,
    });
    await upsertOwnedMetaPhaseTimingOrThrow({
      partitionId: input.partitionId,
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      timingScope: fetchTimingScope,
      runId: sourceRunId,
      phase: "fetch_raw",
      status: "running",
      rowsFetched: rowsFetchedTotal + rows.length,
      rowsWritten: 0,
      attemptCount: input.attemptCount,
      leaseEpoch: input.leaseEpoch,
      leaseOwner: input.workerId,
      startedAt: fetchStartedAt,
    });
    await recordMetaRawSnapshot({
      credentials: input.credentials,
      accountId: input.accountId,
      endpointName: input.endpointName,
      entityScope: "ad_breakdown",
      since: normalizedDay,
      until: normalizedDay,
      payload: rows,
      status: "fetched",
      providerHttpStatus: response.status,
      requestContext: {
        level: "ad",
        breakdowns: input.breakdowns,
        source: "bulk_breakdown_sync",
        pageIndex,
        filteredSpendAds: input.positiveSpendAdIds.length > 0 && input.positiveSpendAdIds.length <= 200,
      },
      partitionId: input.partitionId,
      checkpointId,
      runId: sourceRunId,
      pageIndex,
      providerCursor: json.paging?.next ?? null,
      responseHeaders: {
        "x-business-use-case-usage": usageSummary.raw,
      },
    });
    restoredRows.push(...rows);
    nextPageUrl = json.paging?.next ?? null;
    rowsFetchedTotal += rows.length;
    pageIndex += 1;
    if (usageSummary.maxPercent >= META_USAGE_THROTTLE_THRESHOLD && nextPageUrl) {
      await sleep(META_USAGE_THROTTLE_SLEEP_MS);
    }
  }
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: fetchTimingScope,
    runId: sourceRunId,
    phase: "fetch_raw",
    status: "succeeded",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: 0,
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: fetchStartedAt,
    finishedAt: new Date().toISOString(),
  });

  const breakdownType = getMetaBreakdownTypeFromInput(input.breakdowns);
  const breakdownRows = buildMetaBreakdownDailyRows({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    date: normalizedDay,
    accountTimezone: profile?.timezone ?? "UTC",
    accountCurrency: profile?.currency ?? input.credentials.currency,
    breakdownType,
    rows: restoredRows,
    sourceRunId,
  });
  const breakdownProof = createMetaFinalizationCompletenessProof({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    date: normalizedDay,
    scope: "breakdown",
    sourceRunId,
    complete: true,
    validationStatus: "passed",
  });
  const bulkUpsertStartedAt = new Date().toISOString();
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: bulkUpsertTimingScope,
    runId: sourceRunId,
    phase: "bulk_upsert",
    status: "running",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: 0,
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: bulkUpsertStartedAt,
  });
  await replaceMetaBreakdownDailySlice({
    slice: {
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      date: normalizedDay,
      breakdownType,
    },
    rows: breakdownRows,
    proof: breakdownProof,
  });
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: bulkUpsertTimingScope,
    runId: sourceRunId,
    phase: "bulk_upsert",
    status: "succeeded",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: breakdownRows.length,
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: bulkUpsertStartedAt,
    finishedAt: new Date().toISOString(),
  });
  const finalizeStartedAt = new Date().toISOString();
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: finalizeTimingScope,
    runId: sourceRunId,
    phase: "finalize",
    status: "running",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: 0,
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: finalizeStartedAt,
  });
  await upsertOwnedMetaCheckpointOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    checkpointScope,
    runId: sourceRunId,
    phase: "finalize",
    status: "succeeded",
    pageIndex,
    nextPageUrl: null,
    providerCursor: null,
    rowsFetched: rowsFetchedTotal,
    rowsWritten: breakdownRows.length,
    lastSuccessfulEntityKey: null,
    lastResponseHeaders: checkpoint?.lastResponseHeaders ?? {},
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: fetchStartedAt,
    finishedAt: new Date().toISOString(),
  });
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: finalizeTimingScope,
    runId: sourceRunId,
    phase: "finalize",
    status: "succeeded",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: 1,
    attemptCount: input.attemptCount,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: finalizeStartedAt,
    finishedAt: new Date().toISOString(),
  });

  if (input.publishAuthoritativeSurface) {
    await publishMetaBreakdownAuthoritativeSurface({
      credentials: input.credentials,
      accountId: input.accountId,
      day: normalizedDay,
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      endpointName: input.endpointName,
      source: input.source,
      referenceToday,
      leaseMinutes: input.leaseMinutes,
      startedAt: checkpoint?.startedAt ?? new Date().toISOString(),
      runId: sourceRunId,
      attemptCount: input.attemptCount,
    });
  }
}

export async function publishMetaBreakdownAuthoritativeSurface(input: {
  credentials: MetaCredentials;
  accountId: string;
  day: string;
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  endpointName: string;
  source?: string;
  referenceToday?: string | null;
  leaseMinutes?: number;
  startedAt?: string;
  runId?: string;
  attemptCount?: number;
}) {
  const normalizedDay = normalizeMetaApiDate(input.day);
  const profile = input.credentials.accountProfiles[input.accountId];
  const authoritativeFinalizationV2Enabled =
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(
      input.credentials.businessId,
    );
  const referenceToday = normalizeMetaApiDate(
    input.referenceToday ?? getTodayIsoForTimeZone(profile?.timezone ?? null),
  );
  if (!authoritativeFinalizationV2Enabled || normalizedDay >= referenceToday) {
    return {
      published: false,
      stagedRowCount: 0,
    };
  }

  await heartbeatOwnedMetaPartitionLeaseOrThrow({
    partitionId: input.partitionId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    leaseMinutes: input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
  });

  const sourceRunId = input.runId ?? input.partitionId;
  const startedAt = input.startedAt ?? new Date().toISOString();
  const publishTimingStartedAt = new Date().toISOString();
  const publishTimingScope = buildMetaPhaseTimingScope({
    phase: "publish",
    scope: "breakdown_daily",
  });
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: publishTimingScope,
    runId: sourceRunId,
    phase: "publish",
    status: "running",
    rowsFetched: 0,
    rowsWritten: 0,
    attemptCount: input.attemptCount ?? 0,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: publishTimingStartedAt,
  });
  const sourceManifest = await createMetaAuthoritativeSourceManifest({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    day: normalizedDay,
    surface: "breakdown_daily",
    accountTimezone: profile?.timezone ?? "UTC",
    sourceKind: input.source ?? "repair_recent_day",
    sourceWindowKind: resolveMetaAuthoritativeSourceWindowKind({
      day: normalizedDay,
      referenceToday,
      source: input.source,
    }),
    runId: sourceRunId,
    fetchStatus: "completed",
    freshStartApplied: false,
    checkpointResetApplied: false,
    rawSnapshotWatermark: sourceRunId,
    sourceSpend: null,
    validationBasisVersion: "meta-authoritative-finalization-v2",
    metaJson: {
      partitionId: input.partitionId,
      workerId: input.workerId,
      endpointName: input.endpointName,
      breakdownSurface: "full",
    },
    startedAt,
    completedAt: new Date().toISOString(),
  });
  const totalBreakdownRows = (
    await getDb()`
      SELECT COUNT(*)::int AS count
      FROM meta_breakdown_daily
      WHERE business_id = ${input.credentials.businessId}
        AND provider_account_id = ${input.accountId}
        AND date = ${normalizedDay}
    `
  ) as Array<{ count: number | string }>;
  const stagedRowCount = Number(totalBreakdownRows[0]?.count ?? 0);
  const breakdownSliceVersion = await createMetaAuthoritativeSliceVersion({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    day: normalizedDay,
    surface: "breakdown_daily",
    manifestId: sourceManifest?.id ?? null,
    state: "finalizing",
    truthState: "finalized",
    validationStatus: "pending",
    status: "staging",
    stagedRowCount,
    aggregatedSpend: null,
    validationSummary: {
      publishedAsSurface: true,
      breakdownTypes: ["age", "country", "placement"],
    },
    sourceRunId,
    stageStartedAt: startedAt,
  });
  if (breakdownSliceVersion?.id) {
    await publishMetaAuthoritativeSliceVersion({
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      day: normalizedDay,
      surface: "breakdown_daily",
      sliceVersionId: breakdownSliceVersion.id,
      publishedByRunId: sourceRunId,
      publicationReason: "authoritative_finalize",
      publishStartedAt: publishTimingStartedAt,
    });
  }
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: publishTimingScope,
    runId: sourceRunId,
    phase: "publish",
    status: "succeeded",
    rowsFetched: stagedRowCount,
    rowsWritten: breakdownSliceVersion?.id ? 1 : 0,
    attemptCount: input.attemptCount ?? 0,
    leaseEpoch: input.leaseEpoch,
    leaseOwner: input.workerId,
    startedAt: publishTimingStartedAt,
    finishedAt: new Date().toISOString(),
  });

  return {
    published: Boolean(breakdownSliceVersion?.id),
    stagedRowCount,
  };
}

// ── Time breakdown (for reports) ──────────────────────────────────────────────

export interface MetaTimeBreakdownRow extends MetaMetricsData {
  date: string; // "YYYY-MM-DD"
}

export async function getCampaignTimeBreakdown(
  credentials: MetaCredentials,
  since: string,
  until: string,
  dimension: "day" | "week" | "month"
): Promise<MetaTimeBreakdownRow[]> {
  const timeIncrement =
    dimension === "month" ? "monthly" : dimension === "week" ? "7" : "1";

  const byDate = new Map<string, MetaTimeBreakdownRow>();

  await Promise.all(
    credentials.accountIds.map(async (accountId) => {
      const url = new URL(
        `https://graph.facebook.com/v25.0/${accountId}/insights`
      );
      url.searchParams.set("level", "campaign");
      url.searchParams.set(
        "fields",
        "date_start,spend,ctr,cpm,impressions,clicks,actions,action_values,purchase_roas"
      );
      url.searchParams.set("time_range", JSON.stringify({ since, until }));
      url.searchParams.set("time_increment", timeIncrement);
      url.searchParams.set("limit", "500");
      url.searchParams.set("access_token", credentials.accessToken);

      try {
        const res = await fetch(url.toString(), { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as {
          data?: Array<
            RawCampaignInsight & { date_start?: string }
          >;
        };

        for (const row of json.data ?? []) {
          const date = row.date_start;
          if (!date) continue;
          const m = buildMetrics({
            spend_str: row.spend,
            ctr_str: row.ctr,
            cpm_str: row.cpm,
            impressions_str: row.impressions,
            clicks_str: row.clicks,
            actions: row.actions,
            action_values: row.action_values,
            purchase_roas: row.purchase_roas,
          });
          const existing = byDate.get(date);
          if (!existing) {
            byDate.set(date, { date, ...m });
          } else {
            const spend = r2(existing.spend + m.spend);
            const revenue = r2(existing.revenue + m.revenue);
            const purchases = existing.purchases + m.purchases;
            const clicks = existing.clicks + m.clicks;
            const impressions = existing.impressions + m.impressions;
            byDate.set(date, {
              date,
              spend,
              revenue,
              purchases,
              roas: spend > 0 ? r2(revenue / spend) : 0,
              cpa: purchases > 0 ? r2(spend / purchases) : 0,
              ctr: r2(existing.ctr + m.ctr),
              cpm: r2(existing.cpm + m.cpm),
              clicks,
              impressions,
            });
          }
        }
      } catch {
        // per-account failure is silent
      }
    })
  );

  return Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
}

// ── getCampaigns ──────────────────────────────────────────────────────────────

async function fetchCampaignStatuses(
  credentials: MetaCredentials,
  accountId: string,
  accessToken: string
): Promise<Map<string, string>> {
  const url = new URL(
    `https://graph.facebook.com/v25.0/${accountId}/campaigns`
  );
  url.searchParams.set("fields", "id,name,effective_status,status");
  url.searchParams.set("limit", "200");
  url.searchParams.set("access_token", accessToken);

  try {
    const jsonRows = await fetchPagedCollection<RawCampaign>(url.toString());
    await recordMetaRawSnapshot({
      credentials,
      accountId,
      endpointName: "campaign_statuses",
      entityScope: "campaign",
      since: new Date().toISOString().slice(0, 10),
      until: new Date().toISOString().slice(0, 10),
      payload: jsonRows,
      status: "fetched",
      requestContext: { fields: "id,name,effective_status,status" },
    });
    return new Map(
      jsonRows.map((c) => [
        c.id,
        c.effective_status ?? c.status ?? "UNKNOWN",
      ])
    );
  } catch {
    await recordMetaRawSnapshot({
      credentials,
      accountId,
      endpointName: "campaign_statuses",
      entityScope: "campaign",
      since: new Date().toISOString().slice(0, 10),
      until: new Date().toISOString().slice(0, 10),
      payload: [],
      status: "failed",
      requestContext: { fields: "id,name,effective_status,status" },
    });
    return new Map();
  }
}

export async function fetchMetaCampaignConfigs(
  credentials: MetaCredentials,
  accountId: string,
  accessToken: string
): Promise<Map<string, RawCampaign>> {
  const url = new URL(`https://graph.facebook.com/v25.0/${accountId}/campaigns`);
  url.searchParams.set("fields", META_CAMPAIGN_CONFIG_FIELDS);
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", accessToken);

  try {
    const jsonRows = await fetchPagedCollection<RawCampaign>(url.toString());
    await recordMetaRawSnapshot({
      credentials,
      accountId,
      endpointName: "campaign_configs",
      entityScope: "campaign",
      since: new Date().toISOString().slice(0, 10),
      until: new Date().toISOString().slice(0, 10),
      payload: jsonRows,
      status: "fetched",
      requestContext: {
        fields: META_CAMPAIGN_CONFIG_FIELDS,
      },
    });
    return new Map(jsonRows.map((campaign) => [campaign.id, campaign]));
  } catch {
    await recordMetaRawSnapshot({
      credentials,
      accountId,
      endpointName: "campaign_configs",
      entityScope: "campaign",
      since: new Date().toISOString().slice(0, 10),
      until: new Date().toISOString().slice(0, 10),
      payload: [],
      status: "failed",
      requestContext: {
        fields: META_CAMPAIGN_CONFIG_FIELDS,
      },
    });
    return new Map();
  }
}

export async function fetchMetaAdSetConfigs(
  accountId: string,
  accessToken: string
): Promise<Map<string, RawAdSet>> {
  const adsetConfigUrl = new URL(
    `https://graph.facebook.com/v25.0/${accountId}/adsets`
  );
  adsetConfigUrl.searchParams.set(
    "fields",
    "id,name,campaign_id,effective_status,status,daily_budget,lifetime_budget,optimization_goal,promoted_object{pixel_id,custom_event_type,custom_conversion_id},bid_strategy,bid_amount,bid_constraints{roas_average_floor}"
  );
  adsetConfigUrl.searchParams.set("limit", "500");
  adsetConfigUrl.searchParams.set("access_token", accessToken);
  try {
    const rows = await fetchPagedCollection<RawAdSet>(adsetConfigUrl.toString());
    return new Map(rows.map((row) => [row.id, row]));
  } catch {
    return new Map<string, RawAdSet>();
  }
}

async function persistMetaCampaignConfigSnapshots(input: {
  businessId: string;
  accountId: string;
  campaignConfigs: Map<string, RawCampaign>;
  entityIds?: string[] | null;
}): Promise<number> {
  const entityIds = input.entityIds?.length
    ? Array.from(new Set(input.entityIds.filter(Boolean)))
    : Array.from(input.campaignConfigs.keys());
  if (entityIds.length === 0) return 0;

  const rows = entityIds
    .map((campaignId) => {
      const campaign = input.campaignConfigs.get(campaignId);
      if (!campaign) return null;
      return {
        businessId: input.businessId,
        accountId: input.accountId,
        entityLevel: "campaign" as const,
        entityId: campaignId,
        payload: buildConfigSnapshotPayload({
          campaignId,
          objective: campaign.objective ?? null,
          bidStrategy: campaign.bid_strategy ?? null,
          manualBidAmount:
            campaign.bid_amount != null ? parseNum(campaign.bid_amount) : null,
          targetRoas: campaign.bid_constraints?.roas_average_floor
            ? parseNum(campaign.bid_constraints.roas_average_floor)
            : null,
          dailyBudget:
            campaign.daily_budget != null
              ? parseNum(campaign.daily_budget)
              : null,
          lifetimeBudget:
            campaign.lifetime_budget != null
              ? parseNum(campaign.lifetime_budget)
              : null,
        }),
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  if (rows.length === 0) return 0;
  await appendMetaConfigSnapshots(rows);
  return rows.length;
}

async function fetchCampaignInsights(
  credentials: MetaCredentials,
  accountId: string,
  since: string,
  until: string,
  accessToken: string
): Promise<RawCampaignInsight[]> {
  const url = new URL(
    `https://graph.facebook.com/v25.0/${accountId}/insights`
  );
  url.searchParams.set("level", "campaign");
  url.searchParams.set(
    "fields",
    "campaign_id,campaign_name,spend,ctr,cpm,impressions,clicks,actions,action_values,purchase_roas"
  );
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("limit", "200");
  url.searchParams.set("access_token", accessToken);

  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      await recordMetaRawSnapshot({
        credentials,
        accountId,
        endpointName: "campaign_insights",
        entityScope: "campaign",
        since,
        until,
        payload: [],
        status: "failed",
        providerHttpStatus: res.status,
        requestContext: { level: "campaign" },
      });
      return [];
    }
    const json = (await res.json()) as { data?: RawCampaignInsight[] };
    await recordMetaRawSnapshot({
      credentials,
      accountId,
      endpointName: "campaign_insights",
      entityScope: "campaign",
      since,
      until,
      payload: json.data ?? [],
      status: "fetched",
      providerHttpStatus: res.status,
      requestContext: { level: "campaign" },
    });
    return json.data ?? [];
  } catch {
    await recordMetaRawSnapshot({
      credentials,
      accountId,
      endpointName: "campaign_insights",
      entityScope: "campaign",
      since,
      until,
      payload: [],
      status: "failed",
      requestContext: { level: "campaign" },
    });
    return [];
  }
}

/**
 * Fetch all campaigns for the assigned Meta ad accounts in the date range.
 * Results are sorted by spend descending (highest spend first).
 */
export async function getCampaigns(
  credentials: MetaCredentials,
  since: string,
  until: string
): Promise<MetaCampaignData[]> {
  const normalizedSince = normalizeMetaApiDate(since);
  const normalizedUntil = normalizeMetaApiDate(until);
  const allRows: MetaCampaignData[] = [];

  await Promise.all(
    credentials.accountIds.map(async (accountId) => {
      await withMetaSyncJob({
        credentials,
        accountId,
        scope: "campaign_daily",
        since: normalizedSince,
        until: normalizedUntil,
        run: async () => {
          const [statusMap, insights, campaignConfigs] = await Promise.all([
            fetchCampaignStatuses(credentials, accountId, credentials.accessToken),
            fetchCampaignInsights(
              credentials,
              accountId,
              normalizedSince,
              normalizedUntil,
              credentials.accessToken
            ),
            fetchMetaCampaignConfigs(
              credentials,
              accountId,
              credentials.accessToken
            ),
          ]);
          const profile = credentials.accountProfiles[accountId];
          const normalizedDate = normalizedSince;

          await persistMetaCampaignConfigSnapshots({
            businessId: credentials.businessId,
            accountId,
            campaignConfigs,
          });

          for (const insight of insights) {
            const campaignId = insight.campaign_id ?? "";
            const campaignConfig = campaignConfigs.get(campaignId);
            const config = buildConfigSnapshotPayload({
              campaignId,
              objective: campaignConfig?.objective ?? null,
              bidStrategy: campaignConfig?.bid_strategy ?? null,
              manualBidAmount:
                campaignConfig?.bid_amount != null
                  ? parseNum(campaignConfig.bid_amount)
                  : null,
              targetRoas:
                campaignConfig?.bid_constraints?.roas_average_floor != null
                  ? parseNum(campaignConfig.bid_constraints.roas_average_floor)
                  : null,
              dailyBudget:
                campaignConfig?.daily_budget != null
                  ? parseNum(campaignConfig.daily_budget)
                  : null,
              lifetimeBudget:
                campaignConfig?.lifetime_budget != null
                  ? parseNum(campaignConfig.lifetime_budget)
                  : null,
            });
            allRows.push({
              id: campaignId,
              accountId,
              name: insight.campaign_name ?? "Unknown Campaign",
              status: statusMap.get(campaignId) ?? "UNKNOWN",
              objective: campaignConfig?.objective ?? null,
              buyingType: campaignConfig?.buying_type ?? null,
              budgetLevel: null,
              optimizationGoal: null,
              bidStrategyType: config.bidStrategyType,
              bidStrategyLabel: config.bidStrategyLabel,
              manualBidAmount: config.manualBidAmount,
              previousManualBidAmount: null,
              bidValue: config.bidValue,
              bidValueFormat: config.bidValueFormat,
              previousBidValue: null,
              previousBidValueFormat: null,
              previousBidValueCapturedAt: null,
              dailyBudget: config.dailyBudget,
              lifetimeBudget: config.lifetimeBudget,
              previousDailyBudget: null,
              previousLifetimeBudget: null,
              previousBudgetCapturedAt: null,
              isBudgetMixed: false,
              isConfigMixed: false,
              isOptimizationGoalMixed: false,
              isBidStrategyMixed: false,
              isBidValueMixed: false,
              ...buildMetrics({
                spend_str: insight.spend,
                ctr_str: insight.ctr,
                cpm_str: insight.cpm,
                impressions_str: insight.impressions,
                clicks_str: insight.clicks,
                actions: insight.actions,
                action_values: insight.action_values,
                purchase_roas: insight.purchase_roas,
              }),
            });
          }

          const accountToday = getTodayIsoForTimeZone(profile?.timezone ?? "UTC");
          if (
            isSingleDayWindow(normalizedSince, normalizedUntil) &&
            normalizedDate === accountToday
          ) {
            const singleDayRows = allRows.filter(
              (row) => row.accountId === accountId
            );
            await upsertMetaCampaignDailyRows(
              singleDayRows.map((row): MetaCampaignDailyRow => ({
                businessId: credentials.businessId,
                providerAccountId: accountId,
                date: normalizedDate,
                campaignId: row.id,
                campaignNameCurrent: row.name,
                campaignNameHistorical: row.name,
                campaignStatus: row.status,
                objective: row.objective ?? null,
                buyingType: row.buyingType ?? null,
                optimizationGoal: row.optimizationGoal ?? null,
                bidStrategyType: row.bidStrategyType ?? null,
                bidStrategyLabel: row.bidStrategyLabel ?? null,
                manualBidAmount: row.manualBidAmount ?? null,
                bidValue: row.bidValue ?? null,
                bidValueFormat: row.bidValueFormat ?? null,
                dailyBudget: row.dailyBudget ?? null,
                lifetimeBudget: row.lifetimeBudget ?? null,
                isBudgetMixed: Boolean(row.isBudgetMixed),
                isConfigMixed: Boolean(row.isConfigMixed),
                isOptimizationGoalMixed: Boolean(row.isOptimizationGoalMixed),
                isBidStrategyMixed: Boolean(row.isBidStrategyMixed),
                isBidValueMixed: Boolean(row.isBidValueMixed),
                accountTimezone: profile?.timezone ?? "UTC",
                accountCurrency:
                  profile?.currency ?? credentials.currency ?? "USD",
                spend: row.spend,
                impressions: row.impressions,
                clicks: row.clicks,
                reach: row.impressions,
                frequency: null,
                conversions: row.purchases,
                revenue: row.revenue,
                roas: row.roas,
                cpa: row.cpa || null,
                ctr: row.ctr || null,
                cpc: row.clicks > 0 ? r2(row.spend / row.clicks) : null,
                sourceSnapshotId: null,
              }))
            );
            await upsertMetaAccountDailyRows([
              {
                businessId: credentials.businessId,
                providerAccountId: accountId,
                date: normalizedDate,
                accountName: profile?.name ?? null,
                accountTimezone: profile?.timezone ?? "UTC",
                accountCurrency:
                  profile?.currency ?? credentials.currency ?? "USD",
                spend: r2(
                  singleDayRows.reduce((sum, row) => sum + row.spend, 0)
                ),
                impressions: singleDayRows.reduce(
                  (sum, row) => sum + row.impressions,
                  0
                ),
                clicks: singleDayRows.reduce((sum, row) => sum + row.clicks, 0),
                reach: singleDayRows.reduce(
                  (sum, row) => sum + row.impressions,
                  0
                ),
                frequency: null,
                conversions: singleDayRows.reduce(
                  (sum, row) => sum + row.purchases,
                  0
                ),
                revenue: r2(
                  singleDayRows.reduce((sum, row) => sum + row.revenue, 0)
                ),
                roas:
                  singleDayRows.reduce((sum, row) => sum + row.spend, 0) > 0
                    ? r2(
                        singleDayRows.reduce((sum, row) => sum + row.revenue, 0) /
                          singleDayRows.reduce((sum, row) => sum + row.spend, 0)
                      )
                    : 0,
                cpa:
                  singleDayRows.reduce((sum, row) => sum + row.purchases, 0) > 0
                    ? r2(
                        singleDayRows.reduce((sum, row) => sum + row.spend, 0) /
                          singleDayRows.reduce(
                            (sum, row) => sum + row.purchases,
                            0
                          )
                      )
                    : null,
                ctr:
                  singleDayRows.reduce((sum, row) => sum + row.impressions, 0) > 0
                    ? r2(
                        (singleDayRows.reduce((sum, row) => sum + row.clicks, 0) /
                          singleDayRows.reduce(
                            (sum, row) => sum + row.impressions,
                            0
                          )) *
                          100
                      )
                    : null,
                cpc:
                  singleDayRows.reduce((sum, row) => sum + row.clicks, 0) > 0
                    ? r2(
                        singleDayRows.reduce((sum, row) => sum + row.spend, 0) /
                          singleDayRows.reduce((sum, row) => sum + row.clicks, 0)
                      )
                    : null,
                sourceSnapshotId: null,
              },
            ]);
          }
        },
      });
    })
  );

  return allRows.sort((a, b) => b.spend - a.spend);
}

export async function backfillMetaCampaignConfigSnapshots(input: {
  businessId: string;
  providerAccountId?: string | null;
}): Promise<{
  businessId: string;
  attemptedAccounts: number;
  persistedSnapshots: number;
  skipped: boolean;
}> {
  const credentials = await resolveMetaCredentials(input.businessId);
  if (!credentials) {
    return {
      businessId: input.businessId,
      attemptedAccounts: 0,
      persistedSnapshots: 0,
      skipped: true,
    };
  }

  const accountIds = input.providerAccountId
    ? credentials.accountIds.filter((accountId) => accountId === input.providerAccountId)
    : credentials.accountIds;
  let persistedSnapshots = 0;

  await Promise.all(
    accountIds.map(async (accountId) => {
      const campaignConfigs = await fetchMetaCampaignConfigs(
        credentials,
        accountId,
        credentials.accessToken,
      ).catch(() => new Map<string, RawCampaign>());
      persistedSnapshots += await persistMetaCampaignConfigSnapshots({
        businessId: credentials.businessId,
        accountId,
        campaignConfigs,
      });
    }),
  );

  return {
    businessId: credentials.businessId,
    attemptedAccounts: accountIds.length,
    persistedSnapshots,
    skipped: false,
  };
}

// ── getAdSets ─────────────────────────────────────────────────────────────────

/**
 * Fetch ad sets for either a single campaign or the full account scope.
 * Used by the accordion table's lazy child tree and Meta Decision OS.
 * Results are sorted by spend descending.
 */
export async function getAdSets(
  credentials: MetaCredentials,
  campaignId: string | null | undefined,
  since: string,
  until: string,
  businessId?: string,
  includePrev = false
): Promise<MetaAdSetData[]> {
  const normalizedSince = normalizeMetaApiDate(since);
  const normalizedUntil = normalizeMetaApiDate(until);
  const results: MetaAdSetData[] = [];

  await Promise.all(
    credentials.accountIds.map(async (accountId) => {
      // Fetch adset metadata (status, budget) scoped to the campaign
      const statusUrl = new URL(
        `https://graph.facebook.com/v25.0/${accountId}/adsets`
      );
      statusUrl.searchParams.set(
        "fields",
        "id,name,campaign_id,effective_status,status,daily_budget,lifetime_budget,optimization_goal,promoted_object{pixel_id,custom_event_type,custom_conversion_id},bid_strategy,bid_amount,bid_constraints{roas_average_floor}"
      );
      statusUrl.searchParams.set("limit", "200");
      statusUrl.searchParams.set("access_token", credentials.accessToken);

      // Fetch adset insights filtered to this campaign
      const insightUrl = new URL(
        `https://graph.facebook.com/v25.0/${accountId}/insights`
      );
      insightUrl.searchParams.set("level", "adset");
      insightUrl.searchParams.set(
        "fields",
        "adset_id,adset_name,campaign_id,spend,ctr,inline_link_click_ctr,cpm,impressions,clicks,actions,action_values,purchase_roas"
      );
      if (campaignId) {
        insightUrl.searchParams.set(
          "filtering",
          JSON.stringify([
            { field: "campaign.id", operator: "EQUAL", value: campaignId },
          ])
        );
      }
      insightUrl.searchParams.set(
        "time_range",
        JSON.stringify({ since: normalizedSince, until: normalizedUntil })
      );
      insightUrl.searchParams.set("limit", "200");
      insightUrl.searchParams.set("access_token", credentials.accessToken);

      try {
        const [statusRes, insightRes, campaignConfigs] = await Promise.all([
          fetch(statusUrl.toString(), { cache: "no-store" }),
          fetch(insightUrl.toString(), { cache: "no-store" }),
          fetchMetaCampaignConfigs(credentials, accountId, credentials.accessToken),
        ]);

        const statusJson = statusRes.ok
          ? ((await statusRes.json()) as MetaGraphCollectionResponse<RawAdSet>)
          : { data: [] as RawAdSet[] };
        const insightJson = insightRes.ok
          ? ((await insightRes.json()) as { data?: RawAdSetInsight[] })
          : { data: [] as RawAdSetInsight[] };
        await recordMetaRawSnapshot({
          credentials,
          accountId,
          endpointName: "adset_statuses",
          entityScope: "adset",
          since: normalizedSince,
          until: normalizedUntil,
          payload: statusJson.data ?? [],
          status: statusRes.ok ? "fetched" : "failed",
          providerHttpStatus: statusRes.status,
          requestContext: { campaignId, fields: "id,name,campaign_id,effective_status,status,daily_budget,lifetime_budget,optimization_goal,promoted_object{pixel_id,custom_event_type,custom_conversion_id},bid_strategy,bid_amount,bid_constraints{roas_average_floor}" },
        });
        await recordMetaRawSnapshot({
          credentials,
          accountId,
          endpointName: "adset_insights",
          entityScope: "adset",
          since: normalizedSince,
          until: normalizedUntil,
          payload: insightJson.data ?? [],
          status: insightRes.ok ? "fetched" : "failed",
          providerHttpStatus: insightRes.status,
          requestContext: { campaignId: campaignId ?? null, level: "adset" },
        });
        const allStatusRows = statusJson.paging?.next
          ? await fetchPagedCollection<RawAdSet>(statusUrl.toString())
          : (statusJson.data ?? []);
        const statusRows = campaignId
          ? allStatusRows.filter((adset) => adset.campaign_id === campaignId)
          : allStatusRows;
        const statusMap = new Map<string, RawAdSet>(
          statusRows.map((a) => [a.id, a])
        );
        const profile = credentials.accountProfiles[accountId];
        // Snapshot reads are intentionally limited to the current-day live path.
        const allowSnapshotReadForTodayLive =
          businessId != null &&
          isSingleDayWindow(normalizedSince, normalizedUntil) &&
          isCurrentDayForTimezone(normalizedSince, profile?.timezone ?? null);
        const [latestSnapshots, latestCampaignSnapshots, previousDiffs, previousCampaignDiffs] = allowSnapshotReadForTodayLive
          ? await Promise.all([
              readLatestMetaConfigSnapshots({
                businessId,
                entityLevel: "adset",
                entityIds: Array.from(
                  new Set([
                    ...statusRows.map((adset) => adset.id),
                    ...(insightJson.data ?? []).map((adset) => adset.adset_id ?? "").filter(Boolean),
                  ])
                ),
              }),
              readLatestMetaConfigSnapshots({
                businessId,
                entityLevel: "campaign",
                entityIds: Array.from(
                  new Set(
                    [
                      ...statusRows.map((adset) => adset.campaign_id ?? ""),
                      ...(insightJson.data ?? []).map((adset) => adset.campaign_id ?? ""),
                    ].filter(Boolean),
                  ),
                ),
              }),
              includePrev
                ? readPreviousDifferentMetaConfigDiffs({
                    businessId,
                    entityLevel: "adset",
                    entityIds: Array.from(
                      new Set([
                        ...statusRows.map((adset) => adset.id),
                        ...(insightJson.data ?? []).map((adset) => adset.adset_id ?? "").filter(Boolean),
                      ])
                    ),
                  })
                : Promise.resolve(new Map()),
              includePrev
                ? readPreviousDifferentMetaConfigDiffs({
                    businessId,
                    entityLevel: "campaign",
                    entityIds: Array.from(
                      new Set(
                        [
                          ...statusRows.map((adset) => adset.campaign_id ?? ""),
                          ...(insightJson.data ?? []).map((adset) => adset.campaign_id ?? ""),
                        ].filter(Boolean),
                      ),
                    ),
                  })
                : Promise.resolve(new Map()),
            ])
          : [new Map(), new Map(), new Map(), new Map()];

        for (const insight of insightJson.data ?? []) {
          if (campaignId && insight.campaign_id !== campaignId) continue;

          const adsetId = insight.adset_id ?? "";
          const resolvedCampaignId = insight.campaign_id ?? statusMap.get(adsetId)?.campaign_id ?? "";
          const meta = statusMap.get(adsetId);
          const latestSnapshot = latestSnapshots.get(adsetId);
          const latestCampaignSnapshot = latestCampaignSnapshots.get(resolvedCampaignId);
          const campaignConfig = campaignConfigs.get(resolvedCampaignId) ?? null;
          const previousDiff = previousDiffs.get(adsetId);
          const previousCampaignDiff = previousCampaignDiffs.get(resolvedCampaignId);
          const usesCampaignBudgetFallback =
            meta?.daily_budget == null &&
            meta?.lifetime_budget == null &&
            (campaignConfig?.daily_budget != null || campaignConfig?.lifetime_budget != null);
          const { payload: config, usesCampaignBidFallback } = buildMetaAdSetConfigPayload({
            campaignId: resolvedCampaignId,
            adset: meta,
            campaignConfig,
            latestSnapshot,
            latestCampaignSnapshot,
          });
          results.push({
            id: adsetId,
            accountId,
            name: insight.adset_name ?? meta?.name ?? "Unknown Ad Set",
            campaignId: resolvedCampaignId,
            status:
              meta?.effective_status ??
              meta?.status ??
              campaignConfig?.effective_status ??
              campaignConfig?.status ??
              "UNKNOWN",
            budgetLevel: usesCampaignBudgetFallback ? "campaign" : "adset",
            dailyBudget: config.dailyBudget,
            lifetimeBudget: config.lifetimeBudget,
            optimizationGoal: config.optimizationGoal,
            customEventType: config.customEventType,
            pixelId: config.pixelId,
            customConversionId: config.customConversionId,
            promotedObject: config.promotedObject,
            bidStrategyType: config.bidStrategyType,
            bidStrategyLabel: config.bidStrategyLabel,
            manualBidAmount: config.manualBidAmount,
            previousManualBidAmount:
              previousDiff?.previousManualBidAmount ??
              (usesCampaignBidFallback ? previousCampaignDiff?.previousManualBidAmount ?? null : null),
            bidValue: config.bidValue,
            bidValueFormat: config.bidValueFormat,
            previousBidValue:
              previousDiff?.previousBidValue ??
              (usesCampaignBidFallback ? previousCampaignDiff?.previousBidValue ?? null : null),
            previousBidValueFormat:
              previousDiff?.previousBidValueFormat ??
              (usesCampaignBidFallback ? previousCampaignDiff?.previousBidValueFormat ?? null : null),
            previousBidValueCapturedAt:
              previousDiff?.previousBidCapturedAt ??
              (usesCampaignBidFallback ? previousCampaignDiff?.previousBidCapturedAt ?? null : null),
            isBudgetMixed: false,
            previousDailyBudget:
              previousDiff?.previousDailyBudget ??
              (usesCampaignBudgetFallback ? previousCampaignDiff?.previousDailyBudget ?? null : null),
            previousLifetimeBudget:
              previousDiff?.previousLifetimeBudget ??
              (usesCampaignBudgetFallback ? previousCampaignDiff?.previousLifetimeBudget ?? null : null),
            previousBudgetCapturedAt:
              previousDiff?.previousBudgetCapturedAt ??
              (usesCampaignBudgetFallback ? previousCampaignDiff?.previousBudgetCapturedAt ?? null : null),
            isConfigMixed: false,
            isOptimizationGoalMixed: false,
            isBidStrategyMixed: false,
            isBidValueMixed: false,
            ...buildMetrics({
              spend_str: insight.spend,
              ctr_str: insight.ctr,
              cpm_str: insight.cpm,
              impressions_str: insight.impressions,
              clicks_str: insight.clicks,
              actions: insight.actions,
              action_values: insight.action_values,
              purchase_roas: insight.purchase_roas,
            }),
            inlineLinkClickCtr: insight.inline_link_click_ctr != null
              ? r2(parseNum(insight.inline_link_click_ctr))
              : null,
          });
        }

        if (isSingleDayWindow(normalizedSince, normalizedUntil)) {
          const profile = credentials.accountProfiles[accountId];
          const normalizedDate = normalizedSince;
          const singleDayRows = results.filter((row) => row.accountId === accountId);
          await upsertMetaAdSetDailyRows(
            singleDayRows.map((row) => ({
              businessId: credentials.businessId,
              providerAccountId: accountId,
              date: normalizedDate,
              campaignId: row.campaignId,
              adsetId: row.id,
              adsetNameCurrent: row.name,
              adsetNameHistorical: row.name,
              adsetStatus: row.status,
              accountTimezone: profile?.timezone ?? "UTC",
              accountCurrency: profile?.currency ?? credentials.currency ?? "USD",
              spend: row.spend,
              impressions: row.impressions,
              clicks: row.clicks,
              reach: row.impressions,
              frequency: null,
              conversions: row.purchases,
              revenue: row.revenue,
              roas: row.roas,
              cpa: row.cpa || null,
              ctr: row.ctr || null,
              cpc: row.clicks > 0 ? r2(row.spend / row.clicks) : null,
              sourceSnapshotId: null,
              optimizationGoal: row.optimizationGoal,
              bidStrategyType: row.bidStrategyType,
              bidStrategyLabel: row.bidStrategyLabel,
              manualBidAmount: row.manualBidAmount,
              bidValue: row.bidValue,
              bidValueFormat: row.bidValueFormat,
              dailyBudget: row.dailyBudget,
              lifetimeBudget: row.lifetimeBudget,
              isBudgetMixed: row.isBudgetMixed,
              isConfigMixed: row.isConfigMixed,
              isOptimizationGoalMixed: Boolean(row.isOptimizationGoalMixed),
              isBidStrategyMixed: Boolean(row.isBidStrategyMixed),
              isBidValueMixed: Boolean(row.isBidValueMixed),
            }))
          );
        }

        if (businessId) {
          const campaignEntityIds = campaignId
            ? [campaignId]
            : Array.from(
                new Set(
                  statusRows.map((row) => row.campaign_id ?? "").filter(Boolean)
                )
              );
          await Promise.all([
            appendMetaConfigSnapshots(
              statusRows.map((meta) => {
                const resolvedCampaignId = meta.campaign_id ?? campaignId ?? null;
                const campaignConfig = resolvedCampaignId
                  ? campaignConfigs.get(resolvedCampaignId) ?? null
                  : null;
                return {
                  businessId,
                  accountId,
                  entityLevel: "adset" as const,
                  entityId: meta.id,
                  payload: buildConfigSnapshotPayload({
                    campaignId: resolvedCampaignId,
                    optimizationGoal: meta.optimization_goal ?? null,
                    customEventType: meta.promoted_object?.custom_event_type ?? null,
                    pixelId: meta.promoted_object?.pixel_id ?? null,
                    customConversionId: meta.promoted_object?.custom_conversion_id ?? null,
                    promotedObject: meta.promoted_object ?? null,
                    bidStrategy:
                      meta.bid_strategy ?? campaignConfig?.bid_strategy ?? null,
                    manualBidAmount:
                      meta.bid_amount != null
                        ? parseNum(meta.bid_amount)
                        : campaignConfig?.bid_amount != null
                          ? parseNum(campaignConfig.bid_amount)
                          : null,
                    targetRoas: meta.bid_constraints?.roas_average_floor
                      ? parseNum(meta.bid_constraints.roas_average_floor)
                      : campaignConfig?.bid_constraints?.roas_average_floor
                        ? parseNum(campaignConfig.bid_constraints.roas_average_floor)
                        : null,
                    dailyBudget:
                      meta.daily_budget != null
                        ? parseNum(meta.daily_budget)
                        : campaignConfig?.daily_budget != null
                          ? parseNum(campaignConfig.daily_budget)
                          : null,
                    lifetimeBudget:
                      meta.lifetime_budget != null
                        ? parseNum(meta.lifetime_budget)
                        : campaignConfig?.lifetime_budget != null
                          ? parseNum(campaignConfig.lifetime_budget)
                          : null,
                  }),
                };
              })
            ),
            persistMetaCampaignConfigSnapshots({
              businessId,
              accountId,
              campaignConfigs,
              entityIds: campaignEntityIds,
            }),
          ]);
        }
      } catch {
        // Per-account failures are silent — other accounts still process
      }
    })
  );

  return results.sort((a, b) => b.spend - a.spend);
}

// ── Breakdown helpers ─────────────────────────────────────────────────────────

async function fetchBreakdownRaw(
  credentials: MetaCredentials,
  accountId: string,
  accessToken: string,
  since: string,
  until: string,
  breakdowns: string
): Promise<RawBreakdownInsight[]> {
  const normalizedSince = normalizeMetaApiDate(since);
  const normalizedUntil = normalizeMetaApiDate(until);
  const url = new URL(
    `https://graph.facebook.com/v25.0/${accountId}/insights`
  );
  url.searchParams.set("level", "adset");
  url.searchParams.set("breakdowns", breakdowns);
  url.searchParams.set(
    "fields",
    "spend,clicks,impressions,ctr,cpm,actions,action_values,purchase_roas"
  );
  url.searchParams.set(
    "time_range",
    JSON.stringify({ since: normalizedSince, until: normalizedUntil })
  );
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", accessToken);

  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      await recordMetaRawSnapshot({
        credentials,
        accountId,
        endpointName: `breakdown_${breakdowns}`,
        entityScope: "breakdown",
        since: normalizedSince,
        until: normalizedUntil,
        payload: [],
        status: "failed",
        providerHttpStatus: res.status,
        requestContext: { level: "adset", breakdowns },
      });
      return [];
    }
    const json = (await res.json()) as { data?: RawBreakdownInsight[] };
    await recordMetaRawSnapshot({
      credentials,
      accountId,
      endpointName: `breakdown_${breakdowns}`,
      entityScope: "breakdown",
      since: normalizedSince,
      until: normalizedUntil,
      payload: json.data ?? [],
      status: "fetched",
      providerHttpStatus: res.status,
      requestContext: { level: "adset", breakdowns },
    });
    return json.data ?? [];
  } catch {
    await recordMetaRawSnapshot({
      credentials,
      accountId,
      endpointName: `breakdown_${breakdowns}`,
      entityScope: "breakdown",
      since: normalizedSince,
      until: normalizedUntil,
      payload: [],
      status: "failed",
      requestContext: { level: "adset", breakdowns },
    });
    return [];
  }
}

function aggregateBreakdown(
  rows: RawBreakdownInsight[],
  keyFn: (row: RawBreakdownInsight) => { key: string; label: string }
): MetaBreakdownRow[] {
  const map = new Map<string, MetaBreakdownRow>();

  for (const row of rows) {
    const { key, label } = keyFn(row);
    const metrics = buildMetrics({
      spend_str: row.spend,
      ctr_str: row.ctr,
      cpm_str: row.cpm,
      impressions_str: row.impressions,
      clicks_str: row.clicks,
      actions: row.actions,
      action_values: row.action_values,
      purchase_roas: row.purchase_roas,
    });

    const existing = map.get(key);
    if (existing) {
      existing.spend = r2(existing.spend + metrics.spend);
      existing.purchases += metrics.purchases;
      existing.revenue = r2(existing.revenue + metrics.revenue);
      existing.clicks += metrics.clicks;
      existing.impressions += metrics.impressions;
      // Recompute derived metrics after aggregation
      existing.roas =
        existing.spend > 0 ? r2(existing.revenue / existing.spend) : 0;
      existing.cpa =
        existing.purchases > 0
          ? r2(existing.spend / existing.purchases)
          : 0;
    } else {
      map.set(key, { key, label, ...metrics });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.spend - a.spend);
}

// ── getAgeBreakdown ───────────────────────────────────────────────────────────

export async function getAgeBreakdown(
  credentials: MetaCredentials,
  since: string,
  until: string
): Promise<MetaBreakdownRow[]> {
  const allRows: RawBreakdownInsight[] = [];

  await Promise.all(
    credentials.accountIds.map(async (id) => {
      const rows = await fetchBreakdownRaw(
        credentials,
        id,
        credentials.accessToken,
        since,
        until,
        "age"
      );
      allRows.push(...rows);
    })
  );

  return aggregateBreakdown(allRows, (row) => ({
    key: row.age ?? "unknown",
    label: row.age ?? "Unknown",
  }));
}

// ── getLocationBreakdown ──────────────────────────────────────────────────────

export async function getLocationBreakdown(
  credentials: MetaCredentials,
  since: string,
  until: string
): Promise<MetaBreakdownRow[]> {
  const allRows: RawBreakdownInsight[] = [];

  await Promise.all(
    credentials.accountIds.map(async (id) => {
      const rows = await fetchBreakdownRaw(
        credentials,
        id,
        credentials.accessToken,
        since,
        until,
        "country"
      );
      allRows.push(...rows);
    })
  );

  return aggregateBreakdown(allRows, (row) => ({
    key: row.country ?? "unknown",
    label: row.country ?? "Unknown",
  }));
}

// ── getGenderBreakdown ────────────────────────────────────────────────────────

export async function getGenderBreakdown(
  credentials: MetaCredentials,
  since: string,
  until: string
): Promise<MetaBreakdownRow[]> {
  const allRows: RawBreakdownInsight[] = [];

  await Promise.all(
    credentials.accountIds.map(async (id) => {
      const rows = await fetchBreakdownRaw(
        credentials,
        id,
        credentials.accessToken,
        since,
        until,
        "gender"
      );
      allRows.push(...rows);
    })
  );

  return aggregateBreakdown(allRows, (row) => ({
    key: row.gender ?? "unknown",
    label: row.gender === "male" ? "Male" : row.gender === "female" ? "Female" : row.gender ?? "Unknown",
  }));
}

// ── getRegionBreakdown ────────────────────────────────────────────────────────

export async function getRegionBreakdown(
  credentials: MetaCredentials,
  since: string,
  until: string
): Promise<MetaBreakdownRow[]> {
  const allRows: RawBreakdownInsight[] = [];

  await Promise.all(
    credentials.accountIds.map(async (id) => {
      const rows = await fetchBreakdownRaw(
        credentials,
        id,
        credentials.accessToken,
        since,
        until,
        "region"
      );
      allRows.push(...rows);
    })
  );

  return aggregateBreakdown(allRows, (row) => ({
    key: row.region ?? "unknown",
    label: row.region ?? "Unknown",
  }));
}

// ── getPlacementBreakdown ─────────────────────────────────────────────────────

export async function getPlacementBreakdown(
  credentials: MetaCredentials,
  since: string,
  until: string
): Promise<MetaBreakdownRow[]> {
  const allRows: RawBreakdownInsight[] = [];

  await Promise.all(
    credentials.accountIds.map(async (id) => {
      const rows = await fetchBreakdownRaw(
        credentials,
        id,
        credentials.accessToken,
        since,
        until,
        "publisher_platform,platform_position,impression_device"
      );
      allRows.push(...rows);
    })
  );

  return aggregateBreakdown(allRows, (row) => {
    const parts = [
      row.publisher_platform,
      row.platform_position,
      row.impression_device,
    ].filter(Boolean);
    return {
      key: parts.join("|") || "unknown",
      label: parts.join(" • ") || "Unknown",
    };
  });
}
