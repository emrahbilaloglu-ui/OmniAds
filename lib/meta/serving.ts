/**
 * Historical Meta serving is read-only.
 * Snapshots may fill response-time gaps, but serving must never persist warehouse mutations.
 */

import { resolveMetaCredentials } from "@/lib/api/meta";
import {
  fetchMetaAdSetConfigs,
  fetchMetaCampaignConfigs,
} from "@/lib/api/meta";
import { getMetaBreakdownSupportedStart } from "@/lib/meta/constraints";
import {
  readLatestMetaConfigSnapshots,
  type MetaPreviousConfigDiff,
  readPreviousDifferentMetaConfigDiffs,
} from "@/lib/meta/config-snapshots";
import {
  readLatestMetaAdSetConfigHistory,
  readLatestMetaCampaignConfigHistory,
  readMetaAdSetDimensions,
  readMetaCampaignDimensions,
  readPreviousDifferentMetaAdSetConfigHistoryDiffs,
  readPreviousDifferentMetaCampaignConfigHistoryDiffs,
} from "@/lib/meta/request-model-store";
import {
  emptyMetaWarehouseMetrics,
  getMetaAdSetDailyCoverage,
  getMetaAccountDailyCoverage,
  getMetaAccountDailyRange,
  getMetaAdSetDailyRange,
  getMetaBreakdownDailyRange,
  getMetaCampaignDailyRange,
  getMetaPublishedVerificationSummary,
  getMetaQueueHealth,
  getMetaRawSnapshotCoverageByEndpoint,
} from "@/lib/meta/warehouse";
import {
  type MetaAccountDailyRow,
  type MetaAdSetDailyRow,
  type MetaBreakdownDailyRow,
  type MetaCampaignDailyRow,
  type MetaHistoricalVerificationState,
  type MetaPublishedVerificationSummary,
  type MetaWarehouseFreshness,
} from "@/lib/meta/warehouse-types";
import {
  META_WAREHOUSE_HISTORY_DAYS,
  dayCountInclusive,
  getHistoricalWindowStart,
} from "@/lib/meta/history";
import { buildConfigSnapshotPayload } from "@/lib/meta/configuration";
import { isMetaAuthoritativeFinalizationV2EnabledForBusiness } from "@/lib/meta/authoritative-finalization-config";

function getTodayIsoForTimeZoneServer(timeZone: string): string {
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

function r2(value: number) {
  return Math.round(value * 100) / 100;
}

function buildFreshnessFromRows(
  rows: Array<{ updatedAt?: string }>,
  fallbackState: MetaWarehouseFreshness["dataState"] = "ready"
): MetaWarehouseFreshness {
  const lastSyncedAt = rows.reduce<string | null>((latest, row) => {
    if (!row.updatedAt) return latest;
    if (!latest || row.updatedAt > latest) return row.updatedAt;
    return latest;
  }, null);
  return {
    dataState: rows.length > 0 ? fallbackState : "stale",
    lastSyncedAt,
    liveRefreshedAt: null,
    isPartial: false,
    missingWindows: [],
    warnings: [],
  };
}

function addDaysToIso(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function enumerateMetaServingDays(startDate: string, endDate: string) {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

const META_BREAKDOWN_ENDPOINTS = [
  "breakdown_age",
  "breakdown_country",
  "breakdown_publisher_platform,platform_position,impression_device",
] as const;

export interface MetaWarehouseSummaryResponse {
  freshness: MetaWarehouseFreshness;
  /**
   * Deprecated compatibility field. Status/progress truth lives in /api/meta/status.
   */
  historicalSync: {
    progressPercent: number;
    completedDays: number;
    totalDays: number;
    readyThroughDate: string | null;
    state: "ready" | "syncing" | "partial";
  };
  isPartial?: boolean;
  verification?: {
    verificationState: MetaHistoricalVerificationState;
    sourceFetchedAt: string | null;
    publishedAt: string | null;
    asOf: string | null;
  } | null;
  totals: {
    spend: number;
    revenue: number;
    conversions: number;
    roas: number;
    cpa: number | null;
    ctr: number | null;
    cpc: number | null;
    impressions: number;
    clicks: number;
    reach: number;
  };
  accounts: Array<{
    providerAccountId: string;
    accountName: string | null;
    currency: string;
    timezone: string;
    spend: number;
    revenue: number;
    conversions: number;
    roas: number;
  }>;
}

export interface MetaWarehouseTrendPoint {
  date: string;
  spend: number;
  revenue: number;
  conversions: number;
  roas: number;
  cpa: number | null;
  ctr: number | null;
  cpc: number | null;
  impressions: number;
  clicks: number;
}

export interface MetaWarehouseTrendResponse {
  freshness: MetaWarehouseFreshness;
  isPartial?: boolean;
  verification?: MetaWarehouseSummaryResponse["verification"];
  points: MetaWarehouseTrendPoint[];
}

export interface MetaWarehouseCampaignResponse {
  freshness: MetaWarehouseFreshness;
  isPartial?: boolean;
  verification?: MetaWarehouseSummaryResponse["verification"];
  rows: Array<{
    providerAccountId: string;
    campaignId: string;
    campaignName: string | null;
    campaignStatus: string | null;
    objective: string | null;
    buyingType: string | null;
    optimizationGoal?: string | null;
    customEventType?: string | null;
    isCustomEventTypeMixed?: boolean;
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
    isBidStrategyMixed?: boolean;
    isBidValueMixed?: boolean;
    spend: number;
    revenue: number;
    conversions: number;
    roas: number;
    cpa: number | null;
    ctr: number | null;
    cpc: number | null;
    impressions: number;
    clicks: number;
  }>;
}

export interface MetaWarehouseCampaignTableRow {
  id: string;
  accountId: string;
  name: string;
  status: string;
  objective?: string | null;
  budgetLevel?: "campaign" | "adset" | null;
  spend: number;
  purchases: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  cpm: number;
  cpc: number;
  cpp: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  uniqueClicks: number;
  uniqueCtr: number;
  inlineLinkClickCtr: number;
  outboundClicks: number;
  outboundCtr: number;
  uniqueOutboundClicks: number;
  uniqueOutboundCtr: number;
  landingPageViews: number;
  costPerLandingPageView: number;
  addToCart: number;
  addToCartValue: number;
  costPerAddToCart: number;
  initiateCheckout: number;
  initiateCheckoutValue: number;
  costPerCheckoutInitiated: number;
  leads: number;
  leadsValue: number;
  costPerLead: number;
  registrationsCompleted: number;
  registrationsCompletedValue: number;
  costPerRegistrationCompleted: number;
  searches: number;
  searchesValue: number;
  costPerSearch: number;
  addPaymentInfo: number;
  addPaymentInfoValue: number;
  costPerAddPaymentInfo: number;
  pageLikes: number;
  costPerPageLike: number;
  postEngagement: number;
  costPerEngagement: number;
  postReactions: number;
  costPerReaction: number;
  postComments: number;
  costPerPostComment: number;
  postShares: number;
  costPerPostShare: number;
  messagingConversationsStarted: number;
  costPerMessagingConversationStarted: number;
  appInstalls: number;
  costPerAppInstall: number;
  contentViews: number;
  contentViewsValue: number;
  costPerContentView: number;
  videoViews3s: number;
  videoViews15s: number;
  videoViews25: number;
  videoViews50: number;
  videoViews75: number;
  videoViews95: number;
  videoViews100: number;
  costPerVideoView: number;
  currency: string;
  optimizationGoal: string | null;
  customEventType?: string | null;
  bidStrategyType: string | null;
  bidStrategyLabel: string | null;
  manualBidAmount: number | null;
  previousManualBidAmount: number | null;
  bidValue: number | null;
  bidValueFormat: "currency" | "roas" | null;
  previousBidValue: number | null;
  previousBidValueFormat: "currency" | "roas" | null;
  previousBidValueCapturedAt: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  previousDailyBudget: number | null;
  previousLifetimeBudget: number | null;
  previousBudgetCapturedAt: string | null;
  isBudgetMixed: boolean;
  isConfigMixed: boolean;
  isOptimizationGoalMixed: boolean;
  isCustomEventTypeMixed?: boolean;
  isBidStrategyMixed: boolean;
  isBidValueMixed: boolean;
}

export interface MetaWarehouseAdSetTableRow {
  id: string;
  accountId: string;
  name: string;
  campaignId: string;
  status: string;
  budgetLevel?: "campaign" | "adset" | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  optimizationGoal: string | null;
  customEventType?: string | null;
  pixelId?: string | null;
  customConversionId?: string | null;
  promotedObject?: unknown;
  bidStrategyType: string | null;
  bidStrategyLabel: string | null;
  manualBidAmount: number | null;
  previousManualBidAmount: number | null;
  bidValue: number | null;
  bidValueFormat: "currency" | "roas" | null;
  previousBidValue: number | null;
  previousBidValueFormat: "currency" | "roas" | null;
  previousBidValueCapturedAt: string | null;
  isBudgetMixed: boolean;
  previousDailyBudget: number | null;
  previousLifetimeBudget: number | null;
  previousBudgetCapturedAt: string | null;
  isConfigMixed: boolean;
  isOptimizationGoalMixed: boolean;
  isCustomEventTypeMixed?: boolean;
  isBidStrategyMixed: boolean;
  isBidValueMixed: boolean;
  spend: number;
  purchases: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  cpm: number;
  impressions: number;
  clicks: number;
}

export interface MetaWarehouseBreakdownsResponse {
  freshness: MetaWarehouseFreshness;
  isPartial?: boolean;
  verification?: MetaWarehouseSummaryResponse["verification"];
  age: Array<{ key: string; label: string; spend: number; purchases: number; revenue: number; clicks: number; impressions: number }>;
  location: Array<{ key: string; label: string; spend: number; purchases: number; revenue: number; clicks: number; impressions: number }>;
  placement: Array<{ key: string; label: string; spend: number; purchases: number; revenue: number; clicks: number; impressions: number }>;
  budget: {
    campaign: Array<{ key: string; label: string; spend: number }>;
    adset: Array<{ key: string; label: string; spend: number }>;
  };
}

export interface MetaWarehouseCountryBreakdownsResponse {
  freshness: MetaWarehouseFreshness;
  isPartial?: boolean;
  verification?: MetaWarehouseSummaryResponse["verification"];
  rows: MetaWarehouseBreakdownsResponse["location"];
}

function buildVerificationMetadata(
  verification: MetaPublishedVerificationSummary | null | undefined,
) {
  if (!verification) return null;
  return {
    verificationState: verification.verificationState,
    sourceFetchedAt: verification.sourceFetchedAt,
    publishedAt: verification.publishedAt,
    asOf: verification.asOf,
  };
}

function normalizeMetaServingDate(value: string | Date) {
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

function filterRowsToPublishedKeys<T extends { providerAccountId: string; date: string | Date }>(
  rows: T[],
  verification: MetaPublishedVerificationSummary | null | undefined,
  surface: "account_daily" | "campaign_daily" | "adset_daily",
) {
  const keys = new Set(verification?.publishedKeysBySurface[surface] ?? []);
  if (keys.size === 0) return [] as T[];
  return rows.filter((row) =>
    keys.has(`${row.providerAccountId}:${normalizeMetaServingDate(row.date)}`),
  );
}

function filterBreakdownRowsToPublishedKeys<
  T extends {
    providerAccountId: string;
    date: string | Date;
    breakdownType: string;
  },
>(input: {
  rows: T[];
  verification: MetaPublishedVerificationSummary | null | undefined;
  requiredBreakdownTypes: string[];
}) {
  const publishedKeys = new Set(
    input.verification?.publishedKeysBySurface.account_daily ?? [],
  );
  if (publishedKeys.size === 0) return [] as T[];

  const requiredTypes = new Set(input.requiredBreakdownTypes);
  const breakdownTypesByKey = new Map<string, Set<string>>();
  for (const row of input.rows) {
    const key = `${row.providerAccountId}:${normalizeMetaServingDate(row.date)}`;
    if (!publishedKeys.has(key)) continue;
    const types = breakdownTypesByKey.get(key);
    if (types) {
      types.add(row.breakdownType);
    } else {
      breakdownTypesByKey.set(key, new Set([row.breakdownType]));
    }
  }

  return input.rows.filter((row) => {
    const key = `${row.providerAccountId}:${normalizeMetaServingDate(row.date)}`;
    if (!publishedKeys.has(key)) return false;
    const presentTypes = breakdownTypesByKey.get(key);
    if (!presentTypes) return false;
    for (const requiredType of requiredTypes) {
      if (!presentTypes.has(requiredType)) return false;
    }
    return true;
  });
}

type RequestedMetaBreakdownType = "age" | "country" | "placement";

function aggregateMetaBreakdownRows(input: {
  breakdownRows: MetaBreakdownDailyRow[];
  kind: RequestedMetaBreakdownType;
}) {
  const byKey = new Map<
    string,
    {
      key: string;
      label: string;
      spend: number;
      purchases: number;
      revenue: number;
      clicks: number;
      impressions: number;
    }
  >();
  for (const row of input.breakdownRows.filter(
    (candidate) => candidate.breakdownType === input.kind,
  )) {
    const existing = byKey.get(row.breakdownKey);
    if (existing) {
      existing.spend = r2(existing.spend + row.spend);
      existing.purchases += row.conversions;
      existing.revenue = r2(existing.revenue + row.revenue);
      existing.clicks += row.clicks;
      existing.impressions += row.impressions;
    } else {
      byKey.set(row.breakdownKey, {
        key: row.breakdownKey,
        label: row.breakdownLabel,
        spend: row.spend,
        purchases: row.conversions,
        revenue: row.revenue,
        clicks: row.clicks,
        impressions: row.impressions,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.spend - a.spend);
}

function aggregateMetaCampaignBreakdownBudgetRows(
  rows: MetaCampaignDailyRow[],
) {
  const byKey = new Map<
    string,
    {
      key: string;
      label: string;
      spend: number;
      latestDate: string;
    }
  >();
  for (const row of rows) {
    const key = row.campaignId;
    const label =
      row.campaignNameCurrent ??
      row.campaignNameHistorical ??
      "Unknown campaign";
    const latestDate = normalizeMetaServingDate(row.date);
    const existing = byKey.get(key);
    if (existing) {
      existing.spend = r2(existing.spend + row.spend);
      if (latestDate >= existing.latestDate) {
        existing.latestDate = latestDate;
        existing.label = label;
      }
    } else {
      byKey.set(key, {
        key,
        label,
        spend: row.spend,
        latestDate,
      });
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.spend - a.spend)
    .map(({ latestDate: _latestDate, ...row }) => row);
}

function aggregateMetaAdSetBreakdownBudgetRows(
  rows: MetaAdSetDailyRow[],
) {
  const byKey = new Map<
    string,
    {
      key: string;
      label: string;
      spend: number;
      latestDate: string;
    }
  >();
  for (const row of rows) {
    const key = row.adsetId;
    const label =
      row.adsetNameCurrent ??
      row.adsetNameHistorical ??
      "Unknown ad set";
    const latestDate = normalizeMetaServingDate(row.date);
    const existing = byKey.get(key);
    if (existing) {
      existing.spend = r2(existing.spend + row.spend);
      if (latestDate >= existing.latestDate) {
        existing.latestDate = latestDate;
        existing.label = label;
      }
    } else {
      byKey.set(key, {
        key,
        label,
        spend: row.spend,
        latestDate,
      });
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.spend - a.spend)
    .map(({ latestDate: _latestDate, ...row }) => row);
}

async function getMetaWarehouseBreakdownSnapshot(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  requestedBreakdownTypes: RequestedMetaBreakdownType[];
}) {
  const providerAccountIds = input.providerAccountIds ?? [];
  const v2Enabled =
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId) &&
    providerAccountIds.length > 0;
  const [rawBreakdownRows, verification, campaignRows, adsetRows] =
    await Promise.all([
    getMetaBreakdownDailyRange({
      businessId: input.businessId,
      providerAccountIds: input.providerAccountIds,
      startDate: input.startDate,
      endDate: input.endDate,
      breakdownTypes: [...input.requestedBreakdownTypes],
    }),
    v2Enabled
      ? getMetaPublishedVerificationSummary({
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
          providerAccountIds,
          surfaces: ["account_daily", "campaign_daily"],
        }).catch(() => null)
      : Promise.resolve(null),
    getMetaCampaignDailyRange({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      providerAccountIds: input.providerAccountIds,
    }).catch(() => []),
    getMetaAdSetDailyRange({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      providerAccountIds: input.providerAccountIds,
      campaignIds: null,
    }).catch(() => []),
  ]);
  const breakdownRows = v2Enabled
    ? filterBreakdownRowsToPublishedKeys({
        rows: rawBreakdownRows,
        verification,
        requiredBreakdownTypes: [...input.requestedBreakdownTypes],
      })
    : rawBreakdownRows;

  return {
    breakdownRows,
    budget: {
      campaign: aggregateMetaCampaignBreakdownBudgetRows(campaignRows),
      adset: aggregateMetaAdSetBreakdownBudgetRows(adsetRows),
    },
    verification,
    isPartial: v2Enabled ? !verification?.truthReady : breakdownRows.length === 0,
  };
}

export async function getMetaWarehouseSummary(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
}): Promise<MetaWarehouseSummaryResponse> {
  const providerAccountIds = input.providerAccountIds ?? [];
  const v2Enabled =
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId) &&
    providerAccountIds.length > 0;
  const [rawRows, rawCampaignRows, verification] = await Promise.all([
    getMetaAccountDailyRange(input),
    getMetaCampaignDailyRange(input),
    v2Enabled
      ? getMetaPublishedVerificationSummary({
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
          providerAccountIds,
          surfaces: ["account_daily", "campaign_daily"],
        }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const rows = v2Enabled
    ? filterRowsToPublishedKeys(rawRows, verification, "account_daily")
    : rawRows;
  const campaignRows = v2Enabled
    ? filterRowsToPublishedKeys(rawCampaignRows, verification, "campaign_daily")
    : rawCampaignRows;
  const credentials = await resolveMetaCredentials(input.businessId).catch(() => null);
  const empty = emptyMetaWarehouseMetrics();
  const accountRowsByProvider = new Map(rows.map((row) => [row.providerAccountId, row]));

  const summaryRows =
    campaignRows.length > 0
      ? campaignRows.map((row) => ({
          providerAccountId: row.providerAccountId,
          accountName:
            accountRowsByProvider.get(row.providerAccountId)?.accountName ??
            credentials?.accountProfiles?.[row.providerAccountId]?.name ??
            null,
          accountCurrency: row.accountCurrency,
          accountTimezone: row.accountTimezone,
          spend: row.spend,
          revenue: row.revenue,
          conversions: row.conversions,
          impressions: row.impressions,
          clicks: row.clicks,
          reach: row.reach,
          roas: row.roas,
          updatedAt: row.updatedAt,
        }))
      : rows;

  let totals = summaryRows.reduce(
    (acc, row) => {
      acc.spend += row.spend;
      acc.revenue += row.revenue;
      acc.conversions += row.conversions;
      acc.impressions += row.impressions;
      acc.clicks += row.clicks;
      acc.reach += row.reach;
      return acc;
    },
    {
      ...empty,
      spend: 0,
      revenue: 0,
      conversions: 0,
      impressions: 0,
      clicks: 0,
      reach: 0,
    }
  );

  const accountsMap = new Map<
    string,
    {
      providerAccountId: string;
      accountName: string | null;
      currency: string;
      timezone: string;
      spend: number;
      revenue: number;
      conversions: number;
      roas: number;
    }
  >();
  for (const row of summaryRows) {
    const existing = accountsMap.get(row.providerAccountId);
    if (existing) {
      existing.spend = r2(existing.spend + row.spend);
      existing.revenue = r2(existing.revenue + row.revenue);
      existing.conversions += row.conversions;
      existing.roas = existing.spend > 0 ? r2(existing.revenue / existing.spend) : 0;
    } else {
      accountsMap.set(row.providerAccountId, {
        providerAccountId: row.providerAccountId,
        accountName: row.accountName,
        currency: row.accountCurrency,
        timezone: row.accountTimezone,
        spend: row.spend,
        revenue: row.revenue,
        conversions: row.conversions,
        roas: row.roas,
      });
    }
  }

  const freshness = buildFreshnessFromRows(
    summaryRows,
    summaryRows.length > 0 ? "ready" : "stale"
  );

  const primaryAccountId = credentials?.accountIds[0] ?? null;
  const primaryTimeZone =
    primaryAccountId && credentials?.accountProfiles?.[primaryAccountId]?.timezone
      ? credentials.accountProfiles[primaryAccountId].timezone
      : null;
  const historicalToday = primaryTimeZone
    ? getTodayIsoForTimeZoneServer(primaryTimeZone)
    : new Date().toISOString().slice(0, 10);
  const historicalEnd = addDaysToIso(historicalToday, -1);
  const historicalStart = getHistoricalWindowStart(historicalEnd, META_WAREHOUSE_HISTORY_DAYS);
  const effectiveHistoricalStart =
    historicalStart > getMetaBreakdownSupportedStart(historicalEnd)
      ? historicalStart
      : getMetaBreakdownSupportedStart(historicalEnd);
  const historicalCoverage =
    credentials?.accountIds?.length
      ? await getMetaAccountDailyCoverage({
          businessId: input.businessId,
          providerAccountId: null,
          startDate: historicalStart,
          endDate: historicalEnd,
        }).catch(() => null)
      : null;
  const [historicalAdsetCoverage, historicalBreakdownCoverageByEndpoint] =
    credentials?.accountIds?.length
      ? await Promise.all([
          getMetaAdSetDailyCoverage({
            businessId: input.businessId,
            providerAccountId: null,
            startDate: historicalStart,
            endDate: historicalEnd,
          }).catch(() => null),
          getMetaRawSnapshotCoverageByEndpoint({
            businessId: input.businessId,
            providerAccountId: null,
            endpointNames: [...META_BREAKDOWN_ENDPOINTS],
            startDate: effectiveHistoricalStart,
            endDate: historicalEnd,
          }).catch(() => null),
        ])
      : [null, null];
  const historicalAccountCoverageDays = historicalCoverage?.completed_days ?? 0;
  const historicalAdsetCoverageDays = historicalAdsetCoverage?.completed_days ?? 0;
  const historicalBreakdownCoverageDays = historicalBreakdownCoverageByEndpoint
    ? Math.min(
        ...META_BREAKDOWN_ENDPOINTS.map(
          (endpointName) =>
            historicalBreakdownCoverageByEndpoint.get(endpointName)?.completed_days ?? 0
        )
      )
    : 0;
  const effectiveHistoricalTotalDays = dayCountInclusive(effectiveHistoricalStart, historicalEnd);
  const historicalCompletedDays = Math.min(
    historicalAccountCoverageDays,
    historicalAdsetCoverageDays,
    historicalBreakdownCoverageDays,
    effectiveHistoricalTotalDays
  );
  const historicalTotalDays = effectiveHistoricalTotalDays;
  const historicalProgressPercent = Math.max(
    0,
    Math.min(100, Math.round((historicalCompletedDays / historicalTotalDays) * 100))
  );
  const queueHealth =
    credentials?.accountIds?.length
      ? await getMetaQueueHealth({ businessId: input.businessId }).catch(() => null)
      : null;
  const historicalState =
    historicalProgressPercent >= 100
      ? "ready"
      : (queueHealth?.leasedPartitions ?? 0) > 0 || (queueHealth?.queueDepth ?? 0) > 0
        ? "syncing"
        : historicalCompletedDays > 0 || rows.length > 0
          ? "partial"
          : "syncing";

  return {
    freshness,
    historicalSync: {
      progressPercent: historicalProgressPercent,
      completedDays: historicalCompletedDays,
      totalDays: historicalTotalDays,
      readyThroughDate: historicalCoverage?.ready_through_date ?? null,
      state: historicalState,
    },
    isPartial: v2Enabled ? !verification?.truthReady : summaryRows.length === 0,
    verification: buildVerificationMetadata(verification),
    totals: {
      spend: r2(totals.spend),
      revenue: r2(totals.revenue),
      conversions: totals.conversions,
      roas: totals.spend > 0 ? r2(totals.revenue / totals.spend) : 0,
      cpa: totals.conversions > 0 ? r2(totals.spend / totals.conversions) : null,
      ctr: totals.impressions > 0 ? r2((totals.clicks / totals.impressions) * 100) : null,
      cpc: totals.clicks > 0 ? r2(totals.spend / totals.clicks) : null,
      impressions: totals.impressions,
      clicks: totals.clicks,
      reach: totals.reach,
    },
    accounts: Array.from(accountsMap.values()).sort((a, b) => b.spend - a.spend),
  };
}

export function rebuildAccountRowsFromCampaignRows(input: {
  campaignRows: MetaCampaignDailyRow[];
  existingAccountRows?: MetaAccountDailyRow[];
  accountProfiles?: Record<string, { name?: string | null; timezone?: string | null; currency?: string | null }> | null;
}): MetaAccountDailyRow[] {
  const existingByKey = new Map(
    (input.existingAccountRows ?? []).map((row) => [
      `${row.providerAccountId}:${row.date}`,
      row,
    ]),
  );
  const grouped = new Map<string, MetaCampaignDailyRow[]>();
  for (const row of input.campaignRows) {
    const key = `${row.providerAccountId}:${row.date}`;
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }

  return Array.from(grouped.entries()).map(([key, campaignRows]) => {
    const latest = campaignRows.at(-1) ?? campaignRows[0]!;
    const existing = existingByKey.get(key);
    const profile = input.accountProfiles?.[latest.providerAccountId];
    const truthVersion = Math.max(existing?.truthVersion ?? 1, latest.truthVersion ?? 1);
    const spend = r2(campaignRows.reduce((sum, row) => sum + row.spend, 0));
    const revenue = r2(campaignRows.reduce((sum, row) => sum + row.revenue, 0));
    const conversions = campaignRows.reduce((sum, row) => sum + row.conversions, 0);
    const impressions = campaignRows.reduce((sum, row) => sum + row.impressions, 0);
    const clicks = campaignRows.reduce((sum, row) => sum + row.clicks, 0);
    const reach = campaignRows.reduce((sum, row) => sum + row.reach, 0);
    return {
      businessId: latest.businessId,
      providerAccountId: latest.providerAccountId,
      date: latest.date,
      accountName: existing?.accountName ?? profile?.name ?? null,
      accountTimezone: latest.accountTimezone ?? existing?.accountTimezone ?? profile?.timezone ?? "UTC",
      accountCurrency: latest.accountCurrency ?? existing?.accountCurrency ?? profile?.currency ?? "USD",
      spend,
      impressions,
      clicks,
      reach,
      frequency: reach > 0 ? r2(impressions / reach) : null,
      conversions,
      revenue,
      roas: spend > 0 ? r2(revenue / spend) : 0,
      cpa: conversions > 0 ? r2(spend / conversions) : null,
      ctr: impressions > 0 ? r2((clicks / impressions) * 100) : null,
      cpc: clicks > 0 ? r2(spend / clicks) : null,
      sourceSnapshotId: existing?.sourceSnapshotId ?? latest.sourceSnapshotId ?? null,
      truthState: "finalized" as const,
      truthVersion,
      finalizedAt: new Date().toISOString(),
      validationStatus: "passed" as const,
      sourceRunId: latest.sourceRunId ?? existing?.sourceRunId ?? null,
      createdAt: existing?.createdAt,
      updatedAt: existing?.updatedAt,
    };
  });
}

export async function getMetaWarehouseTrends(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
}): Promise<MetaWarehouseTrendResponse> {
  const providerAccountIds = input.providerAccountIds ?? [];
  const v2Enabled =
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId) &&
    providerAccountIds.length > 0;
  const [rawRows, verification] = await Promise.all([
    getMetaAccountDailyRange(input),
    v2Enabled
      ? getMetaPublishedVerificationSummary({
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
          providerAccountIds,
          surfaces: ["account_daily"],
        }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const rows = v2Enabled
    ? filterRowsToPublishedKeys(rawRows, verification, "account_daily")
    : rawRows;
  const byDate = new Map<string, MetaAccountDailyRow[]>();
  for (const row of rows) {
    const dateKey = normalizeMetaServingDate(row.date);
    const list = byDate.get(dateKey);
    if (list) list.push(row);
    else byDate.set(dateKey, [row]);
  }

  let points = Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, dailyRows]) => {
      const spend = r2(dailyRows.reduce((sum, row) => sum + row.spend, 0));
      const revenue = r2(dailyRows.reduce((sum, row) => sum + row.revenue, 0));
      const conversions = dailyRows.reduce((sum, row) => sum + row.conversions, 0);
      const impressions = dailyRows.reduce((sum, row) => sum + row.impressions, 0);
      const clicks = dailyRows.reduce((sum, row) => sum + row.clicks, 0);
      return {
        date,
        spend,
        revenue,
        conversions,
        roas: spend > 0 ? r2(revenue / spend) : 0,
        cpa: conversions > 0 ? r2(spend / conversions) : null,
        ctr: impressions > 0 ? r2((clicks / impressions) * 100) : null,
        cpc: clicks > 0 ? r2(spend / clicks) : null,
        impressions,
        clicks,
      };
    });

  return {
    freshness: {
      ...buildFreshnessFromRows(points.map((point) => ({ updatedAt: point.date })), rows.length > 0 ? "ready" : "stale"),
    },
    isPartial: v2Enabled ? !verification?.truthReady : rows.length === 0,
    verification: buildVerificationMetadata(verification),
    points,
  };
}

export async function getMetaWarehouseCampaigns(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  campaignIds?: string[] | null;
}): Promise<MetaWarehouseCampaignResponse> {
  const providerAccountIds = input.providerAccountIds ?? [];
  const v2Enabled =
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId) &&
    providerAccountIds.length > 0;
  const [rawRows, verification] = await Promise.all([
    getMetaCampaignDailyRange(input),
    v2Enabled
      ? getMetaPublishedVerificationSummary({
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
          providerAccountIds,
          surfaces: ["campaign_daily"],
        }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const rows = v2Enabled
    ? filterRowsToPublishedKeys(rawRows, verification, "campaign_daily")
    : rawRows;
  const byCampaign = new Map<string, MetaCampaignDailyRow[]>();
  for (const row of rows) {
    const key = `${row.providerAccountId}:${row.campaignId}`;
    const list = byCampaign.get(key);
    if (list) list.push(row);
    else byCampaign.set(key, [row]);
  }

  let aggregated = Array.from(byCampaign.entries()).map(([, campaignRows]) => {
    const latest = campaignRows.at(-1) ?? campaignRows[0];
    const spend = r2(campaignRows.reduce((sum, row) => sum + row.spend, 0));
    const revenue = r2(campaignRows.reduce((sum, row) => sum + row.revenue, 0));
    const conversions = campaignRows.reduce((sum, row) => sum + row.conversions, 0);
    const impressions = campaignRows.reduce((sum, row) => sum + row.impressions, 0);
    const clicks = campaignRows.reduce((sum, row) => sum + row.clicks, 0);
    return {
      providerAccountId: latest.providerAccountId,
      campaignId: latest.campaignId,
      campaignName: latest.campaignNameCurrent ?? latest.campaignNameHistorical,
      campaignStatus: latest.campaignStatus,
      objective: latest.objective,
      buyingType: latest.buyingType,
      optimizationGoal: latest.optimizationGoal ?? null,
      customEventType: latest.customEventType ?? null,
      isCustomEventTypeMixed: Boolean(latest.isCustomEventTypeMixed),
      spend,
      revenue,
      conversions,
      roas: spend > 0 ? r2(revenue / spend) : 0,
      cpa: conversions > 0 ? r2(spend / conversions) : null,
      ctr: impressions > 0 ? r2((clicks / impressions) * 100) : null,
      cpc: clicks > 0 ? r2(spend / clicks) : null,
      impressions,
      clicks,
    };
  });

  const campaignIds = aggregated.map((row) => row.campaignId);
  if (campaignIds.length === 0) {
    return {
      freshness: {
        ...buildFreshnessFromRows(rows, rows.length > 0 ? "ready" : "stale"),
      },
      isPartial: v2Enabled ? !verification?.truthReady : rows.length === 0,
      verification: buildVerificationMetadata(verification),
      rows: [],
    };
  }

  const [dimensions, latestConfigHistory] = await Promise.all([
    readMetaCampaignDimensions({
      businessId: input.businessId,
      campaignIds,
    }).catch((error) => {
      console.warn("[meta-serving] campaign_dimensions_unavailable", {
        businessId: input.businessId,
        message: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }),
    readLatestMetaCampaignConfigHistory({
      businessId: input.businessId,
      campaignIds,
    }).catch((error) => {
      console.warn("[meta-serving] campaign_config_history_unavailable", {
        businessId: input.businessId,
        message: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }),
  ]);

  aggregated = aggregated.map((row) => {
    const dimension = dimensions.get(row.campaignId);
    const latestConfig = latestConfigHistory.get(row.campaignId);
    const currentConfig = latestConfig
      ? buildCurrentConfigFromSnapshot(latestConfig)
      : null;
    return {
      ...row,
      campaignName:
        dimension?.campaignNameCurrent ??
        dimension?.campaignNameHistorical ??
        row.campaignName,
      campaignStatus: dimension?.campaignStatus ?? row.campaignStatus,
      objective: currentConfig?.objective ?? row.objective,
      buyingType: dimension?.buyingType ?? row.buyingType,
      optimizationGoal: currentConfig?.optimizationGoal ?? null,
      customEventType: currentConfig?.customEventType ?? row.customEventType ?? null,
      bidStrategyType: currentConfig?.bidStrategyType ?? null,
      bidStrategyLabel: currentConfig?.bidStrategyLabel ?? null,
      manualBidAmount: currentConfig?.manualBidAmount ?? null,
      bidValue: currentConfig?.bidValue ?? null,
      bidValueFormat: currentConfig?.bidValueFormat ?? null,
      dailyBudget: currentConfig?.dailyBudget ?? null,
      lifetimeBudget: currentConfig?.lifetimeBudget ?? null,
      isBudgetMixed: currentConfig?.isBudgetMixed ?? false,
      isConfigMixed: currentConfig?.isConfigMixed ?? false,
      isOptimizationGoalMixed: currentConfig?.isOptimizationGoalMixed ?? false,
      isCustomEventTypeMixed: currentConfig?.isCustomEventTypeMixed ?? row.isCustomEventTypeMixed ?? false,
      isBidStrategyMixed: currentConfig?.isBidStrategyMixed ?? false,
      isBidValueMixed: currentConfig?.isBidValueMixed ?? false,
    };
  });

  return {
    freshness: {
      ...buildFreshnessFromRows(rows, rows.length > 0 ? "ready" : "stale"),
    },
    isPartial: v2Enabled ? !verification?.truthReady : rows.length === 0,
    verification: buildVerificationMetadata(verification),
    rows: aggregated.sort((a, b) => b.spend - a.spend),
  };
}

type MetaWarehouseCurrentConfig = {
  objective?: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  pixelId?: string | null;
  customConversionId?: string | null;
  promotedObject?: unknown;
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
  isCustomEventTypeMixed: boolean;
  isBidStrategyMixed: boolean;
  isBidValueMixed: boolean;
};

type MetaWarehousePreviousConfig = {
  previousManualBidAmount: number | null;
  previousBidValue: number | null;
  previousBidValueFormat: "currency" | "roas" | null;
  previousBidCapturedAt: string | null;
  previousDailyBudget: number | null;
  previousLifetimeBudget: number | null;
  previousBudgetCapturedAt: string | null;
};

function hasMissingConfigValues(input: {
  objective?: string | null;
  optimizationGoal?: string | null;
  customEventType?: string | null;
  bidStrategyType?: string | null;
  bidStrategyLabel?: string | null;
  manualBidAmount: number | null;
  bidValue: number | null;
  bidValueFormat: "currency" | "roas" | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
}) {
  const missingBid =
    input.manualBidAmount == null &&
    (input.bidValue == null || input.bidValueFormat == null);
  const missingBudget =
    input.dailyBudget == null &&
    input.lifetimeBudget == null;
  return (
    ("objective" in input && input.objective == null) ||
    ("optimizationGoal" in input && input.optimizationGoal == null) ||
    ("customEventType" in input && input.customEventType == null) ||
    ("bidStrategyType" in input && input.bidStrategyType == null) ||
    ("bidStrategyLabel" in input && input.bidStrategyLabel == null) ||
    missingBid ||
    missingBudget
  );
}

function mergeCurrentConfig<
  T extends {
    objective?: string | null;
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
    isCustomEventTypeMixed?: boolean;
    isBidStrategyMixed: boolean;
    isBidValueMixed: boolean;
  },
>(row: T, fallback: MetaWarehouseCurrentConfig | null | undefined): T {
  if (!fallback) return row;
  return {
    ...row,
    objective: row.objective ?? fallback.objective,
    optimizationGoal: row.optimizationGoal ?? fallback.optimizationGoal,
    customEventType: row.customEventType ?? fallback.customEventType,
    pixelId: row.pixelId ?? fallback.pixelId ?? null,
    customConversionId: row.customConversionId ?? fallback.customConversionId ?? null,
    promotedObjectJson: row.promotedObjectJson ?? fallback.promotedObject ?? null,
    bidStrategyType: row.bidStrategyType ?? fallback.bidStrategyType,
    bidStrategyLabel: row.bidStrategyLabel ?? fallback.bidStrategyLabel,
    manualBidAmount: row.manualBidAmount ?? fallback.manualBidAmount,
    bidValue: row.bidValue ?? fallback.bidValue,
    bidValueFormat: row.bidValueFormat ?? fallback.bidValueFormat,
    dailyBudget: row.dailyBudget ?? fallback.dailyBudget,
    lifetimeBudget: row.lifetimeBudget ?? fallback.lifetimeBudget,
    isBudgetMixed: row.isBudgetMixed || fallback.isBudgetMixed,
    isConfigMixed: row.isConfigMixed || fallback.isConfigMixed,
    isOptimizationGoalMixed:
      row.isOptimizationGoalMixed || fallback.isOptimizationGoalMixed,
    isCustomEventTypeMixed:
      Boolean(row.isCustomEventTypeMixed) || fallback.isCustomEventTypeMixed,
    isBidStrategyMixed: row.isBidStrategyMixed || fallback.isBidStrategyMixed,
    isBidValueMixed: row.isBidValueMixed || fallback.isBidValueMixed,
  };
}

function buildEmptyCurrentConfig(objective: string | null = null): MetaWarehouseCurrentConfig {
  return {
    objective,
    optimizationGoal: null,
    customEventType: null,
    pixelId: null,
    customConversionId: null,
    promotedObject: null,
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
    isCustomEventTypeMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
  };
}

function hasInformativeCurrentConfig(config: MetaWarehouseCurrentConfig | null | undefined) {
  if (!config) return false;
  return (
    config.objective != null ||
    config.optimizationGoal != null ||
    config.customEventType != null ||
    config.pixelId != null ||
    config.customConversionId != null ||
    config.bidStrategyType != null ||
    config.bidStrategyLabel != null ||
    config.manualBidAmount != null ||
    config.bidValue != null ||
    config.bidValueFormat != null ||
    config.dailyBudget != null ||
    config.lifetimeBudget != null ||
    config.isBudgetMixed ||
    config.isConfigMixed ||
    config.isOptimizationGoalMixed ||
    config.isCustomEventTypeMixed ||
    config.isBidStrategyMixed ||
    config.isBidValueMixed
  );
}

function buildCurrentConfigFromCampaignResponseRow(
  row: MetaWarehouseCampaignResponse["rows"][number],
): MetaWarehouseCurrentConfig | null {
  const config: MetaWarehouseCurrentConfig = {
    objective: row.objective ?? null,
    optimizationGoal: row.optimizationGoal ?? null,
    customEventType: row.customEventType ?? null,
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
    isCustomEventTypeMixed: Boolean(row.isCustomEventTypeMixed),
    isBidStrategyMixed: Boolean(row.isBidStrategyMixed),
    isBidValueMixed: Boolean(row.isBidValueMixed),
  };
  return hasInformativeCurrentConfig(config) ? config : null;
}

function resolveCurrentConfig(input: {
  snapshot?: MetaWarehouseCurrentConfig | null;
  live?: MetaWarehouseCurrentConfig | null;
}) {
  const snapshotConfig = input.snapshot ?? null;
  const liveConfig = input.live ?? null;
  const merged =
    liveConfig != null
      ? mergeCurrentConfig(
          liveConfig,
          snapshotConfig ?? buildEmptyCurrentConfig(liveConfig.objective ?? null),
        )
      : snapshotConfig;
  return hasInformativeCurrentConfig(merged) ? merged : null;
}

function buildCurrentConfigFromSnapshot(payload: {
  objective?: string | null;
  optimizationGoal: string | null;
  customEventType?: string | null;
  pixelId?: string | null;
  customConversionId?: string | null;
  promotedObject?: unknown;
  bidStrategyType: string | null;
  bidStrategyLabel: string | null;
  manualBidAmount: number | null;
  bidValue: number | null;
  bidValueFormat: "currency" | "roas" | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  isBudgetMixed?: boolean;
  isConfigMixed?: boolean;
  isOptimizationGoalMixed?: boolean;
  isCustomEventTypeMixed?: boolean;
  isBidStrategyMixed?: boolean;
  isBidValueMixed?: boolean;
}): MetaWarehouseCurrentConfig {
  return {
    objective: payload.objective ?? null,
    optimizationGoal: payload.optimizationGoal,
    customEventType: payload.customEventType ?? null,
    pixelId: payload.pixelId ?? null,
    customConversionId: payload.customConversionId ?? null,
    promotedObject: payload.promotedObject ?? null,
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

async function readCurrentConfigFallbacks(input: {
  businessId: string;
  providerAccountIds: string[];
}): Promise<{
  campaignConfigsByAccount: Map<string, Map<string, MetaWarehouseCurrentConfig>>;
  adsetConfigsByAccount: Map<string, Map<string, MetaWarehouseCurrentConfig>>;
}> {
  const providerAccountIds = Array.from(new Set(input.providerAccountIds.filter(Boolean)));
  if (providerAccountIds.length === 0) {
    return {
      campaignConfigsByAccount: new Map(),
      adsetConfigsByAccount: new Map(),
    };
  }

  const credentials = await resolveMetaCredentials(input.businessId).catch(() => null);
  if (!credentials?.accessToken) {
    return {
      campaignConfigsByAccount: new Map(),
      adsetConfigsByAccount: new Map(),
    };
  }

  const campaignConfigsByAccount = new Map<string, Map<string, MetaWarehouseCurrentConfig>>();
  const adsetConfigsByAccount = new Map<string, Map<string, MetaWarehouseCurrentConfig>>();

  await Promise.all(
    providerAccountIds.map(async (providerAccountId) => {
      const [campaignConfigs, adsetConfigs] = await Promise.all([
        fetchMetaCampaignConfigs(credentials, providerAccountId, credentials.accessToken).catch(
          () => new Map()
        ),
        fetchMetaAdSetConfigs(providerAccountId, credentials.accessToken).catch(
          () => new Map()
        ),
      ]);

      const campaignMap = new Map<string, MetaWarehouseCurrentConfig>();
      for (const [campaignId, campaignConfig] of campaignConfigs.entries()) {
        campaignMap.set(
          campaignId,
          buildCurrentConfigFromSnapshot(
            buildConfigSnapshotPayload({
              campaignId,
              objective: campaignConfig.objective ?? null,
              bidStrategy: campaignConfig.bid_strategy ?? null,
              manualBidAmount:
                campaignConfig.bid_amount != null ? Number(campaignConfig.bid_amount) : null,
              targetRoas:
                campaignConfig.bid_constraints?.roas_average_floor != null
                  ? Number(campaignConfig.bid_constraints.roas_average_floor)
                  : null,
              dailyBudget:
                campaignConfig.daily_budget != null ? Number(campaignConfig.daily_budget) : null,
              lifetimeBudget:
                campaignConfig.lifetime_budget != null
                  ? Number(campaignConfig.lifetime_budget)
                  : null,
            })
          )
        );
      }
      campaignConfigsByAccount.set(providerAccountId, campaignMap);

      const adsetMap = new Map<string, MetaWarehouseCurrentConfig>();
      for (const [adsetId, adsetConfig] of adsetConfigs.entries()) {
        const parentCampaign = adsetConfig.campaign_id
          ? campaignConfigs.get(adsetConfig.campaign_id) ?? null
          : null;
        adsetMap.set(
          adsetId,
          buildCurrentConfigFromSnapshot(
            buildConfigSnapshotPayload({
              campaignId: adsetConfig.campaign_id ?? null,
              optimizationGoal: adsetConfig.optimization_goal ?? null,
              customEventType: adsetConfig.promoted_object?.custom_event_type ?? null,
              pixelId: adsetConfig.promoted_object?.pixel_id ?? null,
              customConversionId: adsetConfig.promoted_object?.custom_conversion_id ?? null,
              promotedObject: adsetConfig.promoted_object ?? null,
              bidStrategy:
                adsetConfig.bid_strategy ?? parentCampaign?.bid_strategy ?? null,
              manualBidAmount:
                adsetConfig.bid_amount != null
                  ? Number(adsetConfig.bid_amount)
                  : parentCampaign?.bid_amount != null
                    ? Number(parentCampaign.bid_amount)
                    : null,
              targetRoas:
                adsetConfig.bid_constraints?.roas_average_floor != null
                  ? Number(adsetConfig.bid_constraints.roas_average_floor)
                  : parentCampaign?.bid_constraints?.roas_average_floor != null
                    ? Number(parentCampaign.bid_constraints.roas_average_floor)
                    : null,
              dailyBudget:
                adsetConfig.daily_budget != null
                  ? Number(adsetConfig.daily_budget)
                  : parentCampaign?.daily_budget != null
                    ? Number(parentCampaign.daily_budget)
                    : null,
              lifetimeBudget:
                adsetConfig.lifetime_budget != null
                  ? Number(adsetConfig.lifetime_budget)
                  : parentCampaign?.lifetime_budget != null
                    ? Number(parentCampaign.lifetime_budget)
                    : null,
            })
          )
        );
      }
      adsetConfigsByAccount.set(providerAccountId, adsetMap);
    })
  );

  return {
    campaignConfigsByAccount,
    adsetConfigsByAccount,
  };
}

function mergePreviousConfig(
  current: MetaWarehousePreviousConfig | null,
  fallback: MetaPreviousConfigDiff | null | undefined
): MetaWarehousePreviousConfig | null {
  if (!current && !fallback) return null;
  return {
    previousManualBidAmount:
      current?.previousManualBidAmount ?? fallback?.previousManualBidAmount ?? null,
    previousBidValue:
      current?.previousBidValue ?? fallback?.previousBidValue ?? null,
    previousBidValueFormat:
      current?.previousBidValueFormat ?? fallback?.previousBidValueFormat ?? null,
    previousBidCapturedAt:
      current?.previousBidCapturedAt ?? fallback?.previousBidCapturedAt ?? null,
    previousDailyBudget:
      current?.previousDailyBudget ?? fallback?.previousDailyBudget ?? null,
    previousLifetimeBudget:
      current?.previousLifetimeBudget ?? fallback?.previousLifetimeBudget ?? null,
    previousBudgetCapturedAt:
      current?.previousBudgetCapturedAt ?? fallback?.previousBudgetCapturedAt ?? null,
  };
}

export async function hydrateCampaignRowsFromSnapshotsForServing(input: {
  businessId: string;
  rows: MetaCampaignDailyRow[];
}) {
  const candidateIds = Array.from(
    new Set(
      input.rows
        .filter((row) =>
          hasMissingConfigValues({
            objective: row.objective,
            optimizationGoal: row.optimizationGoal,
            customEventType: row.customEventType,
            bidStrategyType: row.bidStrategyType,
            bidStrategyLabel: row.bidStrategyLabel,
            manualBidAmount: row.manualBidAmount,
            bidValue: row.bidValue,
            bidValueFormat: row.bidValueFormat,
            dailyBudget: row.dailyBudget,
            lifetimeBudget: row.lifetimeBudget,
          })
        )
        .map((row) => row.campaignId)
        .filter(Boolean)
    )
  );
  if (candidateIds.length === 0) return input.rows;

  const [snapshots, currentConfigs] = await Promise.all([
    readLatestMetaConfigSnapshots({
      businessId: input.businessId,
      entityLevel: "campaign",
      entityIds: candidateIds,
    }),
    readCurrentConfigFallbacks({
      businessId: input.businessId,
      providerAccountIds: input.rows.map((row) => row.providerAccountId),
    }),
  ]);

  const repairedRows = input.rows.map((row) => {
    const snapshot = snapshots.get(row.campaignId);
    const currentConfig =
      currentConfigs.campaignConfigsByAccount
        .get(row.providerAccountId)
        ?.get(row.campaignId) ?? null;
    return mergeCurrentConfig(
      mergeCurrentConfig(row, currentConfig),
      snapshot ? buildCurrentConfigFromSnapshot(snapshot) : null,
    );
  });

  return repairedRows;
}

export async function repairCampaignRowsFromSnapshots(input: {
  businessId: string;
  rows: MetaCampaignDailyRow[];
}) {
  return hydrateCampaignRowsFromSnapshotsForServing(input);
}

export async function hydrateAdSetRowsFromSnapshotsForServing(input: {
  businessId: string;
  rows: MetaAdSetDailyRow[];
}) {
  const candidateIds = Array.from(
    new Set(
      input.rows
        .filter((row) =>
          hasMissingConfigValues({
            optimizationGoal: row.optimizationGoal,
            customEventType: row.customEventType,
            bidStrategyType: row.bidStrategyType,
            bidStrategyLabel: row.bidStrategyLabel,
            manualBidAmount: row.manualBidAmount,
            bidValue: row.bidValue,
            bidValueFormat: row.bidValueFormat,
            dailyBudget: row.dailyBudget,
            lifetimeBudget: row.lifetimeBudget,
          })
        )
        .map((row) => row.adsetId)
        .filter(Boolean)
    )
  );
  if (candidateIds.length === 0) return input.rows;

  const [snapshots, currentConfigs] = await Promise.all([
    readLatestMetaConfigSnapshots({
      businessId: input.businessId,
      entityLevel: "adset",
      entityIds: candidateIds,
    }),
    readCurrentConfigFallbacks({
      businessId: input.businessId,
      providerAccountIds: input.rows.map((row) => row.providerAccountId),
    }),
  ]);

  const repairedRows = input.rows.map((row) => {
    const snapshot = snapshots.get(row.adsetId);
    const currentConfig =
      currentConfigs.adsetConfigsByAccount
        .get(row.providerAccountId)
        ?.get(row.adsetId) ?? null;
    return mergeCurrentConfig(
      mergeCurrentConfig(row, currentConfig),
      snapshot ? buildCurrentConfigFromSnapshot(snapshot) : null,
    );
  });

  return repairedRows;
}

export async function repairAdSetRowsFromSnapshots(input: {
  businessId: string;
  rows: MetaAdSetDailyRow[];
}) {
  return hydrateAdSetRowsFromSnapshotsForServing(input);
}

function zeroDetailedMetrics() {
  return {
    uniqueClicks: 0,
    uniqueCtr: 0,
    inlineLinkClickCtr: 0,
    outboundClicks: 0,
    outboundCtr: 0,
    uniqueOutboundClicks: 0,
    uniqueOutboundCtr: 0,
    landingPageViews: 0,
    costPerLandingPageView: 0,
    addToCart: 0,
    addToCartValue: 0,
    costPerAddToCart: 0,
    initiateCheckout: 0,
    initiateCheckoutValue: 0,
    costPerCheckoutInitiated: 0,
    leads: 0,
    leadsValue: 0,
    costPerLead: 0,
    registrationsCompleted: 0,
    registrationsCompletedValue: 0,
    costPerRegistrationCompleted: 0,
    searches: 0,
    searchesValue: 0,
    costPerSearch: 0,
    addPaymentInfo: 0,
    addPaymentInfoValue: 0,
    costPerAddPaymentInfo: 0,
    pageLikes: 0,
    costPerPageLike: 0,
    postEngagement: 0,
    costPerEngagement: 0,
    postReactions: 0,
    costPerReaction: 0,
    postComments: 0,
    costPerPostComment: 0,
    postShares: 0,
    costPerPostShare: 0,
    messagingConversationsStarted: 0,
    costPerMessagingConversationStarted: 0,
    appInstalls: 0,
    costPerAppInstall: 0,
    contentViews: 0,
    contentViewsValue: 0,
    costPerContentView: 0,
    videoViews3s: 0,
    videoViews15s: 0,
    videoViews25: 0,
    videoViews50: 0,
    videoViews75: 0,
    videoViews95: 0,
    videoViews100: 0,
    costPerVideoView: 0,
  };
}

function buildCampaignTableRow(input: {
  row: MetaWarehouseCampaignResponse["rows"][number];
  latestConfig?: MetaWarehouseCurrentConfig | null;
  previousConfig?: MetaWarehousePreviousConfig | null;
}): MetaWarehouseCampaignTableRow {
  const latest = input.latestConfig;
  const previous = input.previousConfig;
  return {
    id: input.row.campaignId,
    accountId: input.row.providerAccountId,
    name: input.row.campaignName ?? "Unknown Campaign",
    status: input.row.campaignStatus ?? "UNKNOWN",
    objective: latest?.objective ?? null,
    budgetLevel: latest?.dailyBudget != null || latest?.lifetimeBudget != null ? "campaign" : null,
    spend: input.row.spend,
    purchases: input.row.conversions,
    revenue: input.row.revenue,
    roas: input.row.roas,
    cpa: input.row.cpa ?? 0,
    ctr: input.row.ctr ?? 0,
    cpm: input.row.impressions > 0 ? r2((input.row.spend / input.row.impressions) * 1000) : 0,
    cpc: input.row.cpc ?? (input.row.clicks > 0 ? r2(input.row.spend / input.row.clicks) : 0),
    cpp: input.row.impressions > 0 ? r2(input.row.spend / input.row.impressions) : 0,
    impressions: input.row.impressions,
    reach: input.row.impressions,
    frequency: 0,
    clicks: input.row.clicks,
    currency: "USD",
    optimizationGoal: latest?.optimizationGoal ?? null,
    customEventType: latest?.customEventType ?? null,
    bidStrategyType: latest?.bidStrategyType ?? null,
    bidStrategyLabel: latest?.bidStrategyLabel ?? null,
    manualBidAmount: latest?.manualBidAmount ?? null,
    previousManualBidAmount: previous?.previousManualBidAmount ?? null,
    bidValue: latest?.bidValue ?? null,
    bidValueFormat: latest?.bidValueFormat ?? null,
    previousBidValue: previous?.previousBidValue ?? null,
    previousBidValueFormat: previous?.previousBidValueFormat ?? null,
    previousBidValueCapturedAt: previous?.previousBidCapturedAt ?? null,
    dailyBudget: latest?.dailyBudget ?? null,
    lifetimeBudget: latest?.lifetimeBudget ?? null,
    previousDailyBudget: previous?.previousDailyBudget ?? null,
    previousLifetimeBudget: previous?.previousLifetimeBudget ?? null,
    previousBudgetCapturedAt: previous?.previousBudgetCapturedAt ?? null,
    isBudgetMixed: Boolean(latest?.isBudgetMixed),
    isConfigMixed: Boolean(latest?.isConfigMixed),
    isOptimizationGoalMixed: Boolean(latest?.isOptimizationGoalMixed),
    isCustomEventTypeMixed: Boolean(latest?.isCustomEventTypeMixed),
    isBidStrategyMixed: Boolean(latest?.isBidStrategyMixed),
    isBidValueMixed: Boolean(latest?.isBidValueMixed),
    ...zeroDetailedMetrics(),
  };
}

export async function getMetaWarehouseCampaignTable(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  campaignIds?: string[] | null;
  includePrev?: boolean;
  includePrevBudget?: boolean;
}): Promise<MetaWarehouseCampaignTableRow[]> {
  const payload = await getMetaWarehouseCampaigns(input);
  if (payload.rows.length === 0) return [];
  const entityIds = Array.from(new Set(payload.rows.map((row) => row.campaignId)));
  const previousEntityIds =
    input.includePrevBudget === false
      ? Array.from(
          new Set(
            payload.rows
              .filter((row) => String(row.campaignStatus ?? "").toUpperCase() === "ACTIVE")
              .filter((row) =>
                row.manualBidAmount != null ||
                row.bidValue != null ||
                row.bidValueFormat != null
              )
              .map((row) => row.campaignId),
          ),
        )
      : entityIds;
  const previousHistoryDiffs =
    input.includePrev && previousEntityIds.length > 0
      ? await readPreviousDifferentMetaCampaignConfigHistoryDiffs({
          businessId: input.businessId,
          campaignIds: previousEntityIds,
          includeBudget: input.includePrevBudget,
        }).catch((error) => {
          console.warn("[meta-serving] campaign_previous_config_unavailable", {
            businessId: input.businessId,
            message: error instanceof Error ? error.message : String(error),
          });
          return new Map<string, MetaPreviousConfigDiff>();
        })
      : new Map<string, MetaPreviousConfigDiff>();

  return payload.rows.map((row) =>
    buildCampaignTableRow({
      row,
      latestConfig: buildCurrentConfigFromCampaignResponseRow(row),
      previousConfig: input.includePrev
        ? mergePreviousConfig(null, previousHistoryDiffs.get(row.campaignId))
        : null,
    })
  );
}

function buildAdSetTableRow(input: {
  row: MetaAdSetDailyRow;
  latestConfig?: MetaWarehouseCurrentConfig | null;
  previousConfig?: MetaWarehousePreviousConfig | null;
}): MetaWarehouseAdSetTableRow {
  const latest = input.latestConfig;
  const previous = input.previousConfig;
  return {
    id: input.row.adsetId,
    accountId: input.row.providerAccountId,
    name: input.row.adsetNameCurrent ?? input.row.adsetNameHistorical ?? "Unknown Ad Set",
    campaignId: input.row.campaignId ?? "",
    status: input.row.adsetStatus ?? "UNKNOWN",
    budgetLevel: latest?.dailyBudget != null || latest?.lifetimeBudget != null ? "adset" : null,
    dailyBudget: latest?.dailyBudget ?? null,
    lifetimeBudget: latest?.lifetimeBudget ?? null,
    optimizationGoal: latest?.optimizationGoal ?? null,
    customEventType: latest?.customEventType ?? null,
    pixelId: latest?.pixelId ?? null,
    customConversionId: latest?.customConversionId ?? null,
    promotedObject: latest?.promotedObject ?? input.row.promotedObjectJson ?? null,
    bidStrategyType: latest?.bidStrategyType ?? null,
    bidStrategyLabel: latest?.bidStrategyLabel ?? null,
    manualBidAmount: latest?.manualBidAmount ?? null,
    previousManualBidAmount: previous?.previousManualBidAmount ?? null,
    bidValue: latest?.bidValue ?? null,
    bidValueFormat: latest?.bidValueFormat ?? null,
    previousBidValue: previous?.previousBidValue ?? null,
    previousBidValueFormat: previous?.previousBidValueFormat ?? null,
    previousBidValueCapturedAt: previous?.previousBidCapturedAt ?? null,
    isBudgetMixed: Boolean(latest?.isBudgetMixed),
    previousDailyBudget: previous?.previousDailyBudget ?? null,
    previousLifetimeBudget: previous?.previousLifetimeBudget ?? null,
    previousBudgetCapturedAt: previous?.previousBudgetCapturedAt ?? null,
    isConfigMixed: Boolean(latest?.isConfigMixed),
    isOptimizationGoalMixed: Boolean(latest?.isOptimizationGoalMixed),
    isCustomEventTypeMixed: Boolean(latest?.isCustomEventTypeMixed),
    isBidStrategyMixed: Boolean(latest?.isBidStrategyMixed),
    isBidValueMixed: Boolean(latest?.isBidValueMixed),
    spend: input.row.spend,
    purchases: input.row.conversions,
    revenue: input.row.revenue,
    roas: input.row.roas,
    cpa: input.row.cpa ?? 0,
    ctr: input.row.ctr ?? 0,
    cpm: input.row.impressions > 0 ? r2((input.row.spend / input.row.impressions) * 1000) : 0,
    impressions: input.row.impressions,
    clicks: input.row.clicks,
  };
}

export async function getMetaWarehouseAdSets(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  campaignId?: string | null;
  campaignIds?: string[] | null;
  providerAccountIds?: string[] | null;
  includePrev?: boolean;
  includePrevBudget?: boolean;
}): Promise<MetaWarehouseAdSetTableRow[]> {
  const providerAccountIds = input.providerAccountIds ?? [];
  const v2Enabled =
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId) &&
    providerAccountIds.length > 0;
  const verification = v2Enabled
    ? await getMetaPublishedVerificationSummary({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        providerAccountIds,
        surfaces: ["adset_daily"],
      }).catch(() => null)
    : null;
  const rows = v2Enabled
    ? filterRowsToPublishedKeys(
        await getMetaAdSetDailyRange({
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
          providerAccountIds: input.providerAccountIds,
          campaignIds: input.campaignIds ?? (input.campaignId ? [input.campaignId] : null),
        }),
        verification,
        "adset_daily",
      )
    : await getMetaAdSetDailyRange({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        providerAccountIds: input.providerAccountIds,
        campaignIds: input.campaignIds ?? (input.campaignId ? [input.campaignId] : null),
      });

  const byAdSet = new Map<string, MetaAdSetDailyRow[]>();
  for (const row of rows) {
    const list = byAdSet.get(row.adsetId);
    if (list) list.push(row);
    else byAdSet.set(row.adsetId, [row]);
  }

  const aggregated = Array.from(byAdSet.values()).map((dailyRows) => {
    const latest = dailyRows.at(-1) ?? dailyRows[0];
    const spend = r2(dailyRows.reduce((sum, row) => sum + row.spend, 0));
    const revenue = r2(dailyRows.reduce((sum, row) => sum + row.revenue, 0));
    const purchases = dailyRows.reduce((sum, row) => sum + row.conversions, 0);
    const impressions = dailyRows.reduce((sum, row) => sum + row.impressions, 0);
    const clicks = dailyRows.reduce((sum, row) => sum + row.clicks, 0);
    return {
      ...latest,
      spend,
      revenue,
      conversions: purchases,
      impressions,
      clicks,
      roas: spend > 0 ? r2(revenue / spend) : 0,
      cpa: purchases > 0 ? r2(spend / purchases) : null,
      ctr: impressions > 0 ? r2((clicks / impressions) * 100) : null,
      cpc: clicks > 0 ? r2(spend / clicks) : null,
    };
  });

  const adsetIds = Array.from(new Set(aggregated.map((row) => row.adsetId)));
  if (adsetIds.length === 0) return [];
  const previousAdsetIds =
    input.includePrevBudget === false
      ? Array.from(
          new Set(
            aggregated
              .filter((row) => String(row.adsetStatus ?? "").toUpperCase() === "ACTIVE")
              .filter((row) =>
                row.manualBidAmount != null ||
                row.bidValue != null ||
                row.bidValueFormat != null
              )
              .map((row) => row.adsetId),
          ),
        )
      : adsetIds;
  const [dimensions, latestConfigHistory, previousHistoryDiffs] = await Promise.all([
    readMetaAdSetDimensions({
      businessId: input.businessId,
      adsetIds,
    }).catch((error) => {
      console.warn("[meta-serving] adset_dimensions_unavailable", {
        businessId: input.businessId,
        message: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }),
    readLatestMetaAdSetConfigHistory({
      businessId: input.businessId,
      adsetIds,
    }).catch((error) => {
      console.warn("[meta-serving] adset_config_history_unavailable", {
        businessId: input.businessId,
        message: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }),
    input.includePrev
      ? readPreviousDifferentMetaAdSetConfigHistoryDiffs({
          businessId: input.businessId,
          adsetIds: previousAdsetIds,
          includeBudget: input.includePrevBudget,
        }).catch((error) => {
          console.warn("[meta-serving] adset_previous_config_unavailable", {
            businessId: input.businessId,
            message: error instanceof Error ? error.message : String(error),
          });
          return new Map<string, MetaPreviousConfigDiff>();
        })
      : Promise.resolve(new Map<string, MetaPreviousConfigDiff>()),
  ]);

  return aggregated
    .map((row) =>
      buildAdSetTableRow({
        row: {
          ...row,
          campaignId: dimensions.get(row.adsetId)?.campaignId ?? row.campaignId,
          adsetNameCurrent:
            dimensions.get(row.adsetId)?.adsetNameCurrent ?? row.adsetNameCurrent,
          adsetNameHistorical:
            dimensions.get(row.adsetId)?.adsetNameHistorical ?? row.adsetNameHistorical,
          adsetStatus: dimensions.get(row.adsetId)?.adsetStatus ?? row.adsetStatus,
        },
        latestConfig: latestConfigHistory.get(row.adsetId)
          ? buildCurrentConfigFromSnapshot(latestConfigHistory.get(row.adsetId)!)
          : null,
        previousConfig: input.includePrev
          ? mergePreviousConfig(null, previousHistoryDiffs.get(row.adsetId))
          : null,
      })
    )
    .sort((a, b) => b.spend - a.spend);
}

export async function getMetaWarehouseBreakdowns(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
}): Promise<MetaWarehouseBreakdownsResponse> {
  const requestedBreakdownTypes = ["age", "country", "placement"] as const;
  const { breakdownRows, budget, verification, isPartial } =
    await getMetaWarehouseBreakdownSnapshot({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      providerAccountIds: input.providerAccountIds,
      requestedBreakdownTypes: [...requestedBreakdownTypes],
    });

  return {
    freshness: buildFreshnessFromRows(
      breakdownRows.map((row) => ({ updatedAt: row.updatedAt })),
      breakdownRows.length > 0 ? "ready" : "syncing"
    ),
    isPartial,
    verification: buildVerificationMetadata(verification),
    age: aggregateMetaBreakdownRows({ breakdownRows, kind: "age" }),
    location: aggregateMetaBreakdownRows({ breakdownRows, kind: "country" }),
    placement: aggregateMetaBreakdownRows({ breakdownRows, kind: "placement" }),
    budget,
  };
}

export async function getMetaWarehouseCountryBreakdowns(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
}): Promise<MetaWarehouseCountryBreakdownsResponse> {
  const { breakdownRows, verification, isPartial } =
    await getMetaWarehouseBreakdownSnapshot({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      providerAccountIds: input.providerAccountIds,
      requestedBreakdownTypes: ["country"],
    });

  return {
    freshness: buildFreshnessFromRows(
      breakdownRows.map((row) => ({ updatedAt: row.updatedAt })),
      breakdownRows.length > 0 ? "ready" : "syncing",
    ),
    isPartial,
    verification: buildVerificationMetadata(verification),
    rows: aggregateMetaBreakdownRows({ breakdownRows, kind: "country" }),
  };
}
