import {
  buildCreativePreviewManifest,
  chooseBestStaticPreviewCandidate,
  collectPreviewCandidates,
  describeStaticPreviewSelection,
  META_CREATIVES_PREVIEW_CONTRACT_VERSION,
} from "@/lib/meta/creatives-preview";
import {
  coerceCreativeTaxonomyFromLegacy,
  deriveLegacyCreativeClassification,
  reconcileCreativeTaxonomyWithVideoEvidence,
} from "@/lib/meta/creative-taxonomy";
import type {
  CreativeMetricFields,
  CreativeDebugInfo,
  LegacyPreviewState,
  MetaCreativeApiRow,
  MetaAdRecord,
  NormalizedRenderPreviewPayload,
  RawCreativeRow,
} from "@/lib/meta/creatives-types";
import { isLikelyLowResCreativeUrl, isThumbnailLikeUrl } from "@/lib/meta/creatives-preview";
import { normalizeMediaUrl } from "@/lib/meta/creatives-utils";
import { resolveAiTagsForRow } from "@/lib/meta/creatives-copy";
import { r2, resolvePreviewOrigin } from "@/lib/meta/creatives-row-mappers";

type PerfSummary = {
  total_ms: number;
  accounts: Array<Record<string, unknown>>;
  stages: Record<string, number>;
  counters: Record<string, number>;
};

export function addPerfStageMs(
  perf: PerfSummary,
  name: string,
  ms: number
) {
  perf.stages[name] = (perf.stages[name] ?? 0) + ms;
}

export function resolveCardThumbnailCreativeIds(params: {
  mergedCreativeById: Map<string, MetaAdRecord["creative"]>;
  insights: Array<{ ad_id?: string | null; spend?: string | null }>;
  adMap: Map<string, MetaAdRecord>;
}) {
  const { mergedCreativeById, insights, adMap } = params;
  const spendByCreativeId = insights.reduce<Map<string, number>>((acc, insight) => {
    const adId = insight.ad_id;
    if (!adId) return acc;
    const creativeId = adMap.get(adId)?.creative?.id;
    if (!creativeId) return acc;
    const spend = parseFloat(insight.spend ?? "0") || 0;
    acc.set(creativeId, (acc.get(creativeId) ?? 0) + spend);
    return acc;
  }, new Map<string, number>());

  return Array.from(mergedCreativeById.entries())
    .filter(([, creative]) => {
      const imageUrl = normalizeMediaUrl(creative?.image_url ?? null);
      if (!imageUrl) return true;
      return isLikelyLowResCreativeUrl(imageUrl);
    })
    .map(([creativeId]) => creativeId)
    .sort((a, b) => (spendByCreativeId.get(b) ?? 0) - (spendByCreativeId.get(a) ?? 0))
    .slice(0, 80);
}

export function getStoryLookupCandidates(
  row: Pick<RawCreativeRow, "object_story_id" | "effective_object_story_id" | "post_id">,
  extractPostId: (value: string | null) => string | null
) {
  return [
    row.object_story_id,
    row.effective_object_story_id,
    row.post_id,
    extractPostId(row.object_story_id ?? null),
    extractPostId(row.effective_object_story_id ?? null),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function collectUnresolvedCreativeIds(rows: RawCreativeRow[]) {
  return Array.from(
    new Set(
      rows
        .map((row) => row.creative_id)
        .filter((creativeId): creativeId is string => typeof creativeId === "string" && creativeId.trim().length > 0)
    )
  ).slice(0, 50);
}

export function normalizeCreativeMetricFields<T extends CreativeMetricFields>(row: T) {
  const spend = Number.isFinite(row.spend) ? Math.max(0, row.spend) : 0;
  const purchases = Number.isFinite(row.purchases) ? Math.max(0, row.purchases) : 0;
  const impressions = Number.isFinite(row.impressions) ? Math.max(0, row.impressions) : 0;
  const linkClicks = Number.isFinite(row.link_clicks) ? Math.max(0, row.link_clicks) : 0;
  const addToCart = Number.isFinite(row.add_to_cart) ? Math.max(0, row.add_to_cart) : 0;
  const purchaseValue =
    Number.isFinite(row.purchase_value) && row.purchase_value > 0 ? row.purchase_value : 0;
  const roasFallbackValue =
    Number.isFinite(row.roas) && row.roas > 0 && spend > 0 ? row.roas * spend : 0;
  const normalizedPurchaseValue = purchaseValue > 0 ? purchaseValue : roasFallbackValue;

  return {
    spend: r2(spend),
    purchase_value: r2(normalizedPurchaseValue),
    roas: r2(spend > 0 ? normalizedPurchaseValue / spend : 0),
    cpa: r2(purchases > 0 ? spend / purchases : 0),
    cpc_link: r2(linkClicks > 0 ? spend / linkClicks : 0),
    cpm: r2(impressions > 0 ? (spend / impressions) * 1000 : 0),
    ctr_all: r2(impressions > 0 ? (linkClicks / impressions) * 100 : 0),
    purchases: Math.round(purchases),
    impressions: Math.round(impressions),
    link_clicks: Math.round(linkClicks),
    add_to_cart: Math.round(addToCart),
    click_to_atc: r2(linkClicks > 0 ? (addToCart / linkClicks) * 100 : 0),
    atc_to_purchase: r2(addToCart > 0 ? (purchases / addToCart) * 100 : 0),
  };
}

export function applyRecoveredCreativeMedia(
  row: RawCreativeRow,
  creative: NonNullable<MetaAdRecord["creative"]>
) {
  const collected = collectPreviewCandidates(creative, new Map<string, string>());
  const candidate1 = collected.candidates[0]?.url ?? null;
  const candidate2 = collected.candidates[1]?.url ?? candidate1;
  const creativeThumb = normalizeMediaUrl(creative.thumbnail_url);
  const creativeImage = normalizeMediaUrl(creative.image_url);
  const chosenThumb = creativeThumb ?? candidate1;
  const chosenImage = creativeImage ?? candidate2;
  const chosenPreview = chosenThumb ?? chosenImage;

  if (!chosenPreview) {
    return false;
  }

  row.thumbnail_url = chosenThumb;
  row.image_url = chosenImage;
  row.preview_url = chosenPreview;
  row.preview_state = "preview";
  if (!row.preview.image_url && !row.preview.poster_url) {
    row.preview = {
      ...row.preview,
      render_mode: "image",
      image_url: chosenImage ?? chosenPreview,
      poster_url: chosenThumb ?? chosenPreview,
      source: row.preview.source ?? "image_url",
    };
  }

  return true;
}

export function buildCreativesPerformanceDebug(params: {
  perf: PerfSummary;
  requestStartedAt: number;
  assignedAccountsCount: number;
  rawRowsCount: number;
  responseRowsCount: number;
  previewAuditSamplesCount: number;
  previewAuditValidationRequests: number;
  enableMediaRecovery: boolean;
  enableCreativeBasicsFallback: boolean;
  enableCreativeDetails: boolean;
  enableThumbnailBackfill: boolean;
  enableCardThumbnailBackfill: boolean;
  enableImageHashLookup: boolean;
  enableMediaCache: boolean;
  totalInsightAdIds: number;
  totalAdMapHits: number;
  mediaFallbackRowsRequested: number;
  mediaDirectFallbackRowsRequested: number;
}) {
  const {
    perf,
    requestStartedAt,
    assignedAccountsCount,
    rawRowsCount,
    responseRowsCount,
    previewAuditSamplesCount,
    previewAuditValidationRequests,
    enableMediaRecovery,
    enableCreativeBasicsFallback,
    enableCreativeDetails,
    enableThumbnailBackfill,
    enableCardThumbnailBackfill,
    enableImageHashLookup,
    enableMediaCache,
    totalInsightAdIds,
    totalAdMapHits,
    mediaFallbackRowsRequested,
    mediaDirectFallbackRowsRequested,
  } = params;

  return {
    ...perf,
    total_ms: Date.now() - requestStartedAt,
    counters: {
      ...perf.counters,
      assigned_accounts: assignedAccountsCount,
      raw_rows: rawRowsCount,
      response_rows: responseRowsCount,
      preview_audit_samples: previewAuditSamplesCount,
      preview_audit_validation_requests: previewAuditValidationRequests,
      media_recovery_enabled: enableMediaRecovery ? 1 : 0,
      creative_basics_fallback_enabled: enableCreativeBasicsFallback ? 1 : 0,
      creative_details_enabled: enableCreativeDetails ? 1 : 0,
      thumbnail_backfill_enabled: enableThumbnailBackfill ? 1 : 0,
      card_thumbnail_backfill_enabled: enableCardThumbnailBackfill ? 1 : 0,
      image_hash_lookup_enabled: enableImageHashLookup ? 1 : 0,
      media_cache_enabled: enableMediaCache ? 1 : 0,
      insight_ad_ids: totalInsightAdIds,
      ads_loaded_for_insights: totalAdMapHits,
      media_fallback_rows_requested: mediaFallbackRowsRequested,
      media_direct_fallback_rows_requested: mediaDirectFallbackRowsRequested,
    },
  };
}

export function buildMetaCreativeApiRow(params: {
  row: RawCreativeRow;
  cachedThumbnailUrl: string | null;
  cardFallbackThumbnailUrl: string | null;
  includeDebugFields: boolean;
}) {
  const { row, cachedThumbnailUrl, cardFallbackThumbnailUrl, includeDebugFields } = params;

  const tableThumbnailFromRow = normalizeMediaUrl(row.table_thumbnail_url ?? null);
  const cardPreviewFromRow = normalizeMediaUrl(row.card_preview_url ?? null);
  const rowPreviewImage = normalizeMediaUrl(row.preview.image_url ?? null);
  const rowPreviewPoster = normalizeMediaUrl(row.preview.poster_url ?? null);
  const rowImageUrl = normalizeMediaUrl(row.image_url);
  const rowPreviewUrl = normalizeMediaUrl(row.preview_url);
  const rowThumbnailUrl = normalizeMediaUrl(row.thumbnail_url);
  const normalizedCachedThumbnailUrl = normalizeMediaUrl(cachedThumbnailUrl);

  const finalThumbnailUrl =
    tableThumbnailFromRow ??
    rowThumbnailUrl ??
    normalizedCachedThumbnailUrl ??
    rowPreviewUrl ??
    rowImageUrl ??
    rowPreviewPoster ??
    rowPreviewImage;

  const preferredCardImageUrl =
    (cardPreviewFromRow && !isThumbnailLikeUrl(cardPreviewFromRow) ? cardPreviewFromRow : null) ??
    (rowImageUrl && !isThumbnailLikeUrl(rowImageUrl) ? rowImageUrl : null) ??
    (rowPreviewUrl && !isThumbnailLikeUrl(rowPreviewUrl) ? rowPreviewUrl : null) ??
    (rowPreviewImage && !isThumbnailLikeUrl(rowPreviewImage) ? rowPreviewImage : null) ??
    (rowPreviewPoster && !isThumbnailLikeUrl(rowPreviewPoster) ? rowPreviewPoster : null) ??
    (cardFallbackThumbnailUrl && !isThumbnailLikeUrl(cardFallbackThumbnailUrl)
      ? cardFallbackThumbnailUrl
      : null) ??
    rowImageUrl ??
    rowPreviewUrl ??
    rowPreviewImage ??
    rowPreviewPoster ??
    cardPreviewFromRow ??
    cardFallbackThumbnailUrl ??
    rowThumbnailUrl ??
    finalThumbnailUrl;

  const finalImageUrl = rowImageUrl ?? preferredCardImageUrl ?? finalThumbnailUrl;
  const finalPreviewUrl = rowPreviewUrl ?? preferredCardImageUrl ?? finalThumbnailUrl;
  const previewState: LegacyPreviewState = finalPreviewUrl ? "preview" : "unavailable";
  const finalNullReason = finalThumbnailUrl
    ? null
    : row.debug?.stage_null_reason ?? "final_map_no_thumbnail";

  const finalPreviewPayload: NormalizedRenderPreviewPayload =
    finalPreviewUrl && row.preview.render_mode === "unavailable"
      ? {
          ...row.preview,
          render_mode: row.preview.video_url ? "video" : "image",
          image_url:
            normalizeMediaUrl(row.preview.image_url) ??
            preferredCardImageUrl ??
            finalImageUrl ??
            finalThumbnailUrl,
          poster_url:
            normalizeMediaUrl(row.preview.poster_url) ??
            preferredCardImageUrl ??
            finalThumbnailUrl ??
            finalImageUrl,
          source: row.preview.source ?? "thumbnail_url",
        }
      : row.preview.render_mode === "image"
        ? {
            ...row.preview,
            image_url:
              normalizeMediaUrl(row.preview.image_url) &&
              !isLikelyLowResCreativeUrl(row.preview.image_url)
                ? row.preview.image_url
                : finalImageUrl ?? row.preview.image_url,
            poster_url:
              normalizeMediaUrl(row.preview.poster_url) &&
              !isLikelyLowResCreativeUrl(row.preview.poster_url)
                ? row.preview.poster_url
                : preferredCardImageUrl ?? finalThumbnailUrl ?? row.preview.poster_url,
          }
        : row.preview;

  const tableThumbnailCandidates = [
    tableThumbnailFromRow,
    rowThumbnailUrl,
    normalizedCachedThumbnailUrl,
    rowPreviewPoster,
    rowPreviewUrl,
    rowImageUrl,
    rowPreviewImage,
  ].filter((value): value is string => Boolean(value));
  const tableThumbnailUrl = tableThumbnailCandidates[0] ?? null;

  const cardCandidates = [
    preferredCardImageUrl,
    cardPreviewFromRow,
    rowImageUrl,
    rowPreviewImage,
    rowPreviewUrl,
    rowPreviewPoster,
    cardFallbackThumbnailUrl,
    rowThumbnailUrl,
  ].filter((value): value is string => Boolean(value));

  const rawCardPreviewCandidate = chooseBestStaticPreviewCandidate(cardCandidates);
  const cardPreviewDebug = describeStaticPreviewSelection({
    tier: "card",
    selectedUrl: rawCardPreviewCandidate,
  });
  const tablePreviewDebug = describeStaticPreviewSelection({
    tier: "table",
    selectedUrl: tableThumbnailUrl,
  });
  const previewManifest = buildCreativePreviewManifest({
    tableSrc: tableThumbnailUrl,
    cardSrc: rawCardPreviewCandidate,
    detailImageSrc:
      finalImageUrl ??
      normalizeMediaUrl(finalPreviewPayload.image_url) ??
      normalizeMediaUrl(finalPreviewPayload.poster_url) ??
      rawCardPreviewCandidate,
    detailVideoSrc: normalizeMediaUrl(finalPreviewPayload.video_url),
    liveHtmlAvailable: Boolean(row.creative_id),
  });
  const cardPreviewUrl = previewManifest.card_src;
  const previewStatus: "ready" | "missing" =
    finalPreviewUrl || finalThumbnailUrl || finalImageUrl || normalizedCachedThumbnailUrl
      ? "ready"
      : "missing";
  const previewOrigin = resolvePreviewOrigin({
    cachedThumbnailUrl: normalizedCachedThumbnailUrl,
    finalPreviewUrl,
    rowPreviewUrl,
    finalThumbnailUrl,
    finalImageUrl,
  });

  const safeSpend = Number.isFinite(row.spend) ? Math.max(0, row.spend) : 0;
  const safePurchases = Number.isFinite(row.purchases) ? Math.max(0, row.purchases) : 0;
  const safeImpressions = Number.isFinite(row.impressions) ? Math.max(0, row.impressions) : 0;
  const safeLinkClicks = Number.isFinite(row.link_clicks) ? Math.max(0, row.link_clicks) : 0;
  const safeAddToCart = Number.isFinite(row.add_to_cart) ? Math.max(0, row.add_to_cart) : 0;
  const basePurchaseValue = Number.isFinite(row.purchase_value) ? Math.max(0, row.purchase_value) : 0;
  const roasFallbackValue =
    Number.isFinite(row.roas) && row.roas > 0 && safeSpend > 0 ? row.roas * safeSpend : 0;
  const normalizedPurchaseValue = basePurchaseValue > 0 ? basePurchaseValue : roasFallbackValue;
  const normalizedRoas = safeSpend > 0 ? normalizedPurchaseValue / safeSpend : 0;
  const normalizedCpa = safePurchases > 0 ? safeSpend / safePurchases : 0;
  const normalizedCpcLink = safeLinkClicks > 0 ? safeSpend / safeLinkClicks : 0;
  const normalizedCpm = safeImpressions > 0 ? (safeSpend / safeImpressions) * 1000 : 0;
  const normalizedCtrAll = safeImpressions > 0 ? (safeLinkClicks / safeImpressions) * 100 : 0;
  const normalizedClickToAtc = safeLinkClicks > 0 ? (safeAddToCart / safeLinkClicks) * 100 : 0;
  const normalizedAtcToPurchase = safeAddToCart > 0 ? (safePurchases / safeAddToCart) * 100 : 0;
  const taxonomySource =
    row.taxonomy_source ??
    (row.creative_primary_type ? "deterministic" : "legacy_fallback");
  const creativeTaxonomy =
    taxonomySource === "deterministic" && row.creative_primary_type
      ? {
          creative_delivery_type: row.creative_delivery_type,
          creative_visual_format: row.creative_visual_format,
          creative_primary_type: row.creative_primary_type,
          creative_primary_label: row.creative_primary_label,
          creative_secondary_type: row.creative_secondary_type,
          creative_secondary_label: row.creative_secondary_label,
          classification_signals: row.classification_signals ?? null,
        }
      : coerceCreativeTaxonomyFromLegacy({
          format: row.format,
          creative_type: row.creative_type,
          is_catalog: row.is_catalog,
        });
  const reconciledCreativeTaxonomy = reconcileCreativeTaxonomyWithVideoEvidence(creativeTaxonomy, {
    preview: finalPreviewPayload,
    thumbstop: row.thumbstop,
    video25: row.video25,
    video50: row.video50,
    video75: row.video75,
    video100: row.video100,
  });
  const taxonomyReconciledByVideoEvidence =
    reconciledCreativeTaxonomy.creative_delivery_type !== creativeTaxonomy.creative_delivery_type ||
    reconciledCreativeTaxonomy.creative_visual_format !== creativeTaxonomy.creative_visual_format ||
    reconciledCreativeTaxonomy.creative_primary_type !== creativeTaxonomy.creative_primary_type ||
    reconciledCreativeTaxonomy.creative_secondary_type !== creativeTaxonomy.creative_secondary_type;
  const legacyCreativeClassification = deriveLegacyCreativeClassification(reconciledCreativeTaxonomy);

  const baseRow: MetaCreativeApiRow = {
    id: row.id,
    creative_id: row.creative_id,
    object_story_id: row.object_story_id ?? null,
    effective_object_story_id: row.effective_object_story_id ?? null,
    post_id: row.post_id ?? null,
    associated_ads_count: row.associated_ads_count,
    account_id: row.account_id,
    account_name: row.account_name,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    adset_id: row.adset_id,
    adset_name: row.adset_name,
    currency: row.currency,
    name: row.name,
    copy_text: row.copy_text ?? null,
    copy_variants: row.copy_variants ?? [],
    headline_variants: row.headline_variants ?? [],
    description_variants: row.description_variants ?? [],
    copy_source: row.copy_source ?? null,
    copy_debug_sources: row.copy_debug_sources ?? [],
    unresolved_reason: row.unresolved_reason ?? null,
    preview_url: finalPreviewUrl,
    preview_source: row.preview_source,
    thumbnail_url: finalThumbnailUrl,
    image_url: finalImageUrl,
    table_thumbnail_url: tableThumbnailUrl,
    card_preview_url: cardPreviewUrl,
    preview_contract_version: META_CREATIVES_PREVIEW_CONTRACT_VERSION,
    preview_manifest: previewManifest,
    card_preview_source_kind: cardPreviewDebug.sourceKind,
    card_preview_resolution_class: cardPreviewDebug.resolutionClass,
    table_preview_source_kind: tablePreviewDebug.sourceKind,
    preview_source_reason: cardPreviewDebug.reason,
    is_catalog: row.is_catalog,
    preview_state: previewState,
    preview: finalPreviewPayload,
    image_hash: row.image_hash ?? row.image_hashes?.[0] ?? null,
    image_hashes: row.image_hashes ?? (row.image_hash ? [row.image_hash] : []),
    launch_date: row.launch_date,
    tags: row.tags,
    ai_tags: resolveAiTagsForRow({
      ...row,
      format: legacyCreativeClassification.format,
      creative_delivery_type: reconciledCreativeTaxonomy.creative_delivery_type,
      creative_visual_format: reconciledCreativeTaxonomy.creative_visual_format,
      creative_primary_type: reconciledCreativeTaxonomy.creative_primary_type,
      creative_primary_label: reconciledCreativeTaxonomy.creative_primary_label,
      creative_secondary_type: reconciledCreativeTaxonomy.creative_secondary_type,
      creative_secondary_label: reconciledCreativeTaxonomy.creative_secondary_label,
    }),
    format: legacyCreativeClassification.format,
    creative_type: legacyCreativeClassification.creative_type,
    creative_type_label: legacyCreativeClassification.creative_type_label,
    creative_delivery_type: reconciledCreativeTaxonomy.creative_delivery_type,
    creative_visual_format: reconciledCreativeTaxonomy.creative_visual_format,
    creative_primary_type: reconciledCreativeTaxonomy.creative_primary_type,
    creative_primary_label: reconciledCreativeTaxonomy.creative_primary_label,
    creative_secondary_type: reconciledCreativeTaxonomy.creative_secondary_type,
    creative_secondary_label: reconciledCreativeTaxonomy.creative_secondary_label,
    classification_signals: reconciledCreativeTaxonomy.classification_signals,
    taxonomy_version: "v2",
    taxonomy_source: taxonomySource,
    taxonomy_reconciled_by_video_evidence: taxonomyReconciledByVideoEvidence,
    spend: r2(safeSpend),
    purchase_value: r2(normalizedPurchaseValue),
    roas: r2(normalizedRoas),
    cpa: r2(normalizedCpa),
    cpc_link: r2(normalizedCpcLink),
    cpm: r2(normalizedCpm),
    ctr_all: r2(normalizedCtrAll),
    purchases: Math.round(safePurchases),
    impressions: Math.round(safeImpressions),
    reach: Math.round(Number(row.reach ?? row.impressions ?? 0)),
    frequency: row.frequency ?? null,
    clicks: Math.round(Number(row.clicks ?? row.link_clicks ?? 0)),
    link_clicks: Math.round(safeLinkClicks),
    outbound_clicks: Math.round(Number(row.outbound_clicks ?? 0)),
    effective_status: row.effective_status ?? null,
    objective: row.objective ?? null,
    attribution_setting: row.attribution_setting ?? null,
    quality_ranking: row.quality_ranking ?? null,
    engagement_rate_ranking: row.engagement_rate_ranking ?? null,
    conversion_rate_ranking: row.conversion_rate_ranking ?? null,
    bid_strategy: row.bid_strategy ?? null,
    optimization_goal: row.optimization_goal ?? null,
    campaign_daily_budget: row.campaign_daily_budget ?? null,
    adset_daily_budget: row.adset_daily_budget ?? null,
    campaign_lifetime_budget: row.campaign_lifetime_budget ?? null,
    adset_lifetime_budget: row.adset_lifetime_budget ?? null,
    landing_page_views: row.landing_page_views,
    add_to_cart: row.add_to_cart,
    initiate_checkout: row.initiate_checkout,
    leads: row.leads,
    messages: row.messages,
    thumbstop: row.thumbstop,
    click_to_atc: r2(normalizedClickToAtc),
    atc_to_purchase: r2(normalizedAtcToPurchase),
    video25: row.video25,
    video50: row.video50,
    video75: row.video75,
    video100: row.video100,
    cached_thumbnail_url: cachedThumbnailUrl,
    preview_status: previewStatus,
    preview_origin: previewOrigin,
  };

  if (!includeDebugFields) {
    return baseRow;
  }

  const baseDebug: CreativeDebugInfo = row.debug ?? {};
  const debug: CreativeDebugInfo = {
    ...baseDebug,
    stage_final_thumbnail_url: finalThumbnailUrl,
    stage_null_reason: finalNullReason,
    resolution_stage: "response-map",
  };

  return {
    ...baseRow,
    debug,
  };
}

export function buildMetaCreativeApiRowLightweight(params: {
  row: RawCreativeRow;
  includeDebugFields: boolean;
}) {
  const { row, includeDebugFields } = params;
  const normalizedMetrics = normalizeCreativeMetricFields(row);
  const previewUrl = normalizeMediaUrl(row.preview_url ?? row.preview?.image_url ?? row.preview?.poster_url ?? null);
  const thumbnailUrl = normalizeMediaUrl(
    row.table_thumbnail_url ??
      row.thumbnail_url ??
      row.preview?.poster_url ??
      row.preview_url ??
      row.image_url ??
      null,
  );
  const imageUrl = normalizeMediaUrl(
    row.card_preview_url ??
      row.image_url ??
      row.preview?.image_url ??
      row.preview_url ??
      row.preview?.poster_url ??
      null,
  );
  const previewState: LegacyPreviewState =
    row.preview_state ?? (previewUrl || thumbnailUrl || imageUrl ? "preview" : "unavailable");
  const previewStatus = previewUrl || thumbnailUrl || imageUrl ? "ready" : "missing";
  const previewOrigin =
    row.table_thumbnail_url || row.card_preview_url || row.preview_manifest
      ? "snapshot"
      : previewUrl || thumbnailUrl || imageUrl
        ? "live"
        : "fallback";

  const baseRow: MetaCreativeApiRow = {
    id: row.id,
    creative_id: row.creative_id,
    object_story_id: row.object_story_id ?? null,
    effective_object_story_id: row.effective_object_story_id ?? null,
    post_id: row.post_id ?? null,
    associated_ads_count: row.associated_ads_count,
    account_id: row.account_id,
    account_name: row.account_name,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    adset_id: row.adset_id,
    adset_name: row.adset_name,
    currency: row.currency,
    name: row.name,
    copy_text: row.copy_text ?? null,
    copy_variants: row.copy_variants ?? [],
    headline_variants: row.headline_variants ?? [],
    description_variants: row.description_variants ?? [],
    copy_source: row.copy_source ?? null,
    copy_debug_sources: row.copy_debug_sources ?? [],
    unresolved_reason: row.unresolved_reason ?? null,
    preview_url: previewUrl,
    preview_source: row.preview_source,
    thumbnail_url: thumbnailUrl,
    image_url: imageUrl,
    table_thumbnail_url: normalizeMediaUrl(row.table_thumbnail_url ?? thumbnailUrl ?? null),
    card_preview_url: normalizeMediaUrl(row.card_preview_url ?? imageUrl ?? null),
    preview_contract_version:
      row.preview_contract_version ?? META_CREATIVES_PREVIEW_CONTRACT_VERSION,
    preview_manifest: row.preview_manifest ?? null,
    card_preview_source_kind: row.card_preview_source_kind ?? "none",
    card_preview_resolution_class: row.card_preview_resolution_class ?? "unknown",
    table_preview_source_kind: row.table_preview_source_kind ?? "none",
    preview_source_reason: row.preview_source_reason ?? "unavailable",
    is_catalog: row.is_catalog,
    preview_state: previewState,
    preview: row.preview,
    image_hash: row.image_hash ?? row.image_hashes?.[0] ?? null,
    image_hashes: row.image_hashes ?? (row.image_hash ? [row.image_hash] : []),
    launch_date: row.launch_date,
    tags: row.tags,
    ai_tags: resolveAiTagsForRow(row),
    format: row.format,
    creative_type: row.creative_type,
    creative_type_label: row.creative_type_label,
    creative_delivery_type: row.creative_delivery_type,
    creative_visual_format: row.creative_visual_format,
    creative_primary_type: row.creative_primary_type,
    creative_primary_label: row.creative_primary_label,
    creative_secondary_type: row.creative_secondary_type,
    creative_secondary_label: row.creative_secondary_label,
    classification_signals: row.classification_signals,
    taxonomy_version: row.taxonomy_version ?? "v2",
    taxonomy_source:
      row.taxonomy_source ??
      (row.creative_primary_type ? "deterministic" : "legacy_fallback"),
    taxonomy_reconciled_by_video_evidence: row.taxonomy_reconciled_by_video_evidence ?? false,
    spend: normalizedMetrics.spend,
    purchase_value: normalizedMetrics.purchase_value,
    roas: normalizedMetrics.roas,
    cpa: normalizedMetrics.cpa,
    cpc_link: normalizedMetrics.cpc_link,
    cpm: normalizedMetrics.cpm,
    ctr_all: normalizedMetrics.ctr_all,
    purchases: normalizedMetrics.purchases,
    impressions: normalizedMetrics.impressions,
    reach: Math.round(Number(row.reach ?? row.impressions ?? 0)),
    frequency: row.frequency ?? null,
    clicks: Math.round(Number(row.clicks ?? row.link_clicks ?? 0)),
    link_clicks: normalizedMetrics.link_clicks,
    outbound_clicks: Math.round(Number(row.outbound_clicks ?? 0)),
    effective_status: row.effective_status ?? null,
    objective: row.objective ?? null,
    attribution_setting: row.attribution_setting ?? null,
    quality_ranking: row.quality_ranking ?? null,
    engagement_rate_ranking: row.engagement_rate_ranking ?? null,
    conversion_rate_ranking: row.conversion_rate_ranking ?? null,
    bid_strategy: row.bid_strategy ?? null,
    optimization_goal: row.optimization_goal ?? null,
    campaign_daily_budget: row.campaign_daily_budget ?? null,
    adset_daily_budget: row.adset_daily_budget ?? null,
    campaign_lifetime_budget: row.campaign_lifetime_budget ?? null,
    adset_lifetime_budget: row.adset_lifetime_budget ?? null,
    landing_page_views: Math.round(Number(row.landing_page_views ?? 0)),
    add_to_cart: normalizedMetrics.add_to_cart,
    initiate_checkout: Math.round(Number(row.initiate_checkout ?? 0)),
    leads: Math.round(Number(row.leads ?? 0)),
    messages: Math.round(Number(row.messages ?? 0)),
    thumbstop: Number(row.thumbstop ?? 0),
    click_to_atc: normalizedMetrics.click_to_atc,
    atc_to_purchase: normalizedMetrics.atc_to_purchase,
    video25: Number(row.video25 ?? 0),
    video50: Number(row.video50 ?? 0),
    video75: Number(row.video75 ?? 0),
    video100: Number(row.video100 ?? 0),
    cached_thumbnail_url: null,
    preview_status: previewStatus,
    preview_origin: previewOrigin,
  };

  if (!includeDebugFields) {
    return baseRow;
  }

  return {
    ...baseRow,
    debug: row.debug ?? {},
  };
}
