import {
  type GoogleAdsAccountQueryFailure,
} from "@/lib/google-ads-gaql";
import type {
  AssetGroupPerformanceRow,
  AssetPerformanceRow,
  AudiencePerformanceRow,
  CampaignPerformanceRow,
  DevicePerformanceRow,
  GeoPerformanceRow,
  KeywordPerformanceRow,
  ProductPerformanceRow,
  SearchTermPerformanceRow,
} from "@/lib/google-ads/intelligence-model";
import { GOOGLE_ADS_METRICS_MATRIX, type GoogleAdsTabId } from "@/lib/google-ads/metrics-matrix";
import {
  buildAdCoreQuery,
  buildAdDetailQuery,
  buildAssetGroupSignalQuery,
  buildAssetGroupAssetDetailQuery,
  buildAssetGroupCoreQuery,
  buildAssetPerformanceCoreQuery,
  buildAssetTextDetailQuery,
  buildAudienceCoreQuery,
  buildCampaignSearchTermCoreQuery,
  buildCampaignBudgetQuery,
  buildCampaignCoreBasicQuery,
  buildCampaignShareQuery,
  buildCustomerSummaryQuery,
  buildDeviceCoreQuery,
  buildGeoCoreQuery,
  buildKeywordCoreQuery,
  buildKeywordLookupQuery,
  buildKeywordQualityQuery,
  buildProductPerformanceLegacyQuery,
  buildProductPerformanceQuery,
  buildSearchTermCoreQuery,
  type GoogleAdsNamedQuery,
} from "@/lib/google-ads/query-builders";
import { countGoogleAdsKeywordInsights } from "@/lib/google-ads/keyword-insights";
import {
  asInteger,
  asNumber,
  asRatio,
  asString,
  createEmptyMeta,
  getCompatObject,
  getCompatValue,
  toMetricSet,
  type GoogleAdsReportMeta,
} from "@/lib/google-ads/normalizers";
import {
  classifySearchIntent,
  classifySearchTerms,
  generateBudgetRecommendations,
  type GadsCampaignRow,
  generateOverviewInsights,
  getCampaignBadges,
} from "@/lib/google-ads-intelligence";
import {
  buildCrossEntityIntelligence,
  type CrossEntityInsight,
} from "@/lib/google-ads/cross-entity-intelligence";
import {
  buildGoogleAdsOpportunityEngine,
  type GoogleAdsOpportunity,
} from "@/lib/google-ads/opportunity-engine";
import {
  analyzeAssetGroups,
  analyzeAssets,
  analyzeBudgetScaling,
  analyzeKeywords,
  analyzeProducts,
  analyzeSearchIntelligence,
} from "@/lib/google-ads/tab-analysis";
import {
  buildQueryOwnershipContextFromTerms,
  classifyQueryOwnership,
  evaluateNegativeKeywordAssessment,
  type QueryOwnershipContext,
} from "@/lib/google-ads/query-ownership";
import { normalizeChannelType, normalizeStatus } from "@/lib/google-ads-gaql";
import {
  addDebugMeta,
  aggregateOverviewKpis,
  BaseReportParams,
  buildCampaignMap,
  CompareMode,
  ComparativeReportParams,
  createPrerequisiteFailureMeta,
  DateRange,
  finalizeMeta,
  getQuerySeverity,
  getNumericShare,
  classifyFailureCategory,
  mapCrossEntityInsightToOpportunity,
  mergeChildMeta,
  mergeFailures,
  type OverviewReportResult,
  type QueryExecution,
  type QueryFailureCategory,
  type QuerySeverity,
  resolveContext,
  runNamedQuery,
  type AssetTypeSummary,
  type ReportContext,
  type ReportResult,
  type SearchThemeSignal,
} from "@/lib/google-ads/reporting-core";
import {
  aggregateOverviewKpisFromCampaigns,
  buildTrendMetrics,
  COUNTRY_MAP,
  dedupeStrings,
  getComparisonWindow,
  normalizeAssetPerformanceLabel,
  pctDelta,
  roundOrNull,
  slugifyQueryCluster,
  type RawRow,
  type TrendMetrics,
} from "@/lib/google-ads/reporting-support";
import { logRuntimeDebug } from "@/lib/runtime-logging";

export async function getGoogleAdsOverviewReport(
  params: ComparativeReportParams
): Promise<OverviewReportResult> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_overview_report",
  });
  if (!resolved.ok) {
    return {
      kpis: {},
      topCampaigns: [],
      insights: [],
      meta: resolved.payload.meta,
      summary: resolved.payload.summary,
    };
  }

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const comparisonWindow = getComparisonWindow({
    compareMode: params.compareMode,
    startDate,
    endDate,
    compareStart: params.compareStart,
    compareEnd: params.compareEnd,
  });

  const [customerSummary, campaignCore, campaignShare] = await Promise.all([
    runNamedQuery(context, buildCustomerSummaryQuery(startDate, endDate)),
    runNamedQuery(context, buildCampaignCoreBasicQuery(startDate, endDate)),
    runNamedQuery(context, buildCampaignShareQuery(startDate, endDate)),
  ]);
  const previousQueries = comparisonWindow
    ? await Promise.all([
        runNamedQuery(
          context,
          buildCustomerSummaryQuery(comparisonWindow.startDate, comparisonWindow.endDate)
        ),
        runNamedQuery(
          context,
          buildCampaignCoreBasicQuery(comparisonWindow.startDate, comparisonWindow.endDate)
        ),
        runNamedQuery(
          context,
          buildCampaignShareQuery(comparisonWindow.startDate, comparisonWindow.endDate)
        ),
      ])
    : null;

  mergeFailures(meta, customerSummary);
  mergeFailures(meta, campaignCore);
  mergeFailures(meta, campaignShare);
  if (previousQueries) {
    mergeFailures(meta, previousQueries[0]);
    mergeFailures(meta, previousQueries[1]);
    mergeFailures(meta, previousQueries[2]);
  }

  const campaigns = buildCampaignMap(campaignCore.rows, campaignShare.rows, [])
    .map((campaign) => ({
      ...(campaign as GadsCampaignRow & Record<string, unknown>),
      badges: [] as string[],
    }))
    .sort((a, b) => Number((b.spend as number) ?? 0) - Number((a.spend as number) ?? 0));

  const customerSummaryKpis = aggregateOverviewKpis(customerSummary.rows);
  const campaignFallback = aggregateOverviewKpisFromCampaigns(campaigns);
  const hasCustomerSummaryData =
    customerSummary.rows.length > 0 && Number(customerSummaryKpis.spend ?? 0) > 0;
  const hasCampaignFallbackData = campaigns.length > 0 && campaignFallback.spend > 0;
  const kpis = hasCustomerSummaryData
    ? customerSummaryKpis
    : hasCampaignFallbackData
    ? {
        spend: Number(campaignFallback.spend.toFixed(2)),
        conversions: Number(campaignFallback.conversions.toFixed(2)),
        revenue: Number(campaignFallback.revenue.toFixed(2)),
        roas:
          campaignFallback.spend > 0
            ? Number((campaignFallback.revenue / campaignFallback.spend).toFixed(2))
            : 0,
        cpa:
          campaignFallback.conversions > 0
            ? Number((campaignFallback.spend / campaignFallback.conversions).toFixed(2))
            : 0,
        ctr:
          campaignFallback.impressions > 0
            ? Number(((campaignFallback.clicks / campaignFallback.impressions) * 100).toFixed(2))
            : 0,
        cpc:
          campaignFallback.clicks > 0
            ? Number((campaignFallback.spend / campaignFallback.clicks).toFixed(2))
            : 0,
        impressions: campaignFallback.impressions,
        clicks: campaignFallback.clicks,
        interactions: 0,
        interactionRate: null,
        convRate:
          campaignFallback.clicks > 0
            ? Number(((campaignFallback.conversions / campaignFallback.clicks) * 100).toFixed(2))
            : 0,
        valuePerConversion:
          campaignFallback.conversions > 0
            ? Number((campaignFallback.revenue / campaignFallback.conversions).toFixed(2))
            : null,
        costPerConversion:
          campaignFallback.conversions > 0
            ? Number((campaignFallback.spend / campaignFallback.conversions).toFixed(2))
            : null,
        videoViews: 0,
        videoViewRate: null,
        engagements: 0,
        engagementRate: null,
      }
    : customerSummaryKpis;
  const previousKpis = previousQueries
    ? aggregateOverviewKpis(previousQueries[0].rows)
    : undefined;
  const accountAvgRoas = Number(kpis.roas ?? 0);
  const accountAvgCpa = Number(kpis.cpa ?? 0);
  const previousCampaignMap = new Map(
    previousQueries
      ? buildCampaignMap(previousQueries[1].rows, previousQueries[2].rows, []).map(
          (campaign) => [String(campaign.id), campaign]
        )
      : []
  );

  const enrichedCampaigns = campaigns.map((campaign) => ({
    ...campaign,
    ...buildTrendMetrics(
      {
        spend: Number(campaign.spend ?? 0),
        revenue: Number(campaign.revenue ?? 0),
        conversions: Number(campaign.conversions ?? 0),
        roas: Number(campaign.roas ?? 0),
        ctr: Number(campaign.ctr ?? 0),
      },
      previousQueries
        ? {
            spend: Number(previousCampaignMap.get(String(campaign.id))?.spend ?? 0),
            revenue: Number(previousCampaignMap.get(String(campaign.id))?.revenue ?? 0),
            conversions: Number(
              previousCampaignMap.get(String(campaign.id))?.conversions ?? 0
            ),
            roas: Number(previousCampaignMap.get(String(campaign.id))?.roas ?? 0),
            ctr: Number(previousCampaignMap.get(String(campaign.id))?.ctr ?? 0),
          }
        : undefined
    ),
    badges: getCampaignBadges(
      {
        id: String(campaign.id),
        name: String(campaign.name),
        status: String(campaign.status ?? "paused"),
        channel: String(campaign.channel ?? "Unknown"),
        spend: Number(campaign.spend ?? 0),
        conversions: Number(campaign.conversions ?? 0),
        revenue: Number(campaign.revenue ?? 0),
        roas: Number(campaign.roas ?? 0),
        cpa: Number(campaign.cpa ?? 0),
        ctr: Number(campaign.ctr ?? 0),
        impressions: Number(campaign.impressions ?? 0),
        clicks: Number(campaign.clicks ?? 0),
        impressionShare:
          typeof campaign.impressionShare === "number"
            ? campaign.impressionShare
            : undefined,
        lostIsBudget:
          typeof campaign.lostIsBudget === "number" ? campaign.lostIsBudget : undefined,
        lostIsRank:
          typeof campaign.lostIsRank === "number" ? campaign.lostIsRank : undefined,
      },
      accountAvgRoas,
      accountAvgCpa
    ),
  }));

  addDebugMeta(meta, "overview", context, {
    date_range: { startDate, endDate },
    comparison_window: comparisonWindow,
  });
  finalizeMeta(meta);

  logRuntimeDebug("google-ads-reporting", "overview_summary", {
    businessId: params.businessId,
    customerIds: context.customerIds,
    kpis,
    topCampaignCount: enrichedCampaigns.length,
    queryFailures: meta.failed_queries.length,
    warnings: meta.warnings.length,
    rowCounts: meta.row_counts,
  });

  return {
    kpis,
    kpiDeltas: {
      spend: previousKpis
        ? pctDelta(Number(kpis.spend ?? 0), Number(previousKpis.spend ?? 0))
        : undefined,
      revenue: previousKpis
        ? pctDelta(Number(kpis.revenue ?? 0), Number(previousKpis.revenue ?? 0))
        : undefined,
      roas: previousKpis
        ? pctDelta(Number(kpis.roas ?? 0), Number(previousKpis.roas ?? 0))
        : undefined,
      conversions: previousKpis
        ? pctDelta(
            Number(kpis.conversions ?? 0),
            Number(previousKpis.conversions ?? 0)
          )
        : undefined,
      cpa: previousKpis
        ? pctDelta(Number(kpis.cpa ?? 0), Number(previousKpis.cpa ?? 0))
        : undefined,
    },
    topCampaigns: enrichedCampaigns.slice(0, 5),
    insights: generateOverviewInsights({
      campaigns: enrichedCampaigns,
      totalSpend: Number(kpis.spend ?? 0),
      totalConversions: Number(kpis.conversions ?? 0),
      totalRevenue: Number(kpis.revenue ?? 0),
      roas: Number(kpis.roas ?? 0),
      cpa: Number(kpis.cpa ?? 0),
    }),
    summary: {
      topCampaignCount: enrichedCampaigns.length,
      resource: GOOGLE_ADS_METRICS_MATRIX.overview.primaryResource,
      usedCoreFallback: !hasCustomerSummaryData && hasCampaignFallbackData,
      overviewDataSource: hasCustomerSummaryData
        ? "customer_summary"
        : hasCampaignFallbackData
        ? "campaign_core_basic_fallback"
        : "empty",
    },
    meta,
  };
}

export async function getGoogleAdsCampaignsReport(
  params: ComparativeReportParams
): Promise<ReportResult<CampaignPerformanceRow & Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_campaigns_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const comparisonWindow = getComparisonWindow({
    compareMode: params.compareMode,
    startDate,
    endDate,
    compareStart: params.compareStart,
    compareEnd: params.compareEnd,
  });
  const [campaignCoreBasic, campaignShare, campaignBudget] = await Promise.all([
    runNamedQuery(context, buildCampaignCoreBasicQuery(startDate, endDate)),
    runNamedQuery(context, buildCampaignShareQuery(startDate, endDate)),
    runNamedQuery(context, buildCampaignBudgetQuery(startDate, endDate)),
  ]);
  const previousQueries = comparisonWindow
    ? await Promise.all([
        runNamedQuery(
          context,
          buildCampaignCoreBasicQuery(comparisonWindow.startDate, comparisonWindow.endDate)
        ),
        runNamedQuery(
          context,
          buildCampaignShareQuery(comparisonWindow.startDate, comparisonWindow.endDate)
        ),
      ])
    : null;

  mergeFailures(meta, campaignCoreBasic);
  mergeFailures(meta, campaignShare);
  mergeFailures(meta, campaignBudget);
  if (previousQueries) {
    mergeFailures(meta, previousQueries[0]);
    mergeFailures(meta, previousQueries[1]);
  }

  const campaigns = buildCampaignMap(
    campaignCoreBasic.rows,
    campaignShare.rows,
    campaignBudget.rows
  );

  const totalSpend = campaigns.reduce((sum, row) => sum + Number(row.spend ?? 0), 0);
  const totalRevenue = campaigns.reduce((sum, row) => sum + Number(row.revenue ?? 0), 0);
  const totalConversions = campaigns.reduce(
    (sum, row) => sum + Number(row.conversions ?? 0),
    0
  );
  const accountAvgRoas = totalSpend > 0 ? Number((totalRevenue / totalSpend).toFixed(2)) : 0;
  const accountAvgCpa =
    totalConversions > 0 ? Number((totalSpend / totalConversions).toFixed(2)) : 0;
  const previousCampaignMap = new Map(
    previousQueries
      ? buildCampaignMap(previousQueries[0].rows, previousQueries[1].rows, []).map(
          (campaign) => [String(campaign.id), campaign]
        )
      : []
  );

  const rows = campaigns.map((campaign) => {
    const spend = Number(campaign.spend ?? 0);
    const revenue = Number(campaign.revenue ?? 0);
    const conversions = Number(campaign.conversions ?? 0);
    const roas = Number(campaign.roas ?? 0);
    const ctr = Number(campaign.ctr ?? 0);
    const previous = previousCampaignMap.get(String(campaign.id));
    const spendShare = totalSpend > 0 ? Number(((spend / totalSpend) * 100).toFixed(1)) : 0;
    const revenueShare =
      totalRevenue > 0 ? Number(((revenue / totalRevenue) * 100).toFixed(1)) : 0;

    let actionState: "scale" | "optimize" | "test" | "reduce" = "optimize";
    if (roas >= accountAvgRoas * 1.15 && getNumericShare(campaign.lostIsBudget) > 0.1) {
      actionState = "scale";
    } else if (spend > Math.max(100, totalSpend * 0.08) && roas < accountAvgRoas * 0.7) {
      actionState = "reduce";
    } else if (conversions === 0 && spend > 0) {
      actionState = "test";
    }

    const performanceLabel =
      roas >= accountAvgRoas * 1.25
        ? "leader"
        : roas >= accountAvgRoas * 0.9
        ? "stable"
        : roas > 0
        ? "watch"
        : "at-risk";

    return {
      ...campaign,
      campaignId: String(campaign.id),
      campaignName: String(campaign.name),
      spendShare,
      revenueShare,
      roasDeltaVsAccount: Number((roas - accountAvgRoas).toFixed(2)),
      scaleState: actionState === "scale" ? "scale" : "monitor",
      wasteState: actionState === "reduce" ? "waste" : "healthy",
      performanceLabel,
      actionState,
      ...buildTrendMetrics(
        {
          spend,
          revenue,
          conversions,
          roas,
          ctr,
        },
        previous
          ? {
              spend: Number(previous.spend ?? 0),
              revenue: Number(previous.revenue ?? 0),
              conversions: Number(previous.conversions ?? 0),
              roas: Number(previous.roas ?? 0),
              ctr: Number(previous.ctr ?? 0),
            }
          : undefined
      ),
      badges: getCampaignBadges(
        {
          id: String(campaign.id),
          name: String(campaign.name),
          status: String(campaign.status ?? "paused"),
          channel: String(campaign.channel ?? "Unknown"),
          spend,
          conversions,
          revenue,
          roas,
          cpa: Number(campaign.cpa ?? 0),
          ctr,
          impressions: Number(campaign.impressions ?? 0),
          clicks: Number(campaign.clicks ?? 0),
          impressionShare:
            typeof campaign.impressionShare === "number"
              ? campaign.impressionShare
              : undefined,
          lostIsBudget:
            typeof campaign.lostIsBudget === "number" ? campaign.lostIsBudget : undefined,
          lostIsRank:
            typeof campaign.lostIsRank === "number" ? campaign.lostIsRank : undefined,
          budget:
            typeof campaign.dailyBudget === "number" ? campaign.dailyBudget : undefined,
        },
        accountAvgRoas,
        accountAvgCpa
      ),
    };
  });
  addDebugMeta(meta, "campaigns", context, {
    date_range: { startDate, endDate },
    comparison_window: comparisonWindow,
  });
  finalizeMeta(meta);

  return {
    rows: rows as unknown as Array<CampaignPerformanceRow & Record<string, unknown>>,
    summary: {
      accountAvgRoas,
      accountAvgCpa,
      rowCount: rows.length,
    },
    meta,
  };
}

export async function getGoogleAdsSearchTermsReport(params: BaseReportParams & {
  filter?: string;
}): Promise<ReportResult<SearchTermPerformanceRow & Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_search_terms_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const [core, lookup] = await Promise.all([
    runNamedQuery(context, buildSearchTermCoreQuery(startDate, endDate)),
    runNamedQuery(context, buildKeywordLookupQuery()),
  ]);

  mergeFailures(meta, core);
  mergeFailures(meta, lookup);

  const keywordSet = new Set(
    lookup.rows
      .map((row) => {
        const criterion = getCompatObject(row, "ad_group_criterion");
        const keyword = getCompatObject(criterion, "keyword");
        return (asString(getCompatValue(keyword, "text")) ?? "").toLowerCase();
      })
      .filter(Boolean)
  );

  const filter = (params.filter ?? "").trim().toLowerCase();
  const rows = core.rows
    .map((row) => {
      const metrics = getCompatObject(row, "metrics");
      const campaign = getCompatObject(row, "campaign");
      const adGroup = getCompatObject(row, "ad_group");
      const searchTermView = getCompatObject(row, "search_term_view");
      const searchTerm = asString(getCompatValue(searchTermView, "search_term")) ?? "";
      const data = toMetricSet(metrics);
      return {
        key: `${asString(getCompatValue(campaign, "id")) ?? "campaign"}:${asString(getCompatValue(adGroup, "id")) ?? "adgroup"}:${searchTerm}`,
        searchTerm,
        status: asString(getCompatValue(searchTermView, "status")) ?? "UNKNOWN",
        campaignId: asString(getCompatValue(campaign, "id")),
        campaign: asString(getCompatValue(campaign, "name")) ?? "",
        campaignName: asString(getCompatValue(campaign, "name")) ?? "",
        adGroupId: asString(getCompatValue(adGroup, "id")),
        adGroup: asString(getCompatValue(adGroup, "name")) ?? "",
        adGroupName: asString(getCompatValue(adGroup, "name")) ?? "",
        impressions: data.impressions,
        clicks: data.clicks,
        spend: data.spend,
        conversions: data.conversions,
        revenue: data.conversionValue,
        roas: data.roas,
        cpa: data.cpa,
        ctr: data.ctr ?? 0,
        cpc: data.averageCpc,
        conversionRate: data.conversionRate,
        valuePerConversion: data.valuePerConversion,
        costPerConversion: data.costPerConversion,
        intent: classifySearchIntent(searchTerm),
        intentClass: classifySearchIntent(searchTerm),
        isKeyword: keywordSet.has(searchTerm.toLowerCase()),
        wasteFlag: data.spend > 20 && data.conversions === 0,
        keywordOpportunityFlag:
          !keywordSet.has(searchTerm.toLowerCase()) && data.conversions >= 2,
        negativeKeywordFlag: data.clicks >= 20 && data.conversions === 0 && data.spend > 10,
        clusterId: slugifyQueryCluster(searchTerm) || searchTerm.toLowerCase(),
      };
    })
    .filter((row) => row.searchTerm.length > 0)
    .filter((row) => !filter || row.searchTerm.toLowerCase().includes(filter));

  const classified = classifySearchTerms(rows as never);
  addDebugMeta(meta, "search-terms", context, {
    date_range: { startDate, endDate },
  });
  finalizeMeta(meta);

  return {
    rows: rows as unknown as Array<SearchTermPerformanceRow & Record<string, unknown>>,
    summary: {
      wastefulCount: classified.wasteful.length,
      negativeKeywordCandidates: classified.negativeKeywordCandidates.length,
      highPerformingCount: classified.highPerforming.length,
      keywordOpportunities: classified.keywordOpportunities.length,
      wastefulSpend: Number(
        classified.wasteful.reduce((sum, term) => sum + term.spend, 0).toFixed(2)
      ),
    },
    meta,
  };
}

function normalizeMatchType(raw: string | null): string {
  if (!raw) return "Unknown";
  const lower = raw.toLowerCase();
  if (lower.includes("exact")) return "Exact";
  if (lower.includes("phrase")) return "Phrase";
  if (lower.includes("broad")) return "Broad";
  return raw;
}

export async function getGoogleAdsKeywordsReport(
  params: BaseReportParams
): Promise<ReportResult<KeywordPerformanceRow & Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_keywords_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const [core, quality] = await Promise.all([
    runNamedQuery(context, buildKeywordCoreQuery(startDate, endDate)),
    runNamedQuery(context, buildKeywordQualityQuery(startDate, endDate)),
  ]);

  mergeFailures(meta, core);
  mergeFailures(meta, quality);
  const qualityAvailable = quality.failures.length === 0;

  const qualityMap = new Map<string, Record<string, unknown>>();
  for (const row of qualityAvailable ? quality.rows : []) {
    const criterion = getCompatObject(row, "ad_group_criterion");
    const id = asString(getCompatValue(criterion, "criterion_id"));
    if (!id) continue;
    qualityMap.set(id, criterion);
  }

  const rows = core.rows
    .map((row) => {
      const criterion = getCompatObject(row, "ad_group_criterion");
      const campaign = getCompatObject(row, "campaign");
      const adGroup = getCompatObject(row, "ad_group");
      const metrics = getCompatObject(row, "metrics");
      const keyword = getCompatObject(criterion, "keyword");
      const qualityInfo = qualityAvailable
        ? getCompatObject(
            qualityMap.get(asString(getCompatValue(criterion, "criterion_id")) ?? "") ?? {},
            "quality_info"
          )
        : {};
      const data = toMetricSet(metrics);
      return {
        criterionId: asString(getCompatValue(criterion, "criterion_id")),
        keyword: asString(getCompatValue(keyword, "text")) ?? "",
        keywordText: asString(getCompatValue(keyword, "text")) ?? "",
        matchType: normalizeMatchType(
          asString(getCompatValue(keyword, "match_type"))
        ),
        status: normalizeStatus(asString(getCompatValue(criterion, "status")) ?? undefined),
        qualityScore: asNumber(getCompatValue(qualityInfo, "quality_score")),
        expectedCtr: asString(getCompatValue(qualityInfo, "expected_click_through_rate")),
        adRelevance: asString(getCompatValue(qualityInfo, "ad_relevance")),
        landingPageExperience: asString(getCompatValue(qualityInfo, "landing_page_experience")),
        adGroupId: asString(getCompatValue(adGroup, "id")),
        adGroup: asString(getCompatValue(adGroup, "name")) ?? "",
        adGroupName: asString(getCompatValue(adGroup, "name")) ?? "",
        campaignId: asString(getCompatValue(campaign, "id")),
        campaign: asString(getCompatValue(campaign, "name")) ?? "",
        campaignName: asString(getCompatValue(campaign, "name")) ?? "",
        impressions: data.impressions,
        clicks: data.clicks,
        spend: data.spend,
        conversions: data.conversions,
        revenue: data.conversionValue,
        roas: data.roas,
        cpa: data.cpa,
        ctr: data.ctr ?? 0,
        cpc: data.averageCpc,
        conversionRate: data.conversionRate,
        valuePerConversion: data.valuePerConversion,
        costPerConversion: data.costPerConversion,
        impressionShare: asRatio(getCompatValue(metrics, "search_impression_share")),
        searchTopImpressionShare: asRatio(getCompatValue(metrics, "search_top_impression_share")),
        searchAbsoluteTopImpressionShare: asRatio(
          getCompatValue(metrics, "search_absolute_top_impression_share")
        ),
      };
    })
    .filter((row) => row.keyword.length > 0);

  addDebugMeta(meta, "keywords", context, {
    date_range: { startDate, endDate },
  });

  const keywordAnalysis = analyzeKeywords(rows);
  const typedRows = keywordAnalysis.rows.map((row) => ({
    ...row,
    keywordState: String(row.classification ?? "weak_keyword") === "scale_keyword"
      ? "scale"
      : String(row.classification ?? "weak_keyword") === "negative_candidate"
      ? "negative_candidate"
      : "weak",
    scaleFlag: String(row.classification ?? "") === "scale_keyword",
    negativeCandidateFlag: String(row.classification ?? "") === "negative_candidate",
  }));
  finalizeMeta(meta);

  return {
    rows: typedRows as unknown as Array<KeywordPerformanceRow & Record<string, unknown>>,
    summary: {
      scaleKeywordCount: keywordAnalysis.summary.scaleKeywordCount,
      weakKeywordCount: keywordAnalysis.summary.weakKeywordCount,
      negativeCandidateCount: keywordAnalysis.summary.negativeCandidateCount,
      accountAverageRoas: keywordAnalysis.summary.accountAverageRoas,
      // Shared with the warehouse serving path so the Search screen's keyword
      // tallies cannot differ by which reader served the window.
      ...countGoogleAdsKeywordInsights(rows),
    },
    insights: keywordAnalysis.insights,
    meta,
  };
}

export function classifySearchAction(row: {
  searchTerm: string;
  campaign: string;
  isKeyword: boolean;
  conversions: number;
  spend: number;
  clicks: number;
  roas: number;
  conversionRate: number | null;
}, brandTerms: string[] = [], productTerms: string[] = [], ownershipContext?: QueryOwnershipContext) {
  const context =
    ownershipContext ??
    buildQueryOwnershipContextFromTerms({
      brandTerms,
      productTerms,
    });
  const ownership = classifyQueryOwnership(row.searchTerm, context);
  const negativeKeywordAssessment = evaluateNegativeKeywordAssessment({
    searchTerm: row.searchTerm,
    ownershipClass: ownership.ownershipClass,
    ownershipConfidence: ownership.ownershipConfidence,
    ownershipNeedsReview: ownership.ownershipNeedsReview,
    intentClass: ownership.intentClass,
    intentConfidence: ownership.intentConfidence,
    intentNeedsReview: ownership.intentNeedsReview,
    clicks: row.clicks,
    spend: row.spend,
    isWasteLike: row.conversions === 0 && row.clicks >= 20 && row.spend >= 20,
    requiredMatchType: "exact",
  });
  if (!row.isKeyword && row.conversions >= 2) return "Add as exact keyword";
  if (negativeKeywordAssessment.eligible) {
    return "Add as negative keyword";
  }
  if (row.roas >= 3 && row.conversions >= 2) return "Promote in headlines";
  if ((row.conversionRate ?? 0) < 1 && row.clicks >= 20) return "Review landing page";
  return "Monitor";
}

function deriveBrandTermsFromSearchRows(rows: Array<{ campaignName: string }>) {
  return Array.from(
    new Set(
      rows
        .filter((row) => row.campaignName.toLowerCase().includes("brand"))
        .flatMap((row) =>
          row.campaignName
            .toLowerCase()
            .replace(/[^a-z0-9\s-]+/g, " ")
            .split(/\s+/)
            .filter((token) => token.length >= 4 && token !== "brand" && token !== "search")
        )
    )
  );
}

function classifyClusterState(cluster: {
  spend: number;
  conversions: number;
  roas: number;
}) {
  if (cluster.spend >= 100 && cluster.conversions === 0) return "Waste";
  if (cluster.conversions >= 5 && cluster.roas >= 3) return "Top driver";
  if (cluster.conversions >= 2 || cluster.roas >= 1.5) return "Promising";
  return "Neutral";
}

function buildSearchClusters(
  rows: Array<{
    searchTerm: string;
    campaign: string;
    intent: string;
    spend: number;
    clicks: number;
    conversions: number;
    revenue: number;
    roas: number;
    isKeyword: boolean;
  }>
) {
  const clusters = new Map<
    string,
    {
      key: string;
      label: string;
      intent: string;
      campaigns: Set<string>;
      examples: string[];
      spend: number;
      clicks: number;
      conversions: number;
      revenue: number;
      keywordBackedCount: number;
    }
  >();

  for (const row of rows) {
    const key = slugifyQueryCluster(row.searchTerm) || row.searchTerm.toLowerCase();
    const current = clusters.get(key) ?? {
      key,
      label: key || row.searchTerm,
      intent: row.intent,
      campaigns: new Set<string>(),
      examples: [],
      spend: 0,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      keywordBackedCount: 0,
    };
    current.campaigns.add(row.campaign);
    if (current.examples.length < 3 && !current.examples.includes(row.searchTerm)) {
      current.examples.push(row.searchTerm);
    }
    current.spend += row.spend;
    current.clicks += row.clicks;
    current.conversions += row.conversions;
    current.revenue += row.revenue;
    current.keywordBackedCount += row.isKeyword ? 1 : 0;
    clusters.set(key, current);
  }

  return Array.from(clusters.values())
    .map((cluster) => {
      const roas = cluster.spend > 0 ? Number((cluster.revenue / cluster.spend).toFixed(2)) : 0;
      return {
        cluster: cluster.label,
        intent: cluster.intent,
        campaigns: Array.from(cluster.campaigns),
        spend: Number(cluster.spend.toFixed(2)),
        clicks: cluster.clicks,
        conversions: Number(cluster.conversions.toFixed(2)),
        revenue: Number(cluster.revenue.toFixed(2)),
        roas,
        coverage: cluster.keywordBackedCount > 0 ? "covered" : "open",
        examples: cluster.examples,
        state: classifyClusterState({
          spend: cluster.spend,
          conversions: cluster.conversions,
          roas,
        }),
        recommendation:
          cluster.conversions >= 3 && cluster.keywordBackedCount === 0
            ? "Build exact-match coverage"
            : cluster.spend >= 100 && cluster.conversions === 0
            ? "Add negatives or tighten intent"
            : roas >= 3
            ? "Reflect this language in assets"
            : "Keep watching",
      };
    })
    .sort((a, b) => b.spend - a.spend);
}

export async function getGoogleAdsSearchIntelligenceReport(params: BaseReportParams & {
  filter?: string;
  executionMode?: "default" | "warehouse_sync";
}): Promise<ReportResult<SearchTermPerformanceRow & Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_search_intelligence_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const warehouseSyncMode = params.executionMode === "warehouse_sync";
  const [core, lookup, campaignSearchTerms] = warehouseSyncMode
    ? await Promise.all([
        runNamedQuery(context, buildSearchTermCoreQuery(startDate, endDate, 5000)),
        Promise.resolve({
          rows: [],
          failures: [],
          query: buildKeywordLookupQuery(),
        }),
        Promise.resolve({
          rows: [],
          failures: [],
          query: buildCampaignSearchTermCoreQuery(startDate, endDate, 5000),
        }),
      ])
    : await Promise.all([
        runNamedQuery(context, buildSearchTermCoreQuery(startDate, endDate)),
        runNamedQuery(context, buildKeywordLookupQuery()),
        runNamedQuery(context, buildCampaignSearchTermCoreQuery(startDate, endDate)),
      ]);

  mergeFailures(meta, core);
  mergeFailures(meta, lookup);
  mergeFailures(meta, campaignSearchTerms);

  const keywordSet = new Set(
    lookup.rows
      .map((row) => {
        const criterion = getCompatObject(row, "ad_group_criterion");
        const keyword = getCompatObject(criterion, "keyword");
        return (asString(getCompatValue(keyword, "text")) ?? "").toLowerCase();
      })
      .filter(Boolean)
  );

  const filter = (params.filter ?? "").trim().toLowerCase();
  const baseRows = core.rows.map((row) => {
    const metrics = getCompatObject(row, "metrics");
    const campaign = getCompatObject(row, "campaign");
    const adGroup = getCompatObject(row, "ad_group");
    const searchTermView = getCompatObject(row, "search_term_view");
    const searchTerm = asString(getCompatValue(searchTermView, "search_term")) ?? "";
    const data = toMetricSet(metrics);
    return {
      key: `${asString(getCompatValue(campaign, "id")) ?? "campaign"}:${searchTerm}`,
      searchTerm,
      campaignId: asString(getCompatValue(campaign, "id")),
      campaign: asString(getCompatValue(campaign, "name")) ?? "",
      campaignName: asString(getCompatValue(campaign, "name")) ?? "",
      adGroupId: asString(getCompatValue(adGroup, "id")),
      adGroup: asString(getCompatValue(adGroup, "name")) ?? "",
      adGroupName: asString(getCompatValue(adGroup, "name")) ?? "",
      matchSource: "SEARCH",
      source: "search_term_view",
      impressions: data.impressions,
      clicks: data.clicks,
      spend: data.spend,
      conversions: data.conversions,
      revenue: data.conversionValue,
      roas: data.roas,
      cpa: data.cpa,
      ctr: data.ctr ?? 0,
      cpc: data.averageCpc,
      conversionRate: data.conversionRate,
      intent: classifySearchIntent(searchTerm),
      intentClass: classifySearchIntent(searchTerm),
      isKeyword: keywordSet.has(searchTerm.toLowerCase()),
      wasteFlag: data.spend > 20 && data.conversions === 0,
      keywordOpportunityFlag:
        !keywordSet.has(searchTerm.toLowerCase()) && data.conversions >= 2,
      negativeKeywordFlag: data.clicks >= 20 && data.conversions === 0 && data.spend > 10,
      clusterId: slugifyQueryCluster(searchTerm) || searchTerm.toLowerCase(),
    };
  });

  const campaignScopeRows = campaignSearchTerms.rows.map((row) => {
    const metrics = getCompatObject(row, "metrics");
    const campaign = getCompatObject(row, "campaign");
    const view = getCompatObject(row, "campaign_search_term_view");
    const segments = getCompatObject(row, "segments");
    const searchTerm = asString(getCompatValue(view, "search_term")) ?? "";
    const data = toMetricSet(metrics);
    return {
      key: `${asString(getCompatValue(campaign, "id")) ?? "campaign"}:${searchTerm}:campaign_scope`,
      searchTerm,
      campaignId: asString(getCompatValue(campaign, "id")),
      campaign: asString(getCompatValue(campaign, "name")) ?? "",
      campaignName: asString(getCompatValue(campaign, "name")) ?? "",
      adGroupId: null,
      adGroup: "Campaign scope",
      adGroupName: "Campaign scope",
      matchSource: asString(getCompatValue(segments, "search_term_match_source")) ?? "UNKNOWN",
      source: "campaign_search_term_view",
      impressions: data.impressions,
      clicks: data.clicks,
      spend: data.spend,
      conversions: data.conversions,
      revenue: data.conversionValue,
      roas: data.roas,
      cpa: data.cpa,
      ctr: data.ctr ?? 0,
      cpc: data.averageCpc,
      conversionRate: data.conversionRate,
      intent: classifySearchIntent(searchTerm),
      intentClass: classifySearchIntent(searchTerm),
      isKeyword: keywordSet.has(searchTerm.toLowerCase()),
      wasteFlag: data.spend > 20 && data.conversions === 0,
      keywordOpportunityFlag:
        !keywordSet.has(searchTerm.toLowerCase()) && data.conversions >= 2,
      negativeKeywordFlag: data.clicks >= 20 && data.conversions === 0 && data.spend > 10,
      clusterId: slugifyQueryCluster(searchTerm) || searchTerm.toLowerCase(),
    };
  });

  const allRows = [...baseRows, ...campaignScopeRows]
    .filter((row) => row.searchTerm.length > 0)
    .filter((row) => !filter || row.searchTerm.toLowerCase().includes(filter));
  const brandTerms = deriveBrandTermsFromSearchRows(allRows);
  const rows = allRows
    .map((row) => ({
      ...row,
      clusterKey: slugifyQueryCluster(row.searchTerm),
      recommendation: classifySearchAction(row, brandTerms),
      classification:
        row.spend > 20 && row.conversions === 0
          ? "waste"
          : !row.isKeyword && row.conversions >= 2
          ? "keyword_opportunity"
          : row.roas >= 3
          ? "top_driver"
          : "monitor",
    }))
    .sort((a, b) => b.spend - a.spend);

  const clusters = buildSearchClusters(rows);
  const searchAnalysis = analyzeSearchIntelligence(rows);
  const keywordCandidates = rows.filter(
    (row) => row.recommendation === "Add as exact keyword"
  );
  const negativeCandidates = rows.filter(
    (row) => row.recommendation === "Add as negative keyword"
  );
  const promotionCandidates = rows.filter(
    (row) => row.recommendation === "Promote in headlines"
  );

  if (campaignSearchTerms.rows.length > 0) {
    meta.warnings.push(
      "Campaign-scope search terms are included where available to broaden Search Intelligence beyond standard search_term_view coverage."
    );
  }

  addDebugMeta(meta, "search-intelligence", context, {
    date_range: { startDate, endDate },
    execution_mode: warehouseSyncMode ? "warehouse_sync" : "default",
  });
  finalizeMeta(meta);

  return {
    rows: rows as unknown as Array<SearchTermPerformanceRow & Record<string, unknown>>,
    summary: {
      wastefulSpend: Number(
        negativeCandidates.reduce((sum, row) => sum + row.spend, 0).toFixed(2)
      ),
      keywordOpportunityCount: keywordCandidates.length,
      negativeKeywordCount: negativeCandidates.length,
      promotionSuggestionCount: promotionCandidates.length,
      clusterCount: clusters.length,
      bestConvertingThemeCount: searchAnalysis.summary.bestConvertingThemeCount,
      wastefulThemeCount: searchAnalysis.summary.wastefulThemeCount,
      emergingThemeCount: searchAnalysis.summary.emergingThemeCount,
    },
    insights: {
      keywordCandidates: keywordCandidates.slice(0, 8),
      negativeCandidates: negativeCandidates.slice(0, 8),
      promotionCandidates: promotionCandidates.slice(0, 8),
      clusters: clusters.slice(0, 12),
      bestConvertingThemes: searchAnalysis.insights.bestConvertingThemes,
      wastefulThemes: searchAnalysis.insights.wastefulThemes,
      newOpportunityQueries: searchAnalysis.insights.newOpportunityQueries,
      semanticClusters: searchAnalysis.insights.semanticClusters,
    },
    meta,
  };
}

function buildAdHeadline(ad: Record<string, unknown>): string {
  const rsa = getCompatObject(ad, "responsive_search_ad");
  const headlinesValue = getCompatValue(rsa, "headlines");
  const headlines = Array.isArray(headlinesValue) ? headlinesValue : [];
  const expanded = getCompatObject(ad, "expanded_text_ad");
  if (headlines.length > 0) {
    return headlines
      .slice(0, 3)
        .map((item) => asString(getCompatValue(item as Record<string, unknown>, "text")) ?? "")
      .filter(Boolean)
      .join(" | ");
  }
  return (
    asString(getCompatValue(ad, "name")) ??
    asString(getCompatValue(expanded, "headline_part1")) ??
    asString(getCompatValue(expanded, "headline_part2")) ??
    "Ad"
  );
}

function buildAdDescription(ad: Record<string, unknown>): string {
  const rsa = getCompatObject(ad, "responsive_search_ad");
  const descriptionsValue = getCompatValue(rsa, "descriptions");
  const descriptions = Array.isArray(descriptionsValue) ? descriptionsValue : [];
  const expanded = getCompatObject(ad, "expanded_text_ad");
  if (descriptions.length > 0) {
    return asString(getCompatValue(descriptions[0] as Record<string, unknown>, "text")) ?? "";
  }
  return asString(getCompatValue(expanded, "description")) ?? "";
}

function normalizeAdStrength(value: string | null): string | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  if (upper.includes("EXCELLENT") || upper.includes("BEST")) return "Best";
  if (upper.includes("GOOD")) return "Good";
  if (upper.includes("AVERAGE") || upper.includes("LEARNING") || upper.includes("PENDING")) {
    return "Learning";
  }
  if (upper.includes("POOR") || upper.includes("LOW")) return "Low";
  return value;
}

export async function getGoogleAdsAdsReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_ads_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const [core, detail] = await Promise.all([
    runNamedQuery(context, buildAdCoreQuery(startDate, endDate)),
    runNamedQuery(context, buildAdDetailQuery(startDate, endDate)),
  ]);
  mergeFailures(meta, core);
  mergeFailures(meta, detail);

  const detailMap = new Map<string, RawRow>();
  for (const row of detail.rows) {
    const adGroupAd = getCompatObject(row, "ad_group_ad");
    const ad = getCompatObject(adGroupAd, "ad");
    const id = asString(getCompatValue(ad, "id"));
    if (id) detailMap.set(id, row);
  }

  const rows = core.rows
    .map((row) => {
      const adGroupAd = getCompatObject(row, "ad_group_ad");
      const ad = getCompatObject(adGroupAd, "ad");
      const campaign = getCompatObject(row, "campaign");
      const adGroup = getCompatObject(row, "ad_group");
      const metrics = getCompatObject(row, "metrics");
      const detailRow = detailMap.get(asString(getCompatValue(ad, "id")) ?? "");
      const detailRoot = detailRow ? getCompatObject(detailRow, "ad_group_ad") : adGroupAd;
      const detailAd = getCompatObject(detailRoot, "ad");
      const data = toMetricSet(metrics);
      return {
        id: asString(getCompatValue(ad, "id")) ?? "unknown",
        headline: buildAdHeadline(detailAd),
        description: buildAdDescription(detailAd),
        type: asString(getCompatValue(ad, "type")) ?? "unknown",
        adStrength: normalizeAdStrength(asString(getCompatValue(detailRoot, "ad_strength"))),
        status: normalizeStatus(asString(getCompatValue(adGroupAd, "status")) ?? undefined),
        campaignId: asString(getCompatValue(campaign, "id")),
        campaign: asString(getCompatValue(campaign, "name")) ?? "",
        adGroupId: asString(getCompatValue(adGroup, "id")),
        adGroup: asString(getCompatValue(adGroup, "name")) ?? "",
        impressions: data.impressions,
        clicks: data.clicks,
        spend: data.spend,
        conversions: data.conversions,
        revenue: data.conversionValue,
        roas: data.roas,
        cpa: data.cpa,
        ctr: data.ctr ?? 0,
        cpc: data.averageCpc,
        conversionRate: data.conversionRate,
        valuePerConversion: data.valuePerConversion,
        costPerConversion: data.costPerConversion,
      };
    })
    .filter((row) => row.id !== "unknown");

  const sorted = [...rows].sort((a, b) => b.conversions - a.conversions);
  const topQuartile = sorted.slice(0, Math.max(1, Math.ceil(rows.length * 0.25)));
  const bottomQuartile = sorted.slice(Math.floor(rows.length * 0.75));

  addDebugMeta(meta, "ads", context, {
    date_range: { startDate, endDate },
  });
  finalizeMeta(meta);

  return {
    rows,
    summary: {
      topPerformerCtr:
        topQuartile.length > 0
          ? Number(
              (
                topQuartile.reduce((sum, row) => sum + row.ctr, 0) / topQuartile.length
              ).toFixed(2)
            )
          : 0,
      bottomPerformerCtr:
        bottomQuartile.length > 0
          ? Number(
              (
                bottomQuartile.reduce((sum, row) => sum + row.ctr, 0) /
                bottomQuartile.length
              ).toFixed(2)
            )
          : 0,
      bestAd: topQuartile[0] ?? null,
      worstAd: bottomQuartile[bottomQuartile.length - 1] ?? null,
    },
    meta,
  };
}

function normalizeAssetKind(fieldType: string | null, assetType: string | null) {
  const source = `${fieldType ?? ""} ${assetType ?? ""}`.toLowerCase();
  if (source.includes("headline")) return "Headline";
  if (source.includes("description")) return "Description";
  if (source.includes("image")) return "Image";
  if (source.includes("video")) return "Video";
  if (source.includes("logo")) return "Logo";
  return assetType?.replace(/_/g, " ") ?? "Asset";
}

function buildAssetPreview(params: {
  fieldType: string | null;
  assetType: string | null;
  name: string | null;
  text: string | null;
  videoTitle: string | null;
}) {
  return (
    params.text ??
    params.videoTitle ??
    params.name ??
    `${normalizeAssetKind(params.fieldType, params.assetType)} asset`
  );
}

export async function getGoogleAdsAssetsReport(
  params: BaseReportParams & {
    executionMode?: "default" | "warehouse_sync";
  }
): Promise<ReportResult<AssetPerformanceRow & Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_assets_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const warehouseSyncMode = params.executionMode === "warehouse_sync";
  const core = await runNamedQuery(
    context,
    buildAssetPerformanceCoreQuery(startDate, endDate, warehouseSyncMode ? 5000 : 2000)
  );
  mergeFailures(meta, core);

  const rows = core.rows
    .map((row) => {
      const assetGroup = getCompatObject(row, "asset_group");
      const campaign = getCompatObject(row, "campaign");
      const asset = getCompatObject(row, "asset");
      const assetGroupAsset = getCompatObject(row, "asset_group_asset");
      const metrics = getCompatObject(row, "metrics");
      const data = toMetricSet(metrics);
      const assetId = asString(getCompatValue(asset, "id")) ?? "unknown";
      const fieldType = asString(getCompatValue(assetGroupAsset, "field_type"));
      const assetType = asString(getCompatValue(asset, "type")) ?? null;
      const textAsset = getCompatObject(asset, "text_asset");
      const imageAsset = getCompatObject(asset, "image_asset");
      const fullSize = getCompatObject(imageAsset, "full_size");
      const youtubeAsset = getCompatObject(asset, "youtube_video_asset");
      const assetText = asString(getCompatValue(textAsset, "text"));
      const imageUrl = asString(getCompatValue(fullSize, "url"));
      const videoTitle = asString(getCompatValue(youtubeAsset, "youtube_video_title"));
      const videoId = asString(getCompatValue(youtubeAsset, "youtube_video_id"));
      const preview = buildAssetPreview({
        fieldType,
        assetType,
        name: asString(getCompatValue(asset, "name")),
        text: assetText,
        videoTitle,
      });
      return {
        id: `${asString(getCompatValue(assetGroup, "id")) ?? "group"}:${assetId}`,
        assetId,
        assetGroupId: asString(getCompatValue(assetGroup, "id")),
        assetGroupIdString: asString(getCompatValue(assetGroup, "id")),
        assetGroup: asString(getCompatValue(assetGroup, "name")) ?? "Unknown asset group",
        assetGroupName: asString(getCompatValue(assetGroup, "name")) ?? "Unknown asset group",
        campaignId: asString(getCompatValue(campaign, "id")),
        campaign: asString(getCompatValue(campaign, "name")) ?? "",
        campaignName: asString(getCompatValue(campaign, "name")) ?? "",
        fieldType,
        type: normalizeAssetKind(fieldType, assetType),
        assetType: normalizeAssetKind(fieldType, assetType),
        rawAssetType: assetType,
        name: asString(getCompatValue(asset, "name")),
        assetName: asString(getCompatValue(asset, "name")),
        text: assetText ?? imageUrl ?? videoTitle ?? null,
        assetText: assetText ?? preview,
        imageUrl,
        preview,
        videoId,
        impressions: data.impressions,
        clicks: data.clicks,
        interactions: data.interactions,
        interactionRate: data.interactionRate,
        spend: data.spend,
        cost: data.spend,
        conversions: data.conversions,
        revenue: data.conversionValue,
        roas: data.roas,
        ctr: data.ctr,
        cpc: data.averageCpc,
        cpa: data.cpa,
        conversionRate: data.conversionRate,
        valuePerConversion: data.valuePerConversion,
        performanceLabel: "average" as "top" | "average" | "underperforming",
      };
    })
    .filter((row) => row.assetId !== "unknown");

  const avgCtr =
    rows.length > 0
      ? rows.reduce((sum, row) => sum + Number(row.ctr ?? 0), 0) / rows.length
      : 0;
  const avgRoas =
    rows.length > 0
      ? rows.reduce((sum, row) => sum + Number(row.roas ?? 0), 0) / rows.length
      : 0;
  const avgInteractionRate =
    rows.length > 0
      ? Number(
          (
            rows.reduce((sum, row) => sum + Number(row.interactionRate ?? 0), 0) / rows.length
          ).toFixed(2)
        )
      : 0;
  const avgConversionRate =
    rows.length > 0
      ? Number(
          (
            rows.reduce((sum, row) => sum + Number(row.conversionRate ?? 0), 0) / rows.length
          ).toFixed(2)
        )
      : 0;

  const enrichedRows = rows.map((row) => {
    let performanceLabel: "top" | "average" | "underperforming" = "average";
    if (
      Number(row.conversions ?? 0) > 0 &&
      Number(row.roas ?? 0) >= Math.max(avgRoas * 1.15, 1.5)
    ) {
      performanceLabel = "top";
    } else if (
      (Number(row.spend ?? 0) > 20 && Number(row.conversions ?? 0) === 0) ||
      (Number(row.ctr ?? 0) > 0 && Number(row.ctr ?? 0) < avgCtr * 0.7) ||
      (Number(row.interactionRate ?? 0) > 0 &&
        Number(row.interactionRate ?? 0) < avgInteractionRate * 0.7)
    ) {
      performanceLabel = "underperforming";
    }

    return {
      ...row,
      performanceLabel,
      hint:
        Number(row.spend ?? 0) > 20 && Number(row.conversions ?? 0) === 0
          ? "Spend is accumulating without any conversion value."
          : row.interactions >= 20 && row.conversions === 0
          ? "High interaction but weak post-click conversion."
          : Number(row.interactionRate ?? 0) < avgInteractionRate * 0.7 && row.impressions >= 100
          ? "Engagement is below account average."
          : Number(row.conversionRate ?? 0) < avgConversionRate * 0.7 && row.clicks >= 15
          ? "Message or landing-page fit looks weak after the click."
          : performanceLabel === "top"
          ? "Top-performing asset worth reusing in new variants."
          : "Average performer; keep testing variety around it.",
    };
  });

  addDebugMeta(meta, "assets", context, {
    date_range: { startDate, endDate },
    execution_mode: warehouseSyncMode ? "warehouse_sync" : "default",
  });

  const assetAnalysis = analyzeAssets(enrichedRows);
  const groupTotals = assetAnalysis.rows.reduce((map, row) => {
    const key = String(row.assetGroupId ?? "unknown");
    const current = map.get(key) ?? { spend: 0, revenue: 0 };
    current.spend += Number(row.spend ?? 0);
    current.revenue += Number(row.revenue ?? 0);
    map.set(key, current);
    return map;
  }, new Map<string, { spend: number; revenue: number }>());
  const typedRows: Array<Record<string, unknown>> = assetAnalysis.rows.map((row) => {
    const totals = groupTotals.get(String(row.assetGroupId ?? "unknown")) ?? {
      spend: 0,
      revenue: 0,
    };
    return {
      ...row,
      assetState: row.performanceLabel,
      spendShareWithinGroup:
        totals.spend > 0 ? Number(((Number(row.spend ?? 0) / totals.spend) * 100).toFixed(1)) : 0,
      revenueShareWithinGroup:
        totals.revenue > 0
          ? Number(((Number(row.revenue ?? 0) / totals.revenue) * 100).toFixed(1))
          : 0,
      wasteFlag:
        String(row.classification ?? "") === "budget_waste" ||
        String(row.classification ?? "") === "weak",
      expandFlag: String(row.classification ?? "") === "top_performer",
    };
  });
  finalizeMeta(meta);

  const topPerformingAssets = enrichedRows
    .filter((row) => row.performanceLabel === "top")
    .sort((a, b) => Number(b.revenue ?? 0) - Number(a.revenue ?? 0))
    .slice(0, 6);
  const weakAssets = enrichedRows
    .filter((row) => row.performanceLabel === "underperforming")
    .sort((a, b) => Number(b.spend ?? 0) - Number(a.spend ?? 0))
    .slice(0, 6);
  const spendNoConversionAssets = enrichedRows
    .filter((row) => Number(row.spend ?? 0) > 20 && Number(row.conversions ?? 0) === 0)
    .sort((a, b) => Number(b.spend ?? 0) - Number(a.spend ?? 0))
    .slice(0, 6);

  return {
    rows: typedRows.sort((a, b) => Number(b.spend ?? 0) - Number(a.spend ?? 0)) as unknown as Array<
      AssetPerformanceRow & Record<string, unknown>
    >,
    summary: {
      topPerformingCount: topPerformingAssets.length,
      topPerformerCount: assetAnalysis.summary.topPerformerCount,
      stableCount: assetAnalysis.summary.stableCount,
      weakCount: assetAnalysis.summary.weakCount,
      budgetWasteCount: assetAnalysis.summary.budgetWasteCount,
      accountAverageRoas: assetAnalysis.summary.accountAverageRoas,
      underperformingCount: enrichedRows.filter(
        (row) => row.performanceLabel === "underperforming"
      ).length,
      spendNoConversionCount: spendNoConversionAssets.length,
      lowCtrCount: enrichedRows.filter(
        (row) => Number(row.interactionRate ?? row.ctr ?? 0) < avgInteractionRate * 0.7
      ).length,
      typeBreakdown: Array.from(
        enrichedRows.reduce((map, row) => {
          map.set(row.type, (map.get(row.type) ?? 0) + 1);
          return map;
        }, new Map<string, number>())
      ).map(([type, count]) => ({ type, count })),
    },
    insights: {
      topPerformingAssets,
      topConvertingAssets: assetAnalysis.insights.topConvertingAssets,
      assetsWastingSpend: assetAnalysis.insights.assetsWastingSpend,
      assetsToExpand: assetAnalysis.insights.assetsToExpand,
      weakAssets,
      spendNoConversionAssets,
      bestConvertingHeadlines: enrichedRows
        .filter(
          (row) =>
            String(row.type).toLowerCase() === "headline" && Number(row.conversions ?? 0) > 0
        )
        .sort((a, b) => Number(b.conversions ?? 0) - Number(a.conversions ?? 0))
        .slice(0, 5),
    },
    meta,
  };
}

function normalizeAudienceType(raw: string | null): string {
  if (!raw) return "Unknown";
  const lower = raw.toLowerCase();
  if (lower.includes("user_list") || lower.includes("remarketing")) return "Remarketing";
  if (lower.includes("user_interest") || lower.includes("affinity")) return "Affinity";
  if (lower.includes("in_market")) return "In-Market";
  if (lower.includes("life_event")) return "Life Events";
  if (lower.includes("custom")) return "Custom";
  if (lower.includes("similar")) return "Similar Audiences";
  return raw.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());
}

export async function getGoogleAdsAudiencesReport(
  params: BaseReportParams
): Promise<ReportResult<AudiencePerformanceRow & Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_audiences_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const core = await runNamedQuery(context, buildAudienceCoreQuery(startDate, endDate));
  mergeFailures(meta, core);

  const rows = core.rows.map((row) => {
    const criterion = getCompatObject(row, "ad_group_criterion");
    const campaign = getCompatObject(row, "campaign");
    const adGroup = getCompatObject(row, "ad_group");
    const metrics = getCompatObject(row, "metrics");
    const data = toMetricSet(metrics);
    return {
      criterionId: asString(getCompatValue(criterion, "criterion_id")) ?? "",
      audienceKey: asString(getCompatValue(criterion, "criterion_id")) ?? "",
      name: asString(getCompatValue(criterion, "criterion_id")) ?? "Unknown audience",
      audienceNameBestEffort:
        asString(getCompatValue(criterion, "criterion_id")) ?? "Unknown audience",
      type: normalizeAudienceType(asString(getCompatValue(criterion, "type"))),
      audienceType: normalizeAudienceType(asString(getCompatValue(criterion, "type"))),
      campaignId: asString(getCompatValue(campaign, "id")),
      campaign: asString(getCompatValue(campaign, "name")) ?? "",
      campaignName: asString(getCompatValue(campaign, "name")) ?? "",
      adGroupId: asString(getCompatValue(adGroup, "id")),
      adGroup: asString(getCompatValue(adGroup, "name")) ?? "",
      adGroupName: asString(getCompatValue(adGroup, "name")) ?? "",
      impressions: data.impressions,
      clicks: data.clicks,
      spend: data.spend,
      conversions: data.conversions,
      revenue: data.conversionValue,
      roas: data.roas,
      cpa: data.cpa,
      ctr: data.ctr ?? 0,
      cpc: data.averageCpc,
      conversionRate: data.conversionRate,
      valuePerConversion: data.valuePerConversion,
      costPerConversion: data.costPerConversion,
      audienceState:
        data.roas >= 3 ? "strong" : data.spend > 20 && data.conversions === 0 ? "weak" : "monitor",
      weakSegmentFlag: data.spend > 20 && data.conversions === 0,
      strongSegmentFlag: data.roas >= 3,
    };
  });

  const byType = new Map<string, { conversions: number; spend: number; revenue: number }>();
  for (const row of rows) {
    const current = byType.get(row.type) ?? { conversions: 0, spend: 0, revenue: 0 };
    byType.set(row.type, {
      conversions: current.conversions + row.conversions,
      spend: current.spend + row.spend,
      revenue: current.revenue + row.revenue,
    });
  }

  addDebugMeta(meta, "audiences", context, {
    date_range: { startDate, endDate },
  });
  finalizeMeta(meta);

  return {
    rows: rows.sort((a, b) => b.spend - a.spend) as unknown as Array<
      AudiencePerformanceRow & Record<string, unknown>
    >,
    summary: {
      byType: Array.from(byType.entries()).map(([type, stats]) => ({
        type,
        conversions: stats.conversions,
        spend: Number(stats.spend.toFixed(2)),
        roas: stats.spend > 0 ? Number((stats.revenue / stats.spend).toFixed(2)) : 0,
      })),
    },
    insights: [],
    meta,
  };
}

export async function getGoogleAdsGeoReport(
  params: BaseReportParams
): Promise<ReportResult<GeoPerformanceRow & Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_geo_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const core = await runNamedQuery(context, buildGeoCoreQuery(startDate, endDate));
  mergeFailures(meta, core);

  const geoMap = new Map<
    number,
    {
      impressions: number;
      clicks: number;
      spend: number;
      conversions: number;
      revenue: number;
    }
  >();

  for (const row of core.rows) {
    const geo = getCompatObject(row, "geographic_view");
    const metrics = getCompatObject(row, "metrics");
    const id = asInteger(getCompatValue(geo, "country_criterion_id"));
    if (!id) continue;
    const current = geoMap.get(id) ?? {
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: 0,
      revenue: 0,
    };
    const data = toMetricSet(metrics);
    geoMap.set(id, {
      impressions: current.impressions + data.impressions,
      clicks: current.clicks + data.clicks,
      spend: Number((current.spend + data.spend).toFixed(2)),
      conversions: current.conversions + data.conversions,
      revenue: Number((current.revenue + data.conversionValue).toFixed(2)),
    });
  }

  const totalSpend = Array.from(geoMap.values()).reduce((sum, row) => sum + row.spend, 0);
  const totalConversions = Array.from(geoMap.values()).reduce(
    (sum, row) => sum + row.conversions,
    0
  );
  const avgCpa =
    totalConversions > 0 ? Number((totalSpend / totalConversions).toFixed(2)) : null;

  const rows = Array.from(geoMap.entries())
    .map(([criterionId, metrics]) => ({
      criterionId,
      geoId: criterionId,
      country: COUNTRY_MAP[criterionId] ?? `Country #${criterionId}`,
      geoName: COUNTRY_MAP[criterionId] ?? `Country #${criterionId}`,
      impressions: metrics.impressions,
      clicks: metrics.clicks,
      spend: metrics.spend,
      conversions: metrics.conversions,
      revenue: metrics.revenue,
      roas: metrics.spend > 0 ? Number((metrics.revenue / metrics.spend).toFixed(2)) : 0,
      cpa:
        metrics.conversions > 0 ? Number((metrics.spend / metrics.conversions).toFixed(2)) : 0,
      ctr:
        metrics.impressions > 0
          ? Number(((metrics.clicks / metrics.impressions) * 100).toFixed(2))
          : 0,
      conversionRate:
        metrics.clicks > 0
          ? Number(((metrics.conversions / metrics.clicks) * 100).toFixed(2))
          : 0,
      vsAvgCpa:
        avgCpa && metrics.conversions > 0
          ? Number((((metrics.spend / metrics.conversions) / avgCpa - 1) * 100).toFixed(0))
          : null,
      geoState:
        metrics.spend > 20 && metrics.revenue > metrics.spend * 3
          ? "scale"
          : metrics.spend > 20 && metrics.conversions === 0
          ? "reduce"
          : "monitor",
      scaleFlag: metrics.spend > 20 && metrics.revenue > metrics.spend * 3,
      reduceFlag: metrics.spend > 20 && metrics.conversions === 0,
    }))
    .sort((a, b) => b.spend - a.spend);

  addDebugMeta(meta, "geo", context, {
    date_range: { startDate, endDate },
  });
  finalizeMeta(meta);

  return {
    rows: rows as unknown as Array<GeoPerformanceRow & Record<string, unknown>>,
    summary: { avgCpa },
    insights: [],
    meta,
  };
}

export async function getGoogleAdsDevicesReport(
  params: BaseReportParams
): Promise<ReportResult<DevicePerformanceRow & Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_devices_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const core = await runNamedQuery(context, buildDeviceCoreQuery(startDate, endDate));
  mergeFailures(meta, core);

  const deviceMap = new Map<
    string,
    {
      impressions: number;
      clicks: number;
      spend: number;
      conversions: number;
      revenue: number;
      videoViews: number;
    }
  >();

  for (const row of core.rows) {
    const segments = (row.segments as Record<string, unknown> | undefined) ?? {};
    const metrics = (row.metrics as Record<string, unknown> | undefined) ?? {};
    const device = asString(segments.device) ?? "UNKNOWN";
    const current = deviceMap.get(device) ?? {
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: 0,
      revenue: 0,
      videoViews: 0,
    };
    const data = toMetricSet(metrics);
    deviceMap.set(device, {
      impressions: current.impressions + data.impressions,
      clicks: current.clicks + data.clicks,
      spend: Number((current.spend + data.spend).toFixed(2)),
      conversions: current.conversions + data.conversions,
      revenue: Number((current.revenue + data.conversionValue).toFixed(2)),
      videoViews: current.videoViews + data.videoViews,
    });
  }

  const rows = Array.from(deviceMap.entries()).map(([device, metrics]) => ({
    device,
    impressions: metrics.impressions,
    clicks: metrics.clicks,
    spend: metrics.spend,
    conversions: metrics.conversions,
    revenue: metrics.revenue,
    roas: metrics.spend > 0 ? Number((metrics.revenue / metrics.spend).toFixed(2)) : 0,
    cpa:
      metrics.conversions > 0 ? Number((metrics.spend / metrics.conversions).toFixed(2)) : 0,
    ctr:
      metrics.impressions > 0
        ? Number(((metrics.clicks / metrics.impressions) * 100).toFixed(2))
        : 0,
    conversionRate:
      metrics.clicks > 0
        ? Number(((metrics.conversions / metrics.clicks) * 100).toFixed(2))
        : 0,
    videoViews: metrics.videoViews,
    deviceState:
      metrics.spend > 20 && metrics.revenue > metrics.spend * 3
        ? "scale"
        : metrics.spend > 20 && metrics.conversions === 0
        ? "weak"
        : "monitor",
    scaleFlag: metrics.spend > 20 && metrics.revenue > metrics.spend * 3,
    weakFlag: metrics.spend > 20 && metrics.conversions === 0,
  }));

  addDebugMeta(meta, "devices", context, {
    date_range: { startDate, endDate },
  });
  finalizeMeta(meta);

  return {
    rows: rows.sort((a, b) => b.spend - a.spend) as unknown as Array<
      DevicePerformanceRow & Record<string, unknown>
    >,
    insights: [],
    meta,
  };
}

export async function getGoogleAdsBudgetReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const report = await getGoogleAdsCampaignsReport(params);
  const rows = report.rows.map((row) => ({
    id: row.id,
    name: row.name,
    dailyBudget: row.dailyBudget ?? null,
    spend: row.spend,
    conversions: row.conversions,
    revenue: row.revenue,
    roas: row.roas,
    cpa: row.cpa,
    impressions: row.impressions,
    clicks: row.clicks,
    impressionShare: row.impressionShare ?? null,
    lostIsBudget: row.lostIsBudget ?? null,
    lostIsRank: row.lostIsRank ?? null,
    status: row.status,
    channel: row.channel,
    ctr: row.ctr,
    spendShare: row.spendShare ?? null,
    revenueShare: row.revenueShare ?? null,
  }));

  const budgetAnalysis = analyzeBudgetScaling(rows);

  const totalSpend = budgetAnalysis.rows.reduce((sum, row) => sum + Number(row.spend ?? 0), 0);
  const totalRevenue = budgetAnalysis.rows.reduce((sum, row) => sum + Number(row.revenue ?? 0), 0);
  const accountAvgRoas = totalSpend > 0 ? Number((totalRevenue / totalSpend).toFixed(2)) : 0;

  return {
    rows: budgetAnalysis.rows,
    summary: {
      totalSpend: Number(totalSpend.toFixed(2)),
      accountAvgRoas,
      scaleCampaignCount: budgetAnalysis.summary.scaleCampaignCount,
      stableCampaignCount: budgetAnalysis.summary.stableCampaignCount,
      budgetSinkCount: budgetAnalysis.summary.budgetSinkCount,
    },
    insights: {
      recommendations: generateBudgetRecommendations(
        budgetAnalysis.rows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          status: String(row.status ?? "paused"),
          channel: String(row.channel ?? "Unknown"),
          spend: Number(row.spend ?? 0),
          conversions: Number(row.conversions ?? 0),
          revenue: Number(row.revenue ?? 0),
          roas: Number(row.roas ?? 0),
          cpa: Number(row.cpa ?? 0),
          ctr: Number(row.ctr ?? 0),
          impressions: Number(row.impressions ?? 0),
          clicks: Number(row.clicks ?? 0),
          impressionShare:
            typeof row.impressionShare === "number" ? row.impressionShare : undefined,
          lostIsBudget:
            typeof row.lostIsBudget === "number" ? row.lostIsBudget : undefined,
          lostIsRank:
            typeof row.lostIsRank === "number" ? row.lostIsRank : undefined,
          budget:
            typeof row.dailyBudget === "number" ? row.dailyBudget : undefined,
        })),
        accountAvgRoas
      ),
      scaleBudgetCandidates: budgetAnalysis.insights.scaleBudgetCandidates,
      budgetWasteCampaigns: budgetAnalysis.insights.budgetWasteCampaigns,
      balancedCampaigns: budgetAnalysis.insights.balancedCampaigns,
    },
    meta: report.meta,
  };
}

export async function getGoogleAdsCreativesReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_creatives_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const [core, detail] = await Promise.all([
    runNamedQuery(context, buildAssetGroupCoreQuery(startDate, endDate)),
    runNamedQuery(context, buildAssetGroupAssetDetailQuery(startDate, endDate)),
  ]);
  mergeFailures(meta, core);
  mergeFailures(meta, detail);

  const assetBreakdown = new Map<string, AssetTypeSummary>();
  for (const row of detail.rows) {
    const assetGroup = getCompatObject(row, "asset_group");
    const asset = getCompatObject(row, "asset");
    const id = asString(getCompatValue(assetGroup, "id"));
    if (!id) continue;
    const current = assetBreakdown.get(id) ?? {};
    const fieldType = asString(
      getCompatValue(getCompatObject(row, "asset_group_asset"), "field_type")
    );
    const assetType = asString(getCompatValue(asset, "type"));
    const label = dedupeStrings([fieldType ?? "", assetType ?? "asset"]).join(":");
    current[label] = (current[label] ?? 0) + 1;
    assetBreakdown.set(id, current);
  }

  const rows = core.rows.map((row) => {
    const assetGroup = getCompatObject(row, "asset_group");
    const campaign = getCompatObject(row, "campaign");
    const metrics = getCompatObject(row, "metrics");
    const data = toMetricSet(metrics);
    const id = asString(getCompatValue(assetGroup, "id")) ?? "unknown";
    const assetMix = assetBreakdown.get(id) ?? {};
    return {
      id,
      name: asString(getCompatValue(assetGroup, "name")) ?? "Unnamed Asset Group",
      type: "Performance Max",
      status: normalizeStatus(asString(getCompatValue(assetGroup, "status")) ?? undefined),
      campaignId: asString(getCompatValue(campaign, "id")),
      campaign: asString(getCompatValue(campaign, "name")) ?? "",
      impressions: data.impressions,
      clicks: data.clicks,
      spend: data.spend,
      conversions: data.conversions,
      revenue: data.conversionValue,
      roas: data.roas,
      cpa: data.cpa,
      ctr: data.ctr ?? 0,
      cpc: data.averageCpc,
      conversionRate: data.conversionRate,
      assetCount: Object.values(assetMix).reduce((sum, count) => sum + count, 0),
      assetMix,
    };
  });

  if (detail.failures.length > 0) {
    meta.warnings.push(
      "Asset metadata could not be loaded for all customers. Performance metrics are still shown."
    );
  }
  meta.unavailable_metrics = dedupeStrings(
    meta.unavailable_metrics.concat([
      ...(GOOGLE_ADS_METRICS_MATRIX.creatives.unavailableByDesign ?? []),
    ])
  );

  addDebugMeta(meta, "creatives", context, {
    date_range: { startDate, endDate },
  });
  finalizeMeta(meta);

  return {
    rows,
    summary: {
      supportedView: "asset_group performance + asset mix",
    },
    insights: [],
    meta,
  };
}

const ASSET_GROUP_REQUIRED_FIELDS = [
  "HEADLINE",
  "DESCRIPTION",
  "MARKETING_IMAGE",
  "LOGO",
  "BUSINESS_NAME",
];

function getAssetGroupCoverageScore(assetMix: AssetTypeSummary) {
  const covered = ASSET_GROUP_REQUIRED_FIELDS.filter((field) => (assetMix[field] ?? 0) > 0);
  return Number(((covered.length / ASSET_GROUP_REQUIRED_FIELDS.length) * 100).toFixed(0));
}

function isThemeAligned(theme: string, corpus: string) {
  const tokens = slugifyQueryCluster(theme).split(" ").filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.some((token) => corpus.includes(token));
}

function getThemeCoverage(theme: string, corpus: string) {
  const tokens = slugifyQueryCluster(theme).split(" ").filter(Boolean);
  if (tokens.length === 0) return "low";
  const matched = tokens.filter((token) => corpus.includes(token)).length;
  const ratio = matched / tokens.length;
  if (ratio >= 0.67) return "high";
  if (ratio > 0) return "medium";
  return "low";
}

function getThemeRecommendation(theme: string, coverage: string) {
  if (coverage === "high") return `Keep reinforcing ${theme} in current assets.`;
  if (coverage === "medium") return `Strengthen messaging by naming ${theme} more directly in headlines.`;
  return `Add headline and description language that explicitly mentions ${theme}.`;
}

export async function getGoogleAdsAssetGroupsReport(
  params: BaseReportParams
): Promise<ReportResult<AssetGroupPerformanceRow & Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_asset_groups_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const [core, detail, signals, assetDetails] = await Promise.all([
    runNamedQuery(context, buildAssetGroupCoreQuery(startDate, endDate)),
    runNamedQuery(context, buildAssetGroupAssetDetailQuery(startDate, endDate)),
    runNamedQuery(context, buildAssetGroupSignalQuery()),
    runNamedQuery(context, buildAssetTextDetailQuery()),
  ]);

  mergeFailures(meta, core);
  mergeFailures(meta, detail);
  mergeFailures(meta, signals);
  mergeFailures(meta, assetDetails);

  const detailMap = new Map<string, { text: string | null }>();
  for (const row of assetDetails.rows) {
    const asset = getCompatObject(row, "asset");
    const textAsset = getCompatObject(asset, "text_asset");
    const id = asString(getCompatValue(asset, "id"));
    if (!id) continue;
    detailMap.set(id, {
      text: asString(getCompatValue(textAsset, "text")),
    });
  }

  const assetBreakdown = new Map<string, AssetTypeSummary>();
  const textCorpusByGroup = new Map<string, string[]>();
  for (const row of detail.rows) {
    const assetGroup = getCompatObject(row, "asset_group");
    const asset = getCompatObject(row, "asset");
    const id = asString(getCompatValue(assetGroup, "id"));
    if (!id) continue;

    const current = assetBreakdown.get(id) ?? {};
    const fieldType = asString(
      getCompatValue(getCompatObject(row, "asset_group_asset"), "field_type")
    );
    const assetType = asString(getCompatValue(asset, "type"));
    const label = dedupeStrings([fieldType ?? "", assetType ?? "asset"]).join(":");
    current[fieldType ?? label] = (current[fieldType ?? label] ?? 0) + 1;
    assetBreakdown.set(id, current);

    const assetId = asString(getCompatValue(asset, "id"));
    const detailEntry = assetId ? detailMap.get(assetId) : null;
    if (detailEntry?.text) {
      const corpus = textCorpusByGroup.get(id) ?? [];
      corpus.push(detailEntry.text.toLowerCase());
      textCorpusByGroup.set(id, corpus);
    }
  }

  const searchThemesByGroup = new Map<string, SearchThemeSignal[]>();
  for (const row of signals.rows) {
    const assetGroup = getCompatObject(row, "asset_group");
    const signal = getCompatObject(row, "asset_group_signal");
    const searchTheme = getCompatObject(signal, "search_theme");
    const groupId = asString(getCompatValue(assetGroup, "id"));
    const text = asString(getCompatValue(searchTheme, "text"));
    if (!groupId || !text) continue;
    const current = searchThemesByGroup.get(groupId) ?? [];
    current.push({
      text,
      approvalStatus: asString(getCompatValue(signal, "approval_status")),
    });
    searchThemesByGroup.set(groupId, current);
  }

  const totalSpend = core.rows.reduce((sum, row) => {
    const metrics = getCompatObject(row, "metrics");
    return sum + toMetricSet(metrics).spend;
  }, 0);
  const totalRevenue = core.rows.reduce((sum, row) => {
    const metrics = getCompatObject(row, "metrics");
    return sum + toMetricSet(metrics).conversionValue;
  }, 0);
  const avgRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;

  const rows = core.rows.map((row) => {
    const assetGroup = getCompatObject(row, "asset_group");
    const campaign = getCompatObject(row, "campaign");
    const metrics = getCompatObject(row, "metrics");
    const data = toMetricSet(metrics);
    const id = asString(getCompatValue(assetGroup, "id")) ?? "unknown";
    const assetMix = assetBreakdown.get(id) ?? {};
    const coverageScore = getAssetGroupCoverageScore(assetMix);
    const searchThemes = searchThemesByGroup.get(id) ?? [];
    const corpus = (textCorpusByGroup.get(id) ?? []).join(" ").toLowerCase();
    const enrichedThemes = searchThemes.map((theme) => {
      const coverage = getThemeCoverage(theme.text, corpus);
      return {
        ...theme,
        coverage,
        alignedMessaging: coverage !== "low",
        messagingMismatch: coverage === "low",
        recommendation: getThemeRecommendation(theme.text, coverage),
      };
    });
    const mismatchedThemes = enrichedThemes.filter((theme) => theme.messagingMismatch);
    const spendShare = totalSpend > 0 ? Number(((data.spend / totalSpend) * 100).toFixed(1)) : 0;
    const revenueShare =
      totalRevenue > 0 ? Number(((data.conversionValue / totalRevenue) * 100).toFixed(1)) : 0;
    const classification =
      data.roas > avgRoas && revenueShare > spendShare
        ? "scale_candidate"
        : spendShare > revenueShare && data.roas < avgRoas
        ? "budget_sink"
        : data.roas >= avgRoas * 0.85 && coverageScore >= 70
        ? "healthy"
        : "weak";
    const state =
      classification === "scale_candidate"
        ? "strong"
        : classification === "budget_sink" || classification === "weak"
        ? "weak"
        : "watch";

    return {
      id,
      assetGroupId: id,
      name: asString(getCompatValue(assetGroup, "name")) ?? "Unnamed Asset Group",
      assetGroupName: asString(getCompatValue(assetGroup, "name")) ?? "Unnamed Asset Group",
      status: normalizeStatus(asString(getCompatValue(assetGroup, "status")) ?? undefined),
      campaignId: asString(getCompatValue(campaign, "id")),
      campaign: asString(getCompatValue(campaign, "name")) ?? "",
      campaignName: asString(getCompatValue(campaign, "name")) ?? "",
      impressions: data.impressions,
      clicks: data.clicks,
      interactions: data.interactions,
      spend: data.spend,
      conversions: data.conversions,
      revenue: data.conversionValue,
      ctr: data.ctr ?? 0,
      roas: data.roas,
      cpa: data.cpa,
      conversionRate: data.conversionRate,
      spendShare,
      revenueShare,
      coverageScore,
      assetCount: Object.values(assetMix).reduce((sum, count) => sum + count, 0),
      assetMix,
      assetCountByType: assetMix,
      classification,
      state,
      adStrength: null,
      finalUrls: [],
      audienceSignalsSummary: null,
      audienceSignals: [],
      searchThemes: enrichedThemes,
      searchThemesConfigured: searchThemes.map((theme) => theme.text),
      searchThemeSummary: searchThemes.map((theme) => theme.text).slice(0, 3).join(", "),
      searchThemeCount: searchThemes.length,
      searchThemeAlignedCount: enrichedThemes.filter((theme) => theme.alignedMessaging).length,
      messagingMismatchCount: mismatchedThemes.length,
      missingAssetFields: ASSET_GROUP_REQUIRED_FIELDS.filter(
        (field) => (assetMix[field] ?? 0) === 0
      ),
      missingAssetTypes: ASSET_GROUP_REQUIRED_FIELDS.filter((field) => (assetMix[field] ?? 0) === 0),
      scaleState: classification === "scale_candidate" ? "scale" : "monitor",
      weakState: classification === "weak" || classification === "budget_sink" ? "weak" : "healthy",
      coverageRisk:
        coverageScore < 70 || Object.values(assetMix).reduce((sum, count) => sum + count, 0) < 6,
      messagingAlignmentScore:
        searchThemes.length > 0
          ? Number(
              (
                (enrichedThemes.filter((theme) => theme.alignedMessaging).length /
                  searchThemes.length) *
                100
              ).toFixed(0)
            )
          : 0,
      recommendation:
        mismatchedThemes[0]?.recommendation ??
        (coverageScore < 70
          ? `Add ${ASSET_GROUP_REQUIRED_FIELDS.filter((field) => (assetMix[field] ?? 0) === 0)
              .join(", ")
              .toLowerCase()} assets.`
          : classification === "budget_sink"
          ? "Reduce budget concentration and rebuild weak messaging."
          : classification === "scale_candidate"
          ? "Expand volume while preserving current message-theme fit."
          : "Keep testing asset variety and tighten messaging."),
    };
  });

  meta.warnings.push(
    "Search themes are shown as configured asset-group signals. Google Ads does not consistently expose asset-group-level theme performance metrics, so alignment is based on configured themes plus available asset messaging."
  );
  if (assetDetails.failures.length > 0) {
    meta.warnings.push(
      "Theme-to-message alignment is partial because some asset text details could not be loaded."
    );
  }

  addDebugMeta(meta, "asset-groups", context, {
    date_range: { startDate, endDate },
  });

  const assetGroupAnalysis = analyzeAssetGroups(rows);
  finalizeMeta(meta);

  return {
    rows: assetGroupAnalysis.rows.sort((a, b) => b.spend - a.spend) as unknown as Array<
      AssetGroupPerformanceRow & Record<string, unknown>
    >,
    summary: {
      strongCount: assetGroupAnalysis.summary.scaleCandidateCount,
      healthyCount: assetGroupAnalysis.summary.healthyCount,
      weakCount: assetGroupAnalysis.summary.weakCount,
      coverageRiskCount: assetGroupAnalysis.summary.coverageRiskCount,
      accountAverageRoas: assetGroupAnalysis.summary.accountAverageRoas,
      budgetSinkCount: rows.filter((row) => row.classification === "budget_sink").length,
      coverageGaps: assetGroupAnalysis.insights.coverageGaps.length,
      searchThemeCount: assetGroupAnalysis.rows.reduce((sum, row) => sum + row.searchThemeCount, 0),
      searchThemeMismatches: assetGroupAnalysis.rows.reduce(
        (sum, row) => sum + Number(row.messagingMismatchCount ?? 0),
        0
      ),
    },
    insights: {
      scaleCandidates: assetGroupAnalysis.insights.scaleCandidates,
      healthyGroups: assetGroupAnalysis.rows
        .filter((row) => row.classification === "healthy")
        .slice(0, 5),
      weakGroups: assetGroupAnalysis.insights.weakGroups,
      budgetSinks: assetGroupAnalysis.rows
        .filter((row) => row.classification === "budget_sink")
        .slice(0, 5),
      coverageGaps: assetGroupAnalysis.insights.coverageGaps,
    },
    meta,
  };
}

export async function getGoogleAdsProductsReport(
  params: BaseReportParams & {
    executionMode?: "default" | "warehouse_sync";
  }
): Promise<ReportResult<ProductPerformanceRow & Record<string, unknown>>> {
  const resolved = await resolveContext({
    businessId: params.businessId,
    accountId: params.accountId,
    dateRange: params.dateRange,
    customStart: params.customStart,
    customEnd: params.customEnd,
    debug: Boolean(params.debug),
    source: params.source ?? "google_ads_products_report",
  });
  if (!resolved.ok) return resolved.payload;

  const { context, startDate, endDate } = resolved;
  const meta = createEmptyMeta(context.debug);
  const warehouseSyncMode = params.executionMode === "warehouse_sync";
  const productsPrimary = await runNamedQuery(
    context,
    buildProductPerformanceQuery(startDate, endDate, warehouseSyncMode ? 5000 : 1000)
  );
  const shouldFallbackToLegacy =
    productsPrimary.rows.length === 0 || productsPrimary.failures.length > 0;
  const productsLegacy = shouldFallbackToLegacy
    ? await runNamedQuery(
        context,
        buildProductPerformanceLegacyQuery(startDate, endDate, warehouseSyncMode ? 5000 : 1000)
      )
    : {
        rows: [],
        failures: [],
        query: buildProductPerformanceLegacyQuery(startDate, endDate, warehouseSyncMode ? 5000 : 1000),
      };
  mergeFailures(meta, productsPrimary);
  mergeFailures(meta, productsLegacy);

  const products =
    productsPrimary.rows.length > 0
      ? productsPrimary
      : productsLegacy.rows.length > 0
      ? productsLegacy
      : productsPrimary;

  if (productsPrimary.rows.length === 0 && productsLegacy.rows.length > 0) {
    meta.warnings.push(
      "Product feed is served via shopping_product_view fallback for this account."
    );
  }

  const productMap = new Map<
    string,
    {
      productId: string;
      productTitle: string;
      impressions: number;
      clicks: number;
      spend: number;
      orders: number;
      revenue: number;
    }
  >();

  for (const row of products.rows) {
    const segments = getCompatObject(row, "segments");
    const metrics = getCompatObject(row, "metrics");
    const productItemId = asString(getCompatValue(segments, "product_item_id"));
    const productTitle = asString(getCompatValue(segments, "product_title"));
    const productId =
      productItemId ??
      (productTitle && productTitle.trim().length > 0
        ? `title:${productTitle.trim().toLowerCase()}`
        : "unknown");
    const current = productMap.get(productId) ?? {
      productId,
      productTitle: productTitle ?? "Unknown product",
      impressions: 0,
      clicks: 0,
      spend: 0,
      orders: 0,
      revenue: 0,
    };
    const data = toMetricSet(metrics);
    productMap.set(productId, {
      ...current,
      impressions: current.impressions + data.impressions,
      clicks: current.clicks + data.clicks,
      spend: Number((current.spend + data.spend).toFixed(2)),
      orders: Number((current.orders + data.conversions).toFixed(2)),
      revenue: Number((current.revenue + data.conversionValue).toFixed(2)),
    });
  }

  const rows = Array.from(productMap.values())
    .filter((row) => row.productId !== "unknown" || Number(row.spend ?? 0) > 0)
    .map((row) => {
      const roas = row.spend > 0 ? Number((row.revenue / row.spend).toFixed(2)) : 0;
      const cpa = row.orders > 0 ? Number((row.spend / row.orders).toFixed(2)) : 0;
      const contribution = Number((row.revenue - row.spend).toFixed(2));
      const spendPerOrder = row.orders > 0 ? Number((row.spend / row.orders).toFixed(2)) : null;
      const avgOrderValue = row.orders > 0 ? Number((row.revenue / row.orders).toFixed(2)) : null;

      return {
        ...row,
        productItemId: row.productId,
        productTitle: row.productTitle,
        itemId: row.productId,
        title: row.productTitle,
        roas,
        cpa,
        orders: row.orders,
        conversions: row.orders,
        ctr:
          row.impressions > 0 ? Number(((row.clicks / row.impressions) * 100).toFixed(2)) : 0,
        avgOrderValue,
        spendPerOrder,
        valuePerClick: row.clicks > 0 ? Number((row.revenue / row.clicks).toFixed(2)) : null,
        contribution,
        contributionProxy: contribution,
        contributionState:
          contribution > 0 ? "positive" : contribution < 0 ? "negative" : "neutral",
        statusLabel:
          roas >= 3 && row.orders >= 2
            ? "scale"
            : row.spend > 25 && roas < 1.5
            ? "reduce"
            : row.orders >= 1 && contribution > 0
            ? "stable"
            : "test",
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  if (warehouseSyncMode) {
    const typedWarehouseRows: Array<Record<string, unknown>> = rows.map((row) => ({
      ...row,
      productItemId: row.productId,
      productTitle: row.productTitle,
      itemId: row.productId,
      title: row.productTitle,
      scaleState: row.statusLabel === "scale" ? "scale" : "monitor",
      underperformingState: row.statusLabel === "reduce" ? "underperforming" : "healthy",
      hiddenWinnerState: "visible",
      classification:
        row.statusLabel === "scale"
          ? "scale_product"
          : row.statusLabel === "reduce"
          ? "underperforming_product"
          : "stable_product",
    }));

    addDebugMeta(meta, "products", context, {
      date_range: { startDate, endDate },
      execution_mode: "warehouse_sync",
      used_legacy_fallback: shouldFallbackToLegacy,
      warehouse_sync_short_circuit: true,
    });
    finalizeMeta(meta);

    const totalSpend = rows.reduce((sum, row) => sum + row.spend, 0);
    const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);

    return {
      rows: typedWarehouseRows as unknown as Array<ProductPerformanceRow & Record<string, unknown>>,
      summary: {
        totalSpend: Number(totalSpend.toFixed(2)),
        totalRevenue: Number(totalRevenue.toFixed(2)),
        accountAverageRoas: totalSpend > 0 ? Number((totalRevenue / totalSpend).toFixed(2)) : 0,
        scaleCandidates: typedWarehouseRows.filter((row) => row.scaleState === "scale").length,
        reduceCandidates: typedWarehouseRows.filter(
          (row) => row.underperformingState === "underperforming"
        ).length,
        hiddenWinnerCount: 0,
        spendConcentrationTop3: Number(
          rows
            .slice(0, 3)
            .reduce((sum, row) => sum + (totalSpend > 0 ? row.spend / totalSpend : 0), 0)
            .toFixed(2)
        ),
      },
      insights: {
        topRevenueProducts: [],
        lowReturnProducts: [],
        scaleCandidates: [],
        hiddenWinners: [],
        spendWithoutReturn: [],
      },
      meta,
    };
  }

  const productAnalysis = analyzeProducts(rows);
  const typedProductRows: Array<Record<string, unknown>> = productAnalysis.rows.map((row) => ({
    ...row,
    productItemId: String(row.productId ?? row.itemId ?? ""),
    productTitle: String(row.productTitle ?? row.title ?? ""),
    scaleState: String(row.classification ?? "") === "scale_product" ? "scale" : "monitor",
    underperformingState:
      String(row.classification ?? "") === "underperforming_product"
        ? "underperforming"
        : "healthy",
    hiddenWinnerState:
      String(row.classification ?? "") === "hidden_winner" ? "hidden_winner" : "visible",
  }));

  const totalSpend = productAnalysis.rows.reduce((sum, row) => sum + row.spend, 0);
  const totalRevenue = productAnalysis.rows.reduce((sum, row) => sum + row.revenue, 0);
  const accountAvgRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;

  addDebugMeta(meta, "products", context, {
    date_range: { startDate, endDate },
    execution_mode: warehouseSyncMode ? "warehouse_sync" : "default",
    used_legacy_fallback: shouldFallbackToLegacy,
  });
  finalizeMeta(meta);

  const topRevenueProducts = [...productAnalysis.rows]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);
  const lowReturnProducts = productAnalysis.rows
    .filter((row) => row.spend > 20 && row.roas < Math.max(accountAvgRoas * 0.75, 1.5))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 5);
  const scaleCandidates = productAnalysis.rows
    .filter((row) => row.roas > Math.max(accountAvgRoas, 2) && row.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);
  const hiddenWinners = productAnalysis.rows
    .filter(
      (row) =>
        row.roas > Math.max(accountAvgRoas * 1.15, 2) && row.spend > 0 && row.spend < totalSpend * 0.08
    )
    .sort((a, b) => b.roas - a.roas)
    .slice(0, 5);

  return {
    rows: typedProductRows as unknown as Array<ProductPerformanceRow & Record<string, unknown>>,
    summary: {
      totalSpend: Number(totalSpend.toFixed(2)),
      totalRevenue: Number(totalRevenue.toFixed(2)),
      accountAverageRoas: productAnalysis.summary.accountAverageRoas,
      scaleCandidates: productAnalysis.summary.scaleProductCount,
      reduceCandidates: productAnalysis.summary.underperformingProductCount,
      hiddenWinnerCount: productAnalysis.summary.hiddenWinnerCount,
      spendConcentrationTop3: Number(
        productAnalysis.rows
          .slice(0, 3)
          .reduce((sum, row) => sum + (totalSpend > 0 ? row.spend / totalSpend : 0), 0)
          .toFixed(2)
      ),
    },
    insights: {
      topRevenueProducts:
        productAnalysis.insights.topRevenueProducts.length > 0
          ? productAnalysis.insights.topRevenueProducts
          : topRevenueProducts,
      lowReturnProducts,
      scaleCandidates:
        productAnalysis.insights.scaleCandidates.length > 0
          ? productAnalysis.insights.scaleCandidates
          : scaleCandidates,
      hiddenWinners:
        productAnalysis.insights.hiddenWinners.length > 0
          ? productAnalysis.insights.hiddenWinners
          : hiddenWinners,
      spendWithoutReturn: productAnalysis.insights.spendWithoutReturn,
    },
    meta,
  };
}

export async function getGoogleAdsDiagnosticsReport(
  params: BaseReportParams
): Promise<ReportResult<Record<string, unknown>>> {
  const reports = await Promise.all([
    getGoogleAdsOverviewReport(params),
    getGoogleAdsCampaignsReport(params),
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

  const [overview, campaigns, searchIntelligence, keywords, assets, assetGroups, products, audiences, geo, devices, budget, opportunities] =
    reports;

  const meta = createEmptyMeta(Boolean(params.debug));
  for (const child of reports) {
    mergeChildMeta(meta, child.meta);
  }
  finalizeMeta(meta);

  const sections = [
    { label: "Overview", meta: overview.meta, rows: 1 },
    { label: "Campaigns", meta: campaigns.meta, rows: campaigns.rows.length },
    {
      label: "Search Intelligence",
      meta: searchIntelligence.meta,
      rows: searchIntelligence.rows.length,
    },
    { label: "Keywords", meta: keywords.meta, rows: keywords.rows.length },
    { label: "Assets", meta: assets.meta, rows: assets.rows.length },
    { label: "Asset Groups", meta: assetGroups.meta, rows: assetGroups.rows.length },
    { label: "Products", meta: products.meta, rows: products.rows.length },
    { label: "Audience Intelligence", meta: audiences.meta, rows: audiences.rows.length },
    { label: "Geo", meta: geo.meta, rows: geo.rows.length },
    { label: "Devices", meta: devices.meta, rows: devices.rows.length },
    { label: "Budget & Scaling", meta: budget.meta, rows: budget.rows.length },
    { label: "Opportunities", meta: opportunities.meta, rows: opportunities.rows.length },
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
      healthySections: sections.filter(
        (section) =>
          !section.partial && section.warningCount === 0 && section.failureCount === 0
      ).length,
      totalWarnings: sections.reduce((sum, section) => sum + section.warningCount, 0),
      totalFailures: sections.reduce((sum, section) => sum + section.failureCount, 0),
      coreBlockers: meta.failed_queries.filter((failure) => failure.severity === "core").length,
      optionalFailures: meta.failed_queries.filter((failure) => failure.severity !== "core").length,
      apiLimitations: meta.failed_queries.filter(
        (failure) =>
          failure.category === "unsupported_query_shape" ||
          failure.category === "unavailable_metric"
      ).length,
      generatedAt: new Date().toISOString(),
    },
    insights: {
      reportFamilies: Object.entries(meta.report_families).map(([family, familyMeta]) => ({
        family,
        partial: familyMeta.partial,
        rowCount: familyMeta.row_count,
        warningCount: familyMeta.warnings.length,
        failureCount: familyMeta.failed_queries.length,
        unavailableMetricCount: familyMeta.unavailable_metrics.length,
        queryNames: familyMeta.query_names,
      })),
      issueInventory: meta.failed_queries.map((failure) => ({
        query: failure.query,
        family: failure.family,
        severity: failure.severity ?? getQuerySeverity(failure.query),
        category:
          failure.category ??
          classifyFailureCategory({
            queryName: failure.query,
            message: failure.message,
            status: failure.status,
            apiStatus: failure.apiStatus,
            apiErrorCode: failure.apiErrorCode,
          }),
        customerId: failure.customerId,
        loginCustomerId: failure.loginCustomerId ?? null,
        status: failure.status ?? null,
        apiStatus: failure.apiStatus ?? null,
        apiErrorCode: failure.apiErrorCode ?? null,
        message: failure.message,
      })),
      groupedIssues: {
        coreBlockers: meta.failed_queries.filter((failure) => failure.severity === "core"),
        optionalFailures: meta.failed_queries.filter((failure) => failure.severity !== "core"),
        permissionContext: meta.failed_queries.filter(
          (failure) => failure.category === "auth_permission_context"
        ),
        apiLimitations: meta.failed_queries.filter(
          (failure) =>
            failure.category === "unsupported_query_shape" ||
            failure.category === "unavailable_metric"
        ),
      },
      limitations: [
        "Asset-group-level search theme performance metrics are not consistently exposed by Google Ads API; configured themes and messaging alignment are shown instead.",
        "Keyword quality metrics depend on Google Ads quality_info availability and may be absent for some criteria.",
        "Product contribution is a value-minus-spend proxy, not a true margin model.",
      ],
    },
    meta,
  };
}

export async function getGoogleAdsOpportunitiesReport(
  params: BaseReportParams
): Promise<ReportResult<GoogleAdsOpportunity>> {
  const [
    campaigns,
    keywords,
    searchIntelligence,
    assets,
    assetGroups,
    products,
    geo,
    devices,
    audiences,
  ] = await Promise.all([
    getGoogleAdsCampaignsReport(params),
    getGoogleAdsKeywordsReport(params),
    getGoogleAdsSearchIntelligenceReport(params),
    getGoogleAdsAssetsReport(params),
    getGoogleAdsAssetGroupsReport(params),
    getGoogleAdsProductsReport(params),
    getGoogleAdsGeoReport(params),
    getGoogleAdsDevicesReport(params),
    getGoogleAdsAudiencesReport(params),
  ]);

  const meta = createEmptyMeta(Boolean(params.debug));
  for (const childMeta of [
    campaigns.meta,
    keywords.meta,
    searchIntelligence.meta,
    assets.meta,
    assetGroups.meta,
    products.meta,
    geo.meta,
    devices.meta,
    audiences.meta,
  ]) {
    mergeChildMeta(meta, childMeta);
  }
  finalizeMeta(meta);

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
  const crossEntityOpportunities = crossEntity.rows
    .filter(
      (insight) =>
        insight.type === "scale_path" ||
        insight.type === "waste_concentration" ||
        insight.type === "asset_theme_alignment"
    )
    .map(mapCrossEntityInsightToOpportunity)
    .filter((row): row is GoogleAdsOpportunity => Boolean(row));

  if (params.debug) {
    meta.debug = {
      child_reports: [
        "campaigns",
        "keywords",
        "search-intelligence",
        "assets",
        "asset-groups",
        "products",
        "geo",
        "devices",
        "audiences",
      ],
    };
  }

  const mergedOpportunityRows = [...crossEntityOpportunities, ...opportunityResult.rows].sort(
    (a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0)
  );

  return {
    rows: mergedOpportunityRows,
    summary: {
      scale: mergedOpportunityRows.filter((row) => row.type === "scale").length,
      reduce: mergedOpportunityRows.filter((row) => row.type === "reduce").length,
      fix: mergedOpportunityRows.filter((row) => row.type === "fix").length,
      test: mergedOpportunityRows.filter((row) => row.type === "test").length,
      total: mergedOpportunityRows.length,
      crossEntity: crossEntityOpportunities.length,
    },
    insights: {
      crossEntity: crossEntity.rows,
    },
    meta,
  };
}
