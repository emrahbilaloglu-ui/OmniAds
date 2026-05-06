import type {
  AiTagKey,
  CopySourceLabel,
  CreativeDebugInfo,
  CreativeFormat,
  GroupBy,
  LegacyPreviewState,
  MetaAccountMeta,
  MetaActionValue,
  MetaAdRecord,
  MetaAiTags,
  PreviewAuditSample,
  RawCreativeRow,
  SortKey,
} from "@/lib/meta/creatives-types";
import {
  aggregateCreativeTaxonomy,
  classifyMetaCreative,
  deriveCreativeFormat,
  deriveLegacyCreativeType,
  getLegacyCreativeTypeLabel,
} from "@/lib/meta/creative-taxonomy";
import { normalizeMediaUrl, extractPostIdFromStoryIdentifier, extractVideoIdsFromCreative } from "@/lib/meta/creatives-utils";
import { buildNormalizedPreview, extractImageHashesFromCreative, resolveThumbnailUrl } from "@/lib/meta/creatives-preview";
import {
  resolveCreativeCopyExtraction,
  normalizeCopyText,
  uniqueNormalizedText,
  mergeDebugSources,
  buildCreativeDebugInfo,
} from "@/lib/meta/creatives-copy";
import { logRuntimeDebug } from "@/lib/runtime-logging";

export function r2(n: number) {
  return Math.round(n * 100) / 100;
}

function parseMetaBudgetAmount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return r2(parsed / 100);
}

export function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function nDaysAgo(n: number) {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return date;
}

export function simpleHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function cleanDate(value?: string | null): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function normalizeActionType(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function parseAction(arr: MetaActionValue[] | undefined, type: string): number {
  if (!Array.isArray(arr)) return 0;
  const target = normalizeActionType(type);
  let total = 0;
  for (const item of arr) {
    const actionType = typeof item?.action_type === "string" ? normalizeActionType(item.action_type) : "";
    if (actionType !== target) continue;
    total += parseFloat(item.value) || 0;
  }
  return total;
}

export function parseActionAny(arr: MetaActionValue[] | undefined, candidates: string[]): number {
  for (const candidate of candidates) {
    const value = parseAction(arr, candidate);
    if (value > 0) return value;
  }
  return 0;
}

function parseActionTotal(arr: MetaActionValue[] | undefined): number {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((total, item) => total + (parseFloat(item?.value ?? "0") || 0), 0);
}

export function parsePurchaseCount(actions: MetaActionValue[] | undefined): number {
  return parseActionAny(actions, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "offsite_conversion_fb_pixel_purchase",
  ]);
}

export function parsePurchaseValue(values: MetaActionValue[] | undefined): number {
  return parseActionAny(values, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "offsite_conversion_fb_pixel_purchase",
  ]);
}

export function parsePurchaseRoas(roas: MetaActionValue[] | undefined): number {
  return parseActionAny(roas, ["purchase", "omni_purchase"]);
}

export function parseLeadCount(actions: MetaActionValue[] | undefined): number {
  return parseActionAny(actions, [
    "lead",
    "onsite_conversion.lead",
    "offsite_conversion.fb_pixel_lead",
    "offsite_conversion_fb_pixel_lead",
  ]);
}

export function parseMessagingConversationCount(actions: MetaActionValue[] | undefined): number {
  return parseActionAny(actions, [
    "onsite_conversion.messaging_conversation_started_7d",
    "onsite_conversion.total_messaging_connection",
    "messaging_conversation_started_7d",
  ]);
}

export function mergeCreativeData(
  baseCreative: MetaAdRecord["creative"],
  detailCreative: NonNullable<MetaAdRecord["creative"]> | undefined
): MetaAdRecord["creative"] {
  if (!baseCreative && !detailCreative) return null;
  if (!baseCreative) return detailCreative ?? null;
  if (!detailCreative) return baseCreative;

  const preferNonEmptyArray = <T>(
    detailItems: T[] | null | undefined,
    baseItems: T[] | null | undefined
  ): T[] | null => {
    if (Array.isArray(detailItems) && detailItems.length > 0) return detailItems;
    if (Array.isArray(baseItems) && baseItems.length > 0) return baseItems;
    return null;
  };

  const mergeTemplateData = (
    baseTemplate: Record<string, unknown> | null | undefined,
    detailTemplate: Record<string, unknown> | null | undefined
  ): Record<string, unknown> | null => {
    const hasBase = Boolean(baseTemplate && Object.keys(baseTemplate).length > 0);
    const hasDetail = Boolean(detailTemplate && Object.keys(detailTemplate).length > 0);
    if (!hasBase && !hasDetail) return null;
    if (!hasBase) return detailTemplate ?? null;
    if (!hasDetail) return baseTemplate ?? null;
    return {
      ...baseTemplate,
      ...detailTemplate,
    };
  };

  const mergeCallToAction = <
    T extends {
      type?: string | null;
      value?: { link?: string | null } | null;
    } | null | undefined,
  >(
    baseCallToAction: T,
    detailCallToAction: T
  ) => {
    if (!baseCallToAction && !detailCallToAction) return null;
    if (!baseCallToAction) return detailCallToAction ?? null;
    if (!detailCallToAction) return baseCallToAction ?? null;
    return {
      ...baseCallToAction,
      ...detailCallToAction,
      value: detailCallToAction.value ?? baseCallToAction.value ?? null,
    };
  };

  const mergeLinkData = (
    baseLinkData: NonNullable<NonNullable<MetaAdRecord["creative"]>["object_story_spec"]>["link_data"],
    detailLinkData: NonNullable<NonNullable<MetaAdRecord["creative"]>["object_story_spec"]>["link_data"]
  ) => {
    if (!baseLinkData && !detailLinkData) return null;
    if (!baseLinkData) return detailLinkData ?? null;
    if (!detailLinkData) return baseLinkData ?? null;
    return {
      ...baseLinkData,
      ...detailLinkData,
      call_to_action: mergeCallToAction(baseLinkData.call_to_action, detailLinkData.call_to_action),
      child_attachments: preferNonEmptyArray(detailLinkData.child_attachments, baseLinkData.child_attachments),
    };
  };

  const mergeVideoData = (
    baseVideoData: NonNullable<NonNullable<MetaAdRecord["creative"]>["object_story_spec"]>["video_data"],
    detailVideoData: NonNullable<NonNullable<MetaAdRecord["creative"]>["object_story_spec"]>["video_data"]
  ) => {
    if (!baseVideoData && !detailVideoData) return null;
    if (!baseVideoData) return detailVideoData ?? null;
    if (!detailVideoData) return baseVideoData ?? null;
    return {
      ...baseVideoData,
      ...detailVideoData,
      call_to_action: mergeCallToAction(baseVideoData.call_to_action, detailVideoData.call_to_action),
    };
  };

  const mergePhotoData = (
    basePhotoData: NonNullable<NonNullable<MetaAdRecord["creative"]>["object_story_spec"]>["photo_data"],
    detailPhotoData: NonNullable<NonNullable<MetaAdRecord["creative"]>["object_story_spec"]>["photo_data"]
  ) => {
    if (!basePhotoData && !detailPhotoData) return null;
    if (!basePhotoData) return detailPhotoData ?? null;
    if (!detailPhotoData) return basePhotoData ?? null;
    return {
      ...basePhotoData,
      ...detailPhotoData,
      call_to_action: mergeCallToAction(basePhotoData.call_to_action, detailPhotoData.call_to_action),
    };
  };

  const mergeObjectStorySpec = (
    baseStorySpec: NonNullable<MetaAdRecord["creative"]>["object_story_spec"],
    detailStorySpec: NonNullable<MetaAdRecord["creative"]>["object_story_spec"]
  ) => {
    if (!baseStorySpec && !detailStorySpec) return null;
    if (!baseStorySpec) return detailStorySpec ?? null;
    if (!detailStorySpec) return baseStorySpec ?? null;
    return {
      ...baseStorySpec,
      ...detailStorySpec,
      link_data: mergeLinkData(baseStorySpec.link_data, detailStorySpec.link_data),
      video_data: mergeVideoData(baseStorySpec.video_data, detailStorySpec.video_data),
      photo_data: mergePhotoData(baseStorySpec.photo_data, detailStorySpec.photo_data),
      template_data: mergeTemplateData(baseStorySpec.template_data, detailStorySpec.template_data),
    };
  };

  const mergeAssetFeedSpec = (
    baseAssetFeedSpec: NonNullable<MetaAdRecord["creative"]>["asset_feed_spec"],
    detailAssetFeedSpec: NonNullable<MetaAdRecord["creative"]>["asset_feed_spec"]
  ) => {
    if (!baseAssetFeedSpec && !detailAssetFeedSpec) return null;
    if (!baseAssetFeedSpec) return detailAssetFeedSpec ?? null;
    if (!detailAssetFeedSpec) return baseAssetFeedSpec ?? null;
    return {
      ...baseAssetFeedSpec,
      ...detailAssetFeedSpec,
      catalog_id: detailAssetFeedSpec.catalog_id ?? baseAssetFeedSpec.catalog_id ?? null,
      product_set_id: detailAssetFeedSpec.product_set_id ?? baseAssetFeedSpec.product_set_id ?? null,
      bodies: preferNonEmptyArray(detailAssetFeedSpec.bodies, baseAssetFeedSpec.bodies),
      titles: preferNonEmptyArray(detailAssetFeedSpec.titles, baseAssetFeedSpec.titles),
      descriptions: preferNonEmptyArray(detailAssetFeedSpec.descriptions, baseAssetFeedSpec.descriptions),
      images: preferNonEmptyArray(detailAssetFeedSpec.images, baseAssetFeedSpec.images),
      videos: preferNonEmptyArray(detailAssetFeedSpec.videos, baseAssetFeedSpec.videos),
    };
  };

  return {
    ...baseCreative,
    ...detailCreative,
    // Keep whichever source has a non-null media URL.
    thumbnail_id: detailCreative.thumbnail_id ?? baseCreative.thumbnail_id ?? null,
    thumbnail_url: detailCreative.thumbnail_url ?? baseCreative.thumbnail_url ?? null,
    image_url: detailCreative.image_url ?? baseCreative.image_url ?? null,
    image_hash: detailCreative.image_hash ?? baseCreative.image_hash ?? null,
    object_story_spec: mergeObjectStorySpec(baseCreative.object_story_spec, detailCreative.object_story_spec),
    asset_feed_spec: mergeAssetFeedSpec(baseCreative.asset_feed_spec, detailCreative.asset_feed_spec),
  };
}

export function hasSuspiciousMissingFunnelMetrics(rows: { link_clicks: number; purchases: number; landing_page_views: number; initiate_checkout: number }[]): boolean {
  if (!Array.isArray(rows) || rows.length < 5) return false;
  const totals = rows.reduce(
    (acc, row) => {
      acc.linkClicks += Number.isFinite(row.link_clicks) ? row.link_clicks : 0;
      acc.purchases += Number.isFinite(row.purchases) ? row.purchases : 0;
      acc.landingPageViews += Number.isFinite(row.landing_page_views) ? row.landing_page_views : 0;
      acc.initiateCheckout += Number.isFinite(row.initiate_checkout) ? row.initiate_checkout : 0;
      return acc;
    },
    { linkClicks: 0, purchases: 0, landingPageViews: 0, initiateCheckout: 0 }
  );

  // If account has real traffic/conversions but funnel metrics are universally zero,
  // a stale/incomplete snapshot is likely; prefer live fetch for this request.
  return totals.linkClicks > 0 && totals.purchases > 0 && totals.landingPageViews === 0 && totals.initiateCheckout === 0;
}

export function hasSuspiciousMissingCatalogRevenueMetrics(
  rows: Array<{
    is_catalog: boolean;
    spend: number;
    purchases: number;
    purchase_value: number;
    roas: number;
  }>
): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.some(
    (row) =>
      row.is_catalog &&
      row.spend > 0 &&
      row.purchases > 0 &&
      row.purchase_value <= 0 &&
      row.roas <= 0
  );
}

export function resolvePreviewOrigin(input: {
  cachedThumbnailUrl: string | null;
  finalPreviewUrl: string | null;
  rowPreviewUrl: string | null;
  finalThumbnailUrl: string | null;
  finalImageUrl: string | null;
}): "snapshot" | "cache" | "live" | "fallback" {
  if (input.cachedThumbnailUrl) return "cache";
  if (input.rowPreviewUrl) return "live";
  if (input.finalThumbnailUrl || input.finalImageUrl || input.finalPreviewUrl) return "fallback";
  return "snapshot";
}

export function toRawRow(
  insight: {
    ad_id?: string;
    ad_name?: string;
    campaign_id?: string;
    campaign_name?: string;
    adset_id?: string;
    adset_name?: string;
    spend?: string;
    cpm?: string;
    cpc?: string;
    ctr?: string;
    clicks?: string;
    impressions?: string;
    reach?: string;
    frequency?: string;
    inline_link_clicks?: string;
    outbound_clicks?: MetaActionValue[];
    attribution_setting?: string;
    quality_ranking?: string;
    engagement_rate_ranking?: string;
    conversion_rate_ranking?: string;
    date_start?: string;
    actions?: MetaActionValue[];
    action_values?: MetaActionValue[];
    purchase_roas?: MetaActionValue[];
    video_play_actions?: MetaActionValue[];
    video_p25_watched_actions?: MetaActionValue[];
    video_p50_watched_actions?: MetaActionValue[];
    video_p75_watched_actions?: MetaActionValue[];
    video_p100_watched_actions?: MetaActionValue[];
  },
  ad: MetaAdRecord | undefined,
  accountMeta: MetaAccountMeta,
  imageHashLookup: Map<string, string>,
  videoSourceLookup: Map<string, { source: string | null; picture: string | null }>,
  debugContext?: {
    enabled?: boolean;
    fetchSource?: string | null;
    hasRawAd?: boolean;
    rawAdId?: string | null;
    rawAdCreative?: boolean;
    rawAdCreativeThumbnailUrl?: string | null;
    enrichedAdCreative?: boolean;
    enrichedAdCreativeThumbnailUrl?: string | null;
    rawCreativeThumbnailUrl?: string | null;
    enrichedCreativeThumbnailUrl?: string | null;
  }
): RawCreativeRow | null {
  const adId = insight.ad_id ?? ad?.id ?? "";
  if (!adId) return null;

  const spend = parseFloat(insight.spend ?? "0") || 0;
  const purchases = Math.round(parsePurchaseCount(insight.actions));
  const purchaseValue = parsePurchaseValue(insight.action_values);
  const purchaseRoas = parsePurchaseRoas(insight.purchase_roas);
  const derivedPurchaseValue = purchaseValue > 0 ? purchaseValue : spend * purchaseRoas;
  const cpa = purchases > 0 ? spend / purchases : 0;

  const linkClicks = parseActionAny(insight.actions, ["link_click", "omni_link_click"]);
  const cpcFromInsight = parseFloat(insight.cpc ?? "0") || 0;
  const cpcLink = linkClicks > 0 ? spend / linkClicks : cpcFromInsight;
  const cpm = parseFloat(insight.cpm ?? "0") || 0;
  const ctrAll = parseFloat(insight.ctr ?? "0") || 0;
  const clicks = Math.round(parseFloat(insight.clicks ?? "0") || 0);

  const impressions = parseFloat(insight.impressions ?? "0") || 0;
  const reach = parseFloat(insight.reach ?? "0") || impressions;
  const frequency = parseFloat(insight.frequency ?? "0") || null;
  const inlineLinkClicks = parseFloat(insight.inline_link_clicks ?? "0") || 0;
  const effectiveLinkClicks = linkClicks || inlineLinkClicks;
  const outboundClicks = Math.round(
    parseActionAny(insight.outbound_clicks, ["outbound_click", "omni_outbound_click"]),
  );
  const landingPageViews = Math.round(
    parseActionAny(insight.actions, [
      "landing_page_view",
      "omni_landing_page_view",
      "offsite_conversion.fb_pixel_landing_page_view",
      "offsite_conversion_fb_pixel_landing_page_view",
    ])
  );
  const addToCart = Math.round(
    parseActionAny(insight.actions, [
      "omni_add_to_cart",
      "add_to_cart",
      "fb_mobile_add_to_cart",
      "offsite_conversion.fb_pixel_add_to_cart",
      "offsite_conversion_fb_pixel_add_to_cart",
    ])
  );
  const initiateCheckout = Math.round(
    parseActionAny(insight.actions, [
      "omni_initiated_checkout",
      "initiated_checkout",
      "initiate_checkout",
      "fb_mobile_initiated_checkout",
      "fb_mobile_initiate_checkout",
      "offsite_conversion.fb_pixel_initiate_checkout",
      "offsite_conversion_fb_pixel_initiate_checkout",
      "offsite_conversion.fb_pixel_initiated_checkout",
      "offsite_conversion_fb_pixel_initiated_checkout",
    ])
  );
  const video3sViews = parseFloat(insight.video_play_actions?.[0]?.value ?? "0") || 0;
  const video25Views = parseFloat(insight.video_p25_watched_actions?.[0]?.value ?? "0") || 0;
  const video50Views = parseFloat(insight.video_p50_watched_actions?.[0]?.value ?? "0") || 0;
  const video75Views = parseFloat(insight.video_p75_watched_actions?.[0]?.value ?? "0") || 0;
  const video100Views = parseFloat(insight.video_p100_watched_actions?.[0]?.value ?? "0") || 0;
  const allActionTotal = parseActionTotal(insight.actions);
  const hasRetainedZeroSpendActivity =
    impressions > 0 ||
    reach > 0 ||
    clicks > 0 ||
    effectiveLinkClicks > 0 ||
    outboundClicks > 0 ||
    purchases > 0 ||
    purchaseValue > 0 ||
    landingPageViews > 0 ||
    addToCart > 0 ||
    initiateCheckout > 0 ||
    allActionTotal > 0 ||
    video3sViews > 0 ||
    video25Views > 0 ||
    video50Views > 0 ||
    video75Views > 0 ||
    video100Views > 0;
  if (spend <= 0 && !hasRetainedZeroSpendActivity) return null;

  const thumbstop = impressions > 0 ? r2((video3sViews / impressions) * 100) : 0;
  const clickToAtc = effectiveLinkClicks > 0 ? r2((addToCart / effectiveLinkClicks) * 100) : 0;
  const atcToPurchase = addToCart > 0 ? r2((purchases / addToCart) * 100) : 0;
  const video25Rate = impressions > 0 ? r2((video25Views / impressions) * 100) : 0;
  const video50Rate = impressions > 0 ? r2((video50Views / impressions) * 100) : 0;
  const video75Rate = impressions > 0 ? r2((video75Views / impressions) * 100) : 0;
  const video100Rate = impressions > 0 ? r2((video100Views / impressions) * 100) : 0;

  const creative = ad?.creative ?? null;
  const promotedObject = ad?.promoted_object ?? ad?.adset?.promoted_object ?? null;
  const normalizedPreview = buildNormalizedPreview({
    creative,
    promotedObject,
    imageHashLookup,
    videoSourceLookup,
  });
  const resolvedThumbnail = resolveThumbnailUrl({ creative });
  const finalThumbnail = normalizedPreview.tiers.table_thumbnail_url ?? normalizedPreview.legacy.thumbnail_url ?? resolvedThumbnail.url;
  const finalCardPreview = normalizedPreview.tiers.card_preview_url ?? normalizedPreview.tiers.preview_image_url ?? null;
  const finalImage =
    normalizedPreview.tiers.image_url ??
    normalizedPreview.legacy.image_url ??
    normalizeMediaUrl(creative?.image_url ?? null) ??
    finalCardPreview ??
    finalThumbnail;
  const finalPreview =
    normalizedPreview.tiers.preview_url ??
    normalizedPreview.legacy.preview_url ??
    finalCardPreview ??
    finalImage ??
    finalThumbnail;
  const finalPreviewImage = normalizedPreview.tiers.preview_image_url ?? finalImage ?? finalCardPreview ?? finalThumbnail;
  const finalPreviewPoster = normalizedPreview.tiers.preview_poster_url ?? finalCardPreview ?? finalPreviewImage ?? finalThumbnail;
  const finalPreviewState: LegacyPreviewState = finalPreview ? "preview" : "unavailable";
  const stageNullReason =
    finalThumbnail
      ? null
      : !debugContext?.hasRawAd
      ? "ad_lookup_miss"
      : !debugContext?.rawAdCreative
      ? "raw_ad_creative_missing"
      : !debugContext?.enrichedAdCreative
      ? "enriched_ad_creative_missing"
      : !finalPreview
      ? "no_resolved_media_url"
      : "unknown";

  if (debugContext?.enabled) {
    logRuntimeDebug("meta-creatives", "thumb_trace_row_pipeline", {
      ad_id: adId,
      creative_id: creative?.id ?? null,
      debug_raw_creative_thumbnail_url: debugContext.rawCreativeThumbnailUrl ?? null,
      debug_enriched_creative_thumbnail_url: debugContext.enrichedCreativeThumbnailUrl ?? null,
      debug_build_input_creative_thumbnail_url: normalizeMediaUrl(creative?.thumbnail_url ?? null),
      debug_build_input_creative_image_url: normalizeMediaUrl(creative?.image_url ?? null),
      debug_resolved_thumbnail_source: resolvedThumbnail.source,
      debug_resolved_thumbnail_url: resolvedThumbnail.url,
      debug_final_thumbnail_url: finalThumbnail,
      debug_final_image_url: finalImage,
      debug_final_preview_url: finalPreview,
      debug_final_preview_state: finalPreviewState,
      is_catalog: normalizedPreview.legacy.is_catalog,
    });
  }
  const creativeTaxonomy = classifyMetaCreative({
    creative,
    promotedObject,
  });
  const format: CreativeFormat = deriveCreativeFormat(creativeTaxonomy);
  const creativeType = deriveLegacyCreativeType(creativeTaxonomy.creative_primary_type);

  const launchDate = cleanDate(ad?.created_time) || cleanDate(insight.date_start) || toISODate(new Date());
  const name = insight.ad_name ?? ad?.name ?? creative?.name ?? "Unnamed ad";
  const copyExtraction = resolveCreativeCopyExtraction(creative);
  const creativeId = creative?.id ?? adId;
  const imageHashes = extractImageHashesFromCreative(creative);
  const objectStoryId =
    typeof creative?.object_story_id === "string" && creative.object_story_id.trim().length > 0
      ? creative.object_story_id.trim()
      : typeof ad?.object_story_id === "string" && ad.object_story_id.trim().length > 0
      ? ad.object_story_id.trim()
      : null;
  const effectiveObjectStoryId =
    typeof creative?.effective_object_story_id === "string" && creative.effective_object_story_id.trim().length > 0
      ? creative.effective_object_story_id.trim()
      : typeof ad?.effective_object_story_id === "string" && ad.effective_object_story_id.trim().length > 0
      ? ad.effective_object_story_id.trim()
      : null;
  const postId =
    extractPostIdFromStoryIdentifier(objectStoryId) ??
    extractPostIdFromStoryIdentifier(effectiveObjectStoryId) ??
    null;

  const rowDebugBase = buildCreativeDebugInfo({
    debug_stage_fetch_source: debugContext?.fetchSource ?? null,
    debug_stage_has_raw_ad: Boolean(debugContext?.hasRawAd),
    debug_stage_raw_ad_id: debugContext?.rawAdId ?? null,
    debug_stage_raw_ad_creative: Boolean(debugContext?.rawAdCreative),
    debug_stage_raw_ad_creative_thumbnail_url: debugContext?.rawAdCreativeThumbnailUrl ?? null,
    debug_stage_enriched_ad_creative: Boolean(debugContext?.enrichedAdCreative),
    debug_stage_enriched_ad_creative_thumbnail_url: debugContext?.enrichedAdCreativeThumbnailUrl ?? null,
    debug_stage_row_input_thumbnail_url: normalizeMediaUrl(creative?.thumbnail_url ?? null),
    debug_stage_final_thumbnail_url: finalThumbnail,
    debug_stage_null_reason: stageNullReason,
    debug_raw_creative_thumbnail_url: debugContext?.rawCreativeThumbnailUrl ?? null,
    debug_enriched_creative_thumbnail_url: debugContext?.enrichedCreativeThumbnailUrl ?? null,
    debug_resolved_thumbnail_source: resolvedThumbnail.source,
    debug_resolution_stage: null,
    debug_creative_object_type: creative?.object_type ?? null,
    debug_creative_video_ids: extractVideoIdsFromCreative(creative),
    debug_creative_effective_object_story_id:
      typeof creative?.effective_object_story_id === "string" ? creative.effective_object_story_id : null,
    debug_creative_object_story_id:
      typeof creative?.object_story_id === "string" ? creative.object_story_id : null,
    debug_creative_object_story_video_id:
      typeof creative?.object_story_spec?.video_data?.video_id === "string"
        ? creative.object_story_spec.video_data.video_id
        : null,
    debug_creative_asset_video_ids: (creative?.asset_feed_spec?.videos ?? [])
      .map((video) => (typeof video?.video_id === "string" ? video.video_id : null))
      .filter((videoId): videoId is string => Boolean(videoId)),
  });

  // Merge preview debug patch — preview fields take precedence over base defaults
  const debug: CreativeDebugInfo = {
    ...rowDebugBase,
    ...normalizedPreview.debug,
  };

  return {
    id: adId,
    creative_id: creativeId,
    object_story_id: objectStoryId,
    effective_object_story_id: effectiveObjectStoryId,
    post_id: postId,
    associated_ads_count: 1,
    account_id: accountMeta.id,
    account_name: accountMeta.name,
    campaign_id: insight.campaign_id ?? ad?.campaign?.id ?? null,
    campaign_name: insight.campaign_name ?? ad?.campaign?.name ?? null,
    currency: accountMeta.currency,
    adset_id: insight.adset_id ?? ad?.adset_id ?? ad?.adset?.id ?? null,
    adset_name: insight.adset_name ?? ad?.adset?.name ?? null,
    name,
    copy_text: copyExtraction.copy_text,
    copy_variants: copyExtraction.copy_variants,
    headline_variants: copyExtraction.headline_variants,
    description_variants: copyExtraction.description_variants,
    copy_source: copyExtraction.copy_source,
    copy_debug_sources: copyExtraction.copy_source ? [copyExtraction.copy_source] : [],
    unresolved_reason:
      copyExtraction.copy_text || copyExtraction.copy_variants.length > 0 || copyExtraction.headline_variants.length > 0 || copyExtraction.description_variants.length > 0
        ? null
        : "no_structured_creative_text",
    preview_url: finalPreview,
    preview_source: normalizedPreview.legacy.preview_source,
    thumbnail_url: finalThumbnail,
    image_url: finalImage,
    table_thumbnail_url: finalThumbnail,
    card_preview_url: finalCardPreview ?? finalImage ?? finalPreview ?? finalThumbnail,
    is_catalog: normalizedPreview.legacy.is_catalog,
    preview_state: finalPreviewState,
    preview: {
      ...normalizedPreview.preview,
      image_url: finalPreviewImage,
      poster_url: finalPreviewPoster,
    },
    image_hash: imageHashes[0] ?? null,
    image_hashes: imageHashes,
    launch_date: launchDate,
    tags: [],
    ai_tags: {},
    format,
    creative_type: creativeType,
    creative_type_label: getLegacyCreativeTypeLabel(creativeType),
    creative_delivery_type: creativeTaxonomy.creative_delivery_type,
    creative_visual_format: creativeTaxonomy.creative_visual_format,
    creative_primary_type: creativeTaxonomy.creative_primary_type,
    creative_primary_label: creativeTaxonomy.creative_primary_label,
    creative_secondary_type: creativeTaxonomy.creative_secondary_type,
    creative_secondary_label: creativeTaxonomy.creative_secondary_label,
    classification_signals: creativeTaxonomy.classification_signals,
    spend: r2(spend),
    purchase_value: r2(derivedPurchaseValue),
    roas: r2(spend > 0 && derivedPurchaseValue > 0 ? derivedPurchaseValue / spend : 0),
    cpa: r2(cpa),
    clicks,
    cpc_link: r2(cpcLink),
    cpm: r2(cpm),
    ctr_all: r2(ctrAll),
    purchases,
    impressions,
    reach,
    frequency,
    link_clicks: effectiveLinkClicks,
    outbound_clicks: outboundClicks,
    effective_status: ad?.effective_status ?? ad?.status ?? null,
    objective: ad?.campaign?.objective ?? null,
    attribution_setting: insight.attribution_setting ?? ad?.attribution_setting ?? null,
    quality_ranking: insight.quality_ranking ?? null,
    engagement_rate_ranking: insight.engagement_rate_ranking ?? null,
    conversion_rate_ranking: insight.conversion_rate_ranking ?? null,
    bid_strategy: ad?.bid_strategy ?? ad?.adset?.bid_strategy ?? ad?.campaign?.bid_strategy ?? null,
    optimization_goal: ad?.optimization_goal ?? ad?.adset?.optimization_goal ?? null,
    campaign_daily_budget: parseMetaBudgetAmount(ad?.campaign?.daily_budget),
    adset_daily_budget: parseMetaBudgetAmount(ad?.adset?.daily_budget),
    campaign_lifetime_budget: parseMetaBudgetAmount(ad?.campaign?.lifetime_budget),
    adset_lifetime_budget: parseMetaBudgetAmount(ad?.adset?.lifetime_budget),
    landing_page_views: landingPageViews,
    add_to_cart: addToCart,
    initiate_checkout: initiateCheckout,
    messages: Math.round(parseMessagingConversationCount(insight.actions)),
    leads: (() => {
      const hasLeadAction = (insight.actions ?? []).some((a) =>
        a.action_type.toLowerCase().includes("lead")
      );
      const leads = Math.round(parseLeadCount(insight.actions));
      if (hasLeadAction || leads === 0) {
        logRuntimeDebug("meta-creatives", "lead_debug", {
          ad_id: insight.ad_id ?? null,
          ad_name: insight.ad_name ?? null,
          actions: (insight.actions ?? []).map((a) => ({
            action_type: a.action_type,
            value: a.value,
          })),
        });
      }
      return leads;
    })(),
    thumbstop,
    click_to_atc: clickToAtc,
    atc_to_purchase: atcToPurchase,
    video25: video25Rate,
    video50: video50Rate,
    video75: video75Rate,
    video100: video100Rate,
    debug,
  };
}

export function groupRows(
  rows: RawCreativeRow[],
  groupBy: GroupBy,
  creativeUsageMap: Map<string, Set<string>>
): RawCreativeRow[] {
  const debugGrouping = process.env.META_CREATIVES_DEBUG_GROUPING === "1";
  if (groupBy === "adName") {
    if (debugGrouping) {
      logRuntimeDebug("meta-creatives", "group_rows_mode_ad_name", {
        input_rows: rows.length,
        output_rows: rows.length,
      });
    }
    return rows.map((row) => ({
      ...row,
      associated_ads_count: creativeUsageMap.get(row.creative_id)?.size ?? row.associated_ads_count ?? 1,
    }));
  }

  const map = new Map<string, RawCreativeRow[]>();
  for (const row of rows) {
    const key =
      groupBy === "creative"
        ? `${row.name}\0${row.format}`
        : groupBy === "ad"
          ? row.id
          : row.adset_id ?? `adset:${row.id}`;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }

  if (debugGrouping) {
    const groupCounts = Array.from(map.entries()).map(([key, list]) => ({ key, count: list.length }));
    const multiAdGroups = groupCounts.filter((g) => g.count > 1);
    logRuntimeDebug("meta-creatives", "group_rows_grouping_applied", {
      groupBy,
      input_rows: rows.length,
      unique_groups: map.size,
      output_rows: map.size,
      multi_ad_groups: multiAdGroups.length,
      sample_multi_ad_groups: multiAdGroups.slice(0, 3),
    });
  }

  const grouped: RawCreativeRow[] = [];
  for (const [key, list] of map.entries()) {
    const spend = list.reduce((acc, item) => acc + item.spend, 0);
    const purchaseValue = list.reduce((acc, item) => acc + item.purchase_value, 0);
    const purchases = list.reduce((acc, item) => acc + item.purchases, 0);
    const impressions = list.reduce((acc, item) => acc + item.impressions, 0);
    const clicks = list.reduce((acc, item) => acc + item.clicks, 0);
    const linkClicks = list.reduce((acc, item) => acc + item.link_clicks, 0);
    const outboundClicks = list.reduce((acc, item) => acc + (item.outbound_clicks ?? 0), 0);
    const landingPageViews = list.reduce((acc, item) => acc + item.landing_page_views, 0);
    const addToCart = list.reduce((acc, item) => acc + item.add_to_cart, 0);
    const initiateCheckout = list.reduce((acc, item) => acc + item.initiate_checkout, 0);
    const leads = list.reduce((acc, item) => acc + item.leads, 0);
    const messages = list.reduce((acc, item) => acc + item.messages, 0);
    const video3sViews = list.reduce((acc, item) => acc + (impressions > 0 ? (item.thumbstop / 100) * item.impressions : 0), 0);
    const video25Views = list.reduce((acc, item) => acc + (item.impressions > 0 ? (item.video25 / 100) * item.impressions : 0), 0);
    const video50Views = list.reduce((acc, item) => acc + (item.impressions > 0 ? (item.video50 / 100) * item.impressions : 0), 0);
    const video75Views = list.reduce((acc, item) => acc + (item.impressions > 0 ? (item.video75 / 100) * item.impressions : 0), 0);
    const video100Views = list.reduce((acc, item) => acc + (item.impressions > 0 ? (item.video100 / 100) * item.impressions : 0), 0);
    const weightedCtr = impressions > 0 ? list.reduce((acc, item) => acc + item.ctr_all * item.impressions, 0) / impressions : 0;
    const reach = list.reduce((acc, item) => acc + Number(item.reach ?? item.impressions ?? 0), 0);
    const groupedFrequency = reach > 0 ? impressions / reach : null;
    const weightedCpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
    const weightedCpc = linkClicks > 0 ? spend / linkClicks : 0;
    const earliestLaunch = [...list]
      .map((item) => item.launch_date)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
    const sample = list[0];
    const uniqueCurrencies = Array.from(new Set(list.map((item) => item.currency).filter(Boolean)));
    if (uniqueCurrencies.length > 1) {
      logRuntimeDebug("meta-creatives", "mixed_currencies_in_grouped_row", {
        groupBy,
        groupKey: key,
        currencies: uniqueCurrencies,
      });
    }
    const previewRow =
      list.find((item) =>
        Boolean(
          item.preview?.video_url ||
            item.preview?.image_url ||
            item.preview?.poster_url ||
            item.preview_url ||
            item.image_url ||
            item.thumbnail_url
        )
      ) ?? null;
    const groupedPreview = previewRow?.preview ?? {
      render_mode:
        previewRow?.preview_url || previewRow?.image_url || previewRow?.thumbnail_url
          ? ("image" as const)
          : ("unavailable" as const),
      html: null,
      image_url: previewRow?.image_url ?? previewRow?.preview_url ?? null,
      video_url: null,
      poster_url: previewRow?.thumbnail_url ?? null,
      source:
        previewRow?.image_url
          ? ("image_url" as const)
          : previewRow?.thumbnail_url
            ? ("thumbnail_url" as const)
            : previewRow?.preview_url
              ? ("preview_url" as const)
              : null,
      is_catalog: list.some((item) => Boolean(item.preview?.is_catalog ?? item.is_catalog)),
    };
    const groupedLegacyState: LegacyPreviewState = groupedPreview.render_mode === "unavailable" ? "unavailable" : "preview";
    const groupedTaxonomy = aggregateCreativeTaxonomy(list);
    const groupedCreativeType = deriveLegacyCreativeType(groupedTaxonomy.creative_primary_type);
    const groupedObjectStoryId =
      list.map((item) => item.object_story_id ?? null).find((value): value is string => Boolean(value)) ?? null;
    const groupedEffectiveObjectStoryId =
      list.map((item) => item.effective_object_story_id ?? null).find((value): value is string => Boolean(value)) ?? null;
    const groupedPostId =
      list.map((item) => item.post_id ?? null).find((value): value is string => Boolean(value)) ??
      extractPostIdFromStoryIdentifier(groupedObjectStoryId) ??
      extractPostIdFromStoryIdentifier(groupedEffectiveObjectStoryId) ??
      null;
    const groupedCopyText =
      list
        .map((item) => normalizeCopyText(item.copy_text))
        .find((value): value is string => Boolean(value)) ??
      null;
    const groupedCopyVariants = uniqueNormalizedText(list.flatMap((item) => item.copy_variants ?? []));
    const groupedHeadlineVariants = uniqueNormalizedText(list.flatMap((item) => item.headline_variants ?? []));
    const groupedDescriptionVariants = uniqueNormalizedText(list.flatMap((item) => item.description_variants ?? []));
    const groupedImageHashes = Array.from(
      new Set(
        list
          .flatMap((item) => [item.image_hash, ...(item.image_hashes ?? [])])
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const groupedCopySource =
      list.map((item) => item.copy_source ?? null).find((value): value is CopySourceLabel => Boolean(value)) ?? null;
    const groupedCopyDebugSources = mergeDebugSources([], list.flatMap((item) => item.copy_debug_sources ?? []));
    const groupedUnresolvedReason =
      list.map((item) => item.unresolved_reason ?? null).find((value): value is string => Boolean(value)) ?? null;

    const stableId =
      groupBy === "creative"
        ? `creative_${simpleHash(key)}`
        : groupBy === "ad"
          ? sample.id
          : `adset_${key}`;
    grouped.push({
      id: stableId,
      creative_id: sample.creative_id,
      object_story_id: groupedObjectStoryId,
      effective_object_story_id: groupedEffectiveObjectStoryId,
      post_id: groupedPostId,
      associated_ads_count:
        groupBy === "creative"
          ? list.length
          : groupBy === "ad"
            ? 1
            : (creativeUsageMap.get(sample.creative_id)?.size ?? 1),
      account_id: sample.account_id,
      account_name: sample.account_name,
      campaign_id: sample.campaign_id,
      campaign_name: sample.campaign_name,
      currency: sample.currency,
      adset_id: sample.adset_id,
      adset_name: sample.adset_name,
      name:
        groupBy === "creative" || groupBy === "ad"
          ? sample.name
          : sample.adset_name ?? sample.name,
      copy_text: groupedCopyText,
      copy_variants: groupedCopyVariants,
      headline_variants: groupedHeadlineVariants,
      description_variants: groupedDescriptionVariants,
      copy_source: groupedCopySource,
      copy_debug_sources: groupedCopyDebugSources,
      unresolved_reason: groupedUnresolvedReason,
      preview_url: groupedPreview.video_url ?? groupedPreview.image_url ?? groupedPreview.poster_url ?? null,
      preview_source: groupedPreview.source,
      thumbnail_url: previewRow?.thumbnail_url ?? groupedPreview.poster_url ?? groupedPreview.image_url ?? null,
      image_url: previewRow?.image_url ?? groupedPreview.image_url ?? groupedPreview.poster_url ?? null,
      table_thumbnail_url:
        previewRow?.table_thumbnail_url ??
        previewRow?.thumbnail_url ??
        groupedPreview.poster_url ??
        groupedPreview.image_url ??
        null,
      card_preview_url:
        previewRow?.card_preview_url ??
        previewRow?.image_url ??
        groupedPreview.image_url ??
        groupedPreview.poster_url ??
        previewRow?.thumbnail_url ??
        null,
      is_catalog: groupedPreview.is_catalog,
      preview_state: groupedLegacyState,
      preview: groupedPreview,
      image_hash: groupedImageHashes[0] ?? null,
      image_hashes: groupedImageHashes,
      launch_date: earliestLaunch ?? sample.launch_date,
      tags: [],
      ai_tags: list.reduce<MetaAiTags>((acc, item) => {
        for (const [rawKey, values] of Object.entries(item.ai_tags)) {
          const tagKey = rawKey as AiTagKey;
          if (!Array.isArray(values) || values.length === 0) continue;
          const merged = new Set([...(acc[tagKey] ?? []), ...values]);
          acc[tagKey] = Array.from(merged);
        }
        return acc;
      }, {}),
      format: list.some((item) => item.format === "catalog")
        ? "catalog"
        : list.some((item) => item.format === "video")
        ? "video"
        : "image",
      creative_type: groupedCreativeType,
      creative_type_label: getLegacyCreativeTypeLabel(groupedCreativeType),
      creative_delivery_type: groupedTaxonomy.creative_delivery_type,
      creative_visual_format: groupedTaxonomy.creative_visual_format,
      creative_primary_type: groupedTaxonomy.creative_primary_type,
      creative_primary_label: groupedTaxonomy.creative_primary_label,
      creative_secondary_type: groupedTaxonomy.creative_secondary_type,
      creative_secondary_label: groupedTaxonomy.creative_secondary_label,
      classification_signals: null,
      spend: r2(spend),
      purchase_value: r2(purchaseValue),
      roas: r2(spend > 0 ? purchaseValue / spend : 0),
      cpa: r2(purchases > 0 ? spend / purchases : 0),
      clicks,
      cpc_link: r2(weightedCpc),
      cpm: r2(weightedCpm),
      ctr_all: r2(weightedCtr),
      purchases,
      impressions,
      reach,
      frequency: groupedFrequency == null ? null : r2(groupedFrequency),
      link_clicks: linkClicks,
      outbound_clicks: outboundClicks,
      effective_status: list.map((item) => item.effective_status ?? null).find((value): value is string => Boolean(value)) ?? null,
      objective: list.map((item) => item.objective ?? null).find((value): value is string => Boolean(value)) ?? null,
      attribution_setting: list.map((item) => item.attribution_setting ?? null).find((value): value is string => Boolean(value)) ?? null,
      quality_ranking: list.map((item) => item.quality_ranking ?? null).find((value): value is string => Boolean(value)) ?? null,
      engagement_rate_ranking: list.map((item) => item.engagement_rate_ranking ?? null).find((value): value is string => Boolean(value)) ?? null,
      conversion_rate_ranking: list.map((item) => item.conversion_rate_ranking ?? null).find((value): value is string => Boolean(value)) ?? null,
      bid_strategy: list.map((item) => item.bid_strategy ?? null).find((value): value is string => Boolean(value)) ?? null,
      optimization_goal: list.map((item) => item.optimization_goal ?? null).find((value): value is string => Boolean(value)) ?? null,
      campaign_daily_budget: list.map((item) => item.campaign_daily_budget ?? null).find((value): value is number => value != null) ?? null,
      adset_daily_budget: list.map((item) => item.adset_daily_budget ?? null).find((value): value is number => value != null) ?? null,
      campaign_lifetime_budget: list.map((item) => item.campaign_lifetime_budget ?? null).find((value): value is number => value != null) ?? null,
      adset_lifetime_budget: list.map((item) => item.adset_lifetime_budget ?? null).find((value): value is number => value != null) ?? null,
      landing_page_views: landingPageViews,
      add_to_cart: addToCart,
      initiate_checkout: initiateCheckout,
      leads,
      messages,
      thumbstop: impressions > 0 ? r2((video3sViews / impressions) * 100) : 0,
      click_to_atc: linkClicks > 0 ? r2((addToCart / linkClicks) * 100) : 0,
      atc_to_purchase: addToCart > 0 ? r2((purchases / addToCart) * 100) : 0,
      video25: impressions > 0 ? r2((video25Views / impressions) * 100) : 0,
      video50: impressions > 0 ? r2((video50Views / impressions) * 100) : 0,
      video75: impressions > 0 ? r2((video75Views / impressions) * 100) : 0,
      video100: impressions > 0 ? r2((video100Views / impressions) * 100) : 0,
    });
  }

  return grouped;
}

export function sortRows(rows: RawCreativeRow[], sort: SortKey): RawCreativeRow[] {
  const keyMap: Record<SortKey, keyof RawCreativeRow> = {
    roas: "roas",
    spend: "spend",
    ctrAll: "ctr_all",
    purchaseValue: "purchase_value",
  };
  const key = keyMap[sort];
  return [...rows].sort((a, b) => Number(b[key]) - Number(a[key]));
}

export function summarizePreviewAudit(samples: PreviewAuditSample[]) {
  const sourceStats = new Map<string, { present: number; valid: number; invalid: number }>();
  for (const sample of samples) {
    for (const candidate of sample.candidates) {
      const current = sourceStats.get(candidate.source) ?? { present: 0, valid: 0, invalid: 0 };
      current.present += 1;
      if (candidate.validation.isValid) current.valid += 1;
      else current.invalid += 1;
      sourceStats.set(candidate.source, current);
    }
  }

  const ranked = Array.from(sourceStats.entries())
    .map(([source, stat]) => ({
      source,
      present: stat.present,
      valid: stat.valid,
      invalid: stat.invalid,
      stability: stat.present > 0 ? stat.valid / stat.present : 0,
    }))
    .sort((a, b) => b.valid - a.valid || b.present - a.present);

  const mostAvailable = [...ranked].sort((a, b) => b.present - a.present)[0] ?? null;
  const mostStable = [...ranked].sort((a, b) => b.stability - a.stability)[0] ?? null;
  const leastReliable = [...ranked].sort((a, b) => a.stability - b.stability)[0] ?? null;

  return {
    sources: ranked,
    most_available: mostAvailable,
    most_stable: mostStable,
    least_reliable: leastReliable,
  };
}
