import type { MetaCreativeRow, MetaCreativePreview } from "@/components/creatives/metricConfig";
import { coerceCreativeTaxonomyFromLegacy } from "@/lib/meta/creative-taxonomy";
import type { MetaCopyApiRow } from "@/app/api/meta/copies/route";
import { measuredAsOf } from "@/lib/tier-zero-as-of";

/**
 * The copies response as the surface must model it.
 *
 * The page used to declare a narrower local shape that carried only
 * `warehouseObservedAt`, so four facts the endpoint publishes were dropped on
 * the floor: whether the read was partial, why, WHICH read produced the rows,
 * and which clock describes them. A field the client type does not mention is a
 * field the client cannot show.
 */
export interface MetaCopiesResponse {
  status?: string;
  message?: string;
  rows: MetaCopyApiRow[];
  meta?: {
    unresolved_filtered_count?: number;
    generatedAt?: string;
    /** When a sync last wrote the warehouse rows for this window. */
    warehouseObservedAt?: string | null;
    /** `warehouse` | `live_fallback` | `current_day_live` | `demo`. */
    readSource?: string | null;
    /** The instant that describes THESE rows, or null when none exists. */
    rowsObservedAt?: string | null;
    rowsObservedAtSource?: "warehouse" | "live" | "unknown";
    isPartial?: boolean;
    notReadyReason?: string | null;
    provider_account_id?: string;
  };
}

/**
 * What the Copies surface tells the Tier-0 freshness contract.
 *
 * Two separate corrections, both about the same substitution.
 *
 * THE AGE. `meta.warehouseObservedAt` is `MAX(updated_at)` over `meta_ad_daily`
 * — when a sync last WROTE the window. The copies route builds its rows from
 * `/api/meta/creatives`, which on the current-day and fallback paths reads Meta
 * LIVE and touches no warehouse row at all, so on those paths the warehouse
 * instant describes different data than the table does. The surface reads
 * `rowsObservedAt`, which is the warehouse instant only when the rows came from
 * the warehouse and null otherwise. Null renders "age unknown", and that is
 * strictly better than a number that belongs to something else.
 *
 * THE PARTIAL. `isPartial`/`notReadyReason` were published by the endpoint and
 * read by nobody, so a window the server had explicitly declared incomplete
 * arrived looking finished. The server's own words are shown; the client
 * invents no reason of its own.
 *
 * The live-read note is appended rather than replacing the reason, because
 * "these rows were read live, so the warehouse write time does not describe
 * them" is exactly the thing the operator could not otherwise know — and it is
 * a statement about lineage, not a second guess at the age.
 */
export function resolveCopiesFreshness(
  response: MetaCopiesResponse | undefined,
): { asOf: string | null; partialReason: string | null } {
  const meta = response?.meta;
  const asOf = measuredAsOf(meta?.rowsObservedAt ?? null);

  const reasons: string[] = [];
  if (meta?.isPartial === true) {
    reasons.push(
      meta.notReadyReason?.trim() ||
        "The upstream Meta creative read completed only in part for this window.",
    );
  }
  if (meta?.rowsObservedAtSource === "live") {
    reasons.push(
      "These rows were read live from Meta, so the warehouse sync time does not describe them.",
    );
  }

  return { asOf, partialReason: reasons.length > 0 ? reasons.join(" ") : null };
}

/**
 * WHICH CLOCK describes the rows currently on screen.
 *
 * The age in the shell pill is one number, and the operator cannot tell from it
 * whether it belongs to the rows in front of them. Two clocks exist here and
 * they are not interchangeable:
 *
 *   - the WAREHOUSE clock, `meta.warehouseObservedAt` = `MAX(updated_at)` over
 *     the window's warehouse rows. It describes the rows only when the copies
 *     route's upstream creatives read actually came from the warehouse
 *     (`readSource === "warehouse"`).
 *   - the LIVE clock, which does not exist. `current_day_live` and
 *     `live_fallback` read Meta directly and write no warehouse row, so there
 *     is no observation instant to quote and the honest age is "unknown".
 *
 * `resolveCopiesFreshness` already refuses to quote the warehouse instant for
 * live rows. This is the other half: the surface states, in words, which clock
 * it is on, so an unknown age reads as a lineage fact rather than a gap.
 *
 * Returns null when no response has arrived — there is nothing to describe yet,
 * and the loading state already says so.
 */
export function describeCopiesRowsClock(
  response: MetaCopiesResponse | undefined,
): string | null {
  const meta = response?.meta;
  if (!response || !meta) return null;
  if (meta.rowsObservedAtSource === "warehouse") {
    return "Warehouse rows · age is the warehouse sync clock";
  }
  if (meta.rowsObservedAtSource === "live") {
    return "Live Meta rows · no warehouse write describes them";
  }
  // The demo business DID name its source; it just has no observation clock,
  // because fixtures were never observed. Saying "the read did not name its
  // source" there would be a second inaccuracy on top of the missing age.
  if (meta.readSource === "demo") {
    return "Demo rows · fixtures carry no observation time";
  }
  return "Row age unavailable · the read did not name its source";
}

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
  /**
   * Messaging angle for this line. The engine auto-tags it from the creative
   * (`resolveAiTagsForRow`, lib/meta/creatives-copy.ts) and `/api/meta/copies`
   * passes `ai_tags` through; a row the engine did not tag stays null and every
   * angle surface renders an em dash rather than a guess.
   */
  copyAngle: string | null;
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

function resolveCopyAngle(row: MetaCopyApiRow): string | null {
  // `ai_tags` is a declared field of the copies response now that the route
  // passes the engine's tags through, so no cast is needed for it. `copy_angle`
  // is still read defensively — an explicit server angle should win over the
  // tag if one is ever published — and keeps its own narrow cast because no
  // route produces it today (`rg -n 'copy_angle' app/ lib/ components/` finds
  // this reader and nothing that writes it).
  const direct = normalizeCopyIdentity((row as { copy_angle?: unknown }).copy_angle);
  if (direct) return direct;
  const messagingAngles = row.ai_tags?.messagingAngle;
  if (!Array.isArray(messagingAngles)) return null;
  for (const candidate of messagingAngles) {
    const normalized = normalizeCopyIdentity(candidate);
    if (normalized) return normalized;
  }
  return null;
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

/**
 * The ad count exactly as the server counted it.
 *
 * The client must not re-derive this. `/api/meta/copies?groupBy=copy` MERGES
 * every ad carrying one copy into one row, so by the time the rows arrive there
 * is one row per copy and any client-side grouping of them can only ever answer
 * 1 — which is what the Ads column printed for a copy running on ten ads. The
 * route now counts distinct `ad_id` inside each bucket, where the ads still
 * exist, and publishes `associated_ads_count`; this reader only validates it.
 *
 * Anything that is not a positive whole number — absent, null, 0, NaN, a string
 * — is an uncounted set, not a count of zero, so it stays unavailable and the
 * column renders an em dash.
 */
function readServedAdsCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
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
  const servedAdsCount = readServedAdsCount(row.associated_ads_count);

  return {
    id: row.id,
    // NOT `?? row.id`. The copy row id is not a creative id, and substituting
    // it made every row look draftable: the drawer's guard checks for a
    // creative id, so a row the provider gave none for still offered an
    // ENABLED "Draft →" that the server then refused. A missing creative id
    // is missing, and the control stays disabled with its reason.
    creativeId: row.creative_id ?? null,
    objectStoryId: null,
    effectiveObjectStoryId: null,
    postId: row.post_id ?? null,
    name: displayName,
    // The server's own count of the distinct ads it merged into this row. The
    // renderer reads `associatedAdsCount` only when the availability flag is
    // true, so an uncounted row carries 0 and shows an em dash instead of the
    // literal 1 this used to claim for every copy.
    associatedAdsCount: servedAdsCount ?? 0,
    associatedAdsCountAvailable: servedAdsCount !== null,
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
    // The engine's own tags for this creative, carried straight from the
    // response. Hardcoding `{}` here made the row claim it was untagged even
    // when the server had tagged it.
    aiTags: row.ai_tags ?? {},
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
    // Only a real server-supplied copy angle or the creative taxonomy's
    // messagingAngle may populate this field. No client inference is allowed.
    copyAngle: resolveCopyAngle(row),
    // The campaign and ad the served row names. On an aggregated `groupBy=copy`
    // row that is the bucket's SAMPLE, not its full membership, so these are
    // deliberately not the ad count and no surface renders them as one — the
    // count comes from `associated_ads_count` above, which the server took
    // while the whole bucket was still in hand.
    usedInCampaigns: row.campaign_name ? [row.campaign_name] : [],
    usedInAds: row.name ? [row.name] : [],
  };
}
