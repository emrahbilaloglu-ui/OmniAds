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

import { parseMetaLinkClicksFromActions } from "@/lib/meta/link-click-parse";
import { sanitizeMetaGraphTraceId } from "@/lib/meta/graph-trace-id";
import { formatMetaFailureForStorage } from "@/lib/sync/meta-error-classification";
import { classifyAmountField } from "@/lib/meta/budget-fact";
import { resolveMinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";
import { getDb } from "@/lib/db";
import { fetchWithTimeout } from "@/lib/http-fetch-with-timeout";
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
import { decideMetaCurrentEvidence } from "@/lib/meta/current-evidence-gate";
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
  appendMetaCurrentConfigHistory,
} from "@/lib/meta/warehouse";
import { deriveMetaFrequencyFromReach } from "@/lib/meta/warehouse-types";
import {
  resolveMetaRawSnapshotFetchUrl,
  resolveMetaRawSnapshotResumeState,
  selectLatestMetaRawSnapshotGeneration,
} from "@/lib/meta/raw-snapshot-generation";
import type {
  MetaAccountDailyRow,
  MetaAdDailyRow,
  MetaAdSetDailyRow,
  MetaBreakdownType,
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
import {
  normalizeMetaProviderUpdatedAt,
  persistMetaEntityObservation,
  readMetaEntityStatesAsOf,
  resolveMetaEntityObservedAt,
  type MetaEntityObservationStateInput,
  type MetaEntityType,
  type MetaObservationCompleteness,
  type MetaObservedAdCreativeRelationship,
} from "@/lib/meta/entity-state-history";
import {
  getMetaAccountContext,
  normalizeMetaCurrencyCode,
} from "@/lib/meta/account-context";
import { logRuntimeInfo, logRuntimeWarn } from "@/lib/runtime-logging";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";

// ── Core metric interface ─────────────────────────────────────────────────────

/**
 * The canonical metric shape for every Meta entity (campaign, ad set, breakdown).
 * Currency fields (spend, revenue, cpa, cpm) use .toFixed(2) precision at the
 * display layer. The raw numbers here are already rounded to 2 decimal places.
 */
export interface MetaMetricsData {
  spend: number; // account currency, rounded to 2 dp
  purchases: number; // integer count
  revenue: number; // account currency, rounded to 2 dp
  roas: number; // ratio, rounded to 2 dp
  cpa: number; // account currency per purchase, rounded to 2 dp
  ctr: number; // percent (e.g. 1.23 = 1.23%), rounded to 2 dp
  cpm: number; // account currency per 1000 impressions, rounded to 2 dp
  impressions: number; // integer count
  clicks: number; // integer count
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
  | "syncMetaAccountCoreWarehouseDay.append_current_config_history"
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
    (error as MetaAccountCoreSubStageTaggedError).metaAccountCoreSubStage =
      stage;
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
    logRuntimeInfo(
      "meta-sync",
      "partition_stage",
      buildMetaAccountCoreSubStagePayload({
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
      }),
    );
    return result;
  } catch (error) {
    const taggedError = tagMetaAccountCoreSubStageError(error, input.stage);
    const errorMessage =
      taggedError instanceof Error ? taggedError.message : String(taggedError);
    logRuntimeWarn(
      "meta-sync",
      "partition_stage_failed",
      buildMetaAccountCoreSubStagePayload({
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
      }),
    );
    throw taggedError;
  }
}

export interface MetaCampaignData extends MetaMetricsData {
  id: string;
  accountId?: string;
  name: string;
  status: string; // "ACTIVE" | "PAUSED" | "ARCHIVED" | "UNKNOWN"
  statusUpdatedAt?: string | null;
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
  statusUpdatedAt?: string | null;
  budgetLevel?: "campaign" | "adset" | null;
  dailyBudget: number | null; // account currency, null when lifetime budget is used
  lifetimeBudget: number | null; // account currency, null when daily budget is used
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
  landingPageViews?: number | null;
  addToCart?: number | null;
  initiateCheckout?: number | null;
  viewContent?: number | null;
  leads?: number | null;
  postEngagement?: number | null;
  thruplayActions?: number | null;
  videoViews3s?: number | null;
  reach?: number | null;
  frequency?: number | null;
}

export interface MetaBreakdownRow extends MetaMetricsData {
  key: string; // stable identifier for de-duplication
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
  updated_time?: string;
  objective?: string;
  buying_type?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  start_time?: string;
  stop_time?: string;
  bid_strategy?: string;
  bid_amount?: string;
  bid_constraints?: {
    roas_average_floor?: string;
  };
}

const META_CAMPAIGN_CONFIG_FIELDS =
  "id,name,objective,effective_status,status,updated_time,buying_type,daily_budget,lifetime_budget,start_time,stop_time,bid_strategy,bid_amount,bid_constraints{roas_average_floor}";

/*
  The two fields the campaigns edge started rejecting.

  Measured in production on 2026-09-07: with `start_time,stop_time` in the list
  (added by 5172235ad on 2026-09-03) `campaign_configs` is 47 HTTP 400s and 0
  successes since 2026-09-04, every one of them on page 0, on all 12 accounts it
  was attempted against, and meta_entity_state_history has not received a single
  `campaign` row in five days. The identical list WITHOUT those two fields
  returned 34,496 successes against 21 failures. The ad-set edge took
  `start_time,end_time` in the same commit and did not move (28,107 of 28,129
  adset rows carry adset_start_time), so the rejection is specific to these
  names on this edge.

  Which of the two, and Meta's code for it, was unknowable: the failure path
  never read the error body. It is recoverable rather than removed — the fetch
  asks for them, and only if the first page is refused does it retry without
  them. The receipt then carries `fieldDegradation.recovered`: true only when
  the narrowed request was accepted, which is the case that proves this edge
  refuses these names. A page-0 refusal that survives the narrowing proves
  nothing about them and is reported as `recovered: false`.
*/
const META_CAMPAIGN_SCHEDULE_FIELDS = ["start_time", "stop_time"] as const;

const META_ADSET_CONFIG_FIELDS =
  "id,name,campaign_id,effective_status,status,updated_time,daily_budget,lifetime_budget,start_time,end_time,optimization_goal,promoted_object{pixel_id,custom_event_type,custom_conversion_id},bid_strategy,bid_amount,bid_constraints{roas_average_floor}";

const META_AD_CONFIG_FIELDS =
  "id,name,campaign_id,adset_id,effective_status,status,updated_time,created_time,creative{id}";

const META_ACTIVE_AD_CONFIG_FIELDS =
  `${META_AD_CONFIG_FIELDS},campaign{id,name}`;

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
  updated_time?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  start_time?: string;
  end_time?: string;
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
  campaign?: { id?: string; name?: string } | null;
  updated_time?: string;
  created_time?: string;
  creative?: { id?: string } | null;
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
  // Optional because Meta OMITS them for a row it did not measure — which is
  // why they must land as null rather than 0.
  reach?: string;
  frequency?: string;
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
  currency: string | null; // ISO 4217 code from the primary ad account
  accountProfiles: Record<
    string,
    {
      currency: string | null;
      timezone: string | null;
      name: string | null;
    }
  >;
}

/**
 * D083 Correction 1 — owner provenance from explicit field semantics.
 *
 * The first version used `daily || lifetime`, which is wrong twice over: the
 * provider's `"0"` sentinel is a truthy JavaScript string, so a non-owning
 * grain claimed ownership; and both fields missing collapsed to
 * `not_applicable`, which asserts "the money is at the other grain" when the
 * truth is that nothing was observed. Absent means `not_observed`; a zero
 * sentinel means this grain does not own the money; only a positive integer
 * makes this grain the owner.
 */
/** The Graph version every fetch in this module addresses. */
export const META_GRAPH_API_VERSION = "v25.0" as const;

export function deriveMetaBudgetOrigin(
  grain: "campaign" | "adset",
  fields: { daily: unknown; lifetime: unknown; requested?: boolean },
): "campaign" | "adset" | "not_observed" | "not_applicable" {
  const daily = classifyAmountField(fields.daily);
  const lifetime = classifyAmountField(fields.lifetime);
  /*
    D086: absence is an OBSERVATION when the fields were requested.

    Both budget fields are in the config endpoint's field list, so a response
    that omits them says this entity carries no budget at this grain. Recording
    that as "not observed" made the canonical owner resolution refuse with
    `owner_origin_unrecognised`, so a CBO campaign's own ad-sets could never be
    proven non-owners. When the caller cannot say the fields were requested the
    old, weaker answer stands.
  */
  if (daily === "absent" && lifetime === "absent") {
    return fields.requested === true ? "not_applicable" : "not_observed";
  }
  if (daily === "invalid" || lifetime === "invalid") return "not_observed";
  if (daily === "positive" || lifetime === "positive") return grain;
  return "not_applicable";
}

/**
 * D083 — records which currency exponent was in force when an amount was
 * captured. A later registry revision must never silently restate a historical
 * observation, so the version travels with the row rather than being re-derived
 * at read time. An unresolvable currency records nothing rather than assuming
 * two decimals.
 */
export function metaBudgetCurrencyProvenance(currency: string | null): {
  budgetCurrencyExponent: number | null;
  budgetCurrencyRegistryVersion: string | null;
} {
  const resolution = resolveMinorUnitExponent(currency);
  return resolution.status === "resolved"
    ? {
        budgetCurrencyExponent: resolution.exponent,
        budgetCurrencyRegistryVersion: resolution.registryVersion,
      }
    : { budgetCurrencyExponent: null, budgetCurrencyRegistryVersion: null };
}

export function resolveMetaCurrencyForAccount(
  credentials: MetaCredentials,
  accountId: string,
): string | null {
  const profileCurrency = normalizeMetaCurrencyCode(
    credentials.accountProfiles[accountId]?.currency,
  );
  if (profileCurrency) return profileCurrency;

  const primaryAccountId = credentials.accountIds[0] ?? null;
  return accountId === primaryAccountId
    ? normalizeMetaCurrencyCode(credentials.currency)
    : null;
}

function requireMetaCurrencyForWarehouseWrite(
  credentials: MetaCredentials,
  accountId: string,
  surface: string,
): string {
  const currency = resolveMetaCurrencyForAccount(credentials, accountId);
  if (!currency) {
    throw new Error(`meta_currency_unavailable:${surface}:${accountId}`);
  }
  return currency;
}

const META_ACCOUNT_PROFILE_TIMEOUT_MS = 8_000;

function readPositiveEnvNumber(name: string, fallback: number) {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const META_FETCH_TIMEOUT_MS = readPositiveEnvNumber(
  "META_FETCH_TIMEOUT_MS",
  90_000,
);
const META_FETCH_HEARTBEAT_INTERVAL_MS = readPositiveEnvNumber(
  "META_FETCH_HEARTBEAT_INTERVAL_MS",
  30_000,
);
const DEFAULT_META_PARTITION_LEASE_MINUTES = readPositiveEnvNumber(
  "META_PARTITION_LEASE_MINUTES",
  15,
);

function normalizeMetaApiDate(value: string): string {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime()))
    return parsed.toISOString().slice(0, 10);
  throw new Error(`Invalid Meta date input: ${value}`);
}

/**
 * Resolve the Meta access token and assigned ad account IDs for a business.
 * Returns null when the integration is missing, disconnected, or has no
 * assigned accounts — callers should treat null as "show empty state".
 */
export async function resolveMetaCredentials(
  businessId: string,
): Promise<MetaCredentials | null> {
  const context = await getMetaAccountContext(businessId).catch(() => null);
  const accessToken = context?.accessToken;
  const accountIds = context?.accountIds ?? [];
  // A disconnected integration keeps its credential row, so checking only for a
  // token would let sync keep calling Meta after the user disconnected. The
  // connection status is the authority; the token is merely the means.
  if (!context?.connected || !accessToken || accountIds.length === 0) return null;

  return {
    businessId,
    accessToken,
    accountIds,
    currency: normalizeMetaCurrencyCode(context?.currency),
    accountProfiles: context?.accountProfiles ?? {},
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function parseAction(arr: MetaActionValue[] | undefined, type: string): number {
  if (!Array.isArray(arr)) return 0;
  const found = arr.find((a) => a.action_type === type);
  return found ? parseFloat(found.value) || 0 : 0;
}

/**
 * The link-click count Meta reported for ONE ad-day row, or null when Meta
 * reported nothing at all.
 *
 * WHICH SOURCE IS AUTHORITATIVE, AND HOW THAT WAS ESTABLISHED.
 *
 * Graph hands this client link clicks in exactly one place: the `actions`
 * array's `link_click` entry. Both ad-level insight field lists in this file —
 * `buildMetaBulkCoreInsightsUrl` and `buildMetaBreakdownInsightsUrl` — request
 * `actions`, and neither requests `inline_link_clicks`. That is not a guess: a
 * key census of `meta_ad_daily.payload_json` (the verbatim Graph ad-day row,
 * assigned at `target.payloadJson = row` in `applyAdInsightRowsToAggregates`)
 * over 2026-08-01..2026-09-06, 14,275 rows, read 2026-09-07 through the
 * read-only production tunnel, returns exactly eighteen keys — campaign_id,
 * campaign_name, adset_id, adset_name, ad_id, ad_name, date_start, date_stop,
 * spend, impressions, clicks, reach, frequency, cpm, ctr, actions,
 * action_values, purchase_roas — and `inline_link_clicks` is not among them.
 *
 * So `inline_link_clicks` is absent from every ad-day this product has ever
 * captured. Naming it the authority would leave the entire stored history
 * unreadable until a full re-fetch landed, and a re-fetch cannot be run from
 * here. The `actions` entry is the source that is already in hand, already at
 * ad-day grain, and already persisted for every row.
 *
 * ABSENT AND MEASURED ZERO ARE DIFFERENT FACTS, SO THEY GET DIFFERENT VALUES.
 *
 * - No `actions` array on the row at all -> null. Meta reported no action
 *   breakdown for this ad-day, which says nothing about link clicks. In the
 *   census above, 2,464 rows are in this state; every one of them has
 *   impressions > 0 and 133 of them have clicks > 0, so "no actions array" is
 *   emphatically not a quiet way of saying "nothing happened".
 * - An `actions` array that carries no `link_click` entry -> 0. This is a
 *   MEASUREMENT: Meta lists the action types that occurred and omits the ones
 *   that did not. 3,171 census rows are in this state. The reason the omission
 *   can be read as zero is that Meta never writes the zero itself — across the
 *   8,640 rows that DO carry a `link_click` entry, the minimum value is 1, and
 *   there is not one explicit `"value": "0"`.
 * - A `link_click` entry -> its value. Exactly one entry per row in the census
 *   (never two), and every value is an integer string.
 *
 * A `link_click` entry whose value does not parse to a finite number returns
 * null rather than 0. Turning an unreadable value into a confident zero is the
 * fabrication this whole change exists to remove; the census found no such
 * value, so this arm is a guard, not an observed case.
 */
export function readMetaLinkClicksFromInsight(row: {
  actions?: MetaActionValue[];
}): number | null {
  if (!Array.isArray(row.actions)) return null;
  /*
    THE SHARED STRICT PARSER (Codex B16).

    This used to be `.find(...)` plus `Number.parseFloat` plus `Math.round`,
    which admitted a rounded fraction, a negative, a value past
    `Number.MAX_SAFE_INTEGER`, and a partial numeric string like "12abc" —
    `parseFloat` stops at the first bad character and reports success on the
    prefix. It also resolved a duplicate `link_click` entry silently, by taking
    the first. The repair path refused every one of those, so the same provider
    payload was admitted by one path and rejected by the other and the column's
    meaning depended on which code wrote it.

    An absent entry is still a measured 0 — that is the census-backed inference
    this function documents above. Everything else is now either an exact
    non-negative integer or UNREADABLE, and unreadable stays null rather than
    becoming a confident zero.
  */
  const parsed = parseMetaLinkClicksFromActions(row.actions);
  if (parsed.ok) return parsed.value;
  return parsed.refusal === "no_link_click_entry" ? 0 : null;
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
  const url = new URL(
    `https://graph.facebook.com/v25.0/${input.accountId}/insights`,
  );
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
  const json = (await res.json()) as MetaGraphCollectionResponse<{
    spend?: string;
  }>;
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
  const cpa =
    totals.conversions > 0 ? r2(totals.spend / totals.conversions) : null;
  const ctr =
    totals.impressions > 0
      ? r2((totals.clicks / totals.impressions) * 100)
      : null;
  const cpc = totals.clicks > 0 ? r2(totals.spend / totals.clicks) : null;
  const frequency =
    totals.reach > 0 ? r2(totals.impressions / totals.reach) : null;
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
    },
  );
}

export type MetaPaginationTermination =
  | "natural_end"
  | "page_cap"
  | "row_cap"
  | "cursor_cycle"
  | "http_failure"
  /**
   * The transport succeeded and the envelope still refused.
   *
   * Graph can answer HTTP 2xx with a body whose top level is `{ error: {...} }`
   * — the same refusal it usually delivers as a 400, carried on a status that
   * `!response.ok` cannot see. It is kept distinct from `http_failure` because
   * the status recorded on the failure IS 200, and an operator reading
   * `http_failure` beside `httpStatus: 200` would reasonably conclude the
   * receipt was lying about one of the two.
   */
  | "error_envelope"
  | "fetch_failure"
  | "parse_failure"
  | "missing_terminal_proof";

/**
 * The Graph error identifiers this module keeps when a page is rejected.
 *
 * Meta answers a rejected request with `error.code`, `error.error_subcode`,
 * `error.is_transient` and `error.fbtrace_id`. Until now a non-OK page recorded
 * the HTTP status and nothing else — the response body was never even read —
 * which is why the `campaign_configs` HTTP 400 that has failed every single
 * attempt since 2026-09-04 (47 failures against 0 successes in
 * meta_raw_snapshots, read on 2026-09-07) still has no attributable provider
 * cause.
 *
 * `error.message` is deliberately NOT kept: it is free text that echoes the
 * request back, and the body around it is the response the access token
 * produced. These four identifiers name the failure and cannot carry a
 * credential.
 */
export interface MetaGraphErrorIdentity {
  errorCode: number | null;
  errorSubcode: number | null;
  isTransient: boolean | null;
  fbtraceId: string | null;
}

const EMPTY_META_GRAPH_ERROR_IDENTITY: MetaGraphErrorIdentity = {
  errorCode: null,
  errorSubcode: null,
  isTransient: null,
  fbtraceId: null,
};

function readOptionalGraphErrorNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Graph has returned `code` as a numeric string on some edges, and a string
  // here would otherwise silently classify as "no code reported".
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Pull ONLY the named identifiers out of a Graph error body. The body string is
 * consumed here and goes no further on this module's fetch paths: it is not
 * returned, not put in a receipt and not logged.
 *
 * Scope is this module. Other Graph callers in the repository keep their own
 * bodies — `fetchMetaAdAccounts` returns `rawBody` to its callers by design —
 * so this is not a repository-wide property and must not be quoted as one.
 */
function readMetaGraphErrorIdentity(rawBody: string): MetaGraphErrorIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ...EMPTY_META_GRAPH_ERROR_IDENTITY };
  }
  const error =
    parsed && typeof parsed === "object"
      ? (parsed as { error?: unknown }).error
      : null;
  if (!error || typeof error !== "object") {
    return { ...EMPTY_META_GRAPH_ERROR_IDENTITY };
  }
  const record = error as Record<string, unknown>;
  return {
    errorCode: readOptionalGraphErrorNumber(record.code),
    errorSubcode: readOptionalGraphErrorNumber(record.error_subcode),
    isTransient:
      typeof record.is_transient === "boolean" ? record.is_transient : null,
    /*
      THE ONLY FREE-FORM STRING THIS MODULE KEEPS, AND IT WAS UNVETTED.

      This was `String(...).trim()`, so whatever Meta put in `fbtrace_id`
      travelled into `MetaGraphRequestError.fbtraceId`, into the
      `collection_page_rejected` / `bulk_page_rejected` warnings, into the
      persisted `MetaPaginationFailure` on a pagination receipt, and from there
      into `lib/sync/meta-sync.ts`'s durable `last_error` / `error_message`.
      Prose, a quoted request with its query string, newlines that split a log
      line, the `:` delimiters the failure messages use as structure, and
      unbounded length all qualified. Every other field this module carries out
      of an error body is a number, a boolean or our own status for exactly
      that reason.

      `sanitizeMetaGraphTraceId` is the shared rule, and it is applied again at
      format time in `durableMetaFailureMessage`.
    */
    fbtraceId: sanitizeMetaGraphTraceId(record.fbtrace_id),
  };
}

/**
 * Whether a response BODY is a Graph refusal, independent of the HTTP status.
 *
 * `readMetaGraphErrorIdentity` cannot answer this. It returns the empty
 * identity for a body with no `error` object AND for an `error` object whose
 * code, subcode, transience and trace id are all missing or unusable, so a
 * caller that tested its result would read "no error" off a refusal that simply
 * arrived without identifiers. Presence and identity are separate questions and
 * get separate functions.
 *
 * Nothing from the body escapes: the return value is a boolean. The redaction
 * this module already applies (`sanitizeMetaPageUrl` on every recorded page
 * URL, and failure messages that name the status rather than quoting Meta's
 * text) is unchanged by this predicate.
 */
function hasMetaGraphErrorEnvelope(rawBody: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const error = (parsed as { error?: unknown }).error;
  return Boolean(error) && typeof error === "object";
}

/**
 * Codes Meta itself documents as retryable: 1/2 (unknown + temporary), 4/17/32
 * (app, user and page-level throttling) and the 80000-series ads throttles.
 * Meta reports them as HTTP 400 with the code in the payload: meta_raw_snapshots
 * holds 400s, 500s, 502s and 503s from this provider and not one 429, so a
 * status-only classifier cannot see the throttling at all.
 */
const META_TRANSIENT_GRAPH_ERROR_CODES = new Set([
  1, 2, 4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006,
  80008, 80014,
]);

function isMetaTransientPageFailure(input: {
  httpStatus: number | null;
  identity: MetaGraphErrorIdentity;
}) {
  // The provider's own verdict wins in both directions: an explicit
  // `is_transient: false` means retrying the identical request cannot help.
  if (input.identity.isTransient !== null) return input.identity.isTransient;
  if (
    input.identity.errorCode !== null &&
    META_TRANSIENT_GRAPH_ERROR_CODES.has(input.identity.errorCode)
  ) {
    return true;
  }
  // HTTP supplies the fallback classification when the Graph body carries no
  // verdict or known code. A bare 429 is still a throttle, and a 5xx is still a
  // provider outage; neither can prove that the request shape is unsupported.
  const httpStatus = input.httpStatus ?? 0;
  return httpStatus === 429 || httpStatus >= 500;
}

/**
 * Whether Graph positively named one of the caller's optional fields as
 * unreadable on this edge.
 *
 * Code 100 alone is too broad: Meta also uses it for invalid creatives,
 * missing promoted objects and unsupported node requests. The message is read
 * only to produce this boolean and never leaves the fetch loop. Matching both
 * Meta's field-specific shape and the exact optional field keeps provider
 * prose and credentials out of receipts and logs while preventing unrelated
 * permanent refusals from entering the narrowing path.
 */
function isMetaOptionalFieldShapeRejection(
  rawBody: string,
  optionalFields: readonly string[],
) {
  if (optionalFields.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const record = error as Record<string, unknown>;
  if (readOptionalGraphErrorNumber(record.code) !== 100) return false;
  if (typeof record.message !== "string") return false;
  const match = record.message.match(
    /\bTried accessing nonexisting field \(([A-Za-z][A-Za-z0-9_]*)\) on node type \([^)]+\)/i,
  );
  const refusedField = match?.[1];
  return Boolean(refusedField && optionalFields.includes(refusedField));
}

export interface MetaPaginationFailure {
  kind: Exclude<MetaPaginationTermination, "natural_end">;
  message: string;
  pageIndex: number;
  pageUrl: string;
  httpStatus: number | null;
  /**
   * Null on failures that never produced a Graph error body (transport
   * failures, unparseable pages, and the client-side caps).
   */
  errorCode: number | null;
  errorSubcode: number | null;
  isTransient: boolean | null;
  fbtraceId: string | null;
  /** Attempts spent on the failing page, including the one that gave up. */
  attempts: number;
}

/**
 * Records that the first page was refused and the request was then narrowed by
 * the caller-named optional fields.
 *
 * Narrowing is a HYPOTHESIS, and `recovered` is the only thing that says
 * whether the hypothesis held. Read it before reading `droppedFields`:
 *
 * - `recovered: true` — the narrowed request was accepted. A first-page
 *   rejection that disappears when named optional fields are removed IS the
 *   diagnosis: the provider refuses those fields on that edge, and the rows
 *   alongside this receipt do not carry them. This is the case the receipt
 *   exists for, so the snapshot cannot claim coverage the response never had.
 * - `recovered: false` — the narrowed request was refused too, so the rejection
 *   was never about these fields. `cause` holds the first refusal and the
 *   receipt's own `failure` holds the second; nothing was dropped from a
 *   capture, because there was no capture.
 *
 * `recovered` exists because the flag used to be set the moment narrowing was
 * ATTEMPTED and was never cleared on the failure path. A `campaign_configs`
 * page 0 refused for an unrelated permanent reason (a permissions error, say)
 * still returned `droppedFields: ["start_time","stop_time"]`, and
 * `paginationReceiptContext` persists that into
 * `meta_raw_snapshots.request_context.pagination` — so the next operator
 * chasing that 400 would read "Meta refuses the schedule fields" off a snapshot
 * where Meta refused nothing of the kind.
 */
export interface MetaPagedFieldDegradation {
  droppedFields: string[];
  cause: MetaPaginationFailure;
  /**
   * True only once a narrowed request came back usable, where "usable" means
   * all four of: a 2xx status, no Graph `error` object in the envelope, a body
   * this client could parse, and a `data` array. A 2xx carrying an error or an
   * unusable collection shape is not evidence that narrowing worked, and it
   * leaves this false.
   */
  recovered: boolean;
}

export interface MetaPagedCollectionReceipt<TItem> {
  rows: TItem[];
  rowObservedAt: string[];
  pageCount: number;
  complete: boolean;
  termination: MetaPaginationTermination;
  failure: MetaPaginationFailure | null;
  fieldDegradation: MetaPagedFieldDegradation | null;
  startedAt: string;
  completedAt: string;
  lastResponseObservedAt: string | null;
}

/**
 * A capture that could not be completed, thrown with the provider's own
 * structured identity attached instead of flattened into a string.
 *
 * `classifyMetaSyncFailure` in lib/sync/meta-error-classification.ts reads
 * `errorCode`, `errorSubcode` and `isTransient` off the thrown value. Until
 * this class existed the only thing that survived a throw out of this module
 * was a message like `meta_campaign_configs_incomplete:http_failure`, so the
 * sync classifier had no code to match on and fell through to its
 * unrecognised-message default — the same default it uses for a bare string it
 * has never seen.
 *
 * The message text is unchanged from what these call sites threw before, so
 * anything that logs or stores it reads exactly what it read yesterday.
 */
export class MetaGraphRequestError extends Error {
  readonly termination: MetaPaginationTermination;
  readonly httpStatus: number | null;
  readonly errorCode: number | null;
  readonly errorSubcode: number | null;
  readonly isTransient: boolean | null;
  readonly fbtraceId: string | null;

  constructor(
    message: string,
    receipt: Pick<
      MetaPagedCollectionReceipt<unknown>,
      "termination" | "failure"
    >,
  ) {
    super(message);
    this.name = "MetaGraphRequestError";
    this.termination = receipt.termination;
    this.httpStatus = receipt.failure?.httpStatus ?? null;
    this.errorCode = receipt.failure?.errorCode ?? null;
    this.errorSubcode = receipt.failure?.errorSubcode ?? null;
    this.isTransient = receipt.failure?.isTransient ?? null;
    this.fbtraceId = receipt.failure?.fbtraceId ?? null;
  }
}

/**
 * Query parameters that carry a credential. `paging.next` is built by Meta and
 * echoes back whatever authenticated the first page, so every URL that leaves
 * this module for a receipt or a log goes through here first.
 */
const META_URL_CREDENTIAL_PARAMS = [
  "access_token",
  "appsecret_proof",
  "client_secret",
  "input_token",
];

function sanitizeMetaPageUrl(value: string) {
  try {
    const url = new URL(value);
    for (const param of META_URL_CREDENTIAL_PARAMS) {
      if (url.searchParams.has(param)) {
        url.searchParams.set(param, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return "[invalid_url]";
  }
}

/**
 * Split a Graph `fields` value on its TOP-LEVEL commas only.
 *
 * `bid_constraints{roas_average_floor}` and
 * `promoted_object{pixel_id,custom_event_type,custom_conversion_id}` both put
 * commas inside braces; a plain `split(",")` would tear those apart and send
 * Meta a field list that is invalid in a new way.
 */
function splitMetaFieldList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "{" || char === "(") depth += 1;
    else if (char === "}" || char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function metaFieldName(field: string) {
  const brace = field.indexOf("{");
  return (brace === -1 ? field : field.slice(0, brace)).trim();
}

interface MetaNarrowedFieldRequest {
  url: string;
  droppedFields: string[];
}

/** Returns null when the URL has no `fields`, or nothing optional to drop. */
function withoutOptionalMetaFields(
  pageUrl: string,
  optionalFields: readonly string[],
): MetaNarrowedFieldRequest | null {
  if (optionalFields.length === 0) return null;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  const fields = url.searchParams.get("fields");
  if (!fields) return null;
  const optional = new Set(optionalFields);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const field of splitMetaFieldList(fields)) {
    if (optional.has(metaFieldName(field))) dropped.push(metaFieldName(field));
    else kept.push(field);
  }
  if (dropped.length === 0 || kept.length === 0) return null;
  url.searchParams.set("fields", kept.join(","));
  return { url: url.toString(), droppedFields: dropped };
}

export interface MetaPagedCollectionOptions {
  /** Hard ceiling on pages followed. */
  pageLimit?: number;
  /** Hard ceiling on rows accumulated across all pages. */
  maxRows?: number;
  /** Attempts allowed per page, including the first. */
  maxAttemptsPerPage?: number;
  /** First backoff step; doubles per retry up to META_RETRY_MAX_DELAY_MS. */
  retryBaseDelayMs?: number;
  /**
   * Fields the caller can complete the capture without. Used only after the
   * FIRST page is rejected and only once — see MetaPagedFieldDegradation.
   */
  optionalFields?: readonly string[];
}

const META_PAGE_LIMIT_DEFAULT = 20;
/**
 * A ceiling for future callers. It cannot bind today — do not read `row_cap` as
 * a live new bound on the current sync.
 *
 * Every caller of `fetchMetaPagedCollectionReceipt` in this module requests
 * `limit=500` or less and takes the default 20-page cap, and Graph never
 * returns more rows on a page than the requested `limit`. The reachable maximum
 * is therefore 20 x 500 = 10,000 rows, so `rows.length + pageRows.length >
 * maxRows` is never true and the `row_cap` termination is unreachable from
 * inside this module.
 *
 * It is deliberately left ABOVE that reachable maximum rather than lowered to
 * something that would fire: any value at or under 10,000 would convert
 * captures that succeed today into `row_cap` failures. What it does buy is that
 * a caller raising `pageLimit` or `limit` inherits a bounded array instead of
 * an unbounded one.
 */
const META_MAX_ROWS_DEFAULT = 100_000;
const META_MAX_ATTEMPTS_PER_PAGE_DEFAULT = 3;
const META_RETRY_BASE_DELAY_MS_DEFAULT = 500;
const META_RETRY_MAX_DELAY_MS = 4_000;

function incompletePaginationReceipt<TItem>(input: {
  rows: TItem[];
  rowObservedAt: string[];
  pageCount: number;
  termination: Exclude<MetaPaginationTermination, "natural_end">;
  message: string;
  pageUrl: string;
  httpStatus?: number | null;
  identity?: MetaGraphErrorIdentity;
  attempts?: number;
  fieldDegradation?: MetaPagedFieldDegradation | null;
  startedAt: string;
  lastResponseObservedAt: string | null;
}): MetaPagedCollectionReceipt<TItem> {
  const completedAt = new Date().toISOString();
  const identity = input.identity ?? EMPTY_META_GRAPH_ERROR_IDENTITY;
  return {
    rows: input.rows,
    rowObservedAt: input.rowObservedAt,
    pageCount: input.pageCount,
    complete: false,
    termination: input.termination,
    failure: {
      kind: input.termination,
      message: input.message,
      pageIndex: input.pageCount,
      pageUrl: sanitizeMetaPageUrl(input.pageUrl),
      httpStatus: input.httpStatus ?? null,
      errorCode: identity.errorCode,
      errorSubcode: identity.errorSubcode,
      isTransient: identity.isTransient,
      fbtraceId: identity.fbtraceId,
      attempts: input.attempts ?? 1,
    },
    fieldDegradation: input.fieldDegradation ?? null,
    startedAt: input.startedAt,
    completedAt,
    lastResponseObservedAt: input.lastResponseObservedAt,
  };
}

export async function fetchMetaPagedCollectionReceipt<TItem>(
  initialUrl: string,
  options?: MetaPagedCollectionOptions,
): Promise<MetaPagedCollectionReceipt<TItem>> {
  const pageLimit = options?.pageLimit ?? META_PAGE_LIMIT_DEFAULT;
  if (!Number.isInteger(pageLimit) || pageLimit < 1) {
    throw new Error("pageLimit must be a positive integer.");
  }
  const maxRows = options?.maxRows ?? META_MAX_ROWS_DEFAULT;
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error("maxRows must be a positive integer.");
  }
  const maxAttemptsPerPage =
    options?.maxAttemptsPerPage ?? META_MAX_ATTEMPTS_PER_PAGE_DEFAULT;
  if (!Number.isInteger(maxAttemptsPerPage) || maxAttemptsPerPage < 1) {
    throw new Error("maxAttemptsPerPage must be a positive integer.");
  }
  const retryBaseDelayMs =
    options?.retryBaseDelayMs ?? META_RETRY_BASE_DELAY_MS_DEFAULT;
  const optionalFields = options?.optionalFields ?? [];

  const startedAt = new Date().toISOString();
  const rows: TItem[] = [];
  const rowObservedAt: string[] = [];
  let nextUrl: string | null = initialUrl;
  let pageCount = 0;
  let lastResponseObservedAt: string | null = null;
  let fieldDegradation: MetaPagedFieldDegradation | null = null;
  // A cursor that points back at a page already fetched would otherwise burn
  // the whole page budget re-reading the same rows and call it a page cap.
  const visitedPageUrls = new Set<string>([initialUrl]);

  while (nextUrl) {
    if (pageCount >= pageLimit) {
      return incompletePaginationReceipt({
        rows,
        rowObservedAt,
        pageCount,
        termination: "page_cap",
        message: `Meta pagination exceeded the ${pageLimit}-page safety cap.`,
        pageUrl: nextUrl,
        fieldDegradation,
        startedAt,
        lastResponseObservedAt,
      });
    }

    // `nextUrl` is reassigned by the degradation branch below, so the page's
    // own URL is held locally for the attempt loop.
    let currentUrl: string = nextUrl;
    let attempt = 0;
    // Attempts for THIS page. Broken out of on a page that parsed cleanly.
    for (;;) {
      attempt += 1;
      let response: Response;
      try {
        response = await fetchWithTimeout(
          currentUrl,
          { cache: "no-store" },
          { timeoutMs: META_FETCH_TIMEOUT_MS, label: "Meta page" },
        );
      } catch (error) {
        // Not retried: META_FETCH_TIMEOUT_MS is 90s and the sync worker holds a
        // 15-minute partition lease, so three stalled sockets on one page would
        // spend a fifth of the lease before the next heartbeat learns anything.
        return incompletePaginationReceipt({
          rows,
          rowObservedAt,
          pageCount,
          termination: "fetch_failure",
          message: error instanceof Error ? error.message : String(error),
          pageUrl: currentUrl,
          attempts: attempt,
          fieldDegradation,
          startedAt,
          lastResponseObservedAt,
        });
      }
      const responseObservedAt = new Date().toISOString();
      lastResponseObservedAt = responseObservedAt;

      // The body is read for EVERY response, not just the non-OK ones.
      //
      // Graph can refuse a request on HTTP 200 by putting `{ "error": {...} }`
      // at the top level of the body, and `!response.ok` is blind to that. Left
      // unclassified, such a page walked straight past the refusal check, so it
      // (a) promoted a narrowing to `recovered: true` — publishing "the
      // provider serves this request without those fields" off a response the
      // provider had just refused — and (b) went on to read `data`, which on a
      // refusal envelope is absent, so the page ended as a `parse_failure`
      // naming a missing data array rather than the provider's own error code.
      //
      // Reading the body once as text and parsing it below also keeps this to a
      // single body consumption; a Response body cannot be read twice.
      const rawBody = await response.text().catch(() => "");
      const identity = readMetaGraphErrorIdentity(rawBody);
      const refusedByEnvelope = response.ok && hasMetaGraphErrorEnvelope(rawBody);

      if (!response.ok || refusedByEnvelope) {
        const transient = isMetaTransientPageFailure({
          httpStatus: response.status,
          identity,
        });
        logRuntimeWarn("meta-graph", "collection_page_rejected", {
          httpStatus: response.status,
          errorCode: identity.errorCode,
          errorSubcode: identity.errorSubcode,
          isTransient: identity.isTransient,
          fbtraceId: sanitizeMetaGraphTraceId(identity.fbtraceId),
          pageIndex: pageCount,
          attempt,
          transient,
          refusedByEnvelope,
        });
        if (transient && attempt < maxAttemptsPerPage) {
          await sleep(
            Math.min(
              retryBaseDelayMs * 2 ** (attempt - 1),
              META_RETRY_MAX_DELAY_MS,
            ),
          );
          continue;
        }

        const failure: MetaPaginationFailure = {
          kind: refusedByEnvelope ? "error_envelope" : "http_failure",
          message: refusedByEnvelope
            ? `Meta collection request returned status ${response.status} with a Graph error envelope.`
            : `Meta collection request failed with status ${response.status}.`,
          pageIndex: pageCount,
          pageUrl: sanitizeMetaPageUrl(currentUrl),
          httpStatus: response.status,
          errorCode: identity.errorCode,
          errorSubcode: identity.errorSubcode,
          isTransient: identity.isTransient,
          fbtraceId: identity.fbtraceId,
          attempts: attempt,
        };

        // Only a permanent, field-specific first-page rejection, and only
        // once. Transient failures can clear on the next request regardless of
        // its field list, while unrelated permanent failures say nothing about
        // these optional fields.
        const narrowed: MetaNarrowedFieldRequest | null =
          !transient &&
          pageCount === 0 &&
          !fieldDegradation &&
          isMetaOptionalFieldShapeRejection(rawBody, optionalFields)
            ? withoutOptionalMetaFields(currentUrl, optionalFields)
            : null;
        if (narrowed) {
          // `recovered` stays false until a narrowed request actually comes
          // back non-error (see the promotion below the refusal block).
          // Setting it true here would attribute an unrelated refusal to these
          // field names on every failure path out of this loop.
          fieldDegradation = {
            droppedFields: narrowed.droppedFields,
            cause: failure,
            recovered: false,
          };
          logRuntimeWarn("meta-graph", "collection_optional_fields_dropped", {
            httpStatus: response.status,
            errorCode: identity.errorCode,
            errorSubcode: identity.errorSubcode,
            isTransient: identity.isTransient,
            fbtraceId: identity.fbtraceId,
            droppedFields: narrowed.droppedFields,
          });
          currentUrl = narrowed.url;
          visitedPageUrls.add(narrowed.url);
          attempt = 0;
          continue;
        }

        return {
          rows,
          rowObservedAt,
          pageCount,
          complete: false,
          termination: failure.kind,
          failure,
          fieldDegradation,
          startedAt,
          completedAt: new Date().toISOString(),
          lastResponseObservedAt,
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch (error) {
        // Deliberately BEFORE the `recovered` promotion below. A body this
        // client cannot parse is not evidence that the narrowed request was
        // served — it is evidence of nothing at all — and `recovered: true` is
        // persisted into `meta_raw_snapshots.request_context.pagination` as the
        // claim "Meta refuses these field names".
        return incompletePaginationReceipt({
          rows,
          rowObservedAt,
          pageCount,
          termination: "parse_failure",
          message:
            error instanceof Error ? error.message : "Invalid JSON response.",
          pageUrl: currentUrl,
          httpStatus: response.status,
          attempts: attempt,
          fieldDegradation,
          startedAt,
          lastResponseObservedAt,
        });
      }

      if (
        payload == null ||
        typeof payload !== "object" ||
        !Array.isArray((payload as { data?: unknown }).data)
      ) {
        return incompletePaginationReceipt({
          rows,
          rowObservedAt,
          pageCount,
          termination: "parse_failure",
          message: "Meta collection response did not contain a data array.",
          pageUrl: currentUrl,
          httpStatus: response.status,
          attempts: attempt,
          fieldDegradation,
          startedAt,
          lastResponseObservedAt,
        });
      }
      // The narrowed request was accepted: a 2xx whose envelope carries no
      // Graph error and whose parsed body contains a usable collection. Only
      // now is the narrowing a diagnosis rather than a hypothesis — the same
      // request minus these fields is the one the provider would serve, so the
      // receipt may say the provider refuses them. Every response that does not
      // get this far keeps `recovered: false` and attributes nothing to the
      // field names.
      if (fieldDegradation && !fieldDegradation.recovered) {
        fieldDegradation = { ...fieldDegradation, recovered: true };
      }
      const json = payload as MetaGraphCollectionResponse<TItem>;
      const pageRows = json.data ?? [];
      if (rows.length + pageRows.length > maxRows) {
        return incompletePaginationReceipt({
          rows,
          rowObservedAt,
          pageCount,
          termination: "row_cap",
          message: `Meta pagination exceeded the ${maxRows}-row safety cap.`,
          pageUrl: currentUrl,
          httpStatus: response.status,
          attempts: attempt,
          fieldDegradation,
          startedAt,
          lastResponseObservedAt,
        });
      }
      rows.push(...pageRows);
      rowObservedAt.push(...pageRows.map(() => responseObservedAt));
      pageCount += 1;

      const paging = (payload as { paging?: unknown }).paging;
      if (
        paging != null &&
        (typeof paging !== "object" || Array.isArray(paging))
      ) {
        return incompletePaginationReceipt({
          rows,
          rowObservedAt,
          pageCount,
          termination: "missing_terminal_proof",
          message: "Meta collection paging metadata was malformed.",
          pageUrl: currentUrl,
          httpStatus: response.status,
          attempts: attempt,
          fieldDegradation,
          startedAt,
          lastResponseObservedAt,
        });
      }
      const rawNext =
        paging && typeof paging === "object"
          ? (paging as { next?: unknown }).next
          : undefined;
      if (rawNext != null && (typeof rawNext !== "string" || !rawNext.trim())) {
        return incompletePaginationReceipt({
          rows,
          rowObservedAt,
          pageCount,
          termination: "missing_terminal_proof",
          message: "Meta collection paging.next was not a usable URL.",
          pageUrl: currentUrl,
          httpStatus: response.status,
          attempts: attempt,
          fieldDegradation,
          startedAt,
          lastResponseObservedAt,
        });
      }
      const candidateNext = typeof rawNext === "string" ? rawNext : null;
      if (candidateNext !== null && visitedPageUrls.has(candidateNext)) {
        return incompletePaginationReceipt({
          rows,
          rowObservedAt,
          pageCount,
          termination: "cursor_cycle",
          message:
            "Meta collection paging.next repeated a page URL already fetched.",
          pageUrl: candidateNext,
          httpStatus: response.status,
          attempts: attempt,
          fieldDegradation,
          startedAt,
          lastResponseObservedAt,
        });
      }
      if (candidateNext !== null) visitedPageUrls.add(candidateNext);
      nextUrl = candidateNext;
      break;
    }
  }

  return {
    rows,
    rowObservedAt,
    pageCount,
    complete: true,
    termination: "natural_end",
    failure: null,
    fieldDegradation,
    startedAt,
    completedAt: new Date().toISOString(),
    lastResponseObservedAt,
  };
}

async function fetchPagedCollection<TItem>(
  initialUrl: string,
): Promise<TItem[]> {
  const receipt = await fetchMetaPagedCollectionReceipt<TItem>(initialUrl);
  if (!receipt.complete) {
    throw new MetaGraphRequestError(
      `meta_pagination_incomplete:${receipt.termination}:${receipt.failure?.message ?? "unknown"}`,
      receipt,
    );
  }
  return receipt.rows;
}

/**
 * The fields a recovered narrowing actually cost this capture.
 *
 * Empty unless `recovered` is true: a narrowing that was attempted and did not
 * help dropped nothing from a capture, because there was no capture. See
 * MetaPagedFieldDegradation.
 */
function degradedRequestFields(
  receipt: Pick<MetaPagedCollectionReceipt<unknown>, "fieldDegradation">,
): readonly string[] {
  const degradation = receipt.fieldDegradation;
  return degradation?.recovered ? degradation.droppedFields : [];
}

function receiptCompleteness(
  receipt: MetaPagedCollectionReceipt<unknown>,
  invalidRowCount: number,
): MetaObservationCompleteness {
  if (receipt.complete && invalidRowCount === 0) {
    /*
      A capture that only succeeded because named fields were DROPPED is not a
      complete observation of the endpoint the receipt describes. Pagination
      finished, so `receipt.complete` is true and this used to return
      "complete" — and the rows alongside it carried NULL where the dropped
      fields would have been. The observation then claimed full coverage of a
      response that never contained those fields, and the null was
      indistinguishable from "the provider has no schedule for this campaign".

      "partial" is the existing lane for "this payload proves what it contains
      and nothing about what it omits": the writer never infers absence or a
      scope exit from it, and `error` below carries the degradation receipt
      that names which fields went missing and why.
    */
    return degradedRequestFields(receipt).length > 0 ? "partial" : "complete";
  }
  if (receipt.pageCount === 0 && receipt.rows.length === 0) return "failed";
  return "partial";
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Field-coverage values for the two things a boolean cannot say.
 *
 * `true`/`false` keep their meaning: the response row carried the field, or it
 * answered the request without it. Neither describes a field the request had to
 * DROP to be accepted at all — that row's null is not evidence of absence,
 * because nothing was ever asked. `degraded_not_observed` says exactly that,
 * and `carried_forward` says the value in this row came from an earlier
 * observation rather than from this response.
 */
const META_FIELD_COVERAGE_DEGRADED = "degraded_not_observed";
const META_FIELD_COVERAGE_CARRIED_FORWARD = "carried_forward";

function metaFieldCoverageState(
  row: object,
  graphField: string,
  degradedFields: ReadonlySet<string>,
) {
  if (degradedFields.has(graphField)) return META_FIELD_COVERAGE_DEGRADED;
  return hasOwn(row, graphField);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function paginationReceiptContext(
  receipt: MetaPagedCollectionReceipt<unknown>,
) {
  return {
    pageCount: receipt.pageCount,
    complete: receipt.complete,
    termination: receipt.termination,
    failure: receipt.failure,
    // A capture that only completed after the request was narrowed is not the
    // capture the `fields` alongside this receipt describes. Without this the
    // snapshot would claim schedule coverage the response never carried.
    //
    // Present with `recovered: false` this says only that narrowing was TRIED
    // and did not help; the refusal in `failure` is then the one to chase, and
    // the field names here are not its cause. See MetaPagedFieldDegradation.
    fieldDegradation: receipt.fieldDegradation,
  };
}

/**
 * Which Graph field carries which end of each entity type's schedule, and the
 * state field it lands in.
 *
 * The two edges spell it differently: `campaigns` answers with
 * `start_time`/`stop_time` and `adsets` with `start_time`/`end_time` — the
 * field lists in META_CAMPAIGN_CONFIG_FIELDS and META_ADSET_CONFIG_FIELDS say
 * so. Ads carry no schedule and are absent here on purpose.
 */
const META_SCHEDULE_FIELDS_BY_ENTITY = {
  campaign: {
    start: { graphField: "start_time", stateField: "campaignStartTime" },
    end: { graphField: "stop_time", stateField: "campaignEndTime" },
    lifetimeBudgetField: "campaignLifetimeBudgetRaw",
  },
  adset: {
    start: { graphField: "start_time", stateField: "adsetStartTime" },
    end: { graphField: "end_time", stateField: "adsetEndTime" },
    lifetimeBudgetField: "adsetLifetimeBudgetRaw",
  },
} as const satisfies Partial<
  Record<
    MetaEntityType,
    {
      start: {
        graphField: string;
        stateField: keyof MetaEntityObservationStateInput;
      };
      end: {
        graphField: string;
        stateField: keyof MetaEntityObservationStateInput;
      };
      lifetimeBudgetField: keyof MetaEntityObservationStateInput;
    }
  >
>;

/**
 * What a degradation cost this capture, counted rather than assumed.
 *
 * `unknownCount` is the number the D083 comment on the campaign mapper is
 * about: a lifetime budget without both ends of its schedule cannot be
 * evaluated at all, and `lifetimeBudgetUnknownCount` is how many of those rows
 * this capture is shipping. Downstream this surfaces as
 * `lifetime_schedule_unretained` in lib/meta/budget-fact.ts, which reads as "we
 * never kept it" — so the count is stated HERE, where the cause is known,
 * instead of being rediscovered as a retention failure.
 */
interface MetaScheduleDegradationReceipt {
  droppedFields: string[];
  entityCount: number;
  carriedForwardCount: number;
  unknownCount: number;
  lifetimeBudgetUnknownCount: number;
  /** True when the prior-value read failed, so nothing could be carried. */
  priorStateReadFailed: boolean;
}

/**
 * Restore a schedule the degraded response was not allowed to carry.
 *
 * WHY THIS EXISTS. The state-history reader resolves an entity's current
 * schedule as the newest row for that entity (DISTINCT ON (entity_id) ORDER BY
 * observed_at DESC), and the partial lane writes any row whose state hash
 * differs from the one already there. So a degraded row with a NULL schedule
 * does not merely fail to add a fact — it BECOMES the winner and destroys one
 * the system already had, from a request that never asked for the field. The
 * same shape as the ad-set status recovery below: the fix is to write what is
 * known, not a null.
 *
 * A carried value is marked `carried_forward` in field coverage, so the row
 * says the value came from an earlier observation rather than from this
 * response, and an entity with no prior observation stays
 * `degraded_not_observed` — UNKNOWN, never a silent null.
 *
 * The read is bounded to the entities this response actually returned and only
 * runs when a degradation happened. A failure to read is not allowed to fail
 * the capture: `priorStateReadFailed` records it, and every row then stays
 * explicitly unknown.
 */
async function carryForwardDegradedSchedule(input: {
  businessId: string;
  providerAccountId: string;
  entityType: Exclude<MetaEntityType, "creative">;
  droppedFields: readonly string[];
  states: MetaEntityObservationStateInput[];
  capturedAt: string;
}): Promise<MetaScheduleDegradationReceipt | null> {
  const schedule =
    input.entityType === "campaign" || input.entityType === "adset"
      ? META_SCHEDULE_FIELDS_BY_ENTITY[input.entityType]
      : null;
  if (!schedule) return null;
  const dropped = new Set(input.droppedFields);
  const startDropped = dropped.has(schedule.start.graphField);
  const endDropped = dropped.has(schedule.end.graphField);
  if (!startDropped && !endDropped) return null;
  if (input.states.length === 0) {
    return {
      droppedFields: [...input.droppedFields],
      entityCount: 0,
      carriedForwardCount: 0,
      unknownCount: 0,
      lifetimeBudgetUnknownCount: 0,
      priorStateReadFailed: false,
    };
  }

  let priorStateReadFailed = false;
  const prior = await readMetaEntityStatesAsOf({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    entityType: input.entityType,
    entityIds: input.states.map((state) => state.entityId),
    cutoff: input.capturedAt,
  }).catch(() => {
    priorStateReadFailed = true;
    return [];
  });
  const priorByEntity = new Map<
    string,
    { start: string | null; end: string | null }
  >();
  for (const priorState of prior) {
    // A row the provider stopped returning is not evidence of a schedule.
    if (priorState.presence !== "present") continue;
    priorByEntity.set(priorState.entityId, {
      start:
        input.entityType === "campaign"
          ? priorState.campaignStartTime
          : priorState.adsetStartTime,
      end:
        input.entityType === "campaign"
          ? priorState.campaignEndTime
          : priorState.adsetEndTime,
    });
  }

  let carriedForwardCount = 0;
  let unknownCount = 0;
  let lifetimeBudgetUnknownCount = 0;
  for (const state of input.states) {
    const known = priorByEntity.get(state.entityId) ?? null;
    const coverage: Record<string, unknown> = { ...state.fieldCoverage };
    let carried = false;
    let stillUnknown = false;
    if (startDropped) {
      if (known?.start) {
        state[schedule.start.stateField] = known.start;
        coverage[schedule.start.stateField] =
          META_FIELD_COVERAGE_CARRIED_FORWARD;
        carried = true;
      } else {
        stillUnknown = true;
      }
    }
    if (endDropped) {
      if (known?.end) {
        state[schedule.end.stateField] = known.end;
        coverage[schedule.end.stateField] = META_FIELD_COVERAGE_CARRIED_FORWARD;
        carried = true;
      } else {
        stillUnknown = true;
      }
    }
    state.fieldCoverage = coverage;
    if (carried) carriedForwardCount += 1;
    if (stillUnknown) {
      unknownCount += 1;
      // Only a POSITIVE amount makes the schedule binding. Meta's `"0"` is the
      // sentinel for "this grain does not own the money" — the same reading
      // deriveMetaBudgetOrigin uses — so counting it here would report
      // campaigns as unevaluable that have no lifetime budget to evaluate.
      if (
        classifyAmountField(state[schedule.lifetimeBudgetField]) === "positive"
      ) {
        lifetimeBudgetUnknownCount += 1;
      }
    }
  }

  return {
    droppedFields: [...input.droppedFields],
    entityCount: input.states.length,
    carriedForwardCount,
    unknownCount,
    lifetimeBudgetUnknownCount,
    priorStateReadFailed,
  };
}

/**
 * Everything a status/config capture writes, decided but not yet written.
 *
 * Split out of `persistMetaStatusConfigObservation` so the degradation contract
 * — what completeness a narrowed capture reports, which schedules it carries
 * forward, and what it says about the ones it cannot — is exercisable without a
 * database. The persist function below is this plus the write, so a test
 * driving this drives the shipped decision path rather than a restatement of
 * it.
 */
export async function buildMetaStatusConfigObservation<TItem>(input: {
  credentials: MetaCredentials;
  accountId: string;
  entityType: Exclude<MetaEntityType, "creative">;
  endpoint: string;
  /** ROUND 14: the real `meta_sync_runs.id` of the attempt writing this. */
  syncRunId?: string | null;
  receipt: MetaPagedCollectionReceipt<TItem>;
  sourceSnapshotId: string | null;
  // D086: the sync partition this capture belongs to. Passed through to the
  // append-only observation receipt so the cohort survives run coalescing.
  partitionId: string;
  mapRow: (input: {
    row: TItem;
    responseObservedAt: string;
    capturedAt: string;
    /**
     * Graph fields this response was not allowed to carry, so the mapper can
     * mark them unobserved instead of writing a null that looks observed.
     */
    degradedFields: readonly string[];
  }) => {
    state: MetaEntityObservationStateInput | null;
    relationship?: MetaObservedAdCreativeRelationship | null;
  };
}) {
  const capturedAt = new Date().toISOString();
  const degradedFields = degradedRequestFields(input.receipt);
  const states: MetaEntityObservationStateInput[] = [];
  const relationships: MetaObservedAdCreativeRelationship[] = [];
  let invalidRowCount = 0;
  input.receipt.rows.forEach((row, index) => {
    const mapped = input.mapRow({
      row,
      responseObservedAt:
        input.receipt.rowObservedAt[index] ??
        input.receipt.lastResponseObservedAt ??
        input.receipt.completedAt,
      capturedAt,
      degradedFields,
    });
    if (!mapped.state) {
      invalidRowCount += 1;
      return;
    }
    states.push(mapped.state);
    if (mapped.relationship) relationships.push(mapped.relationship);
  });
  const scheduleDegradation =
    degradedFields.length > 0
      ? await carryForwardDegradedSchedule({
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          entityType: input.entityType,
          droppedFields: degradedFields,
          states,
          capturedAt,
        })
      : null;
  if (scheduleDegradation) {
    // The consequence, said here rather than discovered downstream. Rows whose
    // schedule is now unknown AND that carry a lifetime budget are the ones the
    // D083 note on the campaign mapper says cannot be evaluated at all.
    logRuntimeWarn("meta-graph", "config_schedule_degraded", {
      endpoint: input.endpoint,
      entityType: input.entityType,
      droppedFields: scheduleDegradation.droppedFields,
      entityCount: scheduleDegradation.entityCount,
      carriedForwardCount: scheduleDegradation.carriedForwardCount,
      unknownCount: scheduleDegradation.unknownCount,
      lifetimeBudgetUnknownCount:
        scheduleDegradation.lifetimeBudgetUnknownCount,
      priorStateReadFailed: scheduleDegradation.priorStateReadFailed,
    });
  }
  const completeness = receiptCompleteness(input.receipt, invalidRowCount);
  const error =
    completeness === "complete"
      ? null
      : {
          pagination: paginationReceiptContext(input.receipt),
          invalidRowCount,
          // Only present when a narrowing actually cost this capture fields.
          ...(scheduleDegradation ? { scheduleDegradation } : {}),
        };
  return {
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    entityType: input.entityType,
    endpoint: input.endpoint,
    observedAt:
      input.receipt.lastResponseObservedAt ?? input.receipt.completedAt,
    capturedAt,
    completeness,
    pageCount: input.receipt.pageCount,
    providerRowCount: input.receipt.rows.length,
    states: completeness === "failed" ? [] : states,
    sourceSnapshotId: input.sourceSnapshotId,
    error,
    adCreativeRelationships:
      input.entityType === "ad" ? relationships : undefined,
    captureReceipt: {
      partitionId: input.partitionId,
      /*
        ── ROUND 14, CONTRACT 1 ────────────────────────────────────────────
        The exact attempt. NOT `partitionId` (reused across retries) and NOT
        the observation `runId` (coalesced content shared by many captures).
        A complete receipt commits before `append_current_config_history`, so
        this is the only durable way to ask afterwards whether the attempt
        that produced it actually finished.
      */
      syncRunId: input.syncRunId ?? null,
      sourceSnapshotId: input.sourceSnapshotId,
      /*
        D086 correction 8: the same id, as a REFERENCE the database enforces.
        `source_snapshot_id` mirrors the run's TEXT column and a free string can
        name anything; `persistMetaRawSnapshot` returns a real row id, so the
        receipt carries it typed and foreign-keyed.
      */
      sourceSnapshotRefId: input.sourceSnapshotId,
    },
  };
}

async function persistMetaStatusConfigObservation<TItem>(
  input: Parameters<typeof buildMetaStatusConfigObservation<TItem>>[0],
) {
  return persistMetaEntityObservation(
    await buildMetaStatusConfigObservation(input),
  );
}

// Exported for the D083 seam, which must exercise the real mapper rather
// than hand-building the normalised state it is supposed to prove.
export function mapCampaignObservationState(input: {
  credentials: MetaCredentials;
  accountId: string;
  row: RawCampaign;
  responseObservedAt: string;
  capturedAt: string;
  /**
   * Graph fields the request had to drop to be accepted. Absent for every
   * capture that was served the field list it asked for.
   */
  degradedFields?: readonly string[];
}) {
  const campaignId = optionalString(input.row.id);
  if (!campaignId) return { state: null };
  const degradedFields = new Set(input.degradedFields ?? []);
  const providerUpdatedAt = normalizeMetaProviderUpdatedAt(
    input.row.updated_time,
    input.capturedAt,
  );
  const campaignDailyBudgetRaw = optionalString(input.row.daily_budget);
  const campaignLifetimeBudgetRaw = optionalString(input.row.lifetime_budget);
  return {
    state: {
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      entityType: "campaign" as const,
      entityId: campaignId,
      campaignId,
      adsetId: null,
      adId: null,
      creativeId: null,
      entityName: optionalString(input.row.name),
      configuredStatus: optionalString(input.row.status),
      effectiveStatus: optionalString(input.row.effective_status),
      learningStatus: null,
      learningSource: "not_observed" as const,
      campaignDailyBudgetRaw,
      campaignLifetimeBudgetRaw,
      adsetDailyBudgetRaw: null,
      adsetLifetimeBudgetRaw: null,
      budgetCurrency:
        resolveMetaCurrencyForAccount(input.credentials, input.accountId) ??
        null,
      // D086: the shape IS observed here — both budget fields are requested,
      // so the response either carries a provider amount in a shape we support
      // or states their absence.
      budgetShapeSupport: "supported" as const,
      budgetOrigin: deriveMetaBudgetOrigin("campaign", {
        daily: input.row.daily_budget,
        lifetime: input.row.lifetime_budget,
        requested: true,
      }),
      // D083 — schedule and the exponent in force at capture. A lifetime budget
      // without both ends of its schedule cannot be evaluated at all.
      //
      // Under degradation the response carries neither field, so these are null
      // here and carryForwardDegradedSchedule fills back whatever was observed
      // before. Whatever it cannot fill is counted and reported as a
      // scheduleDegradation receipt on the observation, because THAT is the set
      // of lifetime-budget campaigns this capture makes unevaluable.
      campaignStartTime: optionalString(input.row.start_time),
      campaignEndTime: optionalString(input.row.stop_time),
      adsetStartTime: null,
      adsetEndTime: null,
      providerApiVersion: META_GRAPH_API_VERSION,
      ...metaBudgetCurrencyProvenance(
        resolveMetaCurrencyForAccount(input.credentials, input.accountId),
      ),
      reviewStatus: null,
      policyStatus: null,
      policyReasons: null,
      providerUpdatedAt,
      presence: "present" as const,
      fieldCoverage: {
        configuredStatus: hasOwn(input.row, "status"),
        effectiveStatus: hasOwn(input.row, "effective_status"),
        providerUpdatedAt: hasOwn(input.row, "updated_time"),
        campaignDailyBudgetRaw: hasOwn(input.row, "daily_budget"),
        campaignLifetimeBudgetRaw: hasOwn(input.row, "lifetime_budget"),
        // D083 C2 — exact presence and source truth. The schedule endpoints are
        // response fields; the exponent, registry version and API version are
        // client-known provenance, and are marked as such rather than claimed
        // as Graph fields.
        //
        // A field the request had to drop reports `degraded_not_observed`
        // rather than `false`: the row's null then says "not asked", not "the
        // provider has none". carryForwardDegradedSchedule upgrades it to
        // `carried_forward` for any entity whose schedule was observed before.
        campaignStartTime: metaFieldCoverageState(
          input.row,
          "start_time",
          degradedFields,
        ),
        campaignEndTime: metaFieldCoverageState(
          input.row,
          "stop_time",
          degradedFields,
        ),
        budgetCurrencyExponent: "client_registry",
        budgetCurrencyRegistryVersion: "client_registry",
        providerApiVersion: "client_known",
        policy: false,
        review: false,
        learning: false,
      },
      observedAt: resolveMetaEntityObservedAt({
        providerUpdatedAt: input.row.updated_time,
        responseObservedAt: input.responseObservedAt,
        capturedAt: input.capturedAt,
      }),
    },
  };
}

export function mapAdSetObservationState(input: {
  credentials: MetaCredentials;
  accountId: string;
  row: RawAdSet;
  responseObservedAt: string;
  capturedAt: string;
  /** See the campaign mapper. */
  degradedFields?: readonly string[];
}) {
  const adsetId = optionalString(input.row.id);
  const campaignId = optionalString(input.row.campaign_id);
  if (!adsetId || !campaignId) return { state: null };
  const degradedFields = new Set(input.degradedFields ?? []);
  const providerUpdatedAt = normalizeMetaProviderUpdatedAt(
    input.row.updated_time,
    input.capturedAt,
  );
  const adsetDailyBudgetRaw = optionalString(input.row.daily_budget);
  const adsetLifetimeBudgetRaw = optionalString(input.row.lifetime_budget);
  return {
    state: {
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      entityType: "adset" as const,
      entityId: adsetId,
      campaignId,
      adsetId,
      adId: null,
      creativeId: null,
      entityName: optionalString(input.row.name),
      configuredStatus: optionalString(input.row.status),
      effectiveStatus: optionalString(input.row.effective_status),
      learningStatus: null,
      learningSource: "not_observed" as const,
      campaignDailyBudgetRaw: null,
      campaignLifetimeBudgetRaw: null,
      adsetDailyBudgetRaw,
      adsetLifetimeBudgetRaw,
      budgetCurrency:
        resolveMetaCurrencyForAccount(input.credentials, input.accountId) ??
        null,
      budgetShapeSupport: "supported" as const,
      budgetOrigin: deriveMetaBudgetOrigin("adset", {
        requested: true,
        daily: input.row.daily_budget,
        lifetime: input.row.lifetime_budget,
      }),
      // D083 — see the campaign mapper.
      campaignStartTime: null,
      campaignEndTime: null,
      adsetStartTime: optionalString(input.row.start_time),
      adsetEndTime: optionalString(input.row.end_time),
      providerApiVersion: META_GRAPH_API_VERSION,
      ...metaBudgetCurrencyProvenance(
        resolveMetaCurrencyForAccount(input.credentials, input.accountId),
      ),
      reviewStatus: null,
      policyStatus: null,
      policyReasons: null,
      providerUpdatedAt,
      presence: "present" as const,
      fieldCoverage: {
        configuredStatus: hasOwn(input.row, "status"),
        effectiveStatus: hasOwn(input.row, "effective_status"),
        providerUpdatedAt: hasOwn(input.row, "updated_time"),
        adsetDailyBudgetRaw: hasOwn(input.row, "daily_budget"),
        adsetLifetimeBudgetRaw: hasOwn(input.row, "lifetime_budget"),
        // D083 C2 — see the campaign mapper.
        adsetStartTime: metaFieldCoverageState(
          input.row,
          "start_time",
          degradedFields,
        ),
        adsetEndTime: metaFieldCoverageState(
          input.row,
          "end_time",
          degradedFields,
        ),
        budgetCurrencyExponent: "client_registry",
        budgetCurrencyRegistryVersion: "client_registry",
        providerApiVersion: "client_known",
        learning: false,
        policy: false,
        review: false,
      },
      observedAt: resolveMetaEntityObservedAt({
        providerUpdatedAt: input.row.updated_time,
        responseObservedAt: input.responseObservedAt,
        capturedAt: input.capturedAt,
      }),
    },
  };
}

function mapAdObservationState(input: {
  credentials: MetaCredentials;
  accountId: string;
  row: RawAd;
  responseObservedAt: string;
  capturedAt: string;
}) {
  const adId = optionalString(input.row.id);
  const campaignId = optionalString(input.row.campaign_id);
  const adsetId = optionalString(input.row.adset_id);
  if (!adId || !campaignId || !adsetId) return { state: null };
  const creativeId = optionalString(input.row.creative?.id);
  const providerUpdatedAt = normalizeMetaProviderUpdatedAt(
    input.row.updated_time,
    input.capturedAt,
  );
  const providerCreatedAt = normalizeMetaProviderUpdatedAt(
    input.row.created_time,
    input.responseObservedAt,
  );
  return {
    state: {
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      entityType: "ad" as const,
      entityId: adId,
      campaignId,
      adsetId,
      adId,
      creativeId,
      entityName: optionalString(input.row.name),
      configuredStatus: optionalString(input.row.status),
      effectiveStatus: optionalString(input.row.effective_status),
      learningStatus: null,
      learningSource: "not_observed" as const,
      campaignDailyBudgetRaw: null,
      campaignLifetimeBudgetRaw: null,
      adsetDailyBudgetRaw: null,
      adsetLifetimeBudgetRaw: null,
      budgetCurrency:
        resolveMetaCurrencyForAccount(input.credentials, input.accountId) ??
        null,
      budgetOrigin: "not_applicable" as const,
      reviewStatus: null,
      policyStatus: null,
      policyReasons: null,
      providerUpdatedAt,
      presence: "present" as const,
      fieldCoverage: {
        configuredStatus: hasOwn(input.row, "status"),
        effectiveStatus: hasOwn(input.row, "effective_status"),
        providerUpdatedAt: hasOwn(input.row, "updated_time"),
        campaignId: hasOwn(input.row, "campaign_id"),
        adsetId: hasOwn(input.row, "adset_id"),
        creativeId: hasOwn(input.row, "creative"),
        policy: false,
        review: false,
        learning: false,
      },
      observedAt: resolveMetaEntityObservedAt({
        providerUpdatedAt: input.row.updated_time,
        responseObservedAt: input.responseObservedAt,
        capturedAt: input.capturedAt,
      }),
    },
    relationship:
      creativeId && providerCreatedAt
        ? { adId, creativeId, providerCreatedAt }
        : null,
  };
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
  referenceToday?: string | null,
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
  const daySpan =
    Number.isFinite(start) && Number.isFinite(end)
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
      getTodayIsoForTimeZone(accountTimezone),
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
        /*
          NEVER THE PROVIDER'S PROSE (Codex B15).

          This wrote `error.message` verbatim, so a Graph URL carrying
          `access_token` — which this module puts in the query string, and
          which an undici `fetch failed` carries in `cause` — reached durable
          storage through a field nobody thinks of as user data.
          `formatMetaFailureForStorage` consumes the raw text once to classify
          it and emits only locally authored words plus Graph's own structured
          identifiers.
        */
        lastError: formatMetaFailureForStorage({ error }),
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
    accountCurrency: resolveMetaCurrencyForAccount(
      input.credentials,
      input.accountId,
    ),
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
const META_MEMORY_FLUSH_THRESHOLD_ROWS =
  Number(process.env.META_MEMORY_FLUSH_THRESHOLD_ROWS ?? 20_000) || 20_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUsageMaxPercent(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value))
    return value.reduce(
      (max, item) => Math.max(max, parseUsageMaxPercent(item)),
      0,
    );
  if (value && typeof value === "object") {
    return Object.values(value).reduce(
      (max, item) => Math.max(max, parseUsageMaxPercent(item)),
      0,
    );
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

function parseMetaBusinessUsageHeader(
  headers: Headers,
): MetaBusinessUsageSummary {
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
  const url = new URL(
    `https://graph.facebook.com/v25.0/${input.accountId}/insights`,
  );
  url.searchParams.set("level", "ad");
  url.searchParams.set(
    "fields",
    "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,reach,frequency,spend,ctr,cpm,impressions,clicks,actions,action_values,purchase_roas",
  );
  url.searchParams.set(
    "time_range",
    JSON.stringify({ since: input.since, until: input.until }),
  );
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
  const url = new URL(
    `https://graph.facebook.com/v25.0/${input.accountId}/insights`,
  );
  url.searchParams.set("level", "ad");
  // `reach` and `frequency` are requested for the same reason the core insights
  // URL above requests them: the warehouse has columns for both and was filling
  // them with 0 and null because nothing ever asked. Their absence was a field
  // list, never a provider limitation.
  url.searchParams.set(
    "fields",
    "ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,spend,ctr,cpm,impressions,clicks,reach,frequency,actions,action_values,purchase_roas",
  );
  url.searchParams.set("breakdowns", input.breakdowns);
  url.searchParams.set(
    "time_range",
    JSON.stringify({ since: input.since, until: input.until }),
  );
  url.searchParams.set("limit", String(META_BULK_PAGE_LIMIT));
  if (
    input.positiveSpendAdIds.length > 0 &&
    input.positiveSpendAdIds.length <= 200
  ) {
    url.searchParams.set(
      "filtering",
      JSON.stringify([
        { field: "ad.id", operator: "IN", value: input.positiveSpendAdIds },
      ]),
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

async function upsertOwnedMetaCheckpointOrThrow(
  input: MetaSyncCheckpointRecord,
) {
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

async function upsertOwnedMetaPhaseTimingOrThrow(
  input: MetaSyncPhaseTimingRecord,
) {
  const timingId = await upsertMetaSyncPhaseTiming(input);
  if (input.leaseOwner && !timingId) {
    throw new Error("lease_conflict:phase_timing_write_rejected");
  }
  return timingId;
}

/**
 * One page of a BULK insights walk, refused as a typed, sanitized failure.
 *
 * THE TWO DEFECTS THIS CLOSES. Both refusal paths — the HTTP error and the 2xx
 * Graph error envelope — used to `throw new Error(json.error?.message ?? ...)`.
 * That is the provider's own prose, verbatim, on an object carrying nothing an
 * automated caller can branch on:
 *
 *   1. NOTHING STRUCTURED. `lib/sync/meta-error-classification.ts` classifies
 *      on `errorCode` / `errorSubcode` / `isTransient` / `httpStatus`, which a
 *      plain `Error` does not have, so an expired token and a rate limit
 *      arrived at the partition failure path indistinguishable from each other
 *      and from a bug in this file. The receipt-based walk
 *      (`fetchMetaPagedCollectionReceipt`) has classified these correctly for
 *      a long time; the bulk walk simply never adopted it.
 *   2. RAW PROVIDER TEXT. Graph error messages routinely quote the request —
 *      including, on some edges, the query string — and this module's own rule
 *      is that a message names the STATUS and never quotes Meta's text
 *      (`sanitizeMetaPageUrl`, and the failure messages built beside it). The
 *      message thrown here reached `lib/sync/meta-sync.ts`, which wrote
 *      `error.message` into durable `error_message` / `last_error` columns and
 *      into logs.
 *
 * So the body is now consumed ONCE as text, classified with the SAME two
 * helpers the receipt walk uses (`readMetaGraphErrorIdentity` for the
 * identifiers, `hasMetaGraphErrorEnvelope` for presence — a refusal that
 * arrives without identifiers is still a refusal), and refused as a
 * `MetaGraphRequestError` whose message is built from the status and the
 * numeric codes. Core and breakdown pagination call this same function, so the
 * two walks cannot drift apart.
 */
async function fetchMetaPagedJson<TItem>(
  url: string,
  context: {
    pageIndex: number;
    stage: string;
    visitedPageUrls?: Set<string>;
  } = {
    pageIndex: 0,
    stage: "meta_bulk_page",
  },
) {
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
      throw new Error(
        `Meta request timed out after ${META_FETCH_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  }
  /*
    Read as TEXT, exactly once. A Response body cannot be consumed twice, and
    the classification below needs the same bytes the parse does. The previous
    `response.json().catch(() => ({}))` also swallowed an unparseable refusal
    into an empty object, which then read as an empty page.
  */
  const rawBody = await response.text().catch(() => "");
  const identity = readMetaGraphErrorIdentity(rawBody);
  /*
    A 2xx carrying a Graph `error` object is a refusal, and it has to be
    classified BEFORE `data` is read. It used to fall through to the caller,
    where `json.data ?? []` turned the refusal into an empty page and
    `json.paging?.next ?? null` ended the walk — so the bulk core sync would
    finish a day having fetched nothing, write ad-days built from zero provider
    rows, and report success. An empty page and a refused page are opposite
    facts; only one of them may terminate a capture.
  */
  const refusedByEnvelope = response.ok && hasMetaGraphErrorEnvelope(rawBody);

  if (!response.ok || refusedByEnvelope) {
    const kind: MetaPaginationFailure["kind"] = refusedByEnvelope
      ? "error_envelope"
      : "http_failure";
    logRuntimeWarn("meta-graph", "bulk_page_rejected", {
      stage: context.stage,
      httpStatus: response.status,
      errorCode: identity.errorCode,
      errorSubcode: identity.errorSubcode,
      isTransient: identity.isTransient,
      // Re-applied at the boundary that PRINTS it, not because the parse is
      // untrusted but because a log line must not be able to inherit an unsafe
      // value from a future caller that builds an identity another way.
      fbtraceId: sanitizeMetaGraphTraceId(identity.fbtraceId),
      pageIndex: context.pageIndex,
      refusedByEnvelope,
    });
    const failure: MetaPaginationFailure = {
      kind,
      message: refusedByEnvelope
        ? `Meta bulk page returned status ${response.status} with a Graph error envelope.`
        : `Meta bulk page failed with status ${response.status}.`,
      pageIndex: context.pageIndex,
      pageUrl: sanitizeMetaPageUrl(url),
      httpStatus: response.status,
      errorCode: identity.errorCode,
      errorSubcode: identity.errorSubcode,
      isTransient: identity.isTransient,
      fbtraceId: identity.fbtraceId,
      attempts: 1,
    };
    throw new MetaGraphRequestError(
      // Status and codes only. The provider's prose is deliberately absent:
      // this message is written to durable columns and to logs.
      `meta_bulk_page_${kind}:status=${response.status}:code=${identity.errorCode ?? "none"}:subcode=${identity.errorSubcode ?? "none"}`,
      { termination: kind, failure },
    );
  }

  let parsed: unknown;
  let parseFailureReason:
    | "empty_body"
    | "invalid_json"
    | "non_object_json"
    | "missing_data_array"
    | null = null;
  if (rawBody.trim() === "") {
    parseFailureReason = "empty_body";
  } else {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parseFailureReason = "invalid_json";
    }
  }
  if (
    parseFailureReason === null &&
    (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
  ) {
    parseFailureReason = "non_object_json";
  }
  if (
    parseFailureReason === null &&
    !Array.isArray((parsed as { data?: unknown }).data)
  ) {
    parseFailureReason = "missing_data_array";
  }
  if (parseFailureReason !== null) {
    /*
      An unusable 2xx body is not an empty page. In particular, coercing a
      malformed LATER page to `{}` makes `paging.next` disappear and promotes
      the already-fetched prefix to a complete authoritative capture. Mirror
      the receipt walk's parse boundary: classify the shape, retain no body
      prose, and throw before either bulk caller can checkpoint or write it.
    */
    logRuntimeWarn("meta-graph", "bulk_page_rejected", {
      stage: context.stage,
      httpStatus: response.status,
      errorCode: null,
      errorSubcode: null,
      isTransient: null,
      fbtraceId: null,
      pageIndex: context.pageIndex,
      refusedByEnvelope: false,
      termination: "parse_failure",
      parseFailureReason,
    });
    const failure: MetaPaginationFailure = {
      kind: "parse_failure",
      message: "Meta bulk page response was not a usable collection.",
      pageIndex: context.pageIndex,
      pageUrl: sanitizeMetaPageUrl(url),
      httpStatus: response.status,
      errorCode: null,
      errorSubcode: null,
      isTransient: null,
      fbtraceId: null,
      attempts: 1,
    };
    throw new MetaGraphRequestError(
      `meta_bulk_page_parse_failure:status=${response.status}:code=none:subcode=none`,
      { termination: "parse_failure", failure },
    );
  }
  const paging = (parsed as { paging?: unknown }).paging;
  let pagingFailureReason:
    | "paging_not_object"
    | "paging_next_not_nonempty_string"
    | null = null;
  if (
    paging != null &&
    (typeof paging !== "object" || Array.isArray(paging))
  ) {
    pagingFailureReason = "paging_not_object";
  }
  const rawNext =
    paging && typeof paging === "object"
      ? (paging as { next?: unknown }).next
      : undefined;
  if (rawNext != null && (typeof rawNext !== "string" || !rawNext.trim())) {
    pagingFailureReason = "paging_next_not_nonempty_string";
  }
  if (pagingFailureReason !== null) {
    /*
      Rows without trustworthy paging metadata are a prefix, not a complete
      collection. Reject the page before the bulk caller can checkpoint its
      rows or turn the malformed terminal claim into an authoritative slice.
    */
    logRuntimeWarn("meta-graph", "bulk_page_rejected", {
      stage: context.stage,
      httpStatus: response.status,
      errorCode: null,
      errorSubcode: null,
      isTransient: null,
      fbtraceId: null,
      pageIndex: context.pageIndex,
      refusedByEnvelope: false,
      termination: "missing_terminal_proof",
      pagingFailureReason,
    });
    const failure: MetaPaginationFailure = {
      kind: "missing_terminal_proof",
      message: "Meta bulk page did not contain usable paging metadata.",
      pageIndex: context.pageIndex,
      pageUrl: sanitizeMetaPageUrl(url),
      httpStatus: response.status,
      errorCode: null,
      errorSubcode: null,
      isTransient: null,
      fbtraceId: null,
      attempts: 1,
    };
    throw new MetaGraphRequestError(
      `meta_bulk_page_missing_terminal_proof:status=${response.status}:code=none:subcode=none`,
      { termination: "missing_terminal_proof", failure },
    );
  }
  const candidateNext = typeof rawNext === "string" ? rawNext : null;
  if (
    candidateNext !== null &&
    context.visitedPageUrls?.has(candidateNext)
  ) {
    logRuntimeWarn("meta-graph", "bulk_page_rejected", {
      stage: context.stage,
      httpStatus: response.status,
      errorCode: null,
      errorSubcode: null,
      isTransient: null,
      fbtraceId: null,
      pageIndex: context.pageIndex,
      refusedByEnvelope: false,
      termination: "cursor_cycle",
    });
    const failure: MetaPaginationFailure = {
      kind: "cursor_cycle",
      message: "Meta bulk page repeated a page URL already fetched.",
      pageIndex: context.pageIndex,
      pageUrl: sanitizeMetaPageUrl(candidateNext),
      httpStatus: response.status,
      errorCode: null,
      errorSubcode: null,
      isTransient: null,
      fbtraceId: null,
      attempts: 1,
    };
    throw new MetaGraphRequestError(
      `meta_bulk_page_cursor_cycle:status=${response.status}:code=none:subcode=none`,
      { termination: "cursor_cycle", failure },
    );
  }
  if (candidateNext !== null) {
    context.visitedPageUrls?.add(candidateNext);
  }
  const json = parsed as MetaGraphCollectionResponse<TItem> & {
    error?: { message?: string };
  };
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
  /**
   * Running link-click total, and OPTIONAL on purpose.
   *
   * Every other member starts at 0 because 0 is the identity for a sum. This
   * one cannot: 0 is also a value Meta actually reports, so an aggregate that
   * started at 0 could never again distinguish "the provider measured no link
   * clicks" from "the provider told us nothing". `undefined` is the identity
   * here — it means no contributing row carried a measurement yet — and
   * `accumulateAdInsight` promotes it to a number the first time one does.
   * `deriveWarehouseMetrics` resolves it to `number | null` for the warehouse.
   */
  linkClicks?: number;
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
  },
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
  // Accumulated exactly like spend and clicks above: one addition per visited
  // row, into the same per-entity target. That is what makes the count safe
  // across pages without any de-duplication of its own — see the
  // no-double-count note on `applyAdInsightRowsToAggregates`.
  //
  // The null arm is a skip, not a zero: a row Meta reported no actions for
  // must not drag an ad's measured total down, and must not by itself turn an
  // unmeasured ad into a measured zero.
  const rowLinkClicks = readMetaLinkClicksFromInsight(row);
  if (rowLinkClicks !== null) {
    target.linkClicks = (target.linkClicks ?? 0) + rowLinkClicks;
  }
  const frequency = parseNum(row.frequency);
  if (frequency > 0 && metrics.impressions > 0) {
    target.frequencySum =
      (target.frequencySum ?? 0) + frequency * metrics.impressions;
    target.frequencyWeight =
      (target.frequencyWeight ?? 0) + metrics.impressions;
  }
}

function deriveWarehouseMetrics(
  input: MetaAggregateTotals & {
    frequencySum?: number;
    frequencyWeight?: number;
  },
) {
  const frequency =
    (input.frequencyWeight ?? 0) > 0
      ? r2((input.frequencySum ?? 0) / Math.max(1, input.frequencyWeight ?? 0))
      : null;
  const ctr =
    input.impressions > 0 ? r2((input.clicks / input.impressions) * 100) : null;
  const cpc = input.clicks > 0 ? r2(input.spend / input.clicks) : null;
  const cpa =
    input.conversions > 0 ? r2(input.spend / input.conversions) : null;
  const roas = input.spend > 0 ? r2(input.revenue / input.spend) : 0;
  return {
    frequency,
    ctr,
    cpc,
    cpa,
    roas,
    // The one place the optional running total becomes the warehouse's
    // `number | null`. `undefined` (no contributing row carried a measurement)
    // and `0` (at least one row did, and it measured zero) are kept apart all
    // the way to the column.
    linkClicks: input.linkClicks ?? null,
  };
}

/**
 * Folds ONE page of Graph ad-level insight rows into the running aggregates.
 *
 * WHY LINK CLICKS CANNOT BE DOUBLE-COUNTED ACROSS PAGES.
 *
 * The property is not a new one to defend; it is spend's property, and link
 * clicks inherit it by construction. This function is the only caller of
 * `accumulateAdInsight`, and `syncMetaAccountCoreWarehouseDay` is the only
 * caller of this function. That sync applies each page exactly once and from
 * two disjoint sources: the restored raw snapshots for the run (the
 * `restore_raw_pages` sub-stage), and then the pages fetched from the cursor
 * the restore left off at (`fetch_source_pages`) — `resolveMetaRawSnapshotFetchUrl`
 * / `resolveMetaRawSnapshotResumeState` exist precisely so the fetch resumes
 * after the restored frontier instead of re-reading it. The bulk sync seeds
 * `visitedPageUrls` from that restored chain and passes it to every page fetch,
 * where `cursor_cycle` stops a provider cursor that points backwards before
 * the repeated response can be recorded or applied.
 *
 * So each provider row is visited once, and every metric here is a single
 * addition per visit into a map keyed by entity id. If a page ever WERE applied
 * twice, spend, impressions, clicks and link clicks would all double together;
 * there is no path that doubles link clicks alone, because there is no
 * link-click-specific traversal, cache or merge anywhere in the fold.
 */
function applyAdInsightRowsToAggregates(
  rows: RawAdInsight[],
  aggregates: {
    account: MetaAggregateTotals & {
      frequencySum?: number;
      frequencyWeight?: number;
    };
    campaigns: Map<
      string,
      MetaAggregateTotals & {
        name?: string | null;
        status?: string | null;
        frequencySum?: number;
        frequencyWeight?: number;
      }
    >;
    adsets: Map<
      string,
      MetaAggregateTotals & {
        campaignId?: string | null;
        name?: string | null;
        status?: string | null;
        frequencySum?: number;
        frequencyWeight?: number;
      }
    >;
    ads: Map<
      string,
      MetaAggregateTotals & {
        campaignId?: string | null;
        adsetId?: string | null;
        name?: string | null;
        status?: string | null;
        reach?: number;
        frequencySum?: number;
        frequencyWeight?: number;
        payloadJson?: unknown;
      }
    >;
  },
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
    campaigns: Map<
      string,
      MetaAggregateTotals & {
        name?: string | null;
        status?: string | null;
        frequencySum?: number;
        frequencyWeight?: number;
      }
    >;
  },
  campaignId: string,
  options?: {
    name?: string | null;
    status?: string | null;
  },
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
    adsets: Map<
      string,
      MetaAggregateTotals & {
        campaignId?: string | null;
        name?: string | null;
        status?: string | null;
        frequencySum?: number;
        frequencyWeight?: number;
      }
    >;
  },
  adsetId: string,
  options?: {
    campaignId?: string | null;
    name?: string | null;
    status?: string | null;
  },
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
    campaigns: Map<
      string,
      MetaAggregateTotals & {
        name?: string | null;
        status?: string | null;
        frequencySum?: number;
        frequencyWeight?: number;
      }
    >;
    adsets: Map<
      string,
      MetaAggregateTotals & {
        campaignId?: string | null;
        name?: string | null;
        status?: string | null;
        frequencySum?: number;
        frequencyWeight?: number;
      }
    >;
  },
  input: {
    campaignConfigs: Map<string, RawCampaign>;
    adsetConfigs: Map<string, RawAdSet>;
  },
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
        status: campaign?.effective_status ?? campaign?.status ?? null,
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
      if (config.objective != null && row.objective == null)
        missingFields.push("objective");
      if (
        (config.bid_strategy != null ||
          config.bid_amount != null ||
          config.bid_constraints?.roas_average_floor != null) &&
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
        campaignName:
          row.campaignNameCurrent ?? row.campaignNameHistorical ?? null,
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
      const campaignConfig = row.campaignId
        ? (input.campaignConfigs.get(row.campaignId) ?? null)
        : null;
      if (!adsetConfig && !campaignConfig) return null;
      const missingFields: string[] = [];
      if (
        adsetConfig?.optimization_goal != null &&
        row.optimizationGoal == null
      ) {
        missingFields.push("optimizationGoal");
      }
      if (
        (adsetConfig?.bid_strategy != null ||
          adsetConfig?.bid_amount != null ||
          adsetConfig?.bid_constraints?.roas_average_floor != null ||
          campaignConfig?.bid_strategy != null ||
          campaignConfig?.bid_amount != null ||
          campaignConfig?.bid_constraints?.roas_average_floor != null) &&
        row.bidStrategyLabel == null
      ) {
        missingFields.push("bidStrategyLabel");
      }
      if (
        (adsetConfig?.daily_budget != null ||
          adsetConfig?.lifetime_budget != null ||
          campaignConfig?.daily_budget != null ||
          campaignConfig?.lifetime_budget != null) &&
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
  /**
   * ROUND 14: the real `meta_sync_runs.id` for this attempt, distinct from
   * `sourceRunId` (which defaults to the partition id and correlates
   * OBSERVATION runs). Threaded from `processMetaPartition`.
   */
  syncRunId?: string | null;
  /**
   * ── ROUND 19, ITEM A1 ────────────────────────────────────────────────────
   * The DB-bound provider-local today, resolved ONCE by `syncMetaPartitionDay`
   * from the `business_provider_accounts` -> `provider_accounts` binding.
   *
   * `accountToday` below was recomputed from `credentials.accountProfiles`,
   * so the partition's truthState/bootstrap could be reasoning about one
   * calendar while the current-evidence gate and the receipt writer used
   * another — the credential zone and the binding zone are different sources
   * and do disagree. Supplied means "use this"; absent keeps the credential
   * fallback for callers that have no binding at all.
   */
  providerLocalToday?: string | null;
  source?: string | null;
}): Promise<MetaBulkCoreSyncResult> {
  const normalizedDay = normalizeMetaApiDate(input.day);
  const profile = input.credentials.accountProfiles[input.accountId];
  const accountCurrency = requireMetaCurrencyForWarehouseWrite(
    input.credentials,
    input.accountId,
    "core_warehouse",
  );
  /*
    ROUND 19, ITEM A1: the caller's DB-bound date wins. The credential-profile
    computation stays only as the fallback for a caller that resolved none.
  */
  const accountToday =
    input.providerLocalToday ??
    getTodayIsoForTimeZone(profile?.timezone ?? "UTC");
  const truthState =
    input.truthState ??
    (normalizedDay === accountToday ? "provisional" : "finalized");
  /**
   * The one current-evidence decision for this work unit.
   *
   * Declared once here, outside the fetch substage, so the config-snapshot
   * writer, the daily writers' `appendConfigHistory`, and the entity
   * observation writer all read the same answer and cannot drift apart. See
   * lib/meta/current-evidence-gate.ts for why they must agree.
   */
  const currentEvidence = decideMetaCurrentEvidence({
    truthState,
    normalizedDay,
    accountToday,
  });
  const persistsCurrentConfigEvidence =
    currentEvidence.persistsCurrentConfigEvidence;
  const finalizedAt =
    truthState === "finalized" ? new Date().toISOString() : null;
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
  let restoredPages: Awaited<ReturnType<typeof listMetaRawSnapshotsForRun>> =
    [];
  const aggregates = {
    account: createEmptyTotals() as MetaAggregateTotals & {
      frequencySum?: number;
      frequencyWeight?: number;
    },
    campaigns: new Map<
      string,
      MetaAggregateTotals & {
        name?: string | null;
        status?: string | null;
        frequencySum?: number;
        frequencyWeight?: number;
      }
    >(),
    adsets: new Map<
      string,
      MetaAggregateTotals & {
        campaignId?: string | null;
        name?: string | null;
        status?: string | null;
        frequencySum?: number;
        frequencyWeight?: number;
      }
    >(),
    ads: new Map<
      string,
      MetaAggregateTotals & {
        campaignId?: string | null;
        adsetId?: string | null;
        name?: string | null;
        status?: string | null;
        reach?: number;
        frequencySum?: number;
        frequencyWeight?: number;
        payloadJson?: unknown;
      }
    >(),
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
      const observedPages = input.freshStart
        ? []
        : await listMetaRawSnapshotsForRun({
            partitionId: input.partitionId,
            endpointName,
            runId: sourceRunId,
          });
      restoredPages = selectLatestMetaRawSnapshotGeneration(observedPages);
      const restoreState = resolveMetaRawSnapshotResumeState({
        pages: restoredPages,
        checkpoint,
      });
      restoredPages = restoreState.pages;
      for (const rawPage of restoredPages) {
        const payload = Array.isArray(rawPage.payload_json)
          ? (rawPage.payload_json as RawAdInsight[])
          : [];
        applyAdInsightRowsToAggregates(payload, aggregates);
        captureMemorySnapshot();
      }
      rowsFetchedTotal = restoredPages.reduce((sum, page) => {
        const payload = Array.isArray(page.payload_json)
          ? page.payload_json.length
          : 0;
        return sum + payload;
      }, 0);
      latestSnapshotId = restoredPages.at(-1)?.id ?? null;
    },
  });

  const restoreState = resolveMetaRawSnapshotResumeState({
    pages: restoredPages,
    checkpoint,
  });
  const initialPageUrl = buildMetaBulkCoreInsightsUrl({
    accountId: input.accountId,
    accessToken: input.credentials.accessToken,
    since: normalizedDay,
    until: normalizedDay,
  });
  // When the resume rewound to the durable raw frontier, the checkpoint's own
  // cursor must NOT be used: it points one page past the page that never
  // landed, so following it would skip that page's rows without any error.
  // The last durable page's cursor is the one that re-fetches the gap.
  let nextPageUrl: string | null = restoreState.rewoundToDurableFrontier
    ? restoreState.resumeCursor
    : resolveMetaRawSnapshotFetchUrl({
        checkpoint,
        initialPageUrl,
      });
  const visitedPageUrls = new Set<string>([
    initialPageUrl,
    ...restoredPages.flatMap((page) =>
      page.provider_cursor ? [page.provider_cursor] : [],
    ),
  ]);
  if (nextPageUrl) visitedPageUrls.add(nextPageUrl);
  let pageIndex = restoreState.nextPageIndex;
  let throttleCount = 0;
  let lastUsagePercent = 0;
  const coreCheckpointStartedAt =
    checkpoint?.startedAt ?? new Date().toISOString();
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
    rowsFetched:
      checkpoint?.rowsFetched ??
      restoredPages.reduce((sum, page) => {
        const payload = Array.isArray(page.payload_json)
          ? page.payload_json.length
          : 0;
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
          leaseMinutes:
            input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
        });
        const fetchHeartbeat = startMetaFetchHeartbeat({
          partitionId: input.partitionId,
          workerId: input.workerId,
          leaseEpoch: input.leaseEpoch,
          leaseMinutes:
            input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
        });
        let pageResult: {
          response: Response;
          json: MetaGraphCollectionResponse<RawAdInsight> & {
            error?: { message?: string };
          };
        };
        try {
          pageResult = await fetchMetaPagedJson<RawAdInsight>(nextPageUrl, {
            pageIndex,
            stage: "syncMetaAccountCoreWarehouseDay.fetch_source_pages",
            visitedPageUrls,
          });
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
            rows.at(-1)?.ad_id ??
            rows.at(-1)?.adset_id ??
            rows.at(-1)?.campaign_id ??
            null,
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
        if (
          usageSummary.maxPercent >= META_USAGE_THROTTLE_THRESHOLD &&
          nextPageUrl
        ) {
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
  /**
   * When the provider actually returned this account's current configuration.
   *
   * `captured_at` is part of the config-history arbiter, so this is the value
   * that decides whether a repeat observation coalesces or appends. It is only
   * ever set from a real receipt; there is no fallback, because a fabricated
   * timestamp is precisely the fact this table exists to record.
   */
  let currentCampaignConfigReceipt: {
    complete: boolean;
    observedAt: string;
  } | null = null;
  let currentAdsetConfigReceipt: {
    complete: boolean;
    observedAt: string;
  } | null = null;
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
      // Current inventory is an ACCOUNT-CURRENT unit, not a per-day one.
      //
      // These three endpoints have no date filter: they return what the account
      // looks like NOW. A historical partition asking them does two wrong things
      // at once — it spends three provider calls per backfilled day, and it then
      // enriches that day's facts with configuration that did not exist then.
      // Suppressing only the durable writes fixed the second half of the storage
      // problem and none of the rest.
      //
      // So on any day that is not the account's own provisional today —
      // historical, finalized, backfill, repair, replay — this makes ZERO
      // provider calls and leaves the config maps empty. Downstream enrichment
      // already treats a missing config as null, which is the truthful answer
      // for a past day.
      if (!currentEvidence.persistsEntityObservations) {
        return;
      }
      // The account-current unit gets its own capacity admission. It is the only
      // place current inventory is fetched, and it writes the raw evidence,
      // observations and typed config history that follow from it.
      await assertSyncGrowthBoundary("meta_account_current_inventory", {
        fresh: true,
      });
      const [campaignReceipt, adsetReceipt, adReceipt] = await Promise.all([
        fetchMetaCampaignConfigsReceipt(
          input.accountId,
          input.credentials.accessToken,
        ),
        fetchMetaAdSetConfigsReceipt(
          input.accountId,
          input.credentials.accessToken,
        ),
        fetchMetaAdConfigsReceipt(
          input.accountId,
          input.credentials.accessToken,
        ),
      ]);
      // Current inventory, recorded ONLY on a current provisional day.
      //
      // These three endpoints have no date filter: they return the account's
      // CURRENT campaigns, ad sets and ads. Recording them with
      // since = until = the historical day being backfilled invented a
      // date-scoped identity for content that has no date. Raw content identity
      // includes the window, so a 365-day backfill wrote 1,095 canonical rows
      // per account whose payloads were byte-identical — the same amplification
      // the observation gate below already closed, one layer down in the raw
      // tables the evidence census did not cover.
      //
      // The rows are still FETCHED and used in memory to enrich this day's
      // metric facts. What stops is treating a historical partition as evidence
      // about today's inventory.
      const [campaignSnapshotId, adsetSnapshotId, adSnapshotId] =
        !currentEvidence.persistsEntityObservations
          ? [null, null, null]
          : await Promise.all([
              recordMetaRawSnapshot({
                credentials: input.credentials,
                accountId: input.accountId,
                endpointName: "campaign_configs",
                entityScope: "campaign",
                // D086: the config snapshots were the only raw pages recorded
                // without their partition, so nothing linked a capture receipt
                // back to the payload it was mapped from.
                partitionId: input.partitionId,
                since: normalizedDay,
                until: normalizedDay,
                payload: campaignReceipt.rows,
                status: campaignReceipt.complete ? "fetched" : "failed",
                providerHttpStatus: campaignReceipt.complete
                  ? 200
                  : (campaignReceipt.failure?.httpStatus ?? null),
                requestContext: {
                  fields: META_CAMPAIGN_CONFIG_FIELDS,
                  source: "bulk_core_sync",
                  pagination: paginationReceiptContext(campaignReceipt),
                },
              }),
              recordMetaRawSnapshot({
                credentials: input.credentials,
                accountId: input.accountId,
                endpointName: "adset_configs",
                entityScope: "adset",
                // D086: the config snapshots were the only raw pages recorded
                // without their partition, so nothing linked a capture receipt
                // back to the payload it was mapped from.
                partitionId: input.partitionId,
                since: normalizedDay,
                until: normalizedDay,
                payload: adsetReceipt.rows,
                status: adsetReceipt.complete ? "fetched" : "failed",
                providerHttpStatus: adsetReceipt.complete
                  ? 200
                  : (adsetReceipt.failure?.httpStatus ?? null),
                requestContext: {
                  fields: META_ADSET_CONFIG_FIELDS,
                  source: "bulk_core_sync",
                  pagination: paginationReceiptContext(adsetReceipt),
                },
              }),
              recordMetaRawSnapshot({
                credentials: input.credentials,
                accountId: input.accountId,
                endpointName: "ad_configs",
                entityScope: "ad",
                // D086: the config snapshots were the only raw pages recorded
                // without their partition, so nothing linked a capture receipt
                // back to the payload it was mapped from.
                partitionId: input.partitionId,
                since: normalizedDay,
                until: normalizedDay,
                payload: adReceipt.rows,
                status: adReceipt.complete ? "fetched" : "failed",
                providerHttpStatus: adReceipt.complete
                  ? 200
                  : (adReceipt.failure?.httpStatus ?? null),
                requestContext: {
                  fields: META_AD_CONFIG_FIELDS,
                  source: "bulk_core_sync",
                  pagination: paginationReceiptContext(adReceipt),
                },
              }),
            ]);
      // These write entity observation RUNS and STATES. The run identity
      // includes capturedAt, which is `now()`, so every historical day of a
      // backfill produced a brand-new run and a fresh state row per entity —
      // dedupe only ever applied within a single run. That is the remaining
      // source of meta_entity_state_history growth, and it is evidence about
      // the CURRENT inventory, so it belongs only to a current provisional day.
      // The rows above are still fetched and used in memory to enrich this
      // day's metric facts; they are simply not recorded as observations.
      if (currentEvidence.persistsEntityObservations) {
        await Promise.all([
          persistMetaStatusConfigObservation({
            credentials: input.credentials,
            accountId: input.accountId,
            entityType: "campaign",
            endpoint: "campaign_configs",
            syncRunId: input.syncRunId ?? null,
            receipt: campaignReceipt,
            sourceSnapshotId: campaignSnapshotId,
            partitionId: input.partitionId,
            mapRow: ({ row, responseObservedAt, capturedAt, degradedFields }) =>
              mapCampaignObservationState({
                credentials: input.credentials,
                accountId: input.accountId,
                row,
                responseObservedAt,
                capturedAt,
                degradedFields,
              }),
          }),
          persistMetaStatusConfigObservation({
            credentials: input.credentials,
            accountId: input.accountId,
            entityType: "adset",
            endpoint: "adset_configs",
            syncRunId: input.syncRunId ?? null,
            receipt: adsetReceipt,
            sourceSnapshotId: adsetSnapshotId,
            partitionId: input.partitionId,
            mapRow: ({ row, responseObservedAt, capturedAt, degradedFields }) =>
              mapAdSetObservationState({
                credentials: input.credentials,
                accountId: input.accountId,
                row,
                responseObservedAt,
                capturedAt,
                degradedFields,
              }),
          }),
          persistMetaStatusConfigObservation({
            credentials: input.credentials,
            accountId: input.accountId,
            entityType: "ad",
            endpoint: "ad_configs",
            syncRunId: input.syncRunId ?? null,
            receipt: adReceipt,
            sourceSnapshotId: adSnapshotId,
            partitionId: input.partitionId,
            mapRow: ({ row, responseObservedAt, capturedAt }) =>
              mapAdObservationState({
                credentials: input.credentials,
                accountId: input.accountId,
                row,
                responseObservedAt,
                capturedAt,
              }),
          }),
        ]);
      }
      // The real observation time of EACH level's configuration, taken from its
      // OWN receipt. Campaign and adset config come from two separate responses
      // observed at two different instants; stamping the campaign receipt's
      // timestamp onto adset history recorded when the campaigns were fetched as
      // when the ad sets were, and `captured_at` is part of the arbiter.
      //
      // Completeness travels with it: a partial page set is missing entities,
      // and absence is indistinguishable from deletion to a later reader.
      currentCampaignConfigReceipt = {
        complete: campaignReceipt.complete,
        observedAt:
          campaignReceipt.lastResponseObservedAt ?? campaignReceipt.completedAt,
      };
      currentAdsetConfigReceipt = {
        complete: adsetReceipt.complete,
        observedAt: adsetReceipt.lastResponseObservedAt ?? adsetReceipt.completedAt,
      };
      campaignConfigs = new Map(
        campaignReceipt.rows.map((campaign) => [campaign.id, campaign]),
      );
      campaignStatuses = new Map(
        campaignReceipt.rows.map((campaign) => [
          campaign.id,
          campaign.effective_status ?? campaign.status ?? "UNKNOWN",
        ]),
      );
      adsetConfigs = new Map(
        adsetReceipt.rows.map((adset) => [adset.id, adset]),
      );
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
  let canonicalSourceDrift: {
    sourceSpend: number;
    rebuiltAccountSpend: number;
    rebuiltCampaignSpend: number;
    toleranceApplied: number;
  } | null = null;
  let accountProof: ReturnType<
    typeof createMetaFinalizationCompletenessProof
  > | null = null;
  let campaignProof: ReturnType<
    typeof createMetaFinalizationCompletenessProof
  > | null = null;
  let adsetProof: ReturnType<
    typeof createMetaFinalizationCompletenessProof
  > | null = null;
  let adProof: ReturnType<
    typeof createMetaFinalizationCompletenessProof
  > | null = null;
  let incompleteCampaignTruth: ReturnType<
    typeof collectIncompleteCampaignTruth
  > = [];
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

      // Same recovery the campaign rows get below: an ad set the config
      // response did not return still has a status in `meta_entity_state_history`,
      // and writing null instead lets the active filter drop a spending row.
      const recoveredAdsetStatuses = new Map<string, string>();
      const missingStatusAdsetIds = Array.from(aggregates.adsets.keys()).filter(
        (adsetId) => {
          const config = adsetConfigs.get(adsetId) ?? null;
          return !config?.effective_status && !config?.status;
        },
      );
      if (missingStatusAdsetIds.length > 0) {
        const recorded = await readMetaEntityStatesAsOf({
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          entityType: "adset",
          entityIds: missingStatusAdsetIds,
          cutoff: new Date(),
        }).catch(() => []);
        for (const state of recorded) {
          if (state.presence !== "present") continue;
          const status = state.effectiveStatus ?? state.configuredStatus;
          if (status) recoveredAdsetStatuses.set(state.entityId, status);
        }
      }

      adsetRows = Array.from(aggregates.adsets.entries()).map(
        ([adsetId, value]): MetaAdSetDailyRow => {
          const metrics = deriveWarehouseMetrics(value);
          const campaignId = value.campaignId ?? null;
          const campaignConfig = campaignId
            ? (campaignConfigs.get(campaignId) ?? null)
            : null;
          const adsetConfig = adsetConfigs.get(adsetId) ?? null;
          const configPayload = buildMetaAdSetConfigPayload({
            campaignId: campaignId ?? "",
            adset: adsetConfig,
            campaignConfig,
            latestSnapshot: latestAdsetSnapshots.get(adsetId) ?? null,
            latestCampaignSnapshot: campaignId
              ? (latestCampaignSnapshots.get(campaignId) ?? null)
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
            adsetStatus:
              adsetConfig?.effective_status ??
              adsetConfig?.status ??
              recoveredAdsetStatuses.get(adsetId) ??
              null,
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
            accountCurrency,
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
        },
      );
      // A campaign the config response did not return still has a status the
      // system recorded — `persistMetaStatusConfigObservation` writes it to
      // `meta_entity_state_history` from the same fetch. Writing null instead
      // made "we did not see it this run" indistinguishable from "it has no
      // status", and the active filter then dropped those rows from every
      // rollup: on one account the five campaigns carrying 95% of the spend
      // were exactly the five the response missed, so the Decision Center
      // reported ROAS 0.00 for an account spending over $1k a day.
      const missingStatusCampaignIds = Array.from(aggregates.campaigns.keys())
        .filter((campaignId) => !campaignStatuses.has(campaignId));
      if (missingStatusCampaignIds.length > 0) {
        const recorded = await readMetaEntityStatesAsOf({
          businessId: input.credentials.businessId,
          providerAccountId: input.accountId,
          entityType: "campaign",
          entityIds: missingStatusCampaignIds,
          cutoff: new Date(),
        }).catch(() => []);
        for (const state of recorded) {
          // `presence` distinguishes an entity we last saw present from one the
          // provider stopped returning; only a present one carries a status we
          // may still claim.
          if (state.presence !== "present") continue;
          const status = state.effectiveStatus ?? state.configuredStatus;
          if (status) campaignStatuses.set(state.entityId, status);
        }
      }

      campaignRows = Array.from(aggregates.campaigns.entries()).map(
        ([campaignId, value]) => {
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
              accountCurrency,
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
            latestCampaignSnapshot:
              latestCampaignSnapshots.get(campaignId) ?? null,
            adsetPayloads: adsetPayloadsByCampaign.get(campaignId) ?? [],
          });
        },
      );
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
          accountCurrency,
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
          /**
           * MEASURED where Meta measured it, null only where Meta said nothing.
           *
           * The history of this line is worth keeping, because both of its
           * previous values were wrong in opposite directions.
           *
           * It was a literal `0` first. Nothing in the sync held a link-click
           * value at any point, so that `0` was a number typed into this file
           * on the provider's behalf — a fabrication, not a measurement. And
           * because this function is the ONLY production writer of
           * `meta_ad_daily.link_clicks` (`upsertMetaAdDailyRows` refuses any
           * caller without `writeMode: "authoritative_fact"`, and the two call
           * sites that pass it — the direct upsert and `replaceMetaAdDailySlice`
           * — are both fed from `adRows` here), every ad-day the sync wrote
           * carried the fabrication.
           *
           * It then became an unconditional `null`, which stopped the
           * fabrication but published a second untruth: that Meta had reported
           * nothing, on rows where Meta had reported a count all along. Read
           * over the read-only production tunnel on 2026-09-07, the column is
           * NULL for all 2,327 rows of 2026-09 and 0-or-NULL for all 11,948
           * rows of 2026-08, against 7,666 positive rows in 2026-03 — while the
           * `payload_json` beside those same rows carries 8,640 `link_click`
           * action entries for 2026-08-01 onwards. A native Refresh verdict
           * needs a link-click denominator, so a column that is null on every
           * current row blocks that verdict on every ad.
           *
           * `metrics.linkClicks` is the third answer and the only measured one:
           * `readMetaLinkClicksFromInsight` reads the `actions` array's
           * `link_click` entry per provider row, `accumulateAdInsight` sums it
           * per ad across pages, and `deriveWarehouseMetrics` resolves the
           * running total to `number | null`. Null now means exactly what the
           * warehouse merge already assumes it means: no contributing row
           * carried a measurement, so
           * `link_clicks = COALESCE(EXCLUDED.link_clicks, meta_ad_daily.link_clicks)`
           * leaves whatever was previously measured alone instead of erasing it.
           *
           * This DOES change the numbers the Decision Engine reads — that is
           * the point of the change, not a side effect of it. Readers that
           * coalesce an absent count to 0 (the null-safety notes in
           * `creative-decision-engine/jobs/ad-calibration-job.ts`, the
           * `SUM(COALESCE(link_clicks, 0))` aggregates in `data-source.ts`) now
           * see the provider's own count where one exists, and the presence
           * sidecar in `lib/meta/creatives-warehouse.ts` still reports
           * "unavailable" for the ad-days where it genuinely does not.
           */
          linkClicks: metrics.linkClicks,
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
          accountCurrency,
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
          !withinMetaTruthTolerance(
            finalizedSourceAccountSpend,
            rebuiltAccountSpend,
          ) ||
          !withinMetaTruthTolerance(
            finalizedSourceAccountSpend,
            rebuiltCampaignSpend,
          )
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
      accountProof =
        truthState === "finalized"
          ? createMetaFinalizationCompletenessProof({
              businessId: input.credentials.businessId,
              providerAccountId: input.accountId,
              date: normalizedDay,
              scope: "account",
              sourceRunId,
              complete:
                accountRows.length === 1 &&
                (campaignRows.length > 0 || zeroSpendFinalizedDay),
              validationStatus,
            })
          : null;
      campaignProof =
        truthState === "finalized"
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
      adsetProof =
        truthState === "finalized" && adsetRows.length > 0
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
      adProof =
        truthState === "finalized"
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
      const sourceManifest = authoritativeFinalizationV2Enabled
        ? await createMetaAuthoritativeSourceManifest({
            businessId: input.credentials.businessId,
            providerAccountId: input.accountId,
            day: normalizedDay,
            surface: "account_daily",
            accountTimezone: profile?.timezone ?? "UTC",
            sourceKind:
              input.source ?? (input.freshStart ? "finalize_day" : "recent"),
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
      const accountSliceVersion = authoritativeFinalizationV2Enabled
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
      const campaignSliceVersion = authoritativeFinalizationV2Enabled
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
      const adsetSliceVersion = authoritativeFinalizationV2Enabled
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
      const adSliceVersion = authoritativeFinalizationV2Enabled
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
      if (
        incompleteCampaignTruth.length > 0 ||
        incompleteAdSetTruth.length > 0
      ) {
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
          `Meta core truth incomplete for ${normalizedDay}: campaigns=${incompleteCampaignTruth.length}, adsets=${incompleteAdSetTruth.length}`,
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
    lastSuccessfulEntityKey:
      adRows.at(-1)?.adId ??
      adsetRows.at(-1)?.adsetId ??
      campaignRows.at(-1)?.campaignId ??
      null,
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
            await replaceMetaCampaignDailySlice({
              rows: campaignRows,
              proof: campaignProof,
            });
          } else {
            await upsertMetaCampaignDailyRows(campaignRows, {
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
      stage: "syncMetaAccountCoreWarehouseDay.write_adset_daily",
      run: async () => {
        if (truthState === "finalized") {
          if (adsetProof) {
            await replaceMetaAdSetDailySlice({
              rows: adsetRows,
              proof: adsetProof,
            });
          } else if (adsetRows.length > 0) {
            await upsertMetaAdSetDailyRows(adsetRows, {
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
      stage: "syncMetaAccountCoreWarehouseDay.write_ad_daily",
      run: async () => {
        if (truthState === "finalized") {
          if (adProof) {
            await replaceMetaAdDailySlice({ rows: adRows, proof: adProof });
          } else if (adRows.length > 0) {
            await upsertMetaAdDailyRows(adRows, {
              writeMode: "authoritative_fact",
            });
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
        persistsCurrentConfigEvidence
          ? await persistMetaCampaignConfigSnapshots({
              businessId: input.credentials.businessId,
              accountId: input.accountId,
              campaignConfigs,
              entityIds: campaignRows.map((row) => row.campaignId),
            })
          : 0;
    },
  });
  if (
    truthState === "finalized" &&
    persistsCurrentConfigEvidence &&
    campaignRows.length > 0 &&
    persistedCampaignConfigCount === 0
  ) {
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
            row.campaignId != null
              ? (campaignConfigs.get(row.campaignId) ?? null)
              : null;
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
      // Same inversion as campaign snapshots above: current adset inventory
      // must not be appended as config history for a historical effective day.
      if (persistsCurrentConfigEvidence && adsetSnapshotRows.length > 0) {
        await appendMetaConfigSnapshots(adsetSnapshotRows);
      }
    },
  });
  // Typed campaign and adset config history for the CURRENT provisional day.
  //
  // This is a first-class write, not a side effect of a finalized daily write.
  // The `appendConfigHistory` option threaded through the daily writers could
  // never fire: those writers run only when `truthState === "finalized"`, and
  // current evidence is permitted only on the account's own local today declared
  // PROVISIONAL. Two mutually exclusive conditions, so both typed config-history
  // tables received nothing at all.
  //
  // The write is driven off the same rows the daily path builds and stamped with
  // the receipt's real observation time, so it shares the daily path's canonical
  // semantic records and fingerprint. Failures propagate.
  let currentConfigHistoryWritten = {
    campaignRowsWritten: 0,
    adsetRowsWritten: 0,
    campaignSkippedIncompleteReceipt: false,
    adsetSkippedIncompleteReceipt: false,
  };
  await captureMetaAccountCoreSubStage({
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    partitionId: input.partitionId,
    scope: partitionScope,
    lane: partitionLane,
    source: partitionSource,
    day: normalizedDay,
    stage: "syncMetaAccountCoreWarehouseDay.append_current_config_history",
    run: async () => {
      if (!currentEvidence.persistsCurrentConfigEvidence) return;
      if (!currentCampaignConfigReceipt || !currentAdsetConfigReceipt) {
        // Current evidence was permitted but no receipt recorded an observation
        // time. That is a contradiction, not a reason to invent one.
        throw new Error(
          "meta_current_config_history_missing_observed_at:" +
            `${input.credentials.businessId}:${input.accountId}:${normalizedDay}`,
        );
      }
      currentConfigHistoryWritten = await appendMetaCurrentConfigHistory({
        campaignRows,
        adsetRows,
        campaignReceipt: currentCampaignConfigReceipt,
        adsetReceipt: currentAdsetConfigReceipt,
      });
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
      ? accountRows.length +
        campaignRows.length +
        adsetRows.length +
        adRows.length
      : 0) +
    persistedCampaignConfigCount +
    (truthState === "finalized" ? adsetSnapshotRows.length : 0) +
    currentConfigHistoryWritten.campaignRowsWritten +
    currentConfigHistoryWritten.adsetRowsWritten;
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
    const reconciliationEventInput =
      driftForEvent != null
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
        publicationReason: input.freshStart
          ? "authoritative_refresh"
          : "authoritative_finalize",
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
        publicationReason: input.freshStart
          ? "authoritative_refresh"
          : "authoritative_finalize",
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
        publicationReason: input.freshStart
          ? "authoritative_refresh"
          : "authoritative_finalize",
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
        publicationReason: input.freshStart
          ? "authoritative_refresh"
          : "authoritative_finalize",
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
      const [accountDailyCheckpoint, adsetDailyCheckpoint, adDailyCheckpoint] =
        await Promise.all([
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
        leaseMinutes:
          input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
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
          startedAt:
            accountDailyCheckpoint?.startedAt ?? coreCheckpointStartedAt,
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
      positiveSpendAdIds = adRows
        .filter((row) => row.spend > 0)
        .map((row) => row.adId);
      await heartbeatOwnedMetaPartitionLeaseOrThrow({
        partitionId: input.partitionId,
        workerId: input.workerId,
        leaseEpoch: input.leaseEpoch,
        leaseMinutes:
          input.leaseMinutes ?? DEFAULT_META_PARTITION_LEASE_MINUTES,
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
        rowsWritten:
          accountRows.length +
          campaignRows.length +
          adsetRows.length +
          adRows.length,
        lastSuccessfulEntityKey:
          positiveSpendAdIds.at(-1) ?? adRows.at(-1)?.adId ?? null,
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

/**
 * One fetch, one type per DIMENSION it actually carries.
 *
 * `age,gender` is a two-dimensional Meta breakdown, and this function used to
 * answer `"age"` for it. That single answer is what destroyed the split: every
 * gender row was keyed by its age bucket alone, so `18-24 / female` and
 * `18-24 / male` merged into one `18-24` row and no reader could ever take them
 * apart again. Returning BOTH types lets the same raw rows be aggregated twice,
 * once per dimension, into two independent identities.
 *
 * `age` is still first and still means exactly what it meant — existing `age`
 * rows keep their keys, their labels and their values.
 */
function getMetaBreakdownTypesFromInput(
  breakdowns: string,
): MetaBreakdownType[] {
  if (breakdowns === "breakdown_age" || breakdowns === "age,gender")
    return ["age", "gender"];
  if (breakdowns === "breakdown_country" || breakdowns === "country")
    return ["country"];
  return ["placement"];
}

function buildMetaBreakdownIdentity(
  breakdownType: MetaBreakdownType,
  row: RawBreakdownInsight,
) {
  if (breakdownType === "age") {
    const age = String(row.age ?? "unknown");
    return { breakdownKey: age, breakdownLabel: age };
  }
  if (breakdownType === "gender") {
    // Keyed on the OTHER dimension of the same row. Meta reports `unknown` as a
    // real bucket, so an absent value falls into the same bucket rather than
    // being dropped — dropping it would silently shrink account spend.
    const gender = String(row.gender ?? "unknown");
    return { breakdownKey: gender, breakdownLabel: gender };
  }
  if (breakdownType === "country") {
    const country = String(row.country ?? "unknown");
    return { breakdownKey: country, breakdownLabel: country };
  }
  const parts = [
    row.publisher_platform,
    row.platform_position,
    row.impression_device,
  ]
    .filter(Boolean)
    .map((value) => String(value));
  const label = parts.join(" • ") || "Unknown";
  const key = parts.join("|") || "unknown";
  return { breakdownKey: key, breakdownLabel: label };
}

/**
 * A reach Meta reported, or `null`.
 *
 * Never a fallback to impressions. The core insights path does
 * `parseNum(row.reach ?? row.impressions)`, which makes frequency identically
 * 1.0 for any row missing reach — a fabricated measurement that reads as a
 * plausible one. Breakdown rows refuse that: a missing, unparseable or negative
 * reach is "not measured", and every metric derived from it is null.
 */
function parseMetaBreakdownMeasuredReach(
  row: RawBreakdownInsight,
): number | null {
  if (row.reach == null) return null;
  const parsed = Number(row.reach);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function buildMetaBreakdownDailyRows(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  accountCurrency: string;
  breakdownType: MetaBreakdownType;
  rows: RawBreakdownInsight[];
  sourceRunId: string;
}) {
  const byKey = new Map<
    string,
    {
      spend: number;
      impressions: number;
      clicks: number;
      /**
       * `null` until a raw row in this bucket actually reported a reach.
       *
       * The old code seeded this to 0 unconditionally, which is how an
       * unmeasured dimension became a measured "zero people reached". Meta
       * omits `reach` for rows it did not measure, so absence stays absent.
       *
       * Summing reach across the ad rows inside one bucket over-counts anyone
       * who saw two ads — the same known over-count the ad-set and account
       * aggregations in `lib/meta/serving.ts` already accept, reused here on
       * purpose rather than replaced with a second, differently-wrong rule.
       */
      reach: number | null;
      frequency: number | null;
      conversions: number;
      revenue: number;
      roas: number;
      cpa: number | null;
      ctr: number | null;
      cpc: number | null;
      breakdownLabel: string;
    }
  >();
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
    const measuredReach = parseMetaBreakdownMeasuredReach(row);
    const existing = byKey.get(identity.breakdownKey);
    if (existing) {
      existing.spend = r2(existing.spend + metrics.spend);
      existing.impressions += metrics.impressions;
      existing.clicks += metrics.clicks;
      existing.reach =
        measuredReach == null
          ? existing.reach
          : (existing.reach ?? 0) + measuredReach;
      existing.frequency = deriveMetaFrequencyFromReach({
        impressions: existing.impressions,
        reach: existing.reach,
      });
      existing.conversions += metrics.purchases;
      existing.revenue = r2(existing.revenue + metrics.revenue);
      existing.roas =
        existing.spend > 0 ? r2(existing.revenue / existing.spend) : 0;
      existing.cpa =
        existing.conversions > 0
          ? r2(existing.spend / existing.conversions)
          : null;
      existing.ctr =
        existing.impressions > 0
          ? r2((existing.clicks / existing.impressions) * 100)
          : null;
      existing.cpc =
        existing.clicks > 0 ? r2(existing.spend / existing.clicks) : null;
    } else {
      byKey.set(identity.breakdownKey, {
        breakdownLabel: identity.breakdownLabel,
        spend: metrics.spend,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        reach: measuredReach,
        frequency: deriveMetaFrequencyFromReach({
          impressions: metrics.impressions,
          reach: measuredReach,
        }),
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
  const accountCurrency = requireMetaCurrencyForWarehouseWrite(
    input.credentials,
    input.accountId,
    "breakdown_warehouse",
  );
  const authoritativeFinalizationV2Enabled =
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(
      input.credentials.businessId,
    );
  const referenceToday = normalizeMetaApiDate(
    input.referenceToday ?? getTodayIsoForTimeZone(profile?.timezone ?? null),
  );
  const checkpoint = await getMetaSyncCheckpoint({
    partitionId: input.partitionId,
    checkpointScope,
    runId: sourceRunId,
  });
  const observedPages = await listMetaRawSnapshotsForRun({
    partitionId: input.partitionId,
    endpointName: input.endpointName,
    runId: sourceRunId,
  });
  const restoredPages = selectLatestMetaRawSnapshotGeneration(observedPages);
  const restoreState = resolveMetaRawSnapshotResumeState({
    pages: restoredPages,
    checkpoint,
  });
  const restoredRows: RawBreakdownInsight[] = [];
  for (const rawPage of restoreState.pages) {
    restoredRows.push(...(rawPage.payload_json as RawBreakdownInsight[]));
  }
  const initialPageUrl = buildMetaBreakdownInsightsUrl({
    accountId: input.accountId,
    accessToken: input.credentials.accessToken,
    since: normalizedDay,
    until: normalizedDay,
    breakdowns: input.breakdowns,
    positiveSpendAdIds: input.positiveSpendAdIds,
  });
  // The raw page generation is the durable prefix. If the checkpoint landed
  // before its page receipt, rewind to the last durable cursor; otherwise
  // resume from the checkpoint while rebuilding the transform input from all
  // raw pages already recorded for this run.
  let nextPageUrl: string | null = restoreState.rewoundToDurableFrontier
    ? restoreState.resumeCursor
    : resolveMetaRawSnapshotFetchUrl({ checkpoint, initialPageUrl });
  const visitedPageUrls = new Set<string>([
    initialPageUrl,
    ...restoreState.pages.flatMap((page) =>
      page.provider_cursor ? [page.provider_cursor] : [],
    ),
  ]);
  if (nextPageUrl) visitedPageUrls.add(nextPageUrl);
  let pageIndex = restoreState.nextPageIndex;
  let rowsFetchedTotal = restoredRows.length;
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
      json: MetaGraphCollectionResponse<RawBreakdownInsight> & {
        error?: { message?: string };
      };
    };
    try {
      pageResult = await fetchMetaPagedJson<RawBreakdownInsight>(nextPageUrl, {
        pageIndex,
        stage: "syncMetaAccountBreakdownWarehouseDay.fetch_source_pages",
        visitedPageUrls,
      });
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
        filteredSpendAds:
          input.positiveSpendAdIds.length > 0 &&
          input.positiveSpendAdIds.length <= 200,
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
    if (
      usageSummary.maxPercent >= META_USAGE_THROTTLE_THRESHOLD &&
      nextPageUrl
    ) {
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

  // ONE fetch, one slice PER DIMENSION it carries. `age,gender` produces an
  // age-typed slice and a gender-typed slice from the same raw rows; the other
  // breakdowns produce exactly the one slice they always did. Each slice is
  // replaced under its own type, so the age slice is byte-for-byte what it was
  // before gender existed.
  const breakdownTypes = getMetaBreakdownTypesFromInput(input.breakdowns);
  const breakdownSlices = breakdownTypes.map((breakdownType) => ({
    breakdownType,
    rows: buildMetaBreakdownDailyRows({
      businessId: input.credentials.businessId,
      providerAccountId: input.accountId,
      date: normalizedDay,
      accountTimezone: profile?.timezone ?? "UTC",
      accountCurrency,
      breakdownType,
      rows: restoredRows,
      sourceRunId,
    }),
  }));
  const breakdownRowsWritten = breakdownSlices.reduce(
    (total, slice) => total + slice.rows.length,
    0,
  );
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
  for (const breakdownSlice of breakdownSlices) {
    await replaceMetaBreakdownDailySlice({
      slice: {
        businessId: input.credentials.businessId,
        providerAccountId: input.accountId,
        date: normalizedDay,
        breakdownType: breakdownSlice.breakdownType,
      },
      rows: breakdownSlice.rows,
      proof: breakdownProof,
    });
  }
  await upsertOwnedMetaPhaseTimingOrThrow({
    partitionId: input.partitionId,
    businessId: input.credentials.businessId,
    providerAccountId: input.accountId,
    timingScope: bulkUpsertTimingScope,
    runId: sourceRunId,
    phase: "bulk_upsert",
    status: "succeeded",
    rowsFetched: rowsFetchedTotal,
    rowsWritten: breakdownRowsWritten,
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
    rowsWritten: breakdownRowsWritten,
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
  const totalBreakdownRows = (await getDb()`
      SELECT COUNT(*)::int AS count
      FROM meta_breakdown_daily
      WHERE business_id = ${input.credentials.businessId}
        AND provider_account_id = ${input.accountId}
        AND date = ${normalizedDay}
    `) as Array<{ count: number | string }>;
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
  dimension: "day" | "week" | "month",
): Promise<MetaTimeBreakdownRow[]> {
  const timeIncrement =
    dimension === "month" ? "monthly" : dimension === "week" ? "7" : "1";

  const byDate = new Map<string, MetaTimeBreakdownRow>();

  await Promise.all(
    credentials.accountIds.map(async (accountId) => {
      const url = new URL(
        `https://graph.facebook.com/v25.0/${accountId}/insights`,
      );
      url.searchParams.set("level", "campaign");
      url.searchParams.set(
        "fields",
        "date_start,spend,ctr,cpm,impressions,clicks,actions,action_values,purchase_roas",
      );
      url.searchParams.set("time_range", JSON.stringify({ since, until }));
      url.searchParams.set("time_increment", timeIncrement);
      url.searchParams.set("limit", "500");
      url.searchParams.set("access_token", credentials.accessToken);

      try {
        const res = await fetchWithTimeout(
          url.toString(),
          { cache: "no-store" },
          { timeoutMs: META_FETCH_TIMEOUT_MS, label: "Meta request" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          data?: Array<RawCampaignInsight & { date_start?: string }>;
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
    }),
  );

  return Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

// ── getCampaigns ──────────────────────────────────────────────────────────────

async function fetchCampaignStatuses(
  credentials: MetaCredentials,
  accountId: string,
  accessToken: string,
): Promise<Map<string, string>> {
  const receipt = await fetchMetaCampaignStatusReceipt(accountId, accessToken);
  const today = new Date().toISOString().slice(0, 10);
  await recordMetaRawSnapshot({
    credentials,
    accountId,
    endpointName: "campaign_statuses",
    entityScope: "campaign",
    since: today,
    until: today,
    payload: receipt.rows,
    status: receipt.complete ? "fetched" : "failed",
    providerHttpStatus: receipt.failure?.httpStatus ?? null,
    requestContext: {
      fields: "id,name,effective_status,status,updated_time",
      pagination: paginationReceiptContext(receipt),
    },
  });
  if (!receipt.complete) {
    throw new MetaGraphRequestError(
      `meta_campaign_statuses_incomplete:${receipt.termination}`,
      receipt,
    );
  }
  return new Map(
    receipt.rows.map((campaign) => [
      campaign.id,
      campaign.effective_status ?? campaign.status ?? "UNKNOWN",
    ]),
  );
}

export async function fetchMetaCampaignStatusReceipt(
  accountId: string,
  accessToken: string,
) {
  const url = new URL(
    `https://graph.facebook.com/v25.0/${accountId}/campaigns`,
  );
  url.searchParams.set(
    "fields",
    "id,name,effective_status,status,updated_time",
  );
  url.searchParams.set("limit", "200");
  url.searchParams.set("access_token", accessToken);
  return fetchMetaPagedCollectionReceipt<RawCampaign>(url.toString());
}

export async function fetchMetaCampaignConfigs(
  credentials: MetaCredentials,
  accountId: string,
  accessToken: string,
  options?: { recordRawSnapshots?: boolean },
): Promise<Map<string, RawCampaign>> {
  const receipt = await fetchMetaCampaignConfigsReceipt(accountId, accessToken);
  const today = new Date().toISOString().slice(0, 10);
  // Capture by default, because the sync path uses this to capture. A read-only
  // caller passes false: this is current inventory keyed by today, and appending
  // it on every page load is a write the caller did not ask for.
  if (options?.recordRawSnapshots !== false)
    await recordMetaRawSnapshot({
      credentials,
      accountId,
      endpointName: "campaign_configs",
      entityScope: "campaign",
      since: today,
      until: today,
      payload: receipt.rows,
      status: receipt.complete ? "fetched" : "failed",
      providerHttpStatus: receipt.failure?.httpStatus ?? null,
      requestContext: {
        fields: META_CAMPAIGN_CONFIG_FIELDS,
        pagination: paginationReceiptContext(receipt),
      },
    });
  if (!receipt.complete) {
    throw new MetaGraphRequestError(
      `meta_campaign_configs_incomplete:${receipt.termination}`,
      receipt,
    );
  }
  return new Map(receipt.rows.map((campaign) => [campaign.id, campaign]));
}

export async function fetchMetaCampaignConfigsReceipt(
  accountId: string,
  accessToken: string,
) {
  const url = new URL(
    `https://graph.facebook.com/v25.0/${accountId}/campaigns`,
  );
  url.searchParams.set("fields", META_CAMPAIGN_CONFIG_FIELDS);
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", accessToken);
  return fetchMetaPagedCollectionReceipt<RawCampaign>(url.toString(), {
    optionalFields: META_CAMPAIGN_SCHEDULE_FIELDS,
  });
}

export async function fetchMetaAdSetConfigs(
  accountId: string,
  accessToken: string,
): Promise<Map<string, RawAdSet>> {
  const receipt = await fetchMetaAdSetConfigsReceipt(accountId, accessToken);
  if (!receipt.complete) {
    throw new MetaGraphRequestError(
      `meta_adset_configs_incomplete:${receipt.termination}`,
      receipt,
    );
  }
  return new Map(receipt.rows.map((row) => [row.id, row]));
}

export async function fetchMetaAdSetConfigsReceipt(
  accountId: string,
  accessToken: string,
) {
  const adsetConfigUrl = new URL(
    `https://graph.facebook.com/v25.0/${accountId}/adsets`,
  );
  adsetConfigUrl.searchParams.set("fields", META_ADSET_CONFIG_FIELDS);
  adsetConfigUrl.searchParams.set("limit", "500");
  adsetConfigUrl.searchParams.set("access_token", accessToken);
  return fetchMetaPagedCollectionReceipt<RawAdSet>(adsetConfigUrl.toString());
}

export async function fetchMetaAdConfigsReceipt(
  accountId: string,
  accessToken: string,
) {
  const adConfigUrl = new URL(
    `https://graph.facebook.com/v25.0/${accountId}/ads`,
  );
  adConfigUrl.searchParams.set("fields", META_AD_CONFIG_FIELDS);
  adConfigUrl.searchParams.set("limit", "500");
  adConfigUrl.searchParams.set("access_token", accessToken);
  return fetchMetaPagedCollectionReceipt<RawAd>(adConfigUrl.toString());
}

export async function fetchMetaActiveAdConfigsReceipt(
  accountId: string,
  accessToken: string,
) {
  const adConfigUrl = new URL(
    `https://graph.facebook.com/v25.0/${accountId}/ads`,
  );
  adConfigUrl.searchParams.set("fields", META_ACTIVE_AD_CONFIG_FIELDS);
  adConfigUrl.searchParams.set("limit", "500");
  adConfigUrl.searchParams.set(
    "filtering",
    JSON.stringify([
      { field: "effective_status", operator: "IN", value: ["ACTIVE"] },
    ]),
  );
  adConfigUrl.searchParams.set("access_token", accessToken);
  return fetchMetaPagedCollectionReceipt<RawAd>(adConfigUrl.toString());
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
  accessToken: string,
): Promise<RawCampaignInsight[]> {
  const url = new URL(`https://graph.facebook.com/v25.0/${accountId}/insights`);
  url.searchParams.set("level", "campaign");
  url.searchParams.set(
    "fields",
    "campaign_id,campaign_name,spend,ctr,cpm,impressions,clicks,actions,action_values,purchase_roas",
  );
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("limit", "200");
  url.searchParams.set("access_token", accessToken);

  try {
    const res = await fetchWithTimeout(
      url.toString(),
      { cache: "no-store" },
      { timeoutMs: META_FETCH_TIMEOUT_MS, label: "Meta request" },
    );
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
  until: string,
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
            fetchCampaignStatuses(
              credentials,
              accountId,
              credentials.accessToken,
            ),
            fetchCampaignInsights(
              credentials,
              accountId,
              normalizedSince,
              normalizedUntil,
              credentials.accessToken,
            ),
            fetchMetaCampaignConfigs(
              credentials,
              accountId,
              credentials.accessToken,
            ),
          ]);
          const profile = credentials.accountProfiles[accountId];
          const normalizedDate = normalizedSince;

          // The current-evidence decision has to be made HERE, before the
          // config snapshot write — not further down next to the daily
          // write-back. This call was unconditional, so every historical
          // window a dashboard requested persisted the account's CURRENT
          // campaign inventory, which is the same fabrication the sync path
          // was fixed for, reached through a read surface.
          const campaignCurrentEvidence = decideMetaCurrentEvidence({
            truthState: "provisional",
            normalizedDay: normalizedDate,
            accountToday: getTodayIsoForTimeZone(profile?.timezone ?? "UTC"),
          });
          if (campaignCurrentEvidence.persistsCurrentConfigEvidence) {
            await persistMetaCampaignConfigSnapshots({
              businessId: credentials.businessId,
              accountId,
              campaignConfigs,
            });
          }

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
              statusUpdatedAt: campaignConfig?.updated_time ?? null,
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

          if (
            isSingleDayWindow(normalizedSince, normalizedUntil) &&
            campaignCurrentEvidence.persistsCurrentConfigEvidence
          ) {
            const accountCurrency = requireMetaCurrencyForWarehouseWrite(
              credentials,
              accountId,
              "campaign_daily",
            );
            const singleDayRows = allRows.filter(
              (row) => row.accountId === accountId,
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
                accountCurrency,
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
              })),
            );
            await upsertMetaAccountDailyRows([
              {
                businessId: credentials.businessId,
                providerAccountId: accountId,
                date: normalizedDate,
                accountName: profile?.name ?? null,
                accountTimezone: profile?.timezone ?? "UTC",
                accountCurrency,
                spend: r2(
                  singleDayRows.reduce((sum, row) => sum + row.spend, 0),
                ),
                impressions: singleDayRows.reduce(
                  (sum, row) => sum + row.impressions,
                  0,
                ),
                clicks: singleDayRows.reduce((sum, row) => sum + row.clicks, 0),
                reach: singleDayRows.reduce(
                  (sum, row) => sum + row.impressions,
                  0,
                ),
                frequency: null,
                conversions: singleDayRows.reduce(
                  (sum, row) => sum + row.purchases,
                  0,
                ),
                revenue: r2(
                  singleDayRows.reduce((sum, row) => sum + row.revenue, 0),
                ),
                roas:
                  singleDayRows.reduce((sum, row) => sum + row.spend, 0) > 0
                    ? r2(
                        singleDayRows.reduce(
                          (sum, row) => sum + row.revenue,
                          0,
                        ) /
                          singleDayRows.reduce(
                            (sum, row) => sum + row.spend,
                            0,
                          ),
                      )
                    : 0,
                cpa:
                  singleDayRows.reduce((sum, row) => sum + row.purchases, 0) > 0
                    ? r2(
                        singleDayRows.reduce((sum, row) => sum + row.spend, 0) /
                          singleDayRows.reduce(
                            (sum, row) => sum + row.purchases,
                            0,
                          ),
                      )
                    : null,
                ctr:
                  singleDayRows.reduce((sum, row) => sum + row.impressions, 0) >
                  0
                    ? r2(
                        (singleDayRows.reduce(
                          (sum, row) => sum + row.clicks,
                          0,
                        ) /
                          singleDayRows.reduce(
                            (sum, row) => sum + row.impressions,
                            0,
                          )) *
                          100,
                      )
                    : null,
                cpc:
                  singleDayRows.reduce((sum, row) => sum + row.clicks, 0) > 0
                    ? r2(
                        singleDayRows.reduce((sum, row) => sum + row.spend, 0) /
                          singleDayRows.reduce(
                            (sum, row) => sum + row.clicks,
                            0,
                          ),
                      )
                    : null,
                sourceSnapshotId: null,
              },
            ]);
          }
        },
      });
    }),
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
    ? credentials.accountIds.filter(
        (accountId) => accountId === input.providerAccountId,
      )
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
  includePrev = false,
  providerAccountIds?: string[] | null,
  options?: {
    /**
     * Whether this call is a capture that should leave raw evidence.
     *
     * Default TRUE, because the sync path uses this function to capture. The
     * read-only live fallback passes FALSE: it exists to answer a screen for a
     * historical range, and recording `adset_statuses` and `adset_insights`
     * under that range attributes CURRENT provider state to a past date — the
     * same fabricated date-keyed identity the historical core path had, reached
     * from a read.
     */
    recordRawSnapshots?: boolean;
  },
): Promise<MetaAdSetData[]> {
  const recordRawSnapshots = options?.recordRawSnapshots !== false;
  const normalizedSince = normalizeMetaApiDate(since);
  const normalizedUntil = normalizeMetaApiDate(until);
  const results: MetaAdSetData[] = [];
  const requestedAccountIds = providerAccountIds
    ? new Set(providerAccountIds.filter(Boolean))
    : null;
  const targetAccountIds = requestedAccountIds
    ? credentials.accountIds.filter((accountId) =>
        requestedAccountIds.has(accountId),
      )
    : credentials.accountIds;

  await Promise.all(
    targetAccountIds.map(async (accountId) => {
      // Fetch adset metadata (status, budget) scoped to the campaign
      const statusUrl = new URL(
        `https://graph.facebook.com/v25.0/${accountId}/adsets`,
      );
      statusUrl.searchParams.set(
        "fields",
        "id,name,campaign_id,effective_status,status,updated_time,daily_budget,lifetime_budget,optimization_goal,promoted_object{pixel_id,custom_event_type,custom_conversion_id},bid_strategy,bid_amount,bid_constraints{roas_average_floor}",
      );
      statusUrl.searchParams.set("limit", "200");
      statusUrl.searchParams.set("access_token", credentials.accessToken);

      // Fetch adset insights filtered to this campaign
      const insightUrl = new URL(
        `https://graph.facebook.com/v25.0/${accountId}/insights`,
      );
      insightUrl.searchParams.set("level", "adset");
      insightUrl.searchParams.set(
        "fields",
        "adset_id,adset_name,campaign_id,spend,ctr,inline_link_click_ctr,cpm,impressions,clicks,actions,action_values,purchase_roas",
      );
      if (campaignId) {
        insightUrl.searchParams.set(
          "filtering",
          JSON.stringify([
            { field: "campaign.id", operator: "EQUAL", value: campaignId },
          ]),
        );
      }
      insightUrl.searchParams.set(
        "time_range",
        JSON.stringify({ since: normalizedSince, until: normalizedUntil }),
      );
      insightUrl.searchParams.set("limit", "200");
      insightUrl.searchParams.set("access_token", credentials.accessToken);

      try {
        const [statusRes, insightRes, campaignConfigs] = await Promise.all([
          fetchWithTimeout(
            statusUrl.toString(),
            { cache: "no-store" },
            { timeoutMs: META_FETCH_TIMEOUT_MS, label: "Meta adset status" },
          ),
          fetchWithTimeout(
            insightUrl.toString(),
            { cache: "no-store" },
            { timeoutMs: META_FETCH_TIMEOUT_MS, label: "Meta adset insight" },
          ),
          fetchMetaCampaignConfigs(
            credentials,
            accountId,
            credentials.accessToken,
            { recordRawSnapshots },
          ),
        ]);

        const statusJson = statusRes.ok
          ? ((await statusRes.json()) as MetaGraphCollectionResponse<RawAdSet>)
          : { data: [] as RawAdSet[] };
        const insightJson = insightRes.ok
          ? ((await insightRes.json()) as { data?: RawAdSetInsight[] })
          : { data: [] as RawAdSetInsight[] };
        if (recordRawSnapshots)
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
            requestContext: {
              campaignId,
              fields:
                "id,name,campaign_id,effective_status,status,updated_time,daily_budget,lifetime_budget,optimization_goal,promoted_object{pixel_id,custom_event_type,custom_conversion_id},bid_strategy,bid_amount,bid_constraints{roas_average_floor}",
            },
          });
        if (recordRawSnapshots)
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
          statusRows.map((a) => [a.id, a]),
        );
        const profile = credentials.accountProfiles[accountId];
        // Snapshot reads are intentionally limited to the current-day live path.
        const allowSnapshotReadForTodayLive =
          businessId != null &&
          isSingleDayWindow(normalizedSince, normalizedUntil) &&
          isCurrentDayForTimezone(normalizedSince, profile?.timezone ?? null);
        const [
          latestSnapshots,
          latestCampaignSnapshots,
          previousDiffs,
          previousCampaignDiffs,
        ] = allowSnapshotReadForTodayLive
          ? await Promise.all([
              readLatestMetaConfigSnapshots({
                businessId,
                entityLevel: "adset",
                entityIds: Array.from(
                  new Set([
                    ...statusRows.map((adset) => adset.id),
                    ...(insightJson.data ?? [])
                      .map((adset) => adset.adset_id ?? "")
                      .filter(Boolean),
                  ]),
                ),
              }),
              readLatestMetaConfigSnapshots({
                businessId,
                entityLevel: "campaign",
                entityIds: Array.from(
                  new Set(
                    [
                      ...statusRows.map((adset) => adset.campaign_id ?? ""),
                      ...(insightJson.data ?? []).map(
                        (adset) => adset.campaign_id ?? "",
                      ),
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
                        ...(insightJson.data ?? [])
                          .map((adset) => adset.adset_id ?? "")
                          .filter(Boolean),
                      ]),
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
                          ...(insightJson.data ?? []).map(
                            (adset) => adset.campaign_id ?? "",
                          ),
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
          const resolvedCampaignId =
            insight.campaign_id ?? statusMap.get(adsetId)?.campaign_id ?? "";
          const meta = statusMap.get(adsetId);
          const latestSnapshot = latestSnapshots.get(adsetId);
          const latestCampaignSnapshot =
            latestCampaignSnapshots.get(resolvedCampaignId);
          const campaignConfig =
            campaignConfigs.get(resolvedCampaignId) ?? null;
          const previousDiff = previousDiffs.get(adsetId);
          const previousCampaignDiff =
            previousCampaignDiffs.get(resolvedCampaignId);
          const usesCampaignBudgetFallback =
            meta?.daily_budget == null &&
            meta?.lifetime_budget == null &&
            (campaignConfig?.daily_budget != null ||
              campaignConfig?.lifetime_budget != null);
          const { payload: config, usesCampaignBidFallback } =
            buildMetaAdSetConfigPayload({
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
            statusUpdatedAt: meta?.updated_time ?? null,
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
              (usesCampaignBidFallback
                ? (previousCampaignDiff?.previousManualBidAmount ?? null)
                : null),
            bidValue: config.bidValue,
            bidValueFormat: config.bidValueFormat,
            previousBidValue:
              previousDiff?.previousBidValue ??
              (usesCampaignBidFallback
                ? (previousCampaignDiff?.previousBidValue ?? null)
                : null),
            previousBidValueFormat:
              previousDiff?.previousBidValueFormat ??
              (usesCampaignBidFallback
                ? (previousCampaignDiff?.previousBidValueFormat ?? null)
                : null),
            previousBidValueCapturedAt:
              previousDiff?.previousBidCapturedAt ??
              (usesCampaignBidFallback
                ? (previousCampaignDiff?.previousBidCapturedAt ?? null)
                : null),
            isBudgetMixed: false,
            previousDailyBudget:
              previousDiff?.previousDailyBudget ??
              (usesCampaignBudgetFallback
                ? (previousCampaignDiff?.previousDailyBudget ?? null)
                : null),
            previousLifetimeBudget:
              previousDiff?.previousLifetimeBudget ??
              (usesCampaignBudgetFallback
                ? (previousCampaignDiff?.previousLifetimeBudget ?? null)
                : null),
            previousBudgetCapturedAt:
              previousDiff?.previousBudgetCapturedAt ??
              (usesCampaignBudgetFallback
                ? (previousCampaignDiff?.previousBudgetCapturedAt ?? null)
                : null),
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
            inlineLinkClickCtr:
              insight.inline_link_click_ctr != null
                ? r2(parseNum(insight.inline_link_click_ctr))
                : null,
          });
        }

        // A single-day window is not the same thing as the account's today.
        // Without the second condition this live READ path wrote adset daily
        // rows AND appended config history for any historical day a dashboard
        // happened to request — the same fabrication as the sync path, reached
        // through a surface whose contract is that it does not write history.
        const adsetAccountToday = getTodayIsoForTimeZone(
          credentials.accountProfiles[accountId]?.timezone ?? "UTC",
        );
        const adsetCurrentEvidence = decideMetaCurrentEvidence({
          truthState: "provisional",
          normalizedDay: normalizedSince,
          accountToday: adsetAccountToday,
        });
        if (
          isSingleDayWindow(normalizedSince, normalizedUntil) &&
          adsetCurrentEvidence.persistsCurrentConfigEvidence
        ) {
          const profile = credentials.accountProfiles[accountId];
          const normalizedDate = normalizedSince;
          const accountCurrency = requireMetaCurrencyForWarehouseWrite(
            credentials,
            accountId,
            "adset_daily",
          );
          const singleDayRows = results.filter(
            (row) => row.accountId === accountId,
          );
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
              accountCurrency,
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
            })),
          );
        }

        // Config snapshots describe the CURRENT inventory these status rows
        // came from. Recording them against a historical read is the same
        // fabrication as the daily write-back above, so both share one gate.
        if (businessId && adsetCurrentEvidence.persistsCurrentConfigEvidence) {
          const campaignEntityIds = campaignId
            ? [campaignId]
            : Array.from(
                new Set(
                  statusRows
                    .map((row) => row.campaign_id ?? "")
                    .filter(Boolean),
                ),
              );
          await Promise.all([
            appendMetaConfigSnapshots(
              statusRows.map((meta) => {
                const resolvedCampaignId =
                  meta.campaign_id ?? campaignId ?? null;
                const campaignConfig = resolvedCampaignId
                  ? (campaignConfigs.get(resolvedCampaignId) ?? null)
                  : null;
                return {
                  businessId,
                  accountId,
                  entityLevel: "adset" as const,
                  entityId: meta.id,
                  payload: buildConfigSnapshotPayload({
                    campaignId: resolvedCampaignId,
                    optimizationGoal: meta.optimization_goal ?? null,
                    customEventType:
                      meta.promoted_object?.custom_event_type ?? null,
                    pixelId: meta.promoted_object?.pixel_id ?? null,
                    customConversionId:
                      meta.promoted_object?.custom_conversion_id ?? null,
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
                        ? parseNum(
                            campaignConfig.bid_constraints.roas_average_floor,
                          )
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
              }),
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
    }),
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
  breakdowns: string,
): Promise<RawBreakdownInsight[]> {
  const normalizedSince = normalizeMetaApiDate(since);
  const normalizedUntil = normalizeMetaApiDate(until);
  const url = new URL(`https://graph.facebook.com/v25.0/${accountId}/insights`);
  url.searchParams.set("level", "adset");
  url.searchParams.set("breakdowns", breakdowns);
  url.searchParams.set(
    "fields",
    "spend,clicks,impressions,ctr,cpm,actions,action_values,purchase_roas",
  );
  url.searchParams.set(
    "time_range",
    JSON.stringify({ since: normalizedSince, until: normalizedUntil }),
  );
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", accessToken);

  try {
    const res = await fetchWithTimeout(
      url.toString(),
      { cache: "no-store" },
      { timeoutMs: META_FETCH_TIMEOUT_MS, label: "Meta request" },
    );
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
  keyFn: (row: RawBreakdownInsight) => { key: string; label: string },
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
        existing.purchases > 0 ? r2(existing.spend / existing.purchases) : 0;
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
  until: string,
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
        "age",
      );
      allRows.push(...rows);
    }),
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
  until: string,
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
        "country",
      );
      allRows.push(...rows);
    }),
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
  until: string,
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
        "gender",
      );
      allRows.push(...rows);
    }),
  );

  return aggregateBreakdown(allRows, (row) => ({
    key: row.gender ?? "unknown",
    label:
      row.gender === "male"
        ? "Male"
        : row.gender === "female"
          ? "Female"
          : (row.gender ?? "Unknown"),
  }));
}

// ── getRegionBreakdown ────────────────────────────────────────────────────────

export async function getRegionBreakdown(
  credentials: MetaCredentials,
  since: string,
  until: string,
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
        "region",
      );
      allRows.push(...rows);
    }),
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
  until: string,
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
        "publisher_platform,platform_position,impression_device",
      );
      allRows.push(...rows);
    }),
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
