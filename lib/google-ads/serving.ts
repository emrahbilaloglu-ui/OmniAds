import { getIntegrationMetadata } from "@/lib/integrations";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";
import { getBusinessCostModel } from "@/lib/business-cost-model";
import { getDateRangeForQuery } from "@/lib/google-ads-gaql";
import { addDaysToIsoDate, getHistoricalWindowStart } from "@/lib/google-ads/history";
import { getComparisonWindow, pctDelta } from "@/lib/google-ads/reporting-support";
import { buildGoogleAdsAdvisorWindows } from "@/lib/google-ads/advisor-windows";
import {
  buildGoogleAdsAdvisorWindowMatrix,
  type GoogleAdsAdvisorWindowMatrixView,
} from "@/lib/google-ads/advisor-window-matrix";
import {
  buildGoogleAdsAdvisorCampaignSupportFromDailyRows,
  buildGoogleAdsAdvisorProductSupportFromDailyRows,
} from "@/lib/google-ads/advisor-historical-support";
import { buildGoogleAdsDecisionSnapshotWindowSet } from "@/lib/google-ads/decision-window-policy";
import {
  buildGoogleAdsDecisionSnapshotMetadata,
  buildGoogleAdsDecisionSummaryTotals,
  normalizeGoogleAdsDecisionSnapshotPayload,
} from "@/lib/google-ads/decision-snapshot";
import {
  classifySearchIntent,
  getCampaignBadges,
  generateOverviewInsights,
  type GadsCampaignRow,
} from "@/lib/google-ads-intelligence";
import { buildGoogleGrowthAdvisor } from "@/lib/google-ads/growth-advisor";
import { decorateAdvisorRecommendationsForExecution } from "@/lib/google-ads/advisor-handoff";
import { summarizeGoogleAdsAdvisorAggregateIntelligence } from "@/lib/google-ads/advisor-aggregate-intelligence";
import { buildActionClusters } from "@/lib/google-ads/action-clusters";
import { annotateAdvisorMemory, getAdvisorExecutionCalibration } from "@/lib/google-ads/advisor-memory";
import { loadGoogleAdsAdvisorAggregateIntelligence } from "@/lib/google-ads/advisor-aggregate-intelligence";
import { buildGoogleAdsOpportunityEngine, type GoogleAdsOpportunity } from "@/lib/google-ads/opportunity-engine";
import { buildCrossEntityIntelligence } from "@/lib/google-ads/cross-entity-intelligence";
import type {
  GoogleAdvisorAggregateClusterSupport,
  GoogleAdvisorAggregateIntelligence,
  GoogleAdvisorHistoricalSupport,
  GoogleAdvisorMetadata,
  GoogleAdvisorResponse,
  GoogleRecommendation,
  GoogleAdvisorAggregateWeeklyQuerySupport,
} from "@/lib/google-ads/growth-advisor-types";
import {
  analyzeAssetGroups,
  analyzeAssets,
  analyzeBudgetScaling,
  analyzeKeywords,
  analyzeProducts,
  analyzeSearchIntelligence,
} from "@/lib/google-ads/tab-analysis";
import { attachMerchantCenterState } from "@/lib/google-ads/merchant-center-item-state";
import { readMerchantCenterFeedState } from "@/lib/google-ads/merchant-center-warehouse";
import { applyCanonicalGoogleAdsProductFields } from "@/lib/google-ads/product-name";
import {
  countGoogleAdsKeywordInsights,
  type GoogleAdsKeywordInsightRow,
} from "@/lib/google-ads/keyword-insights";
import type { GoogleAdsReportMeta } from "@/lib/google-ads/normalizers";
import {
  createGoogleAdsWarehouseFreshness,
  readGoogleAdsAggregatedRange,
  readGoogleAdsDailyRange,
  getGoogleAdsCoveredDates,
  getGoogleAdsDailyCoverage,
  getLatestGoogleAdsSyncHealth,
} from "@/lib/google-ads/warehouse";
import {
  readGoogleAdsFreshness,
  toGoogleAdsFreshnessSummary,
  type GoogleAdsFreshnessSummary,
} from "@/lib/google-ads/freshness-read";
import {
  evaluateOverviewSummaryProjectionValidity,
  readOverviewSummaryRange,
} from "@/lib/overview-summary-store";
import {
  getGoogleAdsCampaignsReport as getLiveGoogleAdsCampaignsReport,
  getGoogleAdsOverviewReport as getLiveGoogleAdsOverviewReport,
  classifySearchAction,
} from "@/lib/google-ads/reporting";
import { buildQueryOwnershipContextFromTerms } from "@/lib/google-ads/query-ownership";
import {
  normalizeGoogleAdsQueryText,
  readGoogleAdsSearchClusterDailyRows,
  readGoogleAdsSearchQueryHotDailySupportRows,
  readGoogleAdsTopQueryWeeklyRows,
  type GoogleAdsSearchClusterDailySupportReadRow,
  type GoogleAdsSearchQueryHotDailySupportReadRow,
  type GoogleAdsTopQueryWeeklySupportReadRow,
} from "@/lib/google-ads/search-intelligence-storage";
import { GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS } from "@/lib/google-ads/google-contract";
import type {
  GoogleAdsWarehouseDataState,
  GoogleAdsWarehouseDailyRow,
  GoogleAdsWarehouseFreshness,
  GoogleAdsWarehouseScope,
} from "@/lib/google-ads/warehouse-types";
import type { BaseReportParams, ComparativeReportParams, ReportResult, OverviewReportResult } from "@/lib/google-ads/reporting-core";
import { buildProviderStateContract } from "@/lib/provider-readiness";
import { logRuntimeDebug } from "@/lib/runtime-logging";
import {
  getProviderPlatformCurrentDate,
  getTodayIsoForTimeZoneServer,
} from "@/lib/provider-platform-date";

type WarehouseMeta = GoogleAdsReportMeta &
  GoogleAdsWarehouseFreshness & {
    /**
     * The freshness verdict this response's `dataState` was decided from.
     *
     * Published so a surface that wants to say "as of" or "complete" reads the
     * evidence instead of re-deriving it from row counts. Null means we could
     * not read the evidence, which is itself a claim a caller must respect:
     * it may not render the range as authoritative.
     */
    completion?: GoogleAdsFreshnessSummary | null;
  };

/** A warehouse freshness block that carries the verdict it was decided from. */
type ServingFreshness = GoogleAdsWarehouseFreshness & {
  completion?: GoogleAdsFreshnessSummary | null;
};

type GenericRow = Record<string, unknown>;
type WarehouseContextCacheEntry = {
  expiresAt: number;
  value: Promise<{
    integration: Awaited<ReturnType<typeof getIntegrationMetadata>> | null;
    providerAccountIds: string[];
    startDate: string;
    endDate: string;
    providerCurrentDate: string;
    dataState: GoogleAdsWarehouseFreshness["dataState"];
    providerState: ReturnType<typeof buildProviderStateContract>;
  }>;
};

const warehouseContextCache = new Map<string, WarehouseContextCacheEntry>();
const WAREHOUSE_CONTEXT_CACHE_TTL_MS = 30 * 1000;

function toNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeDate(value: string) {
  return value.slice(0, 10);
}

function isWarehouseAggregationOom(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return code === "53200" || message.includes("out of memory");
}

function aggregateDailyRowsLocally(
  scope: GoogleAdsWarehouseScope,
  dailyRows: GoogleAdsWarehouseDailyRow[],
) {
  const byEntityKey = new Map<
    string,
    {
      latest: GoogleAdsWarehouseDailyRow;
      spend: number;
      revenue: number;
      conversions: number;
      impressions: number;
      clicks: number;
      updatedAt: string | null;
    }
  >();

  for (const row of dailyRows) {
    const existing = byEntityKey.get(row.entityKey);
    const nextUpdatedAt = row.updatedAt ?? null;
    if (!existing) {
      byEntityKey.set(row.entityKey, {
        latest: row,
        spend: row.spend,
        revenue: row.revenue,
        conversions: row.conversions,
        impressions: row.impressions,
        clicks: row.clicks,
        updatedAt: nextUpdatedAt,
      });
      continue;
    }

    existing.spend += row.spend;
    existing.revenue += row.revenue;
    existing.conversions += row.conversions;
    existing.impressions += row.impressions;
    existing.clicks += row.clicks;
    if (
      nextUpdatedAt &&
      (!existing.updatedAt || nextUpdatedAt.localeCompare(existing.updatedAt) > 0)
    ) {
      existing.latest = row;
      existing.updatedAt = nextUpdatedAt;
    }
  }

  return Array.from(byEntityKey.values())
    .map((entry) => {
      const latest = entry.latest;
      const payload = asObject(latest.payloadJson);
      const spend = entry.spend;
      const revenue = entry.revenue;
      const conversions = entry.conversions;
      const impressions = entry.impressions;
      const clicks = entry.clicks;
      const baseRow = {
        ...payload,
        id: String(payload.id ?? latest.entityKey),
        name: String(payload.name ?? latest.entityLabel ?? latest.entityKey),
        entityKey: latest.entityKey,
        entityLabel: latest.entityLabel,
        campaignId: latest.campaignId,
        campaignName: latest.campaignName,
        adGroupId: latest.adGroupId,
        adGroupName: latest.adGroupName,
        status: latest.status,
        channel: latest.channel,
        classification: latest.classification,
        spend,
        revenue,
        conversions,
        impressions,
        clicks,
        roas: spend > 0 ? Number((revenue / spend).toFixed(2)) : 0,
        cpa: conversions > 0 ? Number((spend / conversions).toFixed(2)) : 0,
        ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
        cpc: clicks > 0 ? Number((spend / clicks).toFixed(2)) : null,
        conversionRate: clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : null,
        updatedAt: latest.updatedAt ?? null,
      } as Record<string, unknown>;

      if (scope === "product_daily") {
        return applyCanonicalGoogleAdsProductFields({
          row: baseRow,
          dimensionProductTitle: latest.entityLabel,
          payload,
          entityLabel: latest.entityLabel,
          entityKey: latest.entityKey,
        });
      }

      return baseRow;
    })
    .sort(
      (left, right) =>
        toNumber(right.spend) - toNumber(left.spend) ||
        String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    );
}

function enumerateDays(startDate: string, endDate: string) {
  const rows: string[] = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    rows.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

async function resolveWarehouseContext(input: {
  businessId: string;
  accountId?: string | null;
  dateRange: BaseReportParams["dateRange"];
  customStart?: string | null;
  customEnd?: string | null;
}) {
  const cacheKey = [
    input.businessId,
    input.accountId ?? "all",
    input.dateRange,
    input.customStart ?? "",
    input.customEnd ?? "",
  ].join(":");
  const cached = warehouseContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = (async () => {
    const [integration, assignment] = await Promise.all([
      getIntegrationMetadata(input.businessId, "google").catch(() => null),
      getProviderAccountAssignments(input.businessId, "google").catch(() => null),
    ]);
    const providerAccountIds =
      input.accountId && input.accountId !== "all"
        ? [input.accountId]
        : assignment?.account_ids ?? [];
    const { startDate, endDate } = getDateRangeForQuery(
      input.dateRange,
      input.customStart ?? undefined,
      input.customEnd ?? undefined
    );
    const providerCurrentDate =
      providerAccountIds.length > 0
        ? await getProviderPlatformCurrentDate({
            provider: "google",
            businessId: input.businessId,
            providerAccountId:
              input.accountId && input.accountId !== "all"
                ? input.accountId
                : providerAccountIds[0],
            providerAccountIds,
          }).catch(() => new Date().toISOString().slice(0, 10))
        : new Date().toISOString().slice(0, 10);

    const providerState = buildProviderStateContract({
      credentialState: integration?.status === "connected" ? "connected" : "not_connected",
      hasAssignedAccounts: providerAccountIds.length > 0,
      warehouseRowCount: 0,
      warehousePartial: false,
      syncState:
        integration?.status !== "connected"
          ? "not_connected"
          : providerAccountIds.length === 0
            ? "connected_no_assignment"
            : "ready",
      selectedCurrentDay: endDate >= providerCurrentDate,
    });

    const dataState: GoogleAdsWarehouseDataState =
      providerState.assignmentState === "unassigned"
        ? "connected_no_assignment"
        : "ready";

    return {
      integration,
      providerAccountIds,
      startDate,
      endDate,
      providerCurrentDate,
      dataState,
      providerState,
    };
  })();

  warehouseContextCache.set(cacheKey, {
    expiresAt: Date.now() + WAREHOUSE_CONTEXT_CACHE_TTL_MS,
    value,
  });
  return value;
}

/**
 * Read the freshness evidence behind a served range.
 *
 * ONE bulk read per response, never one per date or per scope — the snapshot
 * covers every scope asked for in a single pass. Never throws: an unreadable
 * snapshot returns null, which every caller must treat as "we could not tell",
 * not as "fine".
 */
async function readServingCompletion(input: {
  businessId: string;
  scopes: readonly GoogleAdsWarehouseScope[];
  providerAccountIds: string[];
  startDate: string;
  endDate: string;
}): Promise<GoogleAdsFreshnessSummary | null> {
  if (input.providerAccountIds.length === 0) return null;
  try {
    const snapshot = await readGoogleAdsFreshness({
      businessId: input.businessId,
      scopes: input.scopes,
      startDate: input.startDate,
      endDate: input.endDate,
      providerAccountIds: input.providerAccountIds,
      timeoutMs: 15_000,
    });
    return toGoogleAdsFreshnessSummary(snapshot);
  } catch {
    return null;
  }
}

/**
 * Decide the served data state from freshness EVIDENCE, not from row existence.
 *
 * `ready` is the claim that a range may be served as authoritative. It used to
 * be `SELECT DISTINCT date` reaching the end of the window, so a day fetched
 * once at 01:40 and never re-read reported ready forever. It now requires a
 * verdict of at least `converging`: every day covered AND re-read after that
 * day closed.
 *
 * Everything weaker degrades to `stale` — we hold rows we cannot vouch for —
 * and that includes evidence we could not read at all. Failing to green is the
 * whole point: `unknown` means we could not look, which is never a reason to
 * tell the operator the range is settled. Note that even `ready` here is a
 * statement about OUR re-reads; Google never promises a date has stopped
 * changing, so no caller may render this as final or immutable.
 */
function resolveServingDataState(input: {
  completion: GoogleAdsFreshnessSummary | null;
  hasMissingWindows: boolean;
}): GoogleAdsWarehouseDataState {
  if (input.hasMissingWindows) return "partial";
  const completion = input.completion;
  if (!completion || !completion.evidenceAvailable) return "stale";
  switch (completion.state) {
    case "settled":
    case "converging":
      return "ready";
    case "missing":
      return "partial";
    case "provisional":
    case "unknown":
    default:
      return "stale";
  }
}

function buildMeta(input: {
  freshness: ServingFreshness;
  rowCounts?: Record<string, number>;
}): WarehouseMeta {
  const { completion = null, ...freshness } = input.freshness;
  return {
    ...freshness,
    completion,
    partial: freshness.isPartial || freshness.dataState !== "ready",
    failed_queries: [],
    unavailable_metrics: [],
    query_names: [],
    row_counts: input.rowCounts ?? {},
    report_families: {},
  };
}

const GOOGLE_ADVISOR_DAILY_PAYLOAD_KEYS_BY_SCOPE = {
  campaign_daily: [
    "id",
    "name",
    "campaignId",
    "campaignName",
    "status",
    "channel",
    "classification",
  ],
  keyword_daily: [
    "id",
    "name",
    "keywordText",
    "keyword",
    "status",
    "classification",
  ],
  product_daily: [
    "id",
    "name",
    "productTitle",
    "title",
    "status",
    "classification",
    "productItemId",
    "itemId",
    "inventory",
    "stock",
    "availability",
    "productAvailability",
    "compareAtPrice",
    "compare_at_price",
  ],
} as const;

type GoogleAdsAdvisorSupportBundle = {
  context: Awaited<ReturnType<typeof resolveWarehouseContext>>;
  latestSync: Awaited<ReturnType<typeof getLatestGoogleAdsSyncHealth>> | null;
  campaignDailyRows: GoogleAdsWarehouseDailyRow[];
  keywordDailyRows: GoogleAdsWarehouseDailyRow[];
  productDailyRows: GoogleAdsWarehouseDailyRow[];
  hotQueryRows: GoogleAdsSearchQueryHotDailySupportReadRow[];
  queryWeeklyRows: GoogleAdsTopQueryWeeklySupportReadRow[];
  clusterDailyRows: GoogleAdsSearchClusterDailySupportReadRow[];
  /**
   * Freshness verdict for the advisor's own window, read ONCE for the whole
   * bundle. The advisor renders several windows from these rows; deriving a
   * completion claim per window from row counts is what let a frozen day read
   * as ready everywhere at once.
   */
  completion: GoogleAdsFreshnessSummary | null;
};

type GoogleAdsAdvisorAggregatedDailyRows = ReturnType<typeof aggregateDailyRowsLocally>;

type GoogleAdsAdvisorWindowAggregates = {
  campaignRows: GoogleAdsAdvisorAggregatedDailyRows;
  keywordRows: GoogleAdsAdvisorAggregatedDailyRows;
  productRows: GoogleAdsAdvisorAggregatedDailyRows;
};

function pickAdvisorPayloadFields(
  payload: Record<string, unknown>,
  keys: readonly string[],
) {
  return keys.reduce<Record<string, unknown>>((acc, key) => {
    if (payload[key] !== undefined) acc[key] = payload[key];
    return acc;
  }, {});
}

function trimGoogleAdsDailyRowsForAdvisor(
  scope: keyof typeof GOOGLE_ADVISOR_DAILY_PAYLOAD_KEYS_BY_SCOPE,
  rows: GoogleAdsWarehouseDailyRow[],
) {
  const payloadKeys = GOOGLE_ADVISOR_DAILY_PAYLOAD_KEYS_BY_SCOPE[scope];
  return rows.map((row) => ({
    ...row,
    payloadJson: pickAdvisorPayloadFields(asObject(row.payloadJson), payloadKeys),
  }));
}

function filterGoogleAdsDailyRowsByWindow(
  rows: GoogleAdsWarehouseDailyRow[],
  startDate: string,
  endDate: string,
) {
  return rows.filter((row) => normalizeDate(row.date) >= startDate && normalizeDate(row.date) <= endDate);
}

function buildGoogleAdsAdvisorKeywordTermSet(rows: GoogleAdsWarehouseDailyRow[]) {
  return new Set(
    rows
      .map((row) => {
        const payload = asObject(row.payloadJson);
        return normalizeGoogleAdsQueryText(
          String(payload.keywordText ?? payload.keyword ?? row.entityLabel ?? payload.name ?? ""),
        );
      })
      .filter(Boolean),
  );
}

function buildGoogleAdsFreshnessFromPrefetchedRows(input: {
  rows: Array<{ date: string; updatedAt?: string | null }>;
  startDate: string;
  endDate: string;
  latestSync: Awaited<ReturnType<typeof getLatestGoogleAdsSyncHealth>> | null;
  dataState?: GoogleAdsWarehouseFreshness["dataState"];
  completion?: GoogleAdsFreshnessSummary | null;
  warnings?: string[];
}) {
  // Data availability: which days the prefetched rows actually cover. This is a
  // legitimate row-existence question and stays exactly as it was.
  const coveredDates = new Set(input.rows.map((row) => normalizeDate(row.date)));
  const missingWindows = enumerateDays(input.startDate, input.endDate).filter(
    (date) => !coveredDates.has(date),
  );
  const warnings = Array.from(
    new Set([
      ...(input.warnings ?? []),
      ...(input.latestSync?.last_error ? [String(input.latestSync.last_error)] : []),
    ]),
  );
  return Object.assign(
    createGoogleAdsWarehouseFreshness({
    // Completion, unlike availability, comes from the verdict. With no verdict
    // to hand this degrades to `stale` rather than the old `ready`, which was
    // "rows exist for every day" wearing the word for "authoritative".
    dataState:
      input.dataState ??
      resolveServingDataState({
        completion: input.completion ?? null,
        hasMissingWindows: missingWindows.length > 0,
      }),
    lastSyncedAt:
      input.rows.reduce<string | null>((latest, row) => {
        if (!row.updatedAt) return latest;
        return !latest || row.updatedAt > latest ? row.updatedAt : latest;
      }, null) ??
      (typeof input.latestSync?.updated_at === "string"
        ? input.latestSync.updated_at
        : null) ??
      (typeof input.latestSync?.finished_at === "string"
        ? input.latestSync.finished_at
        : null) ??
      (typeof input.latestSync?.started_at === "string"
        ? input.latestSync.started_at
        : null),
    isPartial: missingWindows.length > 0,
    missingWindows,
    warnings,
    }),
    { completion: input.completion ?? null },
  ) satisfies ServingFreshness;
}

function buildGoogleAdsAdvisorCampaignReportFromScopedDailyRows(input: {
  scopedRows: GoogleAdsWarehouseDailyRow[];
  aggregatedRows: GoogleAdsAdvisorAggregatedDailyRows;
  startDate: string;
  endDate: string;
  latestSync: Awaited<ReturnType<typeof getLatestGoogleAdsSyncHealth>> | null;
  dataState?: GoogleAdsWarehouseFreshness["dataState"];
}) {
  const campaignRows = toCampaignRows(input.aggregatedRows);
  const accountAvgRoas =
    campaignRows.reduce((sum, row) => sum + toNumber(row.revenue), 0) /
      Math.max(1, campaignRows.reduce((sum, row) => sum + toNumber(row.spend), 0)) || 0;

  return {
    rows: campaignRows,
    summary: {
      accountAvgRoas: Number(accountAvgRoas.toFixed(2)),
      totalSpend: Number(
        campaignRows.reduce((sum, row) => sum + toNumber(row.spend), 0).toFixed(2),
      ),
      totalRevenue: Number(
        campaignRows.reduce((sum, row) => sum + toNumber(row.revenue), 0).toFixed(2),
      ),
    },
    meta: buildMeta({
      freshness: buildGoogleAdsFreshnessFromPrefetchedRows({
        rows: input.scopedRows,
        startDate: input.startDate,
        endDate: input.endDate,
        latestSync: input.latestSync,
        dataState: input.dataState,
      }),
      rowCounts: { campaign_daily: campaignRows.length },
    }),
  } satisfies ReportResult<Record<string, unknown>>;
}

function buildGoogleAdsAdvisorProductReportFromScopedDailyRows(input: {
  scopedRows: GoogleAdsWarehouseDailyRow[];
  aggregatedRows: GoogleAdsAdvisorAggregatedDailyRows;
  startDate: string;
  endDate: string;
  latestSync: Awaited<ReturnType<typeof getLatestGoogleAdsSyncHealth>> | null;
  dataState?: GoogleAdsWarehouseFreshness["dataState"];
}) {
  const analysis = analyzeProducts(input.aggregatedRows);
  return {
    rows: analysis.rows,
    summary: analysis.summary,
    insights: analysis.insights,
    meta: buildMeta({
      freshness: buildGoogleAdsFreshnessFromPrefetchedRows({
        rows: input.scopedRows,
        startDate: input.startDate,
        endDate: input.endDate,
        latestSync: input.latestSync,
        dataState: input.dataState,
      }),
      rowCounts: { product_daily: analysis.rows.length },
    }),
  } satisfies ReportResult<Record<string, unknown>>;
}

function buildGoogleAdsAdvisorSearchReportFromScopedSupportRows(input: {
  context: Awaited<ReturnType<typeof resolveWarehouseContext>>;
  startDate: string;
  endDate: string;
  latestSync: Awaited<ReturnType<typeof getLatestGoogleAdsSyncHealth>> | null;
  hotQueryRows: GoogleAdsSearchQueryHotDailySupportReadRow[];
  queryWeeklyRows: GoogleAdsTopQueryWeeklySupportReadRow[];
  clusterDailyRows: GoogleAdsSearchClusterDailySupportReadRow[];
  keywordDailyRows?: GoogleAdsWarehouseDailyRow[];
  productDailyRows?: GoogleAdsWarehouseDailyRow[];
  aggregatedKeywordRows?: GoogleAdsAdvisorAggregatedDailyRows;
  aggregatedProductRows?: GoogleAdsAdvisorAggregatedDailyRows;
  keywordTermSet?: Set<string>;
  productTerms?: string[];
  /** Freshness verdict for `search_term_daily`, read once by the caller. */
  completion?: GoogleAdsFreshnessSummary | null;
}) {
  const hotWindow = resolveGoogleAdsSearchHotWindow({
    providerCurrentDate: input.context.providerCurrentDate,
    startDate: input.startDate,
    endDate: input.endDate,
  });

  const termsMeta = (() => {
    if (input.context.providerAccountIds.length === 0 || !hotWindow.withinHotWindow) {
      const freshness = createGoogleAdsWarehouseFreshness({
        dataState:
          input.context.providerAccountIds.length === 0
            ? input.context.dataState
            : "stale",
        isPartial: hotWindow.requestExtendsOutsideWindow,
        warnings: hotWindow.requestExtendsOutsideWindow
          ? [
              `Search intelligence is only retained for the most recent ${GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS} days starting ${hotWindow.supportStart}.`,
            ]
          : [],
      });
      return {
        rows: [] as Array<Record<string, unknown>>,
        meta: buildMeta({
          freshness,
          rowCounts: { search_term_daily: 0 },
        }),
      };
    }

    const hotRows = input.hotQueryRows;
    const keywordSet =
      input.keywordTermSet ??
      new Set(
        ((hotWindow.effectiveStart === input.startDate && hotWindow.effectiveEnd === input.endDate
          ? input.aggregatedKeywordRows
          : aggregateDailyRowsLocally(
              "keyword_daily",
              filterGoogleAdsDailyRowsByWindow(
                input.keywordDailyRows ?? [],
                hotWindow.effectiveStart,
                hotWindow.effectiveEnd,
              ),
            )) ?? []
          )
          .map((row) =>
            normalizeGoogleAdsQueryText(
              String(row.keywordText ?? row.keyword ?? row.entityLabel ?? row.name ?? ""),
            ),
          )
          .filter(Boolean),
      );
    const productTerms =
      input.productTerms ??
      Array.from(
        new Set(
          ((hotWindow.effectiveStart === input.startDate && hotWindow.effectiveEnd === input.endDate
            ? input.aggregatedProductRows
            : aggregateDailyRowsLocally(
                "product_daily",
                filterGoogleAdsDailyRowsByWindow(
                  input.productDailyRows ?? [],
                  hotWindow.effectiveStart,
                  hotWindow.effectiveEnd,
                ),
              )) ?? []
            )
            .map((row) =>
              String(row.name ?? row.productTitle ?? row.title ?? row.entityLabel ?? "").trim(),
            )
            .filter((value) => value.length >= 4),
        ),
      );
    const brandTerms = deriveGoogleAdsBrandTermsFromSearchRows(
      hotRows.map((row) => ({ campaignName: row.campaignName })),
    );
    const ownershipContext = buildQueryOwnershipContextFromTerms({
      brandTerms,
      productTerms,
    });
    const coveredDates = new Set(hotRows.map((row) => normalizeDate(row.date)));
    const missingWindows = enumerateDays(
      hotWindow.effectiveStart,
      hotWindow.effectiveEnd,
    ).filter((date) => !coveredDates.has(date));

    const byTerm = new Map<
      string,
      {
        key: string;
        searchTerm: string;
        campaignId: string | null;
        campaignName: string | null;
        adGroupId: string | null;
        adGroupName: string | null;
        clusterId: string;
        intentClass: string;
        ownershipClass: string | null;
        spend: number;
        revenue: number;
        conversions: number;
        impressions: number;
        clicks: number;
        sourceSnapshotId: string | null;
      }
    >();

    for (const row of hotRows) {
      const searchTerm = String(
        row.displayQuery ?? row.normalizedQuery ?? row.queryHash,
      ).trim();
      if (!searchTerm) continue;
      const normalizedQuery = normalizeGoogleAdsQueryText(searchTerm);
      if (!normalizedQuery) continue;
      const key = [
        row.providerAccountId,
        row.campaignId ?? "",
        row.adGroupId ?? "",
        normalizedQuery,
      ].join(":");
      const current = byTerm.get(key);
      if (!current) {
        byTerm.set(key, {
          key,
          searchTerm,
          campaignId: row.campaignId,
          campaignName: row.campaignName,
          adGroupId: row.adGroupId,
          adGroupName: row.adGroupName,
          clusterId: row.clusterKey || row.clusterLabel || normalizedQuery,
          intentClass: row.intentClass ?? classifySearchIntent(searchTerm),
          ownershipClass: row.ownershipClass ?? null,
          spend: row.spend,
          revenue: row.revenue,
          conversions: row.conversions,
          impressions: row.impressions,
          clicks: row.clicks,
          sourceSnapshotId: row.sourceSnapshotId,
        });
        continue;
      }
      current.spend += row.spend;
      current.revenue += row.revenue;
      current.conversions += row.conversions;
      current.impressions += row.impressions;
      current.clicks += row.clicks;
      if (row.campaignName) current.campaignName = row.campaignName;
      if (row.adGroupName) current.adGroupName = row.adGroupName;
      if (!current.sourceSnapshotId && row.sourceSnapshotId) {
        current.sourceSnapshotId = row.sourceSnapshotId;
      }
    }

    const rows = Array.from(byTerm.values())
      .map((row) => {
        const normalizedQuery = normalizeGoogleAdsQueryText(row.searchTerm);
        const isKeyword = keywordSet.has(normalizedQuery);
        const spend = Number(row.spend.toFixed(2));
        const revenue = Number(row.revenue.toFixed(2));
        const conversions = Number(row.conversions.toFixed(2));
        const impressions = Math.round(row.impressions);
        const clicks = Math.round(row.clicks);
        const roas = spend > 0 ? Number((revenue / spend).toFixed(2)) : 0;
        const cpa =
          conversions > 0 ? Number((spend / conversions).toFixed(2)) : 0;
        const ctr =
          impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
        const cpc = clicks > 0 ? Number((spend / clicks).toFixed(2)) : null;
        const conversionRate =
          clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : null;
        const wasteFlag = spend > 20 && conversions === 0;
        const keywordOpportunityFlag = !isKeyword && conversions >= 2;
        const negativeKeywordFlag = clicks >= 20 && conversions === 0 && spend > 10;
        return {
          key: row.key,
          searchTerm: row.searchTerm,
          status: "HOT_WINDOW",
          campaignId: row.campaignId,
          campaign: row.campaignName ?? "",
          campaignName: row.campaignName ?? "",
          adGroupId: row.adGroupId,
          adGroup: row.adGroupName ?? "",
          adGroupName: row.adGroupName ?? "",
          matchSource: "SEARCH",
          source: "search_query_hot_daily",
          impressions,
          clicks,
          spend,
          conversions,
          revenue,
          roas,
          cpa,
          ctr,
          cpc,
          conversionRate,
          intent: row.intentClass,
          intentClass: row.intentClass,
          classification: row.intentClass,
          isKeyword,
          wasteFlag,
          keywordOpportunityFlag,
          negativeKeywordFlag,
          clusterId: row.clusterId,
          ownershipClass: row.ownershipClass,
          recommendation: classifySearchAction(
            {
              searchTerm: row.searchTerm,
              campaign: row.campaignName ?? "",
              isKeyword,
              conversions,
              spend,
              clicks,
              roas,
              conversionRate,
            },
            brandTerms,
            productTerms,
            ownershipContext,
          ),
          sourceSnapshotId: row.sourceSnapshotId,
        };
      })
      .sort((left, right) => right.spend - left.spend);

    const freshness = createGoogleAdsWarehouseFreshness({
      // `partial` still means "days are literally absent" — a row-existence
      // fact. `ready` no longer follows from its negation: it now needs a
      // freshness verdict saying every day was re-read after it closed.
      dataState:
        hotWindow.requestExtendsOutsideWindow
          ? "partial"
          : resolveServingDataState({
              completion: input.completion ?? null,
              hasMissingWindows: missingWindows.length > 0,
            }),
      lastSyncedAt:
        (typeof input.latestSync?.updated_at === "string"
          ? input.latestSync.updated_at
          : null) ??
        (typeof input.latestSync?.finished_at === "string"
          ? input.latestSync.finished_at
          : null) ??
        (typeof input.latestSync?.started_at === "string"
          ? input.latestSync.started_at
          : null),
      isPartial: missingWindows.length > 0 || hotWindow.requestExtendsOutsideWindow,
      missingWindows,
      warnings: [
        ...(hotWindow.requestExtendsOutsideWindow
          ? [
              `Search intelligence is only retained for the most recent ${GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS} days starting ${hotWindow.supportStart}.`,
            ]
          : []),
        ...(input.latestSync?.last_error ? [String(input.latestSync.last_error)] : []),
      ],
    });

    return {
      rows,
      meta: buildMeta({
        freshness: Object.assign(freshness, { completion: input.completion ?? null }),
        rowCounts: { search_term_daily: rows.length },
      }),
    };
  })();

  const aggregateIntelligence = summarizeGoogleAdsAdvisorAggregateIntelligence({
    queryWeeklyRows: input.queryWeeklyRows,
    clusterDailyRows: input.clusterDailyRows,
    supportWindowStart: input.startDate,
    supportWindowEnd: input.endDate,
  });

  const keywordSet =
    input.keywordTermSet ??
    new Set(
      (input.aggregatedKeywordRows ?? [])
        .map((row) =>
          normalizeGoogleAdsQueryText(
            String(row.keywordText ?? row.keyword ?? row.entityLabel ?? row.name ?? ""),
          ),
        )
        .filter(Boolean),
    );
  const productTerms =
    input.productTerms ??
    Array.from(
      new Set(
        (input.aggregatedProductRows ?? [])
          .map((row) =>
            String(row.name ?? row.productTitle ?? row.title ?? row.entityLabel ?? "").trim(),
          )
          .filter((value) => value.length >= 4),
      ),
    );
  const aggregateFallbackRows =
    aggregateIntelligence.queryWeeklySupport.length > 0
      ? buildSearchIntelligenceRowsFromWeeklySupport({
          rows: aggregateIntelligence.queryWeeklySupport,
          keywordSet,
          productTerms,
        })
      : buildSearchIntelligenceRowsFromClusterSupport(
          aggregateIntelligence.clusterDailySupport,
        );
  const sourceRows =
    termsMeta.rows.length > 0 ? termsMeta.rows : aggregateFallbackRows;
  const rows = sourceRows;
  const analysis = analyzeSearchIntelligence(rows);
  const aggregateInsights =
    aggregateIntelligence.clusterDailySupport.length === 0
      ? null
      : summarizeSearchIntelligenceFromAggregateSupport({
          clusterSupport: aggregateIntelligence.clusterDailySupport,
          queryWeeklySupport: aggregateIntelligence.queryWeeklySupport,
          keywordSet,
        });
  const warnings = Array.from(
    new Set([
      ...termsMeta.meta.warnings,
      ...(aggregateIntelligence.metadata.topQueryWeeklyAvailable ||
      aggregateIntelligence.metadata.clusterDailyAvailable
        ? [
            `Long-range search intelligence is served from additive query and cluster aggregates; raw search-term rows remain limited to the most recent ${GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS} days.`,
          ]
        : []),
    ]),
  );

  return {
    rows,
    summary: {
      wastefulSpend: rows
        .filter((row) => Boolean(row.wasteFlag))
        .reduce((sum, row) => sum + toNumber(row.spend), 0),
      keywordOpportunityCount: rows.filter((row) => Boolean(row.keywordOpportunityFlag)).length,
      negativeKeywordCount: rows.filter((row) => Boolean(row.negativeKeywordFlag)).length,
      promotionSuggestionCount:
        aggregateInsights?.summary.emergingThemeCount ??
        analysis.summary.emergingThemeCount ??
        0,
    },
    insights: aggregateInsights
      ? {
          ...analysis.insights,
          bestConvertingThemes: aggregateInsights.insights.bestConvertingThemes,
          wastefulThemes: aggregateInsights.insights.wastefulThemes,
          newOpportunityQueries:
            aggregateInsights.insights.newOpportunityQueries.length > 0
              ? aggregateInsights.insights.newOpportunityQueries
              : analysis.insights.newOpportunityQueries,
          semanticClusters: aggregateInsights.insights.semanticClusters,
        }
      : analysis.insights,
    meta: {
      ...termsMeta.meta,
      warnings,
      row_counts: {
        ...termsMeta.meta.row_counts,
        search_term_daily: rows.length,
      },
    },
  } satisfies ReportResult<Record<string, unknown>>;
}

async function buildGoogleAdsAdvisorSupportBundle(input: {
  businessId: string;
  context: Awaited<ReturnType<typeof resolveWarehouseContext>>;
}) {
  if (input.context.providerAccountIds.length === 0) {
    return {
      context: input.context,
      latestSync: null,
      campaignDailyRows: [],
      keywordDailyRows: [],
      productDailyRows: [],
      hotQueryRows: [],
      queryWeeklyRows: [],
      clusterDailyRows: [],
      completion: null,
    } satisfies GoogleAdsAdvisorSupportBundle;
  }

  const providerAccountId =
    input.context.providerAccountIds.length === 1 ? input.context.providerAccountIds[0] : null;
  const baselineHotWindow = resolveGoogleAdsSearchHotWindow({
    providerCurrentDate: input.context.providerCurrentDate,
    startDate: input.context.startDate,
    endDate: input.context.endDate,
  });

  const [
    campaignDailyRows,
    keywordDailyRows,
    productDailyRows,
    hotQueryRows,
    queryWeeklyRows,
    clusterDailyRows,
    latestSync,
    completion,
  ] = await Promise.all([
    readGoogleAdsDailyRange({
      scope: "campaign_daily",
      businessId: input.businessId,
      providerAccountIds: input.context.providerAccountIds,
      startDate: input.context.startDate,
      endDate: input.context.endDate,
      timeoutMs: 30_000,
    }),
    readGoogleAdsDailyRange({
      scope: "keyword_daily",
      businessId: input.businessId,
      providerAccountIds: input.context.providerAccountIds,
      startDate: input.context.startDate,
      endDate: input.context.endDate,
      timeoutMs: 30_000,
    }),
    readGoogleAdsDailyRange({
      scope: "product_daily",
      businessId: input.businessId,
      providerAccountIds: input.context.providerAccountIds,
      startDate: input.context.startDate,
      endDate: input.context.endDate,
      timeoutMs: 30_000,
    }),
    baselineHotWindow.withinHotWindow
      ? readGoogleAdsSearchQueryHotDailySupportRows({
          businessId: input.businessId,
          providerAccountId,
          startDate: baselineHotWindow.effectiveStart,
          endDate: baselineHotWindow.effectiveEnd,
        }).catch(() => [])
      : Promise.resolve([]),
    readGoogleAdsTopQueryWeeklyRows({
      businessId: input.businessId,
      providerAccountId,
      startWeek: isoWeekStart(input.context.startDate),
      endWeek: isoWeekStart(input.context.endDate),
    }).catch(() => []),
    readGoogleAdsSearchClusterDailyRows({
      businessId: input.businessId,
      providerAccountId,
      startDate: input.context.startDate,
      endDate: input.context.endDate,
    }).catch(() => []),
    getLatestGoogleAdsSyncHealth({
      businessId: input.businessId,
      providerAccountId,
    }).catch(() => null),
    readServingCompletion({
      businessId: input.businessId,
      scopes: ["search_term_daily"],
      providerAccountIds: input.context.providerAccountIds,
      startDate: input.context.startDate,
      endDate: input.context.endDate,
    }),
  ]);

  return {
    context: input.context,
    latestSync,
    campaignDailyRows: trimGoogleAdsDailyRowsForAdvisor("campaign_daily", campaignDailyRows),
    keywordDailyRows: trimGoogleAdsDailyRowsForAdvisor("keyword_daily", keywordDailyRows),
    productDailyRows: trimGoogleAdsDailyRowsForAdvisor("product_daily", productDailyRows),
    hotQueryRows,
    queryWeeklyRows,
    clusterDailyRows,
    completion,
  } satisfies GoogleAdsAdvisorSupportBundle;
}

function buildGoogleAdsAdvisorWindowRowsFromMatrixView(input: {
  bundle: GoogleAdsAdvisorSupportBundle;
  view: GoogleAdsAdvisorWindowMatrixView;
  aggregates: GoogleAdsAdvisorWindowAggregates;
}) {
  const campaigns = buildGoogleAdsAdvisorCampaignReportFromScopedDailyRows({
    scopedRows: input.view.slice.campaignDailyRows,
    aggregatedRows: input.aggregates.campaignRows,
    startDate: input.view.startDate,
    endDate: input.view.endDate,
    latestSync: input.bundle.latestSync,
    dataState: input.bundle.context.dataState,
  });
  const search = buildGoogleAdsAdvisorSearchReportFromScopedSupportRows({
    context: input.bundle.context,
    startDate: input.view.startDate,
    endDate: input.view.endDate,
    latestSync: input.bundle.latestSync,
    hotQueryRows: input.view.slice.hotQueryRows,
    queryWeeklyRows: input.view.slice.queryWeeklyRows,
    clusterDailyRows: input.view.slice.clusterDailyRows,
    keywordDailyRows: input.view.slice.keywordDailyRows,
    productDailyRows: input.view.slice.productDailyRows,
    aggregatedKeywordRows: input.aggregates.keywordRows,
    aggregatedProductRows: input.aggregates.productRows,
    completion: input.bundle.completion,
  });
  const products = buildGoogleAdsAdvisorProductReportFromScopedDailyRows({
    scopedRows: input.view.slice.productDailyRows,
    aggregatedRows: input.aggregates.productRows,
    startDate: input.view.startDate,
    endDate: input.view.endDate,
    latestSync: input.bundle.latestSync,
    dataState: input.bundle.context.dataState,
  });

  return {
    campaigns,
    search,
    products,
  };
}

async function measureGoogleAdsAdvisorPhase<T>(
  phase: string,
  operation: () => Promise<T>,
  describe?: (value: T) => Record<string, unknown>,
) {
  const startedAt = Date.now();
  const value = await operation();
  logRuntimeDebug("google-ads-advisor", phase, {
    durationMs: Date.now() - startedAt,
    ...(describe ? describe(value) : {}),
  });
  return value;
}

async function buildFreshness(input: {
  businessId: string;
  scope: GoogleAdsWarehouseScope;
  providerAccountIds: string[];
  startDate: string;
  endDate: string;
  rows: GoogleAdsWarehouseDailyRow[];
}) {
  const providerCurrentDate =
    input.providerAccountIds.length > 0
      ? await getProviderPlatformCurrentDate({
          provider: "google",
          businessId: input.businessId,
          providerAccountId:
            input.providerAccountIds.length === 1 ? input.providerAccountIds[0] : null,
          providerAccountIds: input.providerAccountIds,
        }).catch(() => new Date().toISOString().slice(0, 10))
      : new Date().toISOString().slice(0, 10);
  const latestSync = await getLatestGoogleAdsSyncHealth({
    businessId: input.businessId,
    providerAccountId: input.providerAccountIds.length === 1 ? input.providerAccountIds[0] : null,
  }).catch(() => null);
  const [coverage, coveredDateList, completion] = await Promise.all([
    getGoogleAdsDailyCoverage({
      scope: input.scope,
      businessId: input.businessId,
      providerAccountId:
        input.providerAccountIds.length === 1 ? input.providerAccountIds[0] : null,
      startDate: input.startDate,
      endDate: input.endDate,
      includeMetadata: true,
    }).catch(() => null),
    // DATA AVAILABILITY, not completion. This answers "which days have no rows
    // at all", which is the only question row existence can honestly answer,
    // and it still drives `missingWindows` exactly as before.
    getGoogleAdsCoveredDates({
      scope: input.scope,
      businessId: input.businessId,
      providerAccountId:
        input.providerAccountIds.length === 1 ? input.providerAccountIds[0] : null,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => [] as string[]),
    readServingCompletion({
      businessId: input.businessId,
      scopes: [input.scope],
      providerAccountIds: input.providerAccountIds,
      startDate: input.startDate,
      endDate: input.endDate,
    }),
  ]);
  const coveredDates = new Set(coveredDateList);
  const missingWindows = enumerateDays(input.startDate, input.endDate).filter(
    (date) => !coveredDates.has(date)
  );
  return Object.assign(
    createGoogleAdsWarehouseFreshness({
      // COMPLETION. `ready` used to be the negation of `missingWindows`, so a
      // range whose every day was read once at 01:40 and never re-read served
      // as authoritative forever. It now needs the freshness verdict, and an
      // unreadable verdict degrades rather than defaults green.
      dataState:
        input.providerAccountIds.length === 0
          ? "connected_no_assignment"
          : resolveServingDataState({
              completion,
              hasMissingWindows: missingWindows.length > 0,
            }),
      lastSyncedAt:
        input.rows.reduce<string | null>((latest, row) => {
          if (!row.updatedAt) return latest;
          return !latest || row.updatedAt > latest ? row.updatedAt : latest;
        }, null) ??
        (coverage?.latest_updated_at ?? null),
      // The "as of" claim. It used to be `now()` whenever the window touched
      // today, which asserted a refresh that never happened. It is now the
      // instant of the last COMPLETED fetch for this range, and null when we
      // have no evidence of one — no evidence, no claim.
      liveRefreshedAt:
        input.endDate >= providerCurrentDate
          ? (completion?.scopes.find((scope) => scope.scope === input.scope)
              ?.latestObservationAt ?? null)
          : null,
      isPartial: missingWindows.length > 0,
      missingWindows,
      warnings: latestSync && latestSync.last_error ? [String(latestSync.last_error)] : [],
    }),
    { completion },
  ) satisfies ServingFreshness;
}

function aggregateWarehouseRows(rows: GoogleAdsWarehouseDailyRow[]) {
  const map = new Map<string, GenericRow & { __updatedAt?: string }>();
  for (const row of rows) {
    const payload = asObject(row.payloadJson);
    const current = map.get(row.entityKey) ?? {
      ...payload,
      id: payload.id ?? row.entityKey,
      name: payload.name ?? row.entityLabel ?? row.entityKey,
      campaignId: payload.campaignId ?? row.campaignId,
      campaignName: payload.campaignName ?? row.campaignName,
      adGroupId: payload.adGroupId ?? row.adGroupId,
      adGroupName: payload.adGroupName ?? row.adGroupName,
      status: payload.status ?? row.status,
      channel: payload.channel ?? row.channel,
      classification: payload.classification ?? row.classification,
      spend: 0,
      revenue: 0,
      conversions: 0,
      impressions: 0,
      clicks: 0,
      __updatedAt: row.updatedAt,
    };
    current.spend = toNumber(current.spend) + row.spend;
    current.revenue = toNumber(current.revenue) + row.revenue;
    current.conversions = toNumber(current.conversions) + row.conversions;
    current.impressions = toNumber(current.impressions) + row.impressions;
    current.clicks = toNumber(current.clicks) + row.clicks;
    if (!current.status && row.status) current.status = row.status;
    if (!current.channel && row.channel) current.channel = row.channel;
    if (!current.campaignId && row.campaignId) current.campaignId = row.campaignId;
    if (!current.campaignName && row.campaignName) current.campaignName = row.campaignName;
    if (!current.adGroupId && row.adGroupId) current.adGroupId = row.adGroupId;
    if (!current.adGroupName && row.adGroupName) current.adGroupName = row.adGroupName;
    if ((!current.__updatedAt || (row.updatedAt && row.updatedAt > current.__updatedAt)) && row.updatedAt) {
      Object.assign(current, payload);
      current.__updatedAt = row.updatedAt;
    }
    map.set(row.entityKey, current);
  }

  return Array.from(map.values()).map((row) => {
    const spend = toNumber(row.spend);
    const revenue = toNumber(row.revenue);
    const conversions = toNumber(row.conversions);
    const impressions = toNumber(row.impressions);
    const clicks = toNumber(row.clicks);
    return {
      ...row,
      spend,
      revenue,
      conversions,
      impressions,
      clicks,
      roas: spend > 0 ? Number((revenue / spend).toFixed(2)) : 0,
      cpa: conversions > 0 ? Number((spend / conversions).toFixed(2)) : 0,
      ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
      cpc: clicks > 0 ? Number((spend / clicks).toFixed(2)) : null,
      conversionRate: clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : null,
    };
  });
}

function aggregateCampaignLikeTotals(rows: Array<Record<string, unknown>>) {
  const spend = rows.reduce((sum, row) => sum + toNumber(row.spend), 0);
  const revenue = rows.reduce((sum, row) => sum + toNumber(row.revenue), 0);
  const conversions = rows.reduce((sum, row) => sum + toNumber(row.conversions), 0);
  const roas = spend > 0 ? Number((revenue / spend).toFixed(2)) : 0;
  return { spend, revenue, conversions, roas };
}

export interface GoogleAdsOverviewSummaryResult {
  kpis: {
    spend: number;
    revenue: number;
    conversions: number;
    roas: number;
    cpa: number;
    cpc: number;
    ctr: number;
    impressions: number;
    clicks: number;
    convRate: number;
  };
  summary: {
    totalAccounts: number;
    readSource:
      | "warehouse_account_aggregate"
      | "warehouse_campaign_aggregate_fallback"
      | "live_overlay_current_day";
    overlayApplied?: boolean;
    warehouseSegmentEndDate?: string | null;
    liveSegmentStartDate?: string | null;
  };
  meta: WarehouseMeta;
}

export interface GoogleAdsCanonicalOverviewSummaryResult {
  kpis: GoogleAdsOverviewSummaryResult["kpis"];
  kpiDeltas?: Record<string, number | null | undefined>;
  summary: {
    totalAccounts: number;
    readSource:
      | "warehouse_account_aggregate"
      | "warehouse_campaign_aggregate_fallback"
      | "live_overlay_current_day";
    overlayApplied?: boolean;
    warehouseSegmentEndDate?: string | null;
    liveSegmentStartDate?: string | null;
  };
  meta: WarehouseMeta & {
    readSource:
      | "warehouse_account_aggregate"
      | "warehouse_campaign_aggregate_fallback"
      | "live_overlay_current_day";
    overlayApplied?: boolean;
    warehouseSegmentEndDate?: string | null;
    liveSegmentStartDate?: string | null;
  };
}

function isCurrentDayOnlyWindow(input: {
  startDate: string;
  endDate: string;
  providerCurrentDate: string;
}) {
  return (
    input.startDate === input.providerCurrentDate &&
    input.endDate === input.providerCurrentDate
  );
}

function buildCurrentDayOverlayMeta(input: { providerCurrentDate: string }) {
  return {
    readSource: "live_overlay_current_day" as const,
    overlayApplied: true,
    warehouseSegmentEndDate: null,
    liveSegmentStartDate: input.providerCurrentDate,
  };
}

export interface GoogleAdsCanonicalTrendResult {
  points: Array<{
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
  }>;
  meta: WarehouseMeta & {
    readSource:
      | "warehouse_account_daily"
      | "warehouse_campaign_daily_fallback"
      | "projection_fallback"
      | "provider_truth_unavailable";
    fallbackReason: string | null;
    degraded: boolean;
  };
}

function countRangeDays(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
}

function buildOverviewKpisFromRows(rows: Array<Record<string, unknown>>) {
  const spend = rows.reduce((sum, row) => sum + toNumber(row.spend), 0);
  const revenue = rows.reduce((sum, row) => sum + toNumber(row.revenue), 0);
  const conversions = rows.reduce((sum, row) => sum + toNumber(row.conversions), 0);
  const clicks = rows.reduce((sum, row) => sum + toNumber(row.clicks), 0);
  const impressions = rows.reduce((sum, row) => sum + toNumber(row.impressions), 0);
  const roas = spend > 0 ? revenue / spend : 0;
  const cpa = conversions > 0 ? spend / conversions : 0;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpc = clicks > 0 ? spend / clicks : 0;

  return {
    spend: Number(spend.toFixed(2)),
    conversions: Number(conversions.toFixed(2)),
    revenue: Number(revenue.toFixed(2)),
    roas: Number(roas.toFixed(2)),
    cpa: Number(cpa.toFixed(2)),
    cpc: Number(cpc.toFixed(2)),
    ctr: Number(ctr.toFixed(2)),
    impressions,
    clicks,
    convRate: clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : 0,
  };
}

function shouldFallbackGoogleOverviewToCampaignScope(input: {
  account: ReturnType<typeof buildOverviewKpisFromRows>;
  campaign: ReturnType<typeof buildOverviewKpisFromRows>;
}) {
  const spendGap = input.campaign.spend - input.account.spend;
  const revenueGap = input.campaign.revenue - input.account.revenue;
  const conversionGap = input.campaign.conversions - input.account.conversions;
  const spendRatio =
    input.account.spend > 0 ? input.campaign.spend / input.account.spend : input.campaign.spend > 0 ? Infinity : 1;
  const revenueRatio =
    input.account.revenue > 0
      ? input.campaign.revenue / input.account.revenue
      : input.campaign.revenue > 0
        ? Infinity
        : 1;

  return (
    (spendGap > 50 && spendRatio > 1.2) ||
    (revenueGap > 50 && revenueRatio > 1.2) ||
    conversionGap >= 3
  );
}

function aggregateGoogleOverviewTrendPoints(rows: GoogleAdsWarehouseDailyRow[]) {
  const byDate = new Map<
    string,
    {
      spend: number;
      revenue: number;
      conversions: number;
      impressions: number;
      clicks: number;
    }
  >();

  for (const row of rows) {
    const date = normalizeDate(row.date);
    const current = byDate.get(date) ?? {
      spend: 0,
      revenue: 0,
      conversions: 0,
      impressions: 0,
      clicks: 0,
    };
    current.spend += row.spend;
    current.revenue += row.revenue;
    current.conversions += row.conversions;
    current.impressions += row.impressions;
    current.clicks += row.clicks;
    byDate.set(date, current);
  }

  return Array.from(byDate.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([date, totals]) => ({
      date,
      spend: Number(totals.spend.toFixed(2)),
      revenue: Number(totals.revenue.toFixed(2)),
      conversions: Number(totals.conversions.toFixed(2)),
      roas: totals.spend > 0 ? Number((totals.revenue / totals.spend).toFixed(2)) : 0,
      cpa: totals.conversions > 0 ? Number((totals.spend / totals.conversions).toFixed(2)) : null,
      ctr: totals.impressions > 0 ? Number(((totals.clicks / totals.impressions) * 100).toFixed(2)) : null,
      cpc: totals.clicks > 0 ? Number((totals.spend / totals.clicks).toFixed(2)) : null,
      impressions: totals.impressions,
      clicks: totals.clicks,
    }));
}

export function buildGoogleAdsSelectedRangeContext(input: {
  canonicalAsOfDate: string;
  canonicalTotals?: GoogleAdvisorMetadata["canonicalWindowTotals"] | null;
  selectedRangeStart: string;
  selectedRangeEnd: string;
  selectedTotals: {
    spend: number;
    revenue: number;
    conversions: number;
    roas: number;
  };
}) {
  const canonicalStart = addDaysToIsoDate(input.canonicalAsOfDate, -83);
  const insideCanonicalWindow =
    input.selectedRangeStart >= canonicalStart &&
    input.selectedRangeEnd <= input.canonicalAsOfDate;

  if (!insideCanonicalWindow || !input.canonicalTotals) {
    return {
      eligible: false,
      state: "hidden" as const,
      label: "",
      summary: "",
      selectedRangeStart: input.selectedRangeStart,
      selectedRangeEnd: input.selectedRangeEnd,
      deltaPercent: null,
      metricKey: null,
    };
  }

  const canonicalRoas = Number(input.canonicalTotals.roas ?? 0);
  const selectedRoas = Number(input.selectedTotals.roas ?? 0);
  const conversions = Number(input.selectedTotals.conversions ?? 0);
  if (canonicalRoas <= 0 || input.selectedTotals.spend <= 0) {
    return {
      eligible: false,
      state: "hidden" as const,
      label: "",
      summary: "",
      selectedRangeStart: input.selectedRangeStart,
      selectedRangeEnd: input.selectedRangeEnd,
      deltaPercent: null,
      metricKey: null,
    };
  }

  const deltaPercent = Number((((selectedRoas - canonicalRoas) / canonicalRoas) * 100).toFixed(1));
  if (Math.abs(deltaPercent) <= 10) {
    return {
      eligible: true,
      state: "aligned" as const,
      label: "Selected range aligned",
      summary: `Selected ${countRangeDays(input.selectedRangeStart, input.selectedRangeEnd)}-day view is broadly aligned with the multi-window decision snapshot.`,
      selectedRangeStart: input.selectedRangeStart,
      selectedRangeEnd: input.selectedRangeEnd,
      deltaPercent,
      metricKey: "roas" as const,
    };
  }

  if (conversions < 5) {
    return {
      eligible: true,
      state: "volatile" as const,
      label: "Selected range volatile",
      summary: `Selected ${countRangeDays(input.selectedRangeStart, input.selectedRangeEnd)}-day view diverges from the multi-window decision snapshot, but conversion depth is still thin.`,
      selectedRangeStart: input.selectedRangeStart,
      selectedRangeEnd: input.selectedRangeEnd,
      deltaPercent,
      metricKey: "roas" as const,
    };
  }

  return {
    eligible: true,
    state: deltaPercent > 10 ? ("stronger" as const) : ("softer" as const),
    label: deltaPercent > 10 ? "Selected range stronger" : "Selected range softer",
    summary:
      deltaPercent > 10
        ? `Selected ${countRangeDays(input.selectedRangeStart, input.selectedRangeEnd)}-day view is stronger than the multi-window decision snapshot.`
        : `Selected ${countRangeDays(input.selectedRangeStart, input.selectedRangeEnd)}-day view is softer than the multi-window decision snapshot.`,
    selectedRangeStart: input.selectedRangeStart,
    selectedRangeEnd: input.selectedRangeEnd,
    deltaPercent,
    metricKey: "roas" as const,
  };
}

function summarizeAdvisorAggregateRows(rows: Array<Record<string, unknown>>) {
  return rows.reduce<{
    entityCount: number;
    spend: number;
    revenue: number;
    conversions: number;
  }>(
    (acc, row) => {
      acc.entityCount += 1;
      acc.spend += toNumber(row.spend);
      acc.revenue += toNumber(row.revenue);
      acc.conversions += toNumber(row.conversions);
      return acc;
    },
    { entityCount: 0, spend: 0, revenue: 0, conversions: 0 }
  );
}

async function buildGoogleAdsHistoricalSupport(input: {
  businessId: string;
  accountId?: string | null;
  asOfDate: string;
}) : Promise<GoogleAdvisorHistoricalSupport> {
  const historicalStart = getHistoricalWindowStart(input.asOfDate);
  const providerAccountIds =
    input.accountId && input.accountId !== "all" ? [input.accountId] : null;
  const providerAccountId =
    input.accountId && input.accountId !== "all" ? input.accountId : null;

  const [campaigns, searchClusters, products] = await Promise.all([
    readGoogleAdsAggregatedRange({
      scope: "campaign_daily",
      businessId: input.businessId,
      providerAccountIds,
      startDate: historicalStart,
      endDate: input.asOfDate,
    }).catch(() => []),
    readGoogleAdsSearchClusterDailyRows({
      businessId: input.businessId,
      providerAccountId,
      startDate: historicalStart,
      endDate: input.asOfDate,
    }).catch(() => []),
    readGoogleAdsAggregatedRange({
      scope: "product_daily",
      businessId: input.businessId,
      providerAccountIds,
      startDate: historicalStart,
      endDate: input.asOfDate,
    }).catch(() => []),
  ]);

  return {
    source: "warehouse_aggregate",
    available: campaigns.length > 0 || searchClusters.length > 0 || products.length > 0,
    coverageDays: Math.max(
      0,
      Math.round(
        Math.abs(new Date(input.asOfDate).getTime() - new Date(historicalStart).getTime()) /
          86_400_000 +
          1
      )
    ),
    campaigns: summarizeAdvisorAggregateRows(campaigns as Array<Record<string, unknown>>),
    searchTerms: summarizeAdvisorAggregateRows(searchClusters as Array<Record<string, unknown>>),
    products: summarizeAdvisorAggregateRows(products as Array<Record<string, unknown>>),
  };
}

async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
) {
  if (tasks.length === 0) return [] as T[];
  const results = new Array<T>(tasks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]();
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function readAggregatedScope(input: {
  businessId: string;
  providerAccountIds: string[];
  scope: GoogleAdsWarehouseScope;
  startDate: string;
  endDate: string;
}) {
  try {
    const rows = await readGoogleAdsAggregatedRange({
      scope: input.scope,
      businessId: input.businessId,
      providerAccountIds: input.providerAccountIds,
      startDate: input.startDate,
      endDate: input.endDate,
      timeoutMs: 30_000,
    });
    return {
      dailyRows: [] as GoogleAdsWarehouseDailyRow[],
      rows,
    };
  } catch (error) {
    if (!isWarehouseAggregationOom(error)) throw error;
    console.warn("[google-ads-serving] aggregation-fallback-to-daily", {
      scope: input.scope,
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      error: error instanceof Error ? error.message : String(error),
    });
    const dailyRows = await readGoogleAdsDailyRange({
      scope: input.scope,
      businessId: input.businessId,
      providerAccountIds: input.providerAccountIds,
      startDate: input.startDate,
      endDate: input.endDate,
      timeoutMs: 30_000,
    });
    return {
      dailyRows,
      rows: aggregateDailyRowsLocally(input.scope, dailyRows),
    };
  }
}

function toCampaignRows(
  rows: GenericRow[],
  previousRows: GenericRow[] = []
): Array<Record<string, unknown>> {
  const totals = rows.reduce<{ spend: number; revenue: number }>(
    (acc, row) => {
      acc.spend += toNumber(row.spend);
      acc.revenue += toNumber(row.revenue);
      return acc;
    },
    { spend: 0, revenue: 0 }
  );
  const avgRoas = totals.spend > 0 ? totals.revenue / totals.spend : 0;
  const avgCpa =
    rows.reduce((sum, row) => sum + toNumber(row.spend), 0) /
      Math.max(1, rows.reduce((sum, row) => sum + Math.max(0, toNumber(row.conversions)), 0)) || 0;
  const previousById = new Map(previousRows.map((row) => [String(row.id), row]));
  return rows
    .map((row) => {
      const previous = previousById.get(String(row.id));
      const spend = toNumber(row.spend);
      const revenue = toNumber(row.revenue);
      const conversions = toNumber(row.conversions);
      const spendShare = totals.spend > 0 ? Number(((spend / totals.spend) * 100).toFixed(1)) : 0;
      const revenueShare = totals.revenue > 0 ? Number(((revenue / totals.revenue) * 100).toFixed(1)) : 0;
      let actionState: "scale" | "optimize" | "test" | "reduce" = "optimize";
      if (conversions === 0 && spend > 20) actionState = "test";
      else if (row.roas && toNumber(row.roas) >= avgRoas && revenueShare >= spendShare) actionState = "scale";
      else if (row.roas && toNumber(row.roas) < avgRoas && spendShare > revenueShare) actionState = "reduce";
      return {
        ...row,
        id: String(row.id),
        name: String(row.name ?? row.campaignName ?? row.id),
        status: String(row.status ?? "enabled"),
        channel: String(row.channel ?? "Unknown"),
        spendShare,
        revenueShare,
        actionState,
        roasChange: previous ? pctDelta(toNumber(row.roas), toNumber(previous.roas)) : undefined,
        spendChange: previous ? pctDelta(spend, toNumber(previous.spend)) : undefined,
        revenueChange: previous ? pctDelta(revenue, toNumber(previous.revenue)) : undefined,
        conversionsChange: previous ? pctDelta(conversions, toNumber(previous.conversions)) : undefined,
        badges: getCampaignBadges(
          {
            id: String(row.id),
            name: String(row.name ?? row.campaignName ?? row.id),
            status: String(row.status ?? "enabled"),
            channel: String(row.channel ?? "Unknown"),
            spend,
            conversions,
            revenue,
            roas: toNumber(row.roas),
            cpa: toNumber(row.cpa),
            ctr: toNumber(row.ctr),
            impressions: toNumber(row.impressions),
            clicks: toNumber(row.clicks),
            impressionShare: row.impressionShare == null ? undefined : toNumber(row.impressionShare),
            lostIsBudget: row.lostIsBudget == null ? undefined : toNumber(row.lostIsBudget),
          },
          avgRoas,
          avgCpa
        ),
      };
    })
    .sort((a, b) => toNumber((b as Record<string, unknown>).spend) - toNumber((a as Record<string, unknown>).spend));
}

async function buildScopeResponse(input: {
  params: BaseReportParams;
  scope: GoogleAdsWarehouseScope;
}) {
  const context = await resolveWarehouseContext(input.params);
  if (context.dataState === "connected_no_assignment") {
    const freshness = createGoogleAdsWarehouseFreshness({
      dataState: context.dataState,
      warnings: ["No Google Ads account is assigned to this business."],
    });
    return { context, freshness, rows: [], dailyRows: [] as GoogleAdsWarehouseDailyRow[] };
  }
  const { rows, dailyRows } = await readAggregatedScope({
    businessId: input.params.businessId,
    providerAccountIds: context.providerAccountIds,
    scope: input.scope,
    startDate: context.startDate,
    endDate: context.endDate,
  });
  const freshness = await buildFreshness({
    businessId: input.params.businessId,
    scope: input.scope,
    providerAccountIds: context.providerAccountIds,
    startDate: context.startDate,
    endDate: context.endDate,
    rows: dailyRows,
  });
  if (context.providerState.credentialState === "not_connected") {
    freshness.warnings = Array.from(
      new Set([...freshness.warnings, "Google Ads integration is not connected."])
    );
    if (freshness.dataState === "ready") {
      freshness.dataState = freshness.isPartial ? "partial" : "ready";
    }
  }
  return { context, freshness, rows, dailyRows };
}

export async function getGoogleAdsCampaignsReport(
  params: ComparativeReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const currentDayContext = await resolveWarehouseContext({
    businessId: params.businessId,
    accountId: params.accountId ?? null,
    dateRange: params.dateRange,
    customStart: params.customStart ?? null,
    customEnd: params.customEnd ?? null,
  });
  if (
    isCurrentDayOnlyWindow({
      startDate: currentDayContext.startDate,
      endDate: currentDayContext.endDate,
      providerCurrentDate: currentDayContext.providerCurrentDate,
    })
  ) {
    const liveReport = await getLiveGoogleAdsCampaignsReport(params);
    return {
      rows: liveReport.rows,
      summary: {
        ...(liveReport.summary ?? {}),
        readSource: "live_overlay_current_day",
        overlayApplied: true,
        warehouseSegmentEndDate: null,
        liveSegmentStartDate: currentDayContext.providerCurrentDate,
      },
      insights: liveReport.insights,
      meta: {
        ...liveReport.meta,
        readSource: "live_overlay_current_day",
        overlayApplied: true,
        warehouseSegmentEndDate: null,
        liveSegmentStartDate: currentDayContext.providerCurrentDate,
      },
    };
  }

  const current = await buildScopeResponse({ params, scope: "campaign_daily" });
  const compareWindow = getComparisonWindow({
    compareMode: params.compareMode,
    startDate: current.context.startDate,
    endDate: current.context.endDate,
    compareStart: params.compareStart,
    compareEnd: params.compareEnd,
  });
  const previousRows = compareWindow
    ? (
        await readAggregatedScope({
          businessId: params.businessId,
          providerAccountIds: current.context.providerAccountIds,
          scope: "campaign_daily",
          startDate: compareWindow.startDate,
          endDate: compareWindow.endDate,
        })
      ).rows
    : [];
  const campaignRows = toCampaignRows(current.rows, previousRows);
  const accountAvgRoas =
    campaignRows.reduce((sum, row) => sum + toNumber(row.revenue), 0) /
      Math.max(1, campaignRows.reduce((sum, row) => sum + toNumber(row.spend), 0)) || 0;
  return {
    rows: campaignRows,
    summary: {
      accountAvgRoas: Number(accountAvgRoas.toFixed(2)),
      totalSpend: Number(campaignRows.reduce((sum, row) => sum + toNumber(row.spend), 0).toFixed(2)),
      totalRevenue: Number(campaignRows.reduce((sum, row) => sum + toNumber(row.revenue), 0).toFixed(2)),
    },
    meta: buildMeta({
      freshness: current.freshness,
      rowCounts: { campaign_daily: campaignRows.length },
    }),
  };
}

export async function getGoogleAdsOverviewReport(
  params: ComparativeReportParams
): Promise<OverviewReportResult> {
  const currentDayContext = await resolveWarehouseContext({
    businessId: params.businessId,
    accountId: params.accountId ?? null,
    dateRange: params.dateRange,
    customStart: params.customStart ?? null,
    customEnd: params.customEnd ?? null,
  });
  if (
    isCurrentDayOnlyWindow({
      startDate: currentDayContext.startDate,
      endDate: currentDayContext.endDate,
      providerCurrentDate: currentDayContext.providerCurrentDate,
    })
  ) {
    const liveReport = await getLiveGoogleAdsOverviewReport(params);
    return {
      ...liveReport,
      summary: {
        ...(liveReport.summary ?? {}),
        readSource: "live_overlay_current_day",
        overlayApplied: true,
        warehouseSegmentEndDate: null,
        liveSegmentStartDate: currentDayContext.providerCurrentDate,
      },
      meta: {
        ...liveReport.meta,
        readSource: "live_overlay_current_day",
        overlayApplied: true,
        warehouseSegmentEndDate: null,
        liveSegmentStartDate: currentDayContext.providerCurrentDate,
      },
    };
  }

  const [campaigns, canonicalSummary] = await Promise.all([
    getGoogleAdsCampaignsReport(params),
    getGoogleCanonicalOverviewSummary(params),
  ]);
  const campaignRows = campaigns.rows as Array<Record<string, unknown>>;
  const topCampaigns = campaignRows
    .slice(0, 8)
    .map((row) => ({ ...row, badges: Array.isArray(row.badges) ? row.badges : [] })) as Array<
      GadsCampaignRow & { badges: string[] }
    >;
  const insights = generateOverviewInsights({
    campaigns: topCampaigns,
    totalSpend: Number(canonicalSummary.kpis.spend ?? 0),
    totalConversions: Number(canonicalSummary.kpis.conversions ?? 0),
    totalRevenue: Number(canonicalSummary.kpis.revenue ?? 0),
    roas: Number(canonicalSummary.kpis.roas ?? 0),
    cpa: Number(canonicalSummary.kpis.cpa ?? 0),
  });

  return {
    kpis: canonicalSummary.kpis,
    kpiDeltas: canonicalSummary.kpiDeltas,
    topCampaigns,
    insights,
    summary: {
      accountAvgRoas: Number(canonicalSummary.kpis.roas ?? 0),
      totalCampaigns: campaignRows.length,
      readSource: canonicalSummary.summary.readSource,
    },
    meta: canonicalSummary.meta,
  };
}

export async function getGoogleCanonicalOverviewSummary(
  params: ComparativeReportParams,
): Promise<GoogleAdsCanonicalOverviewSummaryResult> {
  const currentDayContext = await resolveWarehouseContext({
    businessId: params.businessId,
    accountId: params.accountId ?? null,
    dateRange: params.dateRange,
    customStart: params.customStart ?? null,
    customEnd: params.customEnd ?? null,
  });
  if (
    isCurrentDayOnlyWindow({
      startDate: currentDayContext.startDate,
      endDate: currentDayContext.endDate,
      providerCurrentDate: currentDayContext.providerCurrentDate,
    })
  ) {
    const liveReport = await getLiveGoogleAdsOverviewReport(params);
    const overlayMeta = buildCurrentDayOverlayMeta({
      providerCurrentDate: currentDayContext.providerCurrentDate,
    });
    return {
      kpis: {
        spend: Number(liveReport.kpis.spend ?? 0),
        revenue: Number(liveReport.kpis.revenue ?? 0),
        conversions: Number(liveReport.kpis.conversions ?? 0),
        roas: Number(liveReport.kpis.roas ?? 0),
        cpa: Number(liveReport.kpis.cpa ?? 0),
        cpc: Number(liveReport.kpis.cpc ?? 0),
        ctr: Number(liveReport.kpis.ctr ?? 0),
        impressions: Number(liveReport.kpis.impressions ?? 0),
        clicks: Number(liveReport.kpis.clicks ?? 0),
        convRate: Number(liveReport.kpis.convRate ?? 0),
      },
      kpiDeltas: liveReport.kpiDeltas,
      summary: {
        totalAccounts: Number(
          liveReport.summary?.topCampaignCount ?? liveReport.topCampaigns.length,
        ),
        ...overlayMeta,
      },
      meta: {
        ...createGoogleAdsWarehouseFreshness({
          dataState: "ready",
          liveRefreshedAt: new Date().toISOString(),
          isPartial: false,
          missingWindows: [],
          warnings: [],
        }),
        partial: false,
        failed_queries: liveReport.meta.failed_queries ?? [],
        unavailable_metrics: liveReport.meta.unavailable_metrics ?? [],
        query_names: liveReport.meta.query_names ?? [],
        row_counts: liveReport.meta.row_counts ?? {},
        report_families: liveReport.meta.report_families ?? {},
        debug: liveReport.meta.debug,
        ...overlayMeta,
      },
    };
  }

  const current = await buildScopeResponse({ params, scope: "account_daily" });
  const accountRows = current.rows as Array<Record<string, unknown>>;
  const compareWindow = getComparisonWindow({
    compareMode: params.compareMode,
    startDate: current.context.startDate,
    endDate: current.context.endDate,
    compareStart: params.compareStart,
    compareEnd: params.compareEnd,
  });
  const previousRows = compareWindow
    ? (
        await readAggregatedScope({
          businessId: params.businessId,
          providerAccountIds: current.context.providerAccountIds,
          scope: "account_daily",
          startDate: compareWindow.startDate,
          endDate: compareWindow.endDate,
        })
      ).rows
    : [];
  const currentKpis = buildOverviewKpisFromRows(accountRows);
  let previousKpis = previousRows.length > 0 ? buildOverviewKpisFromRows(previousRows) : null;
  let effectiveKpis = currentKpis;
  let readSource: "warehouse_account_aggregate" | "warehouse_campaign_aggregate_fallback" =
    "warehouse_account_aggregate";
  let summaryCount = accountRows.length;

  const campaignCurrent = await readAggregatedScope({
    businessId: params.businessId,
    providerAccountIds: current.context.providerAccountIds,
    scope: "campaign_daily",
    startDate: current.context.startDate,
    endDate: current.context.endDate,
  });
  const campaignCurrentKpis = buildOverviewKpisFromRows(campaignCurrent.rows);

  if (
    shouldFallbackGoogleOverviewToCampaignScope({
      account: currentKpis,
      campaign: campaignCurrentKpis,
    })
  ) {
    const campaignPreviousRows = compareWindow
      ? (
          await readAggregatedScope({
            businessId: params.businessId,
            providerAccountIds: current.context.providerAccountIds,
            scope: "campaign_daily",
            startDate: compareWindow.startDate,
            endDate: compareWindow.endDate,
          })
        ).rows
      : [];
    effectiveKpis = campaignCurrentKpis;
    previousKpis =
      campaignPreviousRows.length > 0 ? buildOverviewKpisFromRows(campaignPreviousRows) : null;
    readSource = "warehouse_campaign_aggregate_fallback";
    summaryCount = campaignCurrent.rows.length;
    console.warn("[google-canonical] summary_scope_fallback_to_campaign", {
      businessId: params.businessId,
      startDate: current.context.startDate,
      endDate: current.context.endDate,
      accountSpend: currentKpis.spend,
      campaignSpend: campaignCurrentKpis.spend,
      accountRevenue: currentKpis.revenue,
      campaignRevenue: campaignCurrentKpis.revenue,
      accountConversions: currentKpis.conversions,
      campaignConversions: campaignCurrentKpis.conversions,
    });
  }

  const meta = {
    ...buildMeta({
      freshness: current.freshness,
      rowCounts: { account_daily: accountRows.length },
    }),
    readSource,
  };

  const result = {
    kpis: effectiveKpis,
    kpiDeltas: previousKpis
      ? {
          spend: pctDelta(effectiveKpis.spend, previousKpis.spend),
          revenue: pctDelta(effectiveKpis.revenue, previousKpis.revenue),
          conversions: pctDelta(effectiveKpis.conversions, previousKpis.conversions),
          roas: pctDelta(effectiveKpis.roas, previousKpis.roas),
          cpa: pctDelta(effectiveKpis.cpa, previousKpis.cpa),
          ctr: pctDelta(effectiveKpis.ctr, previousKpis.ctr),
        }
      : undefined,
    summary: {
      totalAccounts: summaryCount,
      readSource,
    },
    meta,
  };
  logRuntimeDebug("google-canonical", "summary_read", {
    businessId: params.businessId,
    startDate: current.context.startDate,
    endDate: current.context.endDate,
    readSource: result.summary.readSource,
    accountCount: result.summary.totalAccounts,
  });
  return result;
}

export async function getGoogleAdsOverviewSummaryAggregate(
  params: BaseReportParams,
): Promise<GoogleAdsOverviewSummaryResult> {
  const canonical = await getGoogleCanonicalOverviewSummary(params);
  return {
    kpis: canonical.kpis,
    summary: canonical.summary,
    meta: canonical.meta,
  };
}

async function resolveGoogleProjectionWindowState(input: {
  businessId: string;
  providerAccountIds: string[];
  startDate: string;
  endDate: string;
}) {
  const snapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: "google",
  }).catch(() => null);
  const primaryTimeZone =
    snapshot?.accounts.find((account) => input.providerAccountIds.includes(account.id))?.timezone ??
    snapshot?.accounts[0]?.timezone ??
    null;

  if (!primaryTimeZone) {
    return {
      historicalOnly: false,
      reason: "provider_timezone_unknown",
      primaryTimeZone: null,
    };
  }

  const currentDateInTimezone = getTodayIsoForTimeZoneServer(primaryTimeZone);
  if (input.endDate >= currentDateInTimezone) {
    return {
      historicalOnly: false,
      reason: "mutable_window",
      primaryTimeZone,
    };
  }

  return {
    historicalOnly: true,
    reason: null,
    primaryTimeZone,
  };
}

export async function getGoogleCanonicalOverviewTrends(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  accountId?: string | null;
  debug?: boolean;
  source?: string;
}): Promise<GoogleAdsCanonicalTrendResult> {
  const context = await resolveWarehouseContext({
    businessId: input.businessId,
    accountId: input.accountId ?? null,
    dateRange: "custom",
    customStart: input.startDate,
    customEnd: input.endDate,
  });

  if (context.providerAccountIds.length === 0) {
    const freshness = createGoogleAdsWarehouseFreshness({
      dataState: "connected_no_assignment",
      warnings: ["No Google Ads account is assigned to this business."],
    });
    return {
      points: [],
      meta: {
        ...buildMeta({
          freshness,
          rowCounts: { account_daily: 0 },
        }),
        readSource: "warehouse_account_daily",
        fallbackReason: null,
        degraded: false,
      },
    };
  }

  try {
    const rows = await readGoogleAdsDailyRange({
      scope: "account_daily",
      businessId: input.businessId,
      providerAccountIds: context.providerAccountIds,
      startDate: context.startDate,
      endDate: context.endDate,
      timeoutMs: 30_000,
    });
    const freshness = await buildFreshness({
      businessId: input.businessId,
      scope: "account_daily",
      providerAccountIds: context.providerAccountIds,
      startDate: context.startDate,
      endDate: context.endDate,
      rows,
    });
    let effectiveRows = rows;
    let readSource: "warehouse_account_daily" | "warehouse_campaign_daily_fallback" =
      "warehouse_account_daily";

    const campaignRows = await readGoogleAdsDailyRange({
      scope: "campaign_daily",
      businessId: input.businessId,
      providerAccountIds: context.providerAccountIds,
      startDate: context.startDate,
      endDate: context.endDate,
      timeoutMs: 30_000,
    });
    const accountTotals = aggregateGoogleOverviewTrendPoints(rows).reduce(
      (acc, row) => {
        acc.spend += Number(row.spend ?? 0);
        acc.revenue += Number(row.revenue ?? 0);
        acc.conversions += Number(row.conversions ?? 0);
        return acc;
      },
      { spend: 0, revenue: 0, conversions: 0 },
    );
    const campaignTotals = aggregateGoogleOverviewTrendPoints(campaignRows).reduce(
      (acc, row) => {
        acc.spend += Number(row.spend ?? 0);
        acc.revenue += Number(row.revenue ?? 0);
        acc.conversions += Number(row.conversions ?? 0);
        return acc;
      },
      { spend: 0, revenue: 0, conversions: 0 },
    );

    if (
      shouldFallbackGoogleOverviewToCampaignScope({
        account: buildOverviewKpisFromRows([accountTotals]),
        campaign: buildOverviewKpisFromRows([campaignTotals]),
      })
    ) {
      effectiveRows = campaignRows;
      readSource = "warehouse_campaign_daily_fallback";
      console.warn("[google-canonical] trends_scope_fallback_to_campaign", {
        businessId: input.businessId,
        startDate: context.startDate,
        endDate: context.endDate,
        accountSpend: accountTotals.spend,
        campaignSpend: campaignTotals.spend,
        accountRevenue: accountTotals.revenue,
        campaignRevenue: campaignTotals.revenue,
        accountConversions: accountTotals.conversions,
        campaignConversions: campaignTotals.conversions,
      });
    }

    logRuntimeDebug("google-canonical", "trends_provider_truth_read_succeeded", {
      businessId: input.businessId,
      startDate: context.startDate,
      endDate: context.endDate,
      rowCount: effectiveRows.length,
      readSource,
    });
    return {
      points: aggregateGoogleOverviewTrendPoints(effectiveRows),
      meta: {
        ...buildMeta({
          freshness,
          rowCounts: { account_daily: effectiveRows.length },
        }),
        readSource,
        fallbackReason: null,
        degraded: false,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[google-canonical] trends_provider_truth_read_failed", {
      businessId: input.businessId,
      startDate: context.startDate,
      endDate: context.endDate,
      message,
    });

    const projectionWindow = await resolveGoogleProjectionWindowState({
      businessId: input.businessId,
      providerAccountIds: context.providerAccountIds,
      startDate: context.startDate,
      endDate: context.endDate,
    });
    if (!projectionWindow.historicalOnly) {
      logRuntimeDebug("google-canonical", "projection_bypassed", {
        businessId: input.businessId,
        startDate: context.startDate,
        endDate: context.endDate,
        reason: projectionWindow.reason,
      });
      const freshness = createGoogleAdsWarehouseFreshness({
        dataState: "partial",
        isPartial: true,
        warnings: ["Google Ads provider truth is unavailable for a mutable window."],
      });
      return {
        points: [],
        meta: {
          ...buildMeta({
            freshness,
            rowCounts: { account_daily: 0 },
          }),
          readSource: "provider_truth_unavailable",
          fallbackReason: projectionWindow.reason,
          degraded: true,
        },
      };
    }

    const cached = await readOverviewSummaryRange({
      businessId: input.businessId,
      provider: "google",
      providerAccountIds: context.providerAccountIds,
      startDate: context.startDate,
      endDate: context.endDate,
    }).catch(() => null);
    const validity = evaluateOverviewSummaryProjectionValidity({
      providerAccountIds: context.providerAccountIds,
      startDate: context.startDate,
      endDate: context.endDate,
      hydrated: Boolean(cached?.hydrated),
      manifest: cached?.manifest,
      rows: cached?.rows ?? [],
    });
    logRuntimeDebug("google-canonical", "projection_evaluated", {
      businessId: input.businessId,
      startDate: context.startDate,
      endDate: context.endDate,
      valid: validity.valid,
      reason: validity.reason,
    });
    if (validity.valid && cached) {
      const projectionRows = cached.rows.map((row) => ({
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        date: row.date,
        accountTimezone: projectionWindow.primaryTimeZone ?? "UTC",
        accountCurrency: "USD",
        entityKey: row.providerAccountId,
        entityLabel: null,
        campaignId: null,
        campaignName: null,
        adGroupId: null,
        adGroupName: null,
        status: null,
        channel: null,
        classification: null,
        spend: row.spend,
        revenue: row.revenue,
        conversions: row.purchases,
        impressions: row.impressions,
        clicks: row.clicks,
        ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null,
        cpc: row.clicks > 0 ? row.spend / row.clicks : null,
        cpa: row.purchases > 0 ? row.spend / row.purchases : null,
        roas: row.spend > 0 ? row.revenue / row.spend : 0,
        conversionRate: row.clicks > 0 ? (row.purchases / row.clicks) * 100 : null,
        interactionRate: null,
        sourceSnapshotId: null,
        payloadJson: {},
        createdAt: undefined,
        updatedAt: row.updatedAt ?? undefined,
      })) as GoogleAdsWarehouseDailyRow[];
      const freshness = createGoogleAdsWarehouseFreshness({
        dataState: "ready",
        lastSyncedAt: cached.manifest?.maxSourceUpdatedAt ?? null,
      });
      console.warn("[google-canonical] projection_fallback_activated", {
        businessId: input.businessId,
        startDate: context.startDate,
        endDate: context.endDate,
        reason: "provider_truth_operational_failure",
      });
      return {
        points: aggregateGoogleOverviewTrendPoints(projectionRows),
        meta: {
          ...buildMeta({
            freshness,
            rowCounts: { account_daily: cached.rows.length },
          }),
          readSource: "projection_fallback",
          fallbackReason: "provider_truth_operational_failure",
          degraded: false,
        },
      };
    }

    const freshness = createGoogleAdsWarehouseFreshness({
      dataState: "partial",
      isPartial: true,
      warnings: ["Google Ads provider truth is unavailable and no verified projection fallback could be used."],
    });
    return {
      points: [],
      meta: {
        ...buildMeta({
          freshness,
          rowCounts: { account_daily: 0 },
        }),
        readSource: "provider_truth_unavailable",
        fallbackReason: validity.reason,
        degraded: true,
      },
    };
  }
}

async function buildSimpleEntityReport(
  params: BaseReportParams,
  scope: GoogleAdsWarehouseScope
): Promise<ReportResult<Record<string, unknown>>> {
  const current = await buildScopeResponse({ params, scope });
  return {
    rows: current.rows,
    summary: { total: current.rows.length },
    meta: buildMeta({
      freshness: current.freshness,
      rowCounts: { [scope]: current.rows.length },
    }),
  };
}

function deriveGoogleAdsBrandTermsFromSearchRows(
  rows: Array<{ campaignName?: string | null }>
) {
  return Array.from(
    new Set(
      rows
        .filter((row) => String(row.campaignName ?? "").toLowerCase().includes("brand"))
        .flatMap((row) =>
          String(row.campaignName ?? "")
            .toLowerCase()
            .replace(/[^a-z0-9\s-]+/g, " ")
            .split(/\s+/)
            .filter(
              (token) =>
                token.length >= 4 &&
                token !== "brand" &&
                token !== "search"
            )
        )
    )
  );
}

function resolveGoogleAdsSearchHotWindow(input: {
  providerCurrentDate: string;
  startDate: string;
  endDate: string;
}) {
  const supportStart = addDaysToIsoDate(
    input.providerCurrentDate,
    -(GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS - 1)
  );
  const effectiveStart =
    input.startDate < supportStart ? supportStart : input.startDate;
  const effectiveEnd =
    input.endDate > input.providerCurrentDate
      ? input.providerCurrentDate
      : input.endDate;
  return {
    supportStart,
    effectiveStart,
    effectiveEnd,
    withinHotWindow: effectiveStart <= effectiveEnd,
    requestExtendsOutsideWindow:
      input.startDate < supportStart || input.endDate > input.providerCurrentDate,
  };
}

function isoWeekStart(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  value.setUTCDate(value.getUTCDate() + diff);
  return value.toISOString().slice(0, 10);
}

function buildSearchIntelligenceRowsFromWeeklySupport(input: {
  rows: GoogleAdvisorAggregateWeeklyQuerySupport[];
  keywordSet: Set<string>;
  productTerms: string[];
}) {
  const ownershipContext = buildQueryOwnershipContextFromTerms({
    productTerms: input.productTerms,
  });
  return input.rows.map((row) => {
    const searchTerm = String(row.displayQuery || row.normalizedQuery).trim();
    const normalizedQuery = normalizeGoogleAdsQueryText(searchTerm);
    const spend = Number(row.totalSpend.toFixed(2));
    const revenue = Number(row.totalRevenue.toFixed(2));
    const conversions = Number(row.totalConversions.toFixed(2));
    const clicks = Math.round(row.totalClicks);
    const roas = spend > 0 ? Number((revenue / spend).toFixed(2)) : 0;
    const cpa =
      conversions > 0 ? Number((spend / conversions).toFixed(2)) : 0;
    const cpc = clicks > 0 ? Number((spend / clicks).toFixed(2)) : null;
    const keywordOpportunityFlag =
      !input.keywordSet.has(normalizedQuery) && conversions >= 2;
    const negativeKeywordFlag =
      clicks >= 20 && conversions === 0 && spend > 10;

    return {
      key: `weekly:${normalizedQuery || searchTerm}`,
      searchTerm,
      status: "INTELLIGENCE_AGGREGATE",
      campaignId: null,
      campaign: "",
      campaignName: "",
      adGroupId: null,
      adGroup: "",
      adGroupName: "",
      matchSource: "AGGREGATE",
      source: "top_query_weekly",
      impressions: 0,
      clicks,
      spend,
      conversions,
      revenue,
      roas,
      cpa,
      ctr: 0,
      cpc,
      conversionRate: null,
      intent: classifySearchIntent(searchTerm),
      intentClass: classifySearchIntent(searchTerm),
      classification: classifySearchIntent(searchTerm),
      isKeyword: input.keywordSet.has(normalizedQuery),
      wasteFlag: spend > 20 && conversions === 0,
      keywordOpportunityFlag,
      negativeKeywordFlag,
      clusterId: normalizedQuery || searchTerm.toLowerCase(),
      ownershipClass: null,
      recommendation: classifySearchAction(
        {
          searchTerm,
          campaign: "",
          isKeyword: input.keywordSet.has(normalizedQuery),
          conversions,
          spend,
          clicks,
          roas,
          conversionRate: null,
        },
        [],
        input.productTerms,
        ownershipContext,
      ),
      supportWeeks: row.weeksPresent,
      lastWeekEnd: row.lastWeekEnd,
    };
  });
}

function buildSearchIntelligenceRowsFromClusterSupport(
  rows: GoogleAdvisorAggregateClusterSupport[]
) {
  return rows.map((row) => {
    const searchTerm = String(row.clusterLabel || row.clusterKey).trim();
    const spend = Number(row.totalSpend.toFixed(2));
    const revenue = Number(row.totalRevenue.toFixed(2));
    const conversions = Number(row.totalConversions.toFixed(2));
    const clicks = Math.round(row.totalClicks);
    const roas = spend > 0 ? Number((revenue / spend).toFixed(2)) : 0;
    const cpa =
      conversions > 0 ? Number((spend / conversions).toFixed(2)) : 0;
    const cpc = clicks > 0 ? Number((spend / clicks).toFixed(2)) : null;

    return {
      key: `cluster:${row.clusterKey}`,
      searchTerm,
      status: "INTELLIGENCE_AGGREGATE",
      campaignId: null,
      campaign: "",
      campaignName: "",
      adGroupId: null,
      adGroup: "",
      adGroupName: "",
      matchSource: "AGGREGATE",
      source: "search_cluster_daily",
      impressions: 0,
      clicks,
      spend,
      conversions,
      revenue,
      roas,
      cpa,
      ctr: 0,
      cpc,
      conversionRate: null,
      intent: row.dominantIntentClass ?? classifySearchIntent(searchTerm),
      intentClass: row.dominantIntentClass ?? classifySearchIntent(searchTerm),
      classification: row.dominantIntentClass ?? classifySearchIntent(searchTerm),
      isKeyword: false,
      wasteFlag: spend > 20 && conversions === 0,
      keywordOpportunityFlag: conversions >= 2,
      negativeKeywordFlag: clicks >= 20 && conversions === 0 && spend > 10,
      clusterId: row.clusterKey,
      ownershipClass: row.dominantOwnershipClass,
      recommendation:
        conversions >= 2
          ? "Promote winning theme"
          : spend > 20 && conversions === 0
            ? "Tighten intent"
            : "Monitor",
      supportDays: row.daysPresent,
      uniqueQueryCount: row.totalUniqueQueries,
      lastSeenDate: row.lastSeenDate,
    };
  });
}

function summarizeSearchIntelligenceFromAggregateSupport(input: {
  clusterSupport: GoogleAdvisorAggregateClusterSupport[];
  queryWeeklySupport: GoogleAdvisorAggregateWeeklyQuerySupport[];
  keywordSet: Set<string>;
}) {
  const semanticClusters = input.clusterSupport.map((row) => ({
    cluster: row.clusterLabel || row.clusterKey,
    intent: row.dominantIntentClass ?? "unknown",
    spend: Number(row.totalSpend.toFixed(2)),
    revenue: Number(row.totalRevenue.toFixed(2)),
    conversions: Number(row.totalConversions.toFixed(2)),
    roas:
      row.totalSpend > 0
        ? Number((row.totalRevenue / row.totalSpend).toFixed(2))
        : 0,
    queries: [row.clusterLabel || row.clusterKey],
    daysPresent: row.daysPresent,
    uniqueQueryCount: row.totalUniqueQueries,
  }));
  const newOpportunityQueries = input.queryWeeklySupport
    .filter((row) => {
      const normalizedQuery = normalizeGoogleAdsQueryText(
        row.displayQuery || row.normalizedQuery
      );
      return !input.keywordSet.has(normalizedQuery) && row.totalConversions >= 1;
    })
    .slice(0, 5)
    .map((row) => ({
      searchTerm: row.displayQuery,
      spend: Number(row.totalSpend.toFixed(2)),
      conversions: Number(row.totalConversions.toFixed(2)),
      revenue: Number(row.totalRevenue.toFixed(2)),
      roas:
        row.totalSpend > 0
          ? Number((row.totalRevenue / row.totalSpend).toFixed(2))
          : 0,
      source: "top_query_weekly",
      matchSource: "AGGREGATE",
      weeksPresent: row.weeksPresent,
      lastWeekEnd: row.lastWeekEnd,
    }));

  return {
    summary: {
      bestConvertingThemeCount: semanticClusters.filter(
        (cluster) => toNumber(cluster.conversions) >= 2
      ).length,
      wastefulThemeCount: semanticClusters.filter(
        (cluster) => toNumber(cluster.spend) > 50 && toNumber(cluster.conversions) === 0
      ).length,
      emergingThemeCount: semanticClusters.filter(
        (cluster) => toNumber(cluster.conversions) > 0 && toNumber(cluster.spend) < 50
      ).length,
    },
    insights: {
      bestConvertingThemes: [...semanticClusters]
        .filter((cluster) => toNumber(cluster.conversions) > 0)
        .sort((left, right) => toNumber(right.roas) - toNumber(left.roas))
        .slice(0, 5),
      wastefulThemes: [...semanticClusters]
        .filter((cluster) => toNumber(cluster.spend) > 20 && toNumber(cluster.conversions) === 0)
        .sort((left, right) => toNumber(right.spend) - toNumber(left.spend))
        .slice(0, 5),
      newOpportunityQueries,
      semanticClusters,
    },
  };
}

async function buildGoogleAdsSearchTermsHotReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const context = await resolveWarehouseContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
  });
  const hotWindow = resolveGoogleAdsSearchHotWindow({
    providerCurrentDate: context.providerCurrentDate,
    startDate: context.startDate,
    endDate: context.endDate,
  });

  if (context.providerAccountIds.length === 0 || !hotWindow.withinHotWindow) {
    const freshness = createGoogleAdsWarehouseFreshness({
      dataState:
        context.providerAccountIds.length === 0
          ? context.dataState
          : "stale",
      isPartial: hotWindow.requestExtendsOutsideWindow,
      warnings: hotWindow.requestExtendsOutsideWindow
        ? [
            `Search intelligence is only retained for the most recent ${GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS} days starting ${hotWindow.supportStart}.`,
          ]
        : [],
    });
    return {
      rows: [],
      summary: { total: 0 },
      meta: buildMeta({
        freshness,
        rowCounts: { search_term_daily: 0 },
      }),
    };
  }

  const providerAccountId =
    context.providerAccountIds.length === 1 ? context.providerAccountIds[0] : null;
  const [hotRows, keywordRows, productRows, latestSync, completion] = await Promise.all([
    readGoogleAdsSearchQueryHotDailySupportRows({
      businessId: params.businessId,
      providerAccountId,
      startDate: hotWindow.effectiveStart,
      endDate: hotWindow.effectiveEnd,
    }).catch(() => []),
    readGoogleAdsAggregatedRange({
      scope: "keyword_daily",
      businessId: params.businessId,
      providerAccountIds: context.providerAccountIds,
      startDate: hotWindow.effectiveStart,
      endDate: hotWindow.effectiveEnd,
    }).catch(() => []),
    readGoogleAdsAggregatedRange({
      scope: "product_daily",
      businessId: params.businessId,
      providerAccountIds: context.providerAccountIds,
      startDate: hotWindow.effectiveStart,
      endDate: hotWindow.effectiveEnd,
    }).catch(() => []),
    getLatestGoogleAdsSyncHealth({
      businessId: params.businessId,
      providerAccountId,
    }).catch(() => null),
    readServingCompletion({
      businessId: params.businessId,
      scopes: ["search_term_daily"],
      providerAccountIds: context.providerAccountIds,
      startDate: hotWindow.effectiveStart,
      endDate: hotWindow.effectiveEnd,
    }),
  ]);

  const keywordSet = new Set(
    keywordRows
      .map((row) =>
        normalizeGoogleAdsQueryText(
          String(
            row.keywordText ??
              row.keyword ??
              row.entityLabel ??
              row.name ??
              ""
          )
        )
      )
      .filter(Boolean)
  );
  const productTerms = Array.from(
    new Set(
      productRows
        .map((row) =>
          String(
            row.name ??
              row.productTitle ??
              row.title ??
              row.entityLabel ??
              ""
          ).trim()
        )
        .filter((value) => value.length >= 4)
    )
  );
  const brandTerms = deriveGoogleAdsBrandTermsFromSearchRows(
    hotRows.map((row) => ({ campaignName: row.campaignName }))
  );
  const ownershipContext = buildQueryOwnershipContextFromTerms({
    brandTerms,
    productTerms,
  });

  const coveredDates = new Set(hotRows.map((row) => row.date));
  const missingWindows = enumerateDays(
    hotWindow.effectiveStart,
    hotWindow.effectiveEnd
  ).filter((date) => !coveredDates.has(date));
  const warnings = [
    ...(hotWindow.requestExtendsOutsideWindow
      ? [
          `Search intelligence is only retained for the most recent ${GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS} days starting ${hotWindow.supportStart}.`,
        ]
      : []),
    ...(latestSync?.last_error ? [String(latestSync.last_error)] : []),
  ];

  const byTerm = new Map<
    string,
    {
      key: string;
      searchTerm: string;
      campaignId: string | null;
      campaignName: string | null;
      adGroupId: string | null;
      adGroupName: string | null;
      clusterId: string;
      intentClass: string;
      ownershipClass: string | null;
      spend: number;
      revenue: number;
      conversions: number;
      impressions: number;
      clicks: number;
      sourceSnapshotId: string | null;
    }
  >();

  for (const row of hotRows) {
    const searchTerm = String(
      row.displayQuery ?? row.normalizedQuery ?? row.queryHash
    ).trim();
    if (!searchTerm) continue;
    const normalizedQuery = normalizeGoogleAdsQueryText(searchTerm);
    if (!normalizedQuery) continue;
    const key = [
      row.providerAccountId,
      row.campaignId ?? "",
      row.adGroupId ?? "",
      normalizedQuery,
    ].join(":");
    const current = byTerm.get(key);
    if (!current) {
      byTerm.set(key, {
        key,
        searchTerm,
        campaignId: row.campaignId,
        campaignName: row.campaignName,
        adGroupId: row.adGroupId,
        adGroupName: row.adGroupName,
        clusterId: row.clusterKey || row.clusterLabel || normalizedQuery,
        intentClass:
          row.intentClass ?? classifySearchIntent(searchTerm),
        ownershipClass: row.ownershipClass ?? null,
        spend: row.spend,
        revenue: row.revenue,
        conversions: row.conversions,
        impressions: row.impressions,
        clicks: row.clicks,
        sourceSnapshotId: row.sourceSnapshotId,
      });
      continue;
    }
    current.spend += row.spend;
    current.revenue += row.revenue;
    current.conversions += row.conversions;
    current.impressions += row.impressions;
    current.clicks += row.clicks;
    if (row.campaignName) current.campaignName = row.campaignName;
    if (row.adGroupName) current.adGroupName = row.adGroupName;
    if (!current.sourceSnapshotId && row.sourceSnapshotId) {
      current.sourceSnapshotId = row.sourceSnapshotId;
    }
  }

  const rows = Array.from(byTerm.values())
    .map((row) => {
      const normalizedQuery = normalizeGoogleAdsQueryText(row.searchTerm);
      const isKeyword = keywordSet.has(normalizedQuery);
      const spend = Number(row.spend.toFixed(2));
      const revenue = Number(row.revenue.toFixed(2));
      const conversions = Number(row.conversions.toFixed(2));
      const impressions = Math.round(row.impressions);
      const clicks = Math.round(row.clicks);
      const roas = spend > 0 ? Number((revenue / spend).toFixed(2)) : 0;
      const cpa =
        conversions > 0 ? Number((spend / conversions).toFixed(2)) : 0;
      const ctr =
        impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
      const cpc =
        clicks > 0 ? Number((spend / clicks).toFixed(2)) : null;
      const conversionRate =
        clicks > 0
          ? Number(((conversions / clicks) * 100).toFixed(2))
          : null;
      const wasteFlag = spend > 20 && conversions === 0;
      const keywordOpportunityFlag = !isKeyword && conversions >= 2;
      const negativeKeywordFlag =
        clicks >= 20 && conversions === 0 && spend > 10;
      const recommendation = classifySearchAction(
        {
          searchTerm: row.searchTerm,
          campaign: row.campaignName ?? "",
          isKeyword,
          conversions,
          spend,
          clicks,
          roas,
          conversionRate,
        },
        brandTerms,
        productTerms,
        ownershipContext,
      );
      return {
        key: row.key,
        searchTerm: row.searchTerm,
        status: "HOT_WINDOW",
        campaignId: row.campaignId,
        campaign: row.campaignName ?? "",
        campaignName: row.campaignName ?? "",
        adGroupId: row.adGroupId,
        adGroup: row.adGroupName ?? "",
        adGroupName: row.adGroupName ?? "",
        matchSource: "SEARCH",
        source: "search_query_hot_daily",
        impressions,
        clicks,
        spend,
        conversions,
        revenue,
        roas,
        cpa,
        ctr,
        cpc,
        conversionRate,
        intent: row.intentClass,
        intentClass: row.intentClass,
        classification: row.intentClass,
        isKeyword,
        wasteFlag,
        keywordOpportunityFlag,
        negativeKeywordFlag,
        clusterId: row.clusterId,
        ownershipClass: row.ownershipClass,
        recommendation,
        sourceSnapshotId: row.sourceSnapshotId,
      };
    })
    .sort((left, right) => right.spend - left.spend);

  const freshness = createGoogleAdsWarehouseFreshness({
    // `partial` stays a row-existence fact; `ready` now comes from the verdict.
    dataState: hotWindow.requestExtendsOutsideWindow
      ? "partial"
      : resolveServingDataState({
          completion,
          hasMissingWindows: missingWindows.length > 0,
        }),
    lastSyncedAt:
      (typeof latestSync?.updated_at === "string"
        ? latestSync.updated_at
        : null) ??
      (typeof latestSync?.finished_at === "string"
        ? latestSync.finished_at
        : null) ??
      (typeof latestSync?.started_at === "string"
        ? latestSync.started_at
        : null),
    isPartial:
      missingWindows.length > 0 || hotWindow.requestExtendsOutsideWindow,
    missingWindows,
    warnings,
  });

  return {
    rows,
    summary: { total: rows.length },
    meta: buildMeta({
      freshness: Object.assign(freshness, { completion }),
      rowCounts: { search_term_daily: rows.length },
    }),
  };
}

export async function getGoogleAdsSearchTermsReport(
  params: BaseReportParams & { filter?: string }
): Promise<ReportResult<Record<string, unknown>>> {
  const report = await buildGoogleAdsSearchTermsHotReport(params);
  const filter = params.filter?.toLowerCase().trim();
  const rows = filter
    ? report.rows.filter((row) => String(row.searchTerm ?? "").toLowerCase().includes(filter))
    : report.rows;
  return {
    rows,
    summary: { total: rows.length },
    meta: {
      ...report.meta,
      row_counts: { search_term_daily: rows.length },
    },
  };
}

export async function getGoogleAdsSearchIntelligenceReport(
  params: BaseReportParams & { filter?: string }
): Promise<ReportResult<Record<string, unknown>>> {
  const [terms, context] = await Promise.all([
    buildGoogleAdsSearchTermsHotReport(params),
    resolveWarehouseContext({
      businessId: params.businessId,
      accountId: params.accountId,
      dateRange: params.dateRange,
      customStart: params.customStart,
      customEnd: params.customEnd,
    }),
  ]);
  const providerAccountId =
    context.providerAccountIds.length === 1 ? context.providerAccountIds[0] : null;
  const shouldLoadAggregateSupport =
    context.providerAccountIds.length > 0;
  const [queryWeeklyRows, clusterDailyRows, keywordRows, productRows] =
    shouldLoadAggregateSupport
      ? await Promise.all([
          readGoogleAdsTopQueryWeeklyRows({
            businessId: params.businessId,
            providerAccountId,
            startWeek: isoWeekStart(context.startDate),
            endWeek: isoWeekStart(context.endDate),
          }).catch(() => []),
          readGoogleAdsSearchClusterDailyRows({
            businessId: params.businessId,
            providerAccountId,
            startDate: context.startDate,
            endDate: context.endDate,
          }).catch(() => []),
          readGoogleAdsAggregatedRange({
            scope: "keyword_daily",
            businessId: params.businessId,
            providerAccountIds: context.providerAccountIds,
            startDate: context.startDate,
            endDate: context.endDate,
          }).catch(() => []),
          readGoogleAdsAggregatedRange({
            scope: "product_daily",
            businessId: params.businessId,
            providerAccountIds: context.providerAccountIds,
            startDate: context.startDate,
            endDate: context.endDate,
          }).catch(() => []),
        ])
      : [[], [], [], []];
  const aggregateIntelligence = summarizeGoogleAdsAdvisorAggregateIntelligence({
    queryWeeklyRows,
    clusterDailyRows,
    supportWindowStart: context.startDate,
    supportWindowEnd: context.endDate,
  });
  const keywordSet = new Set(
    keywordRows
      .map((row) =>
        normalizeGoogleAdsQueryText(
          String(
            row.keywordText ??
              row.keyword ??
              row.entityLabel ??
              row.name ??
              ""
          )
        )
      )
      .filter(Boolean)
  );
  const productTerms = Array.from(
    new Set(
      productRows
        .map((row) =>
          String(
            row.name ??
              row.productTitle ??
              row.title ??
              row.entityLabel ??
              ""
          ).trim()
        )
        .filter((value) => value.length >= 4)
    )
  );
  const aggregateFallbackRows =
    aggregateIntelligence.queryWeeklySupport.length > 0
      ? buildSearchIntelligenceRowsFromWeeklySupport({
          rows: aggregateIntelligence.queryWeeklySupport,
          keywordSet,
          productTerms,
        })
      : buildSearchIntelligenceRowsFromClusterSupport(
          aggregateIntelligence.clusterDailySupport
        );
  const sourceRows =
    terms.rows.length > 0 ? terms.rows : aggregateFallbackRows;
  const rows = params.filter
    ? sourceRows.filter((row) =>
        String(row.classification ?? row.intentClass ?? "")
          .toLowerCase()
          .includes(params.filter!.toLowerCase())
      )
    : sourceRows;
  const analysis = analyzeSearchIntelligence(rows);
  const aggregateInsights =
    params.filter || aggregateIntelligence.clusterDailySupport.length === 0
      ? null
      : summarizeSearchIntelligenceFromAggregateSupport({
          clusterSupport: aggregateIntelligence.clusterDailySupport,
          queryWeeklySupport: aggregateIntelligence.queryWeeklySupport,
          keywordSet,
        });
  const warnings = Array.from(
    new Set([
      ...terms.meta.warnings,
      ...(aggregateIntelligence.metadata.topQueryWeeklyAvailable ||
      aggregateIntelligence.metadata.clusterDailyAvailable
        ? [
            `Long-range search intelligence is served from additive query and cluster aggregates; raw search-term rows remain limited to the most recent ${GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS} days.`,
          ]
        : []),
    ])
  );
  return {
    rows,
    summary: {
      wastefulSpend: rows
        .filter((row) => Boolean(row.wasteFlag))
        .reduce((sum, row) => sum + toNumber(row.spend), 0),
      keywordOpportunityCount: rows.filter((row) => Boolean(row.keywordOpportunityFlag)).length,
      negativeKeywordCount: rows.filter((row) => Boolean(row.negativeKeywordFlag)).length,
      promotionSuggestionCount:
        aggregateInsights?.summary.emergingThemeCount ??
        analysis.summary.emergingThemeCount ??
        0,
    },
    insights: aggregateInsights
      ? {
          ...analysis.insights,
          bestConvertingThemes: aggregateInsights.insights.bestConvertingThemes,
          wastefulThemes: aggregateInsights.insights.wastefulThemes,
          newOpportunityQueries:
            aggregateInsights.insights.newOpportunityQueries.length > 0
              ? aggregateInsights.insights.newOpportunityQueries
              : analysis.insights.newOpportunityQueries,
          semanticClusters: aggregateInsights.insights.semanticClusters,
        }
      : analysis.insights,
    meta: {
      ...terms.meta,
      warnings,
      row_counts: {
        ...terms.meta.row_counts,
        search_term_daily: rows.length,
      },
    },
  };
}

export async function getGoogleAdsKeywordsReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const report = await buildSimpleEntityReport(params, "keyword_daily");
  const analysis = analyzeKeywords(report.rows);
  return {
    rows: analysis.rows,
    summary: {
      ...analysis.summary,
      // The Search screen's three keyword tallies. They were computed only on
      // the live report path, so the warehouse-served screen had nothing to
      // read and invented row counts in their place. Same predicates, one
      // module, both readers.
      ...countGoogleAdsKeywordInsights(
        report.rows as unknown as GoogleAdsKeywordInsightRow[],
      ),
    },
    insights: analysis.insights,
    meta: report.meta,
  };
}

export async function getGoogleAdsAdsReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  return buildSimpleEntityReport(params, "ad_daily");
}

export async function getGoogleAdsAssetsReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const report = await buildSimpleEntityReport(params, "asset_daily");
  const analysis = analyzeAssets(report.rows);
  return {
    rows: analysis.rows,
    summary: analysis.summary,
    insights: analysis.insights,
    meta: report.meta,
  };
}

export async function getGoogleAdsAssetGroupsReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const report = await buildSimpleEntityReport(params, "asset_group_daily");
  const analysis = analyzeAssetGroups(report.rows);
  return {
    rows: analysis.rows,
    summary: analysis.summary,
    insights: analysis.insights,
    meta: report.meta,
  };
}

/**
 * The Merchant Center block the Products screen's tiles print.
 *
 * Every field is nullable and null means "not read", never "zero". The screen
 * distinguishes the two: an unread count is ink and prints the em dash, a real
 * count of zero is tinted and prints `0`.
 */
export interface GoogleAdsProductFeedSummary {
  totalItemsInFeed: number | null;
  servingItemCount: number | null;
  limitedItemCount: number | null;
  disapprovedItemCount: number | null;
  /** ISO timestamp of the newest Merchant Center observation. */
  syncedAt: string | null;
  /** Which Merchant Center accounts answered. Empty when none did. */
  merchantCenterIds: string[];
}

export interface GoogleAdsProductsReportResult
  extends ReportResult<Record<string, unknown>> {
  feed: GoogleAdsProductFeedSummary | null;
}

export async function getGoogleAdsProductsReport(
  params: BaseReportParams
): Promise<GoogleAdsProductsReportResult> {
  const scope = await buildScopeResponse({ params, scope: "product_daily" });
  const report: ReportResult<Record<string, unknown>> = {
    rows: scope.rows,
    summary: { total: scope.rows.length },
    meta: buildMeta({
      freshness: scope.freshness,
      rowCounts: { product_daily: scope.rows.length },
    }),
  };
  const analysis = analyzeProducts(report.rows);

  // Merchant Center item state is read separately and joined here, never
  // fetched from the provider on this path: this is the warehouse reader, and a
  // read that reached out to Google would make the screen's latency depend on
  // an account link most businesses do not have. A failed or missing read
  // yields null and the surface keeps its em dashes.
  const feedRead = await readMerchantCenterFeedState({
    businessId: params.businessId,
    providerAccountIds: scope.context.providerAccountIds,
  }).catch(() => null);

  if (!feedRead) {
    // The absence, stated. The Products screen itself has no slot for a
    // sentence — its tiles print the em dash, which is the design's own way of
    // saying "not read" — so the reason belongs where every other unreadable
    // Google surface reports itself: the Diagnostics tab's warning list.
    report.meta.warnings.push(
      "Merchant Center item state is unavailable: no Merchant Center product has been read for this account. Feed status and the feed-health counts stay blank until the Google Ads account is linked to a Merchant Center account.",
    );
  }

  const rows = attachMerchantCenterState(analysis.rows, feedRead?.items ?? null);

  return {
    rows,
    summary: analysis.summary,
    insights: analysis.insights,
    meta: report.meta,
    feed: feedRead
      ? {
          totalItemsInFeed: feedRead.tallies.totalItemsInFeed,
          servingItemCount: feedRead.tallies.servingItemCount,
          limitedItemCount: feedRead.tallies.limitedItemCount,
          disapprovedItemCount: feedRead.tallies.disapprovedItemCount,
          syncedAt: feedRead.observedAt,
          merchantCenterIds: feedRead.merchantCenterIds,
        }
      : null,
  };
}

export async function getGoogleAdsAudiencesReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const report = await buildSimpleEntityReport(params, "audience_daily");
  const byType = new Map<string, { type: string; spend: number; conversions: number; revenue: number; roas: number }>();
  for (const row of report.rows) {
    const type = String(row.audienceType ?? row.type ?? "Unknown");
    const current = byType.get(type) ?? { type, spend: 0, conversions: 0, revenue: 0, roas: 0 };
    current.spend += toNumber(row.spend);
    current.conversions += toNumber(row.conversions);
    current.revenue += toNumber(row.revenue);
    current.roas = current.spend > 0 ? Number((current.revenue / current.spend).toFixed(2)) : 0;
    byType.set(type, current);
  }
  return {
    rows: report.rows,
    summary: { byType: Array.from(byType.values()) },
    meta: report.meta,
  };
}

export async function getGoogleAdsGeoReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  return buildSimpleEntityReport(params, "geo_daily");
}

export async function getGoogleAdsDevicesReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  return buildSimpleEntityReport(params, "device_daily");
}

export async function getGoogleAdsBudgetReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const campaigns = await getGoogleAdsCampaignsReport({
    ...params,
    compareMode: "none",
  });
  const analysis = analyzeBudgetScaling(campaigns.rows);
  return {
    rows: analysis.rows,
    summary: analysis.summary,
    insights: analysis.insights,
    meta: campaigns.meta,
  };
}

export async function getGoogleAdsCreativesReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  return getGoogleAdsAssetsReport(params);
}

export async function getGoogleAdsOpportunitiesReport(
  params: BaseReportParams
): Promise<ReportResult<GoogleAdsOpportunity>> {
  const [campaigns, keywords, searchIntelligence, assets, assetGroups, products, geo, devices, audiences] =
    await Promise.all([
      getGoogleAdsCampaignsReport({ ...params, compareMode: "none" }),
      getGoogleAdsKeywordsReport(params),
      getGoogleAdsSearchIntelligenceReport(params),
      getGoogleAdsAssetsReport(params),
      getGoogleAdsAssetGroupsReport(params),
      getGoogleAdsProductsReport(params),
      getGoogleAdsGeoReport(params),
      getGoogleAdsDevicesReport(params),
      getGoogleAdsAudiencesReport(params),
    ]);

  const opportunityResult = buildGoogleAdsOpportunityEngine({
    campaigns: campaigns.rows,
    products: products.rows,
    assets: assets.rows,
    assetGroups: assetGroups.rows,
    searchTerms: searchIntelligence.rows,
    keywords: keywords.rows,
    audiences: audiences.rows,
    geo: geo.rows,
    devices: devices.rows,
  });
  const crossEntity = buildCrossEntityIntelligence({
    campaigns: campaigns.rows,
    products: products.rows,
    assets: assets.rows,
    assetGroups: assetGroups.rows,
    searchTerms: searchIntelligence.rows,
  });
  const crossRows = crossEntity.rows
    .filter((row) => ["scale_path", "waste_concentration", "asset_theme_alignment"].includes(String(row.type)))
    .map((row) => ({
      id: String(row.id),
      type: String(row.type).includes("waste") ? "reduce" : "scale",
      entityType: "campaign",
      entityId: String(row.relatedEntities?.[0]?.entityId ?? row.id),
      title: String(row.title),
      description: String(row.description),
      reasoning: String(row.reasoning),
      expectedImpact: row.impact === "high" ? "high" : row.impact === "medium" ? "medium" : "low",
      confidence: toNumber(row.confidence),
      metrics: row.metrics ?? {},
    })) as GoogleAdsOpportunity[];
  const rows = [...crossRows, ...opportunityResult.rows].sort(
    (a, b) => toNumber(b.confidence) - toNumber(a.confidence)
  );
  return {
    rows,
    summary: {
      scale: rows.filter((row) => row.type === "scale").length,
      reduce: rows.filter((row) => row.type === "reduce").length,
      fix: rows.filter((row) => row.type === "fix").length,
      test: rows.filter((row) => row.type === "test").length,
      total: rows.length,
      crossEntity: crossRows.length,
    },
    meta: campaigns.meta,
  };
}

export async function getGoogleAdsDiagnosticsReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const reports = await Promise.all([
    getGoogleAdsOverviewReport({ ...params, compareMode: "none" }),
    getGoogleAdsCampaignsReport({ ...params, compareMode: "none" }),
    getGoogleAdsSearchIntelligenceReport(params),
    getGoogleAdsKeywordsReport(params),
    getGoogleAdsAssetsReport(params),
    getGoogleAdsAssetGroupsReport(params),
    getGoogleAdsProductsReport(params),
    getGoogleAdsAudiencesReport(params),
    getGoogleAdsGeoReport(params),
    getGoogleAdsDevicesReport(params),
    getGoogleAdsBudgetReport(params),
    getGoogleAdsOpportunitiesReport(params),
  ]);
  const sections = [
    { label: "Overview", meta: reports[0].meta, rows: 1 },
    { label: "Campaigns", meta: reports[1].meta, rows: reports[1].rows.length },
    { label: "Search Intelligence", meta: reports[2].meta, rows: reports[2].rows.length },
    { label: "Keywords", meta: reports[3].meta, rows: reports[3].rows.length },
    { label: "Assets", meta: reports[4].meta, rows: reports[4].rows.length },
    { label: "Asset Groups", meta: reports[5].meta, rows: reports[5].rows.length },
    { label: "Products", meta: reports[6].meta, rows: reports[6].rows.length },
    { label: "Audience Intelligence", meta: reports[7].meta, rows: reports[7].rows.length },
    { label: "Geo", meta: reports[8].meta, rows: reports[8].rows.length },
    { label: "Devices", meta: reports[9].meta, rows: reports[9].rows.length },
    { label: "Budget & Scaling", meta: reports[10].meta, rows: reports[10].rows.length },
    { label: "Opportunities", meta: reports[11].meta, rows: reports[11].rows.length },
  ].map((section) => ({
    ...section,
    partial: section.meta.partial,
    warningCount: section.meta.warnings.length,
    failureCount: section.meta.failed_queries.length,
    unavailableMetricCount: section.meta.unavailable_metrics.length,
  }));
  return {
    rows: sections,
    summary: {
      loadedSections: sections.length,
      healthySections: sections.filter((section) => !section.partial && section.warningCount === 0).length,
      totalWarnings: sections.reduce((sum, section) => sum + section.warningCount, 0),
      totalFailures: 0,
      coreBlockers: 0,
      optionalFailures: 0,
      apiLimitations: 0,
      generatedAt: new Date().toISOString(),
    },
    insights: {
      reportFamilies: [],
      issueInventory: [],
      groupedIssues: {
        coreBlockers: [],
        optionalFailures: [],
        permissionContext: [],
        apiLimitations: [],
      },
      limitations: ["Google Ads is now served from the DB warehouse; route-level request caches are disabled."],
    },
    meta: reports[0].meta,
  };
}

async function finalizeGoogleAdsAdvisorReport(input: {
  params: BaseReportParams;
  selectedLabel: string;
  selectedWindowKey: "operational_28d" | "custom";
  selectedCampaigns: Awaited<ReturnType<typeof getGoogleAdsCampaignsReport>>;
  selectedSearch: Awaited<ReturnType<typeof getGoogleAdsSearchIntelligenceReport>>;
  /**
   * Rows only. Widened off `getGoogleAdsProductsReport`'s return type because
   * the advisor reads `.rows` and nothing else — binding it to the Products
   * screen's shape would have made every synthetic product window owe a
   * Merchant Center block it has no business carrying.
   */
  selectedProducts: ReportResult<Record<string, unknown>>;
  selectedAssets: Awaited<ReturnType<typeof getGoogleAdsAssetsReport>>;
  selectedAssetGroups: Awaited<ReturnType<typeof getGoogleAdsAssetGroupsReport>>;
  selectedGeos: Awaited<ReturnType<typeof getGoogleAdsGeoReport>>;
  selectedDevices: Awaited<ReturnType<typeof getGoogleAdsDevicesReport>>;
  windows: Array<{
    key:
      | "alarm_1d"
      | "alarm_3d"
      | "alarm_7d"
      | "operational_28d"
      | "query_governance_56d"
      | "baseline_84d";
    label: string;
    searchTerms: Array<Record<string, unknown>>;
    campaigns?: Array<Record<string, unknown>>;
    products?: Array<Record<string, unknown>>;
    campaignSupport?: ReturnType<typeof buildGoogleAdsAdvisorCampaignSupportFromDailyRows>;
    productSupport?: ReturnType<typeof buildGoogleAdsAdvisorProductSupportFromDailyRows>;
  }>;
  historicalSupport: GoogleAdvisorHistoricalSupport | null;
  aggregateIntelligence?: GoogleAdvisorAggregateIntelligence | null;
  analysisMode: "snapshot" | "debug_custom";
  asOfDate: string;
}) {
  const advisorContext = await resolveWarehouseContext({
    businessId: input.params.businessId,
    accountId: input.params.accountId,
    dateRange: input.params.dateRange,
    customStart: input.params.customStart,
    customEnd: input.params.customEnd,
  });
  const resolvedAccountId =
    input.params.accountId && input.params.accountId !== "all"
      ? input.params.accountId
      : advisorContext.providerAccountIds.length === 1
        ? advisorContext.providerAccountIds[0]
        : null;

  const costModel = await getBusinessCostModel(input.params.businessId);
  const aggregateSupportWindowSet = buildGoogleAdsDecisionSnapshotWindowSet(input.asOfDate);
  const aggregateSupportStart = aggregateSupportWindowSet.baselineWindow.startDate;
  const aggregateIntelligence: GoogleAdvisorAggregateIntelligence | null =
    input.aggregateIntelligence ??
    (await loadGoogleAdsAdvisorAggregateIntelligence({
      businessId: input.params.businessId,
      providerAccountId: resolvedAccountId,
      supportWindowStart: aggregateSupportStart,
      supportWindowEnd: input.asOfDate,
    }).catch((error) => ({
      queryWeeklySupport: [],
      clusterDailySupport: [],
      metadata: {
        topQueryWeeklyAvailable: false,
        clusterDailyAvailable: false,
        queryWeeklyRows: 0,
        clusterDailyRows: 0,
        supportWindowStart: aggregateSupportStart,
        supportWindowEnd: input.asOfDate,
        note:
          error instanceof Error
            ? `Persisted aggregate intelligence was unavailable for this advisor run: ${error.message}`
            : "Persisted aggregate intelligence was unavailable for this advisor run.",
      },
    })));

  const advisor = buildGoogleGrowthAdvisor({
    selectedLabel: input.selectedLabel,
    analysisMetadata: {
      analysisMode: input.analysisMode,
      asOfDate: input.asOfDate,
      selectedWindowKey: input.selectedWindowKey,
    },
    historicalSupport: input.historicalSupport,
    commerceContext: {
      costModel,
      commerceSources: (input.selectedProducts.rows as Array<Record<string, unknown>>).map((row) => ({
        productItemId: String(row.productItemId ?? row.itemId ?? "") || null,
        productTitle: String(row.name ?? row.productTitle ?? row.title ?? ""),
        inventory:
          typeof row.inventory === "number"
            ? Number(row.inventory)
            : typeof row.stock === "number"
              ? Number(row.stock)
              : null,
        availability:
          typeof row.availability === "string"
            ? String(row.availability)
            : typeof row.productAvailability === "string"
              ? String(row.productAvailability)
              : null,
        compareAtPrice:
          typeof row.compareAtPrice === "number"
            ? Number(row.compareAtPrice)
            : typeof row.compare_at_price === "number"
              ? Number(row.compare_at_price)
              : null,
      })),
    },
    selectedCampaigns: input.selectedCampaigns.rows as never[],
    selectedSearchTerms: input.selectedSearch.rows as never[],
    selectedProducts: input.selectedProducts.rows as never[],
    selectedAssets: input.selectedAssets.rows as never[],
    selectedAssetGroups: input.selectedAssetGroups.rows as never[],
    selectedGeos: input.selectedGeos.rows as never[],
    selectedDevices: input.selectedDevices.rows as never[],
    windows: input.windows as never[],
    aggregateIntelligence,
  });

  const executionCalibration = await getAdvisorExecutionCalibration({
    businessId: input.params.businessId,
    accountId: input.params.accountId ?? "all",
  });

  const recommendations: GoogleRecommendation[] = decorateAdvisorRecommendationsForExecution({
    accountId: resolvedAccountId,
    selectedCampaigns: input.selectedCampaigns.rows as never[],
    selectedSearchTerms: input.selectedSearch.rows as never[],
    selectedProducts: input.selectedProducts.rows as never[],
    selectedAssets: input.selectedAssets.rows as never[],
    executionCalibration,
    recommendations: await annotateAdvisorMemory({
    businessId: input.params.businessId,
    accountId: input.params.accountId ?? "all",
    recommendations: advisor.recommendations,
    }),
  }) as GoogleRecommendation[];
  const recommendationsById = new Map(recommendations.map((recommendation) => [recommendation.id, recommendation]));
  const sections = advisor.sections
    .map((section) => ({
      ...section,
      recommendations: section.recommendations
        .map((recommendation) => recommendationsById.get(recommendation.id) ?? recommendation)
        .filter(Boolean),
    }))
    .filter((section) => section.recommendations.length > 0);
  const clusters = buildActionClusters({ recommendations: recommendations as GoogleRecommendation[] });
  const topCluster = clusters[0] ?? null;
  return {
    ...advisor,
    summary: {
      ...advisor.summary,
      headline: topCluster?.clusterObjective ?? recommendations[0]?.title ?? advisor.summary.headline,
      topPriority: topCluster?.clusterObjective ?? recommendations[0]?.recommendedAction ?? advisor.summary.topPriority,
      operatorNote:
        clusters.length > 0
          ? `${clusters.length} operator moves are live. Highest priority: ${topCluster?.clusterObjective ?? recommendations[0]?.title ?? "Review current recommendations."}`
          : recommendations.length > 0
            ? `${recommendations.length} actionable Google recommendations are live. Highest priority: ${recommendations[0].title}.`
          : advisor.summary.operatorNote,
      watchouts: recommendations
        .filter(
          (recommendation) =>
            recommendation.doBucket === "do_later" ||
            recommendation.decisionState === "watch" ||
            recommendation.integrityState === "blocked"
        )
        .slice(0, 3)
        .map((recommendation) => recommendation.title),
    },
    recommendations,
    sections,
    clusters,
    meta: {
      selectedCampaigns: input.selectedCampaigns.rows.length,
      selectedSearchTerms: input.selectedSearch.rows.length,
      selectedProducts: input.selectedProducts.rows.length,
      selectedAssets: input.selectedAssets.rows.length,
      freshness: input.selectedCampaigns.meta,
    },
    metadata: buildGoogleAdsDecisionSnapshotMetadata({
      analysisMode: input.analysisMode,
      asOfDate: input.asOfDate,
      selectedWindowKey: input.selectedWindowKey,
      historicalSupport: input.historicalSupport,
      decisionSummaryTotals: advisor.metadata?.decisionSummaryTotals ?? null,
      selectedRangeTotals: advisor.metadata?.selectedRangeTotals ?? null,
      selectedRangeContext: advisor.metadata?.selectedRangeContext ?? null,
      aggregateIntelligence: advisor.metadata?.aggregateIntelligence ?? aggregateIntelligence?.metadata ?? null,
    }),
  };
}

export async function buildCanonicalGoogleAdsAdvisorReport(params: BaseReportParams) {
  const advisorContext = await resolveWarehouseContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: "90",
    customStart: null,
    customEnd: null,
  });
  const asOfDate = addDaysToIsoDate(advisorContext.endDate, -1);
  const snapshotWindowSet = buildGoogleAdsDecisionSnapshotWindowSet(asOfDate);
  const alarm1 = snapshotWindowSet.healthAlarmWindows[0];
  const alarm3 = snapshotWindowSet.healthAlarmWindows[1];
  const alarm7 = snapshotWindowSet.healthAlarmWindows[2];
  const operational28 = {
    customStart: snapshotWindowSet.primaryWindow.startDate,
    customEnd: snapshotWindowSet.primaryWindow.endDate,
    key: snapshotWindowSet.primaryWindow.key,
    label: snapshotWindowSet.primaryWindow.label,
  };
  const queryGovernance56 = {
    customStart: snapshotWindowSet.queryWindow.startDate,
    customEnd: snapshotWindowSet.queryWindow.endDate,
    key: snapshotWindowSet.queryWindow.key,
    label: snapshotWindowSet.queryWindow.label,
  };
  const baseline84 = {
    customStart: snapshotWindowSet.baselineWindow.startDate,
    customEnd: snapshotWindowSet.baselineWindow.endDate,
    key: snapshotWindowSet.baselineWindow.key,
    label: snapshotWindowSet.baselineWindow.label,
  };
  const costHistoricalSupport = await buildGoogleAdsHistoricalSupport({
    businessId: params.businessId,
    accountId: params.accountId ?? null,
    asOfDate,
  });

  const [
    selectedCampaigns,
    selectedSearch,
    selectedProducts,
    selectedAssets,
    selectedAssetGroups,
    selectedGeos,
    selectedDevices,
    last3Campaigns,
    last3Search,
    last3Products,
    last7Campaigns,
    last7Search,
    last7Products,
    last14Campaigns,
    last14Search,
    last14Products,
    last30Campaigns,
    last30Search,
    last30Products,
    last90Campaigns,
    last90Search,
    last90Products,
  ] = await runWithConcurrencyLimit(
    [
      () => getGoogleAdsCampaignsReport({ ...params, dateRange: "custom", customStart: operational28.customStart, customEnd: operational28.customEnd, compareMode: "none" }),
      () => getGoogleAdsSearchIntelligenceReport({ ...params, dateRange: "custom", customStart: operational28.customStart, customEnd: operational28.customEnd }),
      () => getGoogleAdsProductsReport({ ...params, dateRange: "custom", customStart: operational28.customStart, customEnd: operational28.customEnd }),
      () => getGoogleAdsAssetsReport({ ...params, dateRange: "custom", customStart: operational28.customStart, customEnd: operational28.customEnd }),
      () => getGoogleAdsAssetGroupsReport({ ...params, dateRange: "custom", customStart: operational28.customStart, customEnd: operational28.customEnd }),
      () => getGoogleAdsGeoReport({ ...params, dateRange: "custom", customStart: operational28.customStart, customEnd: operational28.customEnd }),
      () => getGoogleAdsDevicesReport({ ...params, dateRange: "custom", customStart: operational28.customStart, customEnd: operational28.customEnd }),
      () => getGoogleAdsCampaignsReport({ ...params, dateRange: "custom", customStart: alarm1.startDate, customEnd: alarm1.endDate, compareMode: "none" }),
      () => getGoogleAdsSearchIntelligenceReport({ ...params, dateRange: "custom", customStart: alarm1.startDate, customEnd: alarm1.endDate }),
      () => getGoogleAdsProductsReport({ ...params, dateRange: "custom", customStart: alarm1.startDate, customEnd: alarm1.endDate }),
      () => getGoogleAdsCampaignsReport({ ...params, dateRange: "custom", customStart: alarm3.startDate, customEnd: alarm3.endDate, compareMode: "none" }),
      () => getGoogleAdsSearchIntelligenceReport({ ...params, dateRange: "custom", customStart: alarm3.startDate, customEnd: alarm3.endDate }),
      () => getGoogleAdsProductsReport({ ...params, dateRange: "custom", customStart: alarm3.startDate, customEnd: alarm3.endDate }),
      () => getGoogleAdsCampaignsReport({ ...params, dateRange: "custom", customStart: alarm7.startDate, customEnd: alarm7.endDate, compareMode: "none" }),
      () => getGoogleAdsSearchIntelligenceReport({ ...params, dateRange: "custom", customStart: alarm7.startDate, customEnd: alarm7.endDate }),
      () => getGoogleAdsProductsReport({ ...params, dateRange: "custom", customStart: alarm7.startDate, customEnd: alarm7.endDate }),
      () => getGoogleAdsCampaignsReport({ ...params, dateRange: "custom", customStart: queryGovernance56.customStart, customEnd: queryGovernance56.customEnd, compareMode: "none" }),
      () => getGoogleAdsSearchIntelligenceReport({ ...params, dateRange: "custom", customStart: queryGovernance56.customStart, customEnd: queryGovernance56.customEnd }),
      () => getGoogleAdsProductsReport({ ...params, dateRange: "custom", customStart: queryGovernance56.customStart, customEnd: queryGovernance56.customEnd }),
      () => getGoogleAdsCampaignsReport({ ...params, dateRange: "custom", customStart: baseline84.customStart, customEnd: baseline84.customEnd, compareMode: "none" }),
      () => getGoogleAdsSearchIntelligenceReport({ ...params, dateRange: "custom", customStart: baseline84.customStart, customEnd: baseline84.customEnd }),
      () => getGoogleAdsProductsReport({ ...params, dateRange: "custom", customStart: baseline84.customStart, customEnd: baseline84.customEnd }),
    ],
    2
  );

  return finalizeGoogleAdsAdvisorReport({
    params: { ...params, dateRange: "custom", customStart: operational28.customStart, customEnd: operational28.customEnd },
    selectedLabel: "operational 28d",
    selectedWindowKey: "operational_28d",
    selectedCampaigns,
    selectedSearch,
    selectedProducts,
    selectedAssets,
    selectedAssetGroups,
    selectedGeos,
    selectedDevices,
    windows: [
      { key: alarm1.key, label: alarm1.label, campaigns: last3Campaigns.rows as never[], searchTerms: last3Search.rows as never[], products: last3Products.rows as never[] },
      { key: alarm3.key, label: alarm3.label, campaigns: last7Campaigns.rows as never[], searchTerms: last7Search.rows as never[], products: last7Products.rows as never[] },
      { key: alarm7.key, label: alarm7.label, campaigns: last14Campaigns.rows as never[], searchTerms: last14Search.rows as never[], products: last14Products.rows as never[] },
      { key: operational28.key, label: operational28.label, campaigns: selectedCampaigns.rows as never[], searchTerms: selectedSearch.rows as never[], products: selectedProducts.rows as never[] },
      { key: queryGovernance56.key, label: queryGovernance56.label, campaigns: last30Campaigns.rows as never[], searchTerms: last30Search.rows as never[], products: last30Products.rows as never[] },
      { key: baseline84.key, label: baseline84.label, campaigns: last90Campaigns.rows as never[], searchTerms: last90Search.rows as never[], products: last90Products.rows as never[] },
    ],
    historicalSupport: costHistoricalSupport,
    analysisMode: "snapshot",
    asOfDate,
  });
}

export async function buildGoogleAdsDecisionSnapshotReport(params: BaseReportParams) {
  return buildCanonicalGoogleAdsAdvisorReport(params);
}

export async function getGoogleAdsAdvisorReport(
  params: BaseReportParams
) {
  const { selectedWindow, supportWindows } = buildGoogleAdsAdvisorWindows({
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
  });
  const baseline84 = supportWindows[supportWindows.length - 1]!;
  const asOfDate = selectedWindow.customEnd;

  const baselineContext = await resolveWarehouseContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: "custom",
    customStart: baseline84.customStart,
    customEnd: baseline84.customEnd,
  });

  const supportBundleStartedAt = Date.now();
  const supportBundlePromise = buildGoogleAdsAdvisorSupportBundle({
    businessId: params.businessId,
    context: baselineContext,
  });
  const selectedContextStartedAt = Date.now();
  const selectedContextPromise = runWithConcurrencyLimit(
    [
      () =>
        getGoogleAdsAssetsReport({
          ...params,
          dateRange: "custom",
          customStart: selectedWindow.customStart,
          customEnd: selectedWindow.customEnd,
        }),
      () =>
        getGoogleAdsAssetGroupsReport({
          ...params,
          dateRange: "custom",
          customStart: selectedWindow.customStart,
          customEnd: selectedWindow.customEnd,
        }),
      () =>
        getGoogleAdsGeoReport({
          ...params,
          dateRange: "custom",
          customStart: selectedWindow.customStart,
          customEnd: selectedWindow.customEnd,
        }),
      () =>
        getGoogleAdsDevicesReport({
          ...params,
          dateRange: "custom",
          customStart: selectedWindow.customStart,
          customEnd: selectedWindow.customEnd,
        }),
    ],
    4,
  );

  const [supportBundle, [selectedAssets, selectedAssetGroups, selectedGeos, selectedDevices]] =
    await Promise.all([supportBundlePromise, selectedContextPromise]);

  logRuntimeDebug("google-ads-advisor", "advisor.support_bundle_read", {
    durationMs: Date.now() - supportBundleStartedAt,
    campaignDailyRows: supportBundle.campaignDailyRows.length,
    keywordDailyRows: supportBundle.keywordDailyRows.length,
    productDailyRows: supportBundle.productDailyRows.length,
    hotQueryRows: supportBundle.hotQueryRows.length,
    queryWeeklyRows: supportBundle.queryWeeklyRows.length,
    clusterDailyRows: supportBundle.clusterDailyRows.length,
  });

  logRuntimeDebug("google-ads-advisor", "advisor.selected_context_reads", {
    durationMs: Date.now() - selectedContextStartedAt,
    assetRows: selectedAssets.rows.length,
    assetGroupRows: selectedAssetGroups.rows.length,
    geoRows: selectedGeos.rows.length,
    deviceRows: selectedDevices.rows.length,
  });

  const {
    selectedCampaigns,
    selectedSearch,
    selectedProducts,
    windows,
    aggregateIntelligence,
  } = await measureGoogleAdsAdvisorPhase(
    "advisor.window_slicing",
    async () => {
      const matrix = await measureGoogleAdsAdvisorPhase(
        "advisor.window_slicing.index_build",
        async () =>
          buildGoogleAdsAdvisorWindowMatrix({
            selectedWindow,
            supportWindows,
            campaignDailyRows: supportBundle.campaignDailyRows,
            keywordDailyRows: supportBundle.keywordDailyRows,
            productDailyRows: supportBundle.productDailyRows,
            hotQueryRows: supportBundle.hotQueryRows,
            queryWeeklyRows: supportBundle.queryWeeklyRows,
            clusterDailyRows: supportBundle.clusterDailyRows,
          }),
        (value) => ({
          windowCount: value.telemetry.windowCount,
          uniqueSliceCount: value.uniqueSlices.length,
          assignedCampaignRows: value.telemetry.assignedCampaignRows,
          assignedKeywordRows: value.telemetry.assignedKeywordRows,
          assignedProductRows: value.telemetry.assignedProductRows,
        }),
      );

      const selectedAggregates = {
        campaignRows: aggregateDailyRowsLocally(
          "campaign_daily",
          matrix.selectedView.slice.campaignDailyRows,
        ),
        keywordRows: aggregateDailyRowsLocally(
          "keyword_daily",
          matrix.selectedView.slice.keywordDailyRows,
        ),
        productRows: aggregateDailyRowsLocally(
          "product_daily",
          matrix.selectedView.slice.productDailyRows,
        ),
      } satisfies GoogleAdsAdvisorWindowAggregates;

      const selectedWindowRows = await measureGoogleAdsAdvisorPhase(
        "advisor.window_slicing.selected_materialization",
        async () =>
          buildGoogleAdsAdvisorWindowRowsFromMatrixView({
            bundle: supportBundle,
            view: matrix.selectedView,
            aggregates: selectedAggregates,
          }),
        (value) => ({
          campaignRows: value.campaigns.rows.length,
          searchRows: value.search.rows.length,
          productRows: value.products.rows.length,
        }),
      );

      const orderedSupportViews = supportWindows.map((window) => matrix.supportViews[window.key]);
      const campaignSupportByRange = new Map<
        string,
        ReturnType<typeof buildGoogleAdsAdvisorCampaignSupportFromDailyRows>
      >();
      const productSupportByRange = new Map<
        string,
        ReturnType<typeof buildGoogleAdsAdvisorProductSupportFromDailyRows>
      >();
      const keywordTermSetByRange = new Map<string, Set<string>>();
      const searchRowsByRange = new Map<string, Array<Record<string, unknown>>>();

      const campaignSupportViews = await measureGoogleAdsAdvisorPhase(
        "advisor.window_slicing.campaign_support",
        async () =>
          orderedSupportViews.map((view) => {
            const cached = campaignSupportByRange.get(view.slice.rangeKey);
            if (cached) {
              return {
                key: view.key,
                label: view.label,
                campaignSupport: cached,
              };
            }
            const next = buildGoogleAdsAdvisorCampaignSupportFromDailyRows(
              view.slice.campaignDailyRows,
            );
            campaignSupportByRange.set(view.slice.rangeKey, next);
            return {
              key: view.key,
              label: view.label,
              campaignSupport: next,
            };
          }),
        (value) => ({
          windowCount: value.length,
          rowCount: orderedSupportViews.reduce(
            (sum, view) => sum + view.slice.campaignDailyRows.length,
            0,
          ),
          uniqueEntityCount: value.reduce(
            (sum, view) => sum + view.campaignSupport.familiesPresent.length,
            0,
          ),
        }),
      );

      const productSupportViews = await measureGoogleAdsAdvisorPhase(
        "advisor.window_slicing.product_support",
        async () =>
          orderedSupportViews.map((view) => {
            const cached = productSupportByRange.get(view.slice.rangeKey);
            if (cached) {
              return {
                key: view.key,
                label: view.label,
                productSupport: cached,
              };
            }
            const next = buildGoogleAdsAdvisorProductSupportFromDailyRows(
              view.slice.productDailyRows,
            );
            productSupportByRange.set(view.slice.rangeKey, next);
            return {
              key: view.key,
              label: view.label,
              productSupport: next,
            };
          }),
        (value) => ({
          windowCount: value.length,
          assignedProductRows: orderedSupportViews.reduce(
            (sum, view) => sum + view.slice.productDailyRows.length,
            0,
          ),
          uniqueEntityCount: value.reduce(
            (sum, view) => sum + view.productSupport.productCount,
            0,
          ),
        }),
      );

      const searchSupportViews = await measureGoogleAdsAdvisorPhase(
        "advisor.window_slicing.search_support",
        async () =>
          orderedSupportViews.map((view) => {
            const cached = searchRowsByRange.get(view.slice.rangeKey);
            if (cached) {
              return {
                key: view.key,
                label: view.label,
                searchTerms: cached,
              };
            }
            const keywordTermSet =
              keywordTermSetByRange.get(view.slice.rangeKey) ??
              buildGoogleAdsAdvisorKeywordTermSet(view.slice.keywordDailyRows);
            keywordTermSetByRange.set(view.slice.rangeKey, keywordTermSet);
            const productSupport = productSupportByRange.get(view.slice.rangeKey);
            const rows =
              view.slice.rangeKey === matrix.selectedView.slice.rangeKey
                ? (selectedWindowRows.search.rows as Array<Record<string, unknown>>)
                : (buildGoogleAdsAdvisorSearchReportFromScopedSupportRows({
                    context: supportBundle.context,
                    startDate: view.startDate,
                    endDate: view.endDate,
                    latestSync: supportBundle.latestSync,
                    hotQueryRows: view.slice.hotQueryRows,
                    queryWeeklyRows: view.slice.queryWeeklyRows,
                    clusterDailyRows: view.slice.clusterDailyRows,
                    keywordTermSet,
                    productTerms: productSupport?.productTitles ?? [],
                  }).rows as Array<Record<string, unknown>>);
            searchRowsByRange.set(view.slice.rangeKey, rows);
            return {
              key: view.key,
              label: view.label,
              searchTerms: rows,
            };
          }),
        (value) => ({
          windowCount: value.length,
          rowCount: value.reduce((sum, view) => sum + view.searchTerms.length, 0),
        }),
      );

      return {
        selectedCampaigns: selectedWindowRows.campaigns,
        selectedSearch: selectedWindowRows.search,
        selectedProducts: selectedWindowRows.products,
        windows: orderedSupportViews.map((view) => ({
          key: view.key as
            | "alarm_1d"
            | "alarm_3d"
            | "alarm_7d"
            | "operational_28d"
            | "query_governance_56d"
            | "baseline_84d",
          label: view.label,
          searchTerms:
            searchSupportViews.find((entry) => entry.key === view.key)?.searchTerms ?? [],
          campaignSupport:
            campaignSupportViews.find((entry) => entry.key === view.key)?.campaignSupport,
          productSupport:
            productSupportViews.find((entry) => entry.key === view.key)?.productSupport,
        })),
        aggregateIntelligence: summarizeGoogleAdsAdvisorAggregateIntelligence({
          queryWeeklyRows: matrix.supportViews.baseline_84d.slice.queryWeeklyRows,
          clusterDailyRows: matrix.supportViews.baseline_84d.slice.clusterDailyRows,
          supportWindowStart: baseline84.customStart,
          supportWindowEnd: baseline84.customEnd,
        }),
        telemetry: matrix.telemetry,
      };
    },
    (value) => ({
      windowCount: value.telemetry.windowCount,
      assignedCampaignRows: value.telemetry.assignedCampaignRows,
      assignedKeywordRows: value.telemetry.assignedKeywordRows,
      assignedProductRows: value.telemetry.assignedProductRows,
      windowRowCounts: {
        selected: value.telemetry.windowRowCounts.selected_custom,
        alarm_1d: value.telemetry.windowRowCounts.alarm_1d,
        alarm_3d: value.telemetry.windowRowCounts.alarm_3d,
        alarm_7d: value.telemetry.windowRowCounts.alarm_7d,
        operational_28d: value.telemetry.windowRowCounts.operational_28d,
        query_governance_56d: value.telemetry.windowRowCounts.query_governance_56d,
        baseline_84d: value.telemetry.windowRowCounts.baseline_84d,
      },
      selectedCampaignRows: value.selectedCampaigns.rows.length,
      selectedSearchRows: value.selectedSearch.rows.length,
      selectedProductRows: value.selectedProducts.rows.length,
      baselineCampaignRows:
        value.windows.find((window) => window.key === "baseline_84d")?.campaignSupport
          ?.familiesPresent.length ?? 0,
      baselineSearchRows:
        value.windows.find((window) => window.key === "baseline_84d")?.searchTerms.length ?? 0,
      baselineProductRows:
        value.windows.find((window) => window.key === "baseline_84d")?.productSupport
          ?.productCount ?? 0,
    }),
  );

  const advisorPayload = await measureGoogleAdsAdvisorPhase(
    "advisor.finalize_payload",
    () =>
      finalizeGoogleAdsAdvisorReport({
        params,
        selectedLabel: selectedWindow.label,
        selectedWindowKey: "custom",
        selectedCampaigns,
        selectedSearch,
        selectedProducts,
        selectedAssets,
        selectedAssetGroups,
        selectedGeos,
        selectedDevices,
        windows,
        historicalSupport: null,
        aggregateIntelligence,
        analysisMode: "debug_custom",
        asOfDate,
      }),
    (value) => ({
      recommendationCount: value.recommendations.length,
      sectionCount: value.sections.length,
      clusterCount: value.clusters.length,
    }),
  );

  return normalizeGoogleAdsDecisionSnapshotPayload({
    advisorPayload,
    analysisMode: "debug_custom",
    asOfDate,
    selectedWindowKey: "custom",
    historicalSupport: null,
    actionContractSource: "native",
  });
}
