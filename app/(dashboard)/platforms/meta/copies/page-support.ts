import type { MetaCreativeRow, MetaCreativePreview } from "@/components/creatives/metricConfig";
import { coerceCreativeTaxonomyFromLegacy } from "@/lib/meta/creative-taxonomy";
import type { MetaCopyApiRow } from "@/app/api/meta/copies/route";

export type CopyMotionRow = MetaCreativeRow & {
  copyText: string;
  usedInCampaigns: string[];
  usedInAds: string[];
  copyHeadline: string | null;
  copyDescription: string | null;
  copySource: string | null;
  copyAssetType: MetaCopyApiRow["copy_asset_type"];
  normalizedCopyKey: string | null;
  unresolvedReason: string | null;
};

const EMPTY_PREVIEW: MetaCreativePreview = {
  render_mode: "unavailable",
  image_url: null,
  video_url: null,
  poster_url: null,
  source: null,
  is_catalog: false,
};

function normalizeCopyIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return null;
  return normalized;
}

function excerptCopyText(value: string, max = 220): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trim()}...`;
}

function resolveCopyDisplayText(row: MetaCopyApiRow): string {
  return (
    normalizeCopyIdentity(row.copy_text) ??
    normalizeCopyIdentity(row.primary_text) ??
    normalizeCopyIdentity(row.headline) ??
    normalizeCopyIdentity(row.description) ??
    normalizeCopyIdentity(row.name) ??
    "Copy unavailable"
  );
}

export function mapApiRowToCopyRow(row: MetaCopyApiRow): CopyMotionRow {
  const linkClicks = row.link_clicks ?? 0;
  const clicks = linkClicks;
  const purchases = row.purchases ?? 0;
  const addToCart = row.add_to_cart ?? 0;
  const impressions = row.impressions ?? 0;
  const clickToAddToCart = row.click_to_atc_ratio ?? 0;
  const clickToPurchase = row.click_to_purchase ?? 0;
  const linkCtr = impressions > 0 ? (linkClicks / impressions) * 100 : 0;
  const fallbackFormat = row.is_catalog ? "catalog" : row.preview?.render_mode === "video" ? "video" : "image";
  const fallbackCreativeType = row.is_catalog ? "feed_catalog" : row.preview?.render_mode === "video" ? "video" : "feed";
  const creativeTaxonomy = coerceCreativeTaxonomyFromLegacy({
    format: fallbackFormat,
    creative_type: fallbackCreativeType,
    is_catalog: row.is_catalog,
  });

  const copyText = resolveCopyDisplayText(row);
  const displayName = excerptCopyText(copyText, 180);

  return {
    id: row.id,
    creativeId: row.creative_id ?? row.id,
    objectStoryId: null,
    effectiveObjectStoryId: null,
    postId: row.post_id ?? null,
    name: displayName,
    associatedAdsCount: 1,
    accountId: row.account_id ?? null,
    accountName: row.account_name ?? null,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    adSetId: row.adset_id,
    adSetName: row.adset_name,
    currency: row.currency ?? null,
    format: fallbackFormat,
    creativeType: fallbackCreativeType,
    creativeTypeLabel: row.is_catalog ? "Feed (Catalog ads)" : row.preview?.render_mode === "video" ? "Video" : "Feed",
    creativeDeliveryType: creativeTaxonomy.creative_delivery_type,
    creativeVisualFormat: creativeTaxonomy.creative_visual_format,
    creativePrimaryType: creativeTaxonomy.creative_primary_type,
    creativePrimaryLabel: creativeTaxonomy.creative_primary_label,
    creativeSecondaryType: creativeTaxonomy.creative_secondary_type,
    creativeSecondaryLabel: creativeTaxonomy.creative_secondary_label,
    thumbnailUrl: row.thumbnail_url,
    previewUrl: row.preview_url,
    imageUrl: row.image_url,
    tableThumbnailUrl: row.table_thumbnail_url ?? row.thumbnail_url ?? null,
    cardPreviewUrl:
      row.card_preview_url ?? row.image_url ?? row.thumbnail_url ?? row.preview_url ?? null,
    cachedThumbnailUrl: null,
    isCatalog: row.is_catalog ?? false,
    previewState: row.preview_state,
    preview: row.preview ?? EMPTY_PREVIEW,
    launchDate: row.launch_date ?? "",
    tags: [],
    aiTags: {},
    spend: row.spend,
    purchaseValue: row.purchase_value ?? 0,
    roas: row.roas,
    cpa: row.cpa,
    cpcLink: row.cpc_link,
    cpm: row.cpm,
    ctrAll: row.ctr_all,
    linkCtr,
    purchases,
    impressions,
    clicks,
    linkClicks,
    landingPageViews: row.landing_page_views ?? 0,
    addToCart,
    initiateCheckout: row.initiate_checkout ?? 0,
    leads: row.leads ?? 0,
    messages: row.messages ?? 0,
    thumbstop: row.thumbstop ?? 0,
    clickToAddToCart,
    clickToPurchase,
    video25: row.video25 ?? 0,
    video50: row.video50 ?? 0,
    video75: row.video75 ?? 0,
    video100: row.video100 ?? 0,
    atcToPurchaseRatio: row.atc_to_purchase_ratio ?? 0,
    copyText,
    copyVariants: Array.isArray(row.copy_variants) ? row.copy_variants : [],
    headlineVariants: Array.isArray(row.headline_variants) ? row.headline_variants : [],
    descriptionVariants: Array.isArray(row.description_variants) ? row.description_variants : [],
    copyHeadline: normalizeCopyIdentity(row.headline),
    copyDescription: normalizeCopyIdentity(row.description),
    copySource: row.copy_source ?? null,
    copyAssetType: row.copy_asset_type ?? null,
    normalizedCopyKey: row.normalized_copy_key ?? null,
    unresolvedReason: row.unresolved_reason ?? null,
    usedInCampaigns: row.campaign_name ? [row.campaign_name] : [],
    usedInAds: row.name ? [row.name] : [],
  };
}
