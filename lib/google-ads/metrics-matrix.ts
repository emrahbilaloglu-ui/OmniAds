export type GoogleAdsTabId =
  | "overview"
  | "campaigns"
  | "search-intelligence"
  | "search-terms"
  | "keywords"
  | "ads"
  | "assets"
  | "creatives"
  | "asset-groups"
  | "products"
  | "audiences"
  | "geo"
  | "devices"
  | "budget"
  | "opportunities";

export interface GoogleAdsMetricsMatrixEntry {
  tab: GoogleAdsTabId;
  primaryResource: string;
  mergeKey: string;
  queryFamilies: string[];
  primaryDimensions: string[];
  primaryMetrics: string[];
  fallbackMetrics?: string[];
  unavailableByDesign?: string[];
}

export const GOOGLE_ADS_METRICS_MATRIX: Record<
  GoogleAdsTabId,
  GoogleAdsMetricsMatrixEntry
> = {
  overview: {
    tab: "overview",
    primaryResource: "customer + campaign",
    mergeKey: "campaign.id",
    queryFamilies: ["customer_summary", "campaign_core_basic", "campaign_share"],
    primaryDimensions: ["customer.id", "campaign.id", "campaign.name", "campaign.channel"],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
      "search_impression_share",
      "search_budget_lost_impression_share",
      "search_rank_lost_impression_share",
      "search_top_impression_share",
      "search_absolute_top_impression_share",
      "top_impression_percentage",
      "absolute_top_impression_percentage",
    ],
    fallbackMetrics: [
      "ctr",
      "average_cpc",
      "average_cost",
      "conversion_rate",
      "cost_per_conversion",
      "value_per_conversion",
      "roas",
    ],
  },
  campaigns: {
    tab: "campaigns",
    primaryResource: "campaign",
    mergeKey: "campaign.id",
    queryFamilies: ["campaign_core_basic", "campaign_share", "campaign_budget"],
    primaryDimensions: [
      "campaign.id",
      "campaign.name",
      "campaign.status",
      "campaign.advertising_channel_type",
      "campaign.serving_status",
    ],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    fallbackMetrics: [
      "search_impression_share",
      "search_budget_lost_impression_share",
      "search_rank_lost_impression_share",
      "search_top_impression_share",
      "search_absolute_top_impression_share",
      "top_impression_percentage",
      "absolute_top_impression_percentage",
    ],
  },
  "search-intelligence": {
    tab: "search-intelligence",
    primaryResource: "search_term_view + campaign_search_term_view",
    mergeKey: "search term + campaign",
    queryFamilies: ["search_term_core", "campaign_search_term_core", "keyword_lookup"],
    primaryDimensions: [
      "search_term_view.search_term",
      "campaign_search_term_view.search_term",
      "campaign.id",
      "campaign.name",
    ],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    fallbackMetrics: ["ctr", "conversion_rate", "cost_per_conversion", "roas"],
  },
  "search-terms": {
    tab: "search-terms",
    primaryResource: "search_term_view",
    mergeKey: "search_term_view.search_term + campaign.id + ad_group.id",
    queryFamilies: ["search_term_core", "keyword_lookup"],
    primaryDimensions: [
      "search_term_view.search_term",
      "campaign.id",
      "campaign.name",
      "ad_group.id",
      "ad_group.name",
    ],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
    ],
    fallbackMetrics: ["ctr", "average_cpc", "conversion_rate", "cost_per_conversion", "value_per_conversion", "roas"],
  },
  keywords: {
    tab: "keywords",
    primaryResource: "keyword_view",
    mergeKey: "ad_group_criterion.criterion_id",
    queryFamilies: ["keyword_core", "keyword_quality"],
    primaryDimensions: [
      "ad_group_criterion.criterion_id",
      "ad_group_criterion.keyword.text",
      "ad_group_criterion.keyword.match_type",
      "campaign.id",
      "campaign.name",
      "ad_group.id",
      "ad_group.name",
    ],
    primaryMetrics: [
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
    fallbackMetrics: [
      "ctr",
      "average_cpc",
      "average_cost",
      "conversion_rate",
      "cost_per_conversion",
      "value_per_conversion",
      "roas",
      "quality_score",
      "expected_ctr",
      "ad_relevance",
      "landing_page_experience",
    ],
  },
  ads: {
    tab: "ads",
    primaryResource: "ad_group_ad",
    mergeKey: "ad_group_ad.ad.id",
    queryFamilies: ["ad_core", "ad_detail"],
    primaryDimensions: [
      "ad_group_ad.ad.id",
      "ad_group_ad.ad.type",
      "campaign.id",
      "campaign.name",
      "ad_group.id",
      "ad_group.name",
    ],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
      "ad_strength",
    ],
    fallbackMetrics: ["ctr", "average_cpc", "conversion_rate", "cost_per_conversion", "value_per_conversion", "roas"],
  },
  assets: {
    tab: "assets",
    primaryResource: "asset_group_asset + asset",
    mergeKey: "asset.id + asset_group.id",
    queryFamilies: ["asset_performance_core", "asset_text_detail"],
    primaryDimensions: [
      "asset.id",
      "asset.name",
      "asset.type",
      "asset_group.id",
      "asset_group.name",
      "campaign.id",
      "campaign.name",
    ],
    primaryMetrics: [
      "impressions",
      "clicks",
      "interactions",
      "cost_micros",
      "conversions",
      "conversions_value",
      "performance_label",
    ],
    fallbackMetrics: ["ctr", "interaction_rate", "conversion_rate", "roas"],
    unavailableByDesign: ["uniform_asset_preview_url"],
  },
  creatives: {
    tab: "creatives",
    primaryResource: "asset_group + asset_group_asset",
    mergeKey: "asset_group.id",
    queryFamilies: ["asset_group_core", "asset_group_asset_detail"],
    primaryDimensions: [
      "asset_group.id",
      "asset_group.name",
      "campaign.id",
      "campaign.name",
      "asset_group_asset.field_type",
      "asset.id",
      "asset.type",
    ],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    fallbackMetrics: ["ctr", "average_cpc", "conversion_rate", "cost_per_conversion", "value_per_conversion", "roas"],
    unavailableByDesign: [
      "creative_thumbnail",
      "visual_asset_level_spend",
      "asset_level_conversion_value",
    ],
  },
  "asset-groups": {
    tab: "asset-groups",
    primaryResource: "asset_group + asset_group_asset + asset_group_signal",
    mergeKey: "asset_group.id",
    queryFamilies: ["asset_group_core", "asset_group_asset_detail", "asset_group_signal"],
    primaryDimensions: [
      "asset_group.id",
      "asset_group.name",
      "campaign.id",
      "campaign.name",
    ],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    fallbackMetrics: ["ctr", "conversion_rate", "roas"],
    unavailableByDesign: ["asset_group_level_search_theme_performance_metrics"],
  },
  products: {
    tab: "products",
    primaryResource: "shopping_performance_view",
    mergeKey: "shopping_product.item_id",
    queryFamilies: ["product_performance"],
    primaryDimensions: [
      "shopping_product.item_id",
      "shopping_product.title",
      "shopping_product.brand",
    ],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
    ],
    fallbackMetrics: ["ctr", "cpa", "roas", "value_per_click"],
    unavailableByDesign: ["true_margin", "true_cogs"],
  },
  audiences: {
    tab: "audiences",
    primaryResource: "ad_group_audience_view",
    mergeKey: "ad_group_criterion.criterion_id",
    queryFamilies: ["audience_core", "audience_user_list"],
    primaryDimensions: [
      "ad_group_criterion.criterion_id",
      "ad_group_criterion.type",
      "campaign.id",
      "campaign.name",
      "ad_group.id",
      "ad_group.name",
      // Joined from `ad_group_criterion` → `user_list`: the list's own name and
      // the two membership sizes Google serves, one per network.
      "ad_group_criterion.user_list.user_list",
      "user_list.name",
      "user_list.size_for_display",
      "user_list.size_for_search",
    ],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    fallbackMetrics: ["ctr", "average_cpc", "conversion_rate", "cost_per_conversion", "value_per_conversion", "roas"],
    // A user-list audience now carries `user_list.name` and a served size. The
    // audience types that are not lists — affinity, in-market, life events —
    // still have neither on any resource, so their name stays the criterion id
    // and their size stays the em dash.
    unavailableByDesign: [
      "stable_audience_display_name_for_non_user_list_audiences",
      "audience_size_for_non_user_list_audiences",
    ],
  },
  geo: {
    tab: "geo",
    primaryResource: "geographic_view",
    mergeKey: "geographic_view.country_criterion_id",
    queryFamilies: ["geo_core"],
    primaryDimensions: [
      "geographic_view.country_criterion_id",
      "geographic_view.location_type",
    ],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    fallbackMetrics: ["ctr", "average_cpc", "conversion_rate", "cost_per_conversion", "value_per_conversion", "roas"],
  },
  devices: {
    tab: "devices",
    primaryResource: "campaign segmented by device",
    mergeKey: "segments.device",
    queryFamilies: ["device_core"],
    primaryDimensions: ["segments.device"],
    primaryMetrics: [
      "impressions",
      "clicks",
      "cost_micros",
      "conversions",
      "conversions_value",
      "interactions",
    ],
    fallbackMetrics: ["ctr", "average_cpc", "conversion_rate", "cost_per_conversion", "value_per_conversion", "roas"],
  },
  budget: {
    tab: "budget",
    primaryResource: "campaign + campaign_budget",
    mergeKey: "campaign.id",
    queryFamilies: [
      "campaign_budget",
      "campaign_share",
      "campaign_core_basic",
    ],
    primaryDimensions: [
      "campaign.id",
      "campaign.name",
      "campaign_budget.amount_micros",
      "campaign.serving_status",
    ],
    primaryMetrics: [
      "cost_micros",
      "conversions",
      "conversions_value",
      "search_impression_share",
      "search_budget_lost_impression_share",
      "search_rank_lost_impression_share",
      "top_impression_percentage",
      "absolute_top_impression_percentage",
    ],
  },
  opportunities: {
    tab: "opportunities",
    primaryResource: "derived from campaign + keyword + search term + ad + device + audience families",
    mergeKey: "derived",
    queryFamilies: [
      "campaign_core_basic",
      "campaign_share",
      "keyword_core",
      "keyword_quality",
      "search_term_core",
      "ad_core",
      "device_core",
      "audience_core",
    ],
    primaryDimensions: ["derived"],
    primaryMetrics: [
      "all_supported_core_metrics_consumed_from_other_tabs",
    ],
  },
};
