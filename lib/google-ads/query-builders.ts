export interface GoogleAdsNamedQuery {
  name: string;
  family: string;
  resource: string;
  query: string;
  mergeKey: string;
  metrics: string[];
}

export const GOOGLE_ADS_CAMPAIGN_CORE_LIMIT = (() => {
  const parsed = Number(process.env.GOOGLE_ADS_CAMPAIGN_CORE_LIMIT ?? 10_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();

function compactQuery(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function buildDateWhereClause(startDate: string, endDate: string): string {
  return `segments.date BETWEEN '${startDate}' AND '${endDate}'`;
}

export function buildGoogleAdsQuery(params: {
  select: string[];
  from: string;
  where?: string[];
  orderBy?: string[];
  limit?: number;
}): string {
  const parts = [
    `SELECT ${params.select.join(", ")}`,
    `FROM ${params.from}`,
  ];
  if (params.where && params.where.length > 0) {
    parts.push(`WHERE ${params.where.join(" AND ")}`);
  }
  if (params.orderBy && params.orderBy.length > 0) {
    parts.push(`ORDER BY ${params.orderBy.join(", ")}`);
  }
  if (typeof params.limit === "number") {
    parts.push(`LIMIT ${params.limit}`);
  }
  return compactQuery(parts.join(" "));
}

export function buildCustomerSummaryQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "customer_summary",
    family: "customer_summary",
    resource: "customer",
    mergeKey: "customer",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "customer.id",
        "customer.descriptive_name",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.interactions",
      ],
      from: "customer",
      where: [buildDateWhereClause(startDate, endDate)],
    }),
  };
}

export function buildCampaignCoreBasicQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "campaign_core_basic",
    family: "campaign_core_basic",
    resource: "campaign",
    mergeKey: "campaign.id",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "campaign.id",
        "campaign.name",
        "campaign.status",
        "campaign.advertising_channel_type",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.interactions",
      ],
      from: "campaign",
      where: [
        buildDateWhereClause(startDate, endDate),
        "campaign.status != 'REMOVED'",
      ],
      orderBy: ["metrics.cost_micros DESC"],
      limit: GOOGLE_ADS_CAMPAIGN_CORE_LIMIT,
    }),
  };
}

export function buildCampaignShareQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "campaign_share",
    family: "campaign_share",
    resource: "campaign",
    mergeKey: "campaign.id",
    metrics: [
      "search_impression_share",
      "search_budget_lost_impression_share",
      "search_rank_lost_impression_share",
      "search_top_impression_share",
      "search_absolute_top_impression_share",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "campaign.id",
        "metrics.search_impression_share",
        "metrics.search_budget_lost_impression_share",
        "metrics.search_rank_lost_impression_share",
        "metrics.search_top_impression_share",
        "metrics.search_absolute_top_impression_share",
      ],
      from: "campaign",
      where: [
        buildDateWhereClause(startDate, endDate),
        "campaign.status != 'REMOVED'",
        "campaign.advertising_channel_type IN ('SEARCH', 'SHOPPING')",
      ],
    }),
  };
}

export function buildCampaignBudgetQuery(
  _startDate: string,
  _endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "campaign_budget",
    family: "campaign_budget",
    resource: "campaign",
    mergeKey: "campaign.id",
    metrics: ["campaign_budget.amount_micros"],
    query: buildGoogleAdsQuery({
      select: [
        "campaign.id",
        "campaign_budget.resource_name",
        "campaign_budget.amount_micros",
        "campaign_budget.delivery_method",
        "campaign_budget.explicitly_shared",
      ],
      from: "campaign",
      where: [
        "campaign.status != 'REMOVED'",
      ],
    }),
  };
}

export function buildSearchTermCoreQuery(
  startDate: string,
  endDate: string,
  limit = 1000
): GoogleAdsNamedQuery {
  return {
    name: "search_term_core",
    family: "search_term_core",
    resource: "search_term_view",
    mergeKey: "search_term_view.search_term",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "search_term_view.search_term",
        "search_term_view.status",
        "campaign.id",
        "campaign.name",
        "ad_group.id",
        "ad_group.name",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.interactions",
      ],
      from: "search_term_view",
      where: [buildDateWhereClause(startDate, endDate)],
      orderBy: ["metrics.cost_micros DESC"],
      limit,
    }),
  };
}

export function buildKeywordLookupQuery(): GoogleAdsNamedQuery {
  return {
    name: "keyword_lookup",
    family: "keyword_lookup",
    resource: "keyword_view",
    mergeKey: "ad_group_criterion.criterion_id",
    metrics: [],
    query: buildGoogleAdsQuery({
      select: [
        "ad_group_criterion.criterion_id",
        "ad_group_criterion.keyword.text",
      ],
      from: "keyword_view",
      where: ["ad_group_criterion.status != 'REMOVED'"],
      limit: 5000,
    }),
  };
}

export function buildKeywordCoreQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "keyword_core",
    family: "keyword_core",
    resource: "keyword_view",
    mergeKey: "ad_group_criterion.criterion_id",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
      "search_impression_share",
      "search_top_impression_share",
      "search_absolute_top_impression_share",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "ad_group_criterion.criterion_id",
        "ad_group_criterion.keyword.text",
        "ad_group_criterion.keyword.match_type",
        "ad_group_criterion.status",
        "campaign.id",
        "campaign.name",
        "ad_group.id",
        "ad_group.name",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.interactions",
        "metrics.search_impression_share",
        "metrics.search_top_impression_share",
        "metrics.search_absolute_top_impression_share",
      ],
      from: "keyword_view",
      where: [
        buildDateWhereClause(startDate, endDate),
        "ad_group_criterion.status != 'REMOVED'",
      ],
      orderBy: ["metrics.cost_micros DESC"],
      limit: 1500,
    }),
  };
}

export function buildKeywordQualityQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "keyword_quality",
    family: "keyword_quality",
    resource: "keyword_view",
    mergeKey: "ad_group_criterion.criterion_id",
    metrics: [
      "quality_score",
      "expected_ctr",
      "ad_relevance",
      "landing_page_experience",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "ad_group_criterion.criterion_id",
        "ad_group_criterion.quality_info.quality_score",
        "ad_group_criterion.quality_info.expected_click_through_rate",
        "ad_group_criterion.quality_info.ad_relevance",
        "ad_group_criterion.quality_info.landing_page_experience",
      ],
      from: "keyword_view",
      where: [
        buildDateWhereClause(startDate, endDate),
        "ad_group_criterion.status != 'REMOVED'",
      ],
      limit: 1500,
    }),
  };
}

export function buildAdCoreQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "ad_core",
    family: "ad_core",
    resource: "ad_group_ad",
    mergeKey: "ad_group_ad.ad.id",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "ad_group_ad.ad.id",
        "ad_group_ad.ad.name",
        "ad_group_ad.ad.type",
        "ad_group_ad.status",
        "campaign.id",
        "campaign.name",
        "ad_group.id",
        "ad_group.name",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.interactions",
      ],
      from: "ad_group_ad",
      where: [
        buildDateWhereClause(startDate, endDate),
        "ad_group_ad.status != 'REMOVED'",
      ],
      orderBy: ["metrics.cost_micros DESC"],
      limit: 1000,
    }),
  };
}

export function buildAdDetailQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "ad_detail",
    family: "ad_detail",
    resource: "ad_group_ad",
    mergeKey: "ad_group_ad.ad.id",
    metrics: ["ad_strength"],
    query: buildGoogleAdsQuery({
      select: [
        "ad_group_ad.ad.id",
        "ad_group_ad.ad.responsive_search_ad.headlines",
        "ad_group_ad.ad.responsive_search_ad.descriptions",
        "ad_group_ad.ad.expanded_text_ad.headline_part1",
        "ad_group_ad.ad.expanded_text_ad.headline_part2",
        "ad_group_ad.ad.expanded_text_ad.description",
        "ad_group_ad.ad_strength",
      ],
      from: "ad_group_ad",
      where: [
        buildDateWhereClause(startDate, endDate),
        "ad_group_ad.status != 'REMOVED'",
      ],
      limit: 1000,
    }),
  };
}

export function buildAssetGroupCoreQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "asset_group_core",
    family: "asset_group_core",
    resource: "asset_group",
    mergeKey: "asset_group.id",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "asset_group.id",
        "asset_group.name",
        "asset_group.status",
        // Google's own Performance Max ad-strength verdict. The design's
        // Ad strength column states it is Google-served, and it is: this is the
        // provider's enum, never a locally recomputed score.
        "asset_group.ad_strength",
        "campaign.id",
        "campaign.name",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.interactions",
      ],
      from: "asset_group",
      where: [
        buildDateWhereClause(startDate, endDate),
        "asset_group.status != 'REMOVED'",
      ],
      orderBy: ["metrics.cost_micros DESC"],
      limit: 500,
    }),
  };
}

export function buildAssetGroupAssetDetailQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "asset_group_asset_detail",
    family: "asset_group_coverage",
    resource: "asset_group_asset",
    mergeKey: "asset_group.id",
    metrics: [],
    query: buildGoogleAdsQuery({
      select: [
        "asset_group.id",
        "asset_group_asset.field_type",
        "asset.id",
        "asset.type",
      ],
      from: "asset_group_asset",
      where: [
        buildDateWhereClause(startDate, endDate),
        "asset_group_asset.status != 'REMOVED'",
      ],
      limit: 2000,
    }),
  };
}

export function buildAudienceCoreQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "audience_core",
    family: "audience_core",
    resource: "ad_group_audience_view",
    mergeKey: "ad_group_criterion.criterion_id",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "ad_group_criterion.criterion_id",
        "ad_group_criterion.type",
        "campaign.id",
        "campaign.name",
        "ad_group.id",
        "ad_group.name",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.interactions",
      ],
      from: "ad_group_audience_view",
      where: [buildDateWhereClause(startDate, endDate)],
      orderBy: ["metrics.cost_micros DESC"],
      limit: 1000,
    }),
  };
}

export function buildGeoCoreQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "geo_core",
    family: "geo_core",
    resource: "geographic_view",
    mergeKey: "geographic_view.country_criterion_id",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "geographic_view.country_criterion_id",
        "geographic_view.location_type",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.interactions",
      ],
      from: "geographic_view",
      where: [buildDateWhereClause(startDate, endDate)],
      orderBy: ["metrics.cost_micros DESC"],
      limit: 1000,
    }),
  };
}

export function buildDeviceCoreQuery(
  startDate: string,
  endDate: string
): GoogleAdsNamedQuery {
  return {
    name: "device_core",
    family: "device_core",
    resource: "campaign",
    mergeKey: "segments.device",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "segments.device",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.interactions",
      ],
      from: "campaign",
      where: [
        buildDateWhereClause(startDate, endDate),
        "campaign.status != 'REMOVED'",
      ],
    }),
  };
}

export function buildCampaignSearchTermCoreQuery(
  startDate: string,
  endDate: string,
  limit = 1000
): GoogleAdsNamedQuery {
  return {
    name: "campaign_search_term_core",
    family: "search_term_cluster_support",
    resource: "campaign_search_term_view",
    mergeKey: "campaign.id + campaign_search_term_view.search_term",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "campaign.id",
        "campaign.name",
        "campaign_search_term_view.search_term",
        "segments.search_term_match_source",
        "segments.search_term_match_type",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.interactions",
      ],
      from: "campaign_search_term_view",
      where: [
        buildDateWhereClause(startDate, endDate),
        "campaign.status != 'REMOVED'",
      ],
      orderBy: ["metrics.cost_micros DESC"],
      limit,
    }),
  };
}

export function buildAssetPerformanceCoreQuery(
  startDate: string,
  endDate: string,
  limit = 2000
): GoogleAdsNamedQuery {
  return {
    name: "asset_performance_core",
    family: "asset_core",
    resource: "asset_group_asset",
    mergeKey: "asset.id",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "asset_group.id",
        "asset_group.name",
        "campaign.id",
        "campaign.name",
        "asset_group_asset.field_type",
        // Google's own per-asset performance verdict. The design's Text assets
        // card states the rating is Google-served, and this is the field that
        // makes that true: the provider's PENDING/LEARNING/LOW/GOOD/BEST enum,
        // never a locally recomputed score. `lib/google-ads/metrics-matrix.ts`
        // has listed it as a primary metric of the assets tab all along.
        "asset_group_asset.performance_label",
        "asset.id",
        "asset.name",
        "asset.type",
        "asset.text_asset.text",
        "asset.image_asset.full_size.url",
        "asset.youtube_video_asset.youtube_video_title",
        "asset.youtube_video_asset.youtube_video_id",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.interactions",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
      ],
      from: "asset_group_asset",
      where: [
        buildDateWhereClause(startDate, endDate),
        "asset_group_asset.status != 'REMOVED'",
      ],
      orderBy: ["metrics.cost_micros DESC"],
      limit,
    }),
  };
}

export function buildAssetTextDetailQuery(): GoogleAdsNamedQuery {
  return {
    name: "asset_text_detail",
    family: "asset_metadata",
    resource: "asset",
    mergeKey: "asset.id",
    metrics: [],
    query: buildGoogleAdsQuery({
      select: [
        "asset.id",
        "asset.name",
        "asset.type",
        "asset.text_asset.text",
        "asset.youtube_video_asset.youtube_video_title",
        "asset.youtube_video_asset.youtube_video_id",
      ],
      from: "asset",
      limit: 5000,
    }),
  };
}

export function buildAssetGroupSignalQuery(): GoogleAdsNamedQuery {
  return {
    name: "asset_group_signal",
    family: "asset_group_signals",
    resource: "asset_group_signal",
    mergeKey: "asset_group.id",
    metrics: [],
    query: buildGoogleAdsQuery({
      select: [
        "asset_group.id",
        "asset_group.name",
        "campaign.id",
        "campaign.name",
        "asset_group_signal.search_theme.text",
        "asset_group_signal.approval_status",
      ],
      from: "asset_group_signal",
      limit: 2000,
    }),
  };
}

export function buildProductPerformanceQuery(
  startDate: string,
  endDate: string,
  limit = 1000
): GoogleAdsNamedQuery {
  return {
    name: "product_performance",
    family: "product_core",
    resource: "shopping_performance_view",
    mergeKey: "segments.product_item_id",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "segments.product_item_id",
        "segments.product_title",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
      ],
      from: "shopping_performance_view",
      where: [buildDateWhereClause(startDate, endDate)],
      orderBy: ["metrics.cost_micros DESC"],
      limit,
    }),
  };
}

export function buildProductPerformanceLegacyQuery(
  startDate: string,
  endDate: string,
  limit = 1000
): GoogleAdsNamedQuery {
  return {
    name: "product_performance_legacy",
    family: "product_core",
    resource: "shopping_product_view",
    mergeKey: "segments.product_item_id",
    metrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
    ],
    query: buildGoogleAdsQuery({
      select: [
        "segments.product_item_id",
        "segments.product_title",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
      ],
      from: "shopping_product_view",
      where: [buildDateWhereClause(startDate, endDate)],
      orderBy: ["metrics.cost_micros DESC"],
      limit,
    }),
  };
}

/**
 * Merchant Center per-item state, read through the Google Ads API.
 *
 * `shopping_performance_view` and `shopping_product_view` answer "what did this
 * item do", and neither carries an approval, availability or item-issue field —
 * which is why the design's Feed status column had no source. `shopping_product`
 * answers "what state is this item in", and it does it under the `adwords`
 * scope the business has already granted, so no Merchant Center re-consent and
 * no second OAuth client is involved.
 *
 * Deliberately dateless. Item state is CURRENT state, not a daily fact: adding
 * `segments.date` would multiply every item by the window and then force a
 * "which day is the truth" question the resource has no answer to. `metrics.*`
 * is likewise absent — the metrics on this screen come from the shopping
 * report, and asking twice would only let the two disagree.
 */
export function buildMerchantCenterItemStateQuery(
  limit = 5000,
): GoogleAdsNamedQuery {
  return {
    name: "merchant_center_item_state",
    family: "product_feed_state",
    resource: "shopping_product",
    mergeKey: "shopping_product.item_id",
    metrics: [],
    query: buildGoogleAdsQuery({
      select: [
        "shopping_product.merchant_center_id",
        "shopping_product.item_id",
        "shopping_product.title",
        "shopping_product.feed_label",
        "shopping_product.language_code",
        "shopping_product.channel",
        "shopping_product.availability",
        "shopping_product.status",
        "shopping_product.issues",
      ],
      from: "shopping_product",
      limit,
    }),
  };
}
