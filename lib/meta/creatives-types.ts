// ── Primitive enums / unions ───────────────────────────────────────────────────

export type GroupBy = "adName" | "ad" | "creative" | "adSet";
export type FormatFilter = "all" | "image" | "video";
export type SortKey = "roas" | "spend" | "ctrAll" | "purchaseValue";
export type CreativeFormat = "image" | "video" | "catalog";
export type CreativeType = "feed" | "video" | "flexible" | "feed_catalog";
export type CreativeDeliveryType = "standard" | "catalog" | "flexible" | "mixed";
export type CreativeVisualFormat = "image" | "video" | "carousel" | "mixed";
export type CreativePrimaryType = "standard" | "catalog" | "flexible" | "carousel" | "video" | "mixed";
export type CreativeSecondaryType = "video" | "carousel";
export type CreativeTaxonomyVersion = "v2";
export type CreativeTaxonomySource = "deterministic" | "legacy_fallback";
export type PreviewContractVersion = "v5";
export type PreviewSourceKind = "non_thumbnail_static" | "thumbnail_static" | "none";
export type PreviewResolutionClass = "high_res" | "medium_res" | "low_res" | "unknown";
export type PreviewManifestRenderState =
  | "renderable_high_quality"
  | "renderable_low_quality"
  | "missing";
export type PreviewCardState = "ready" | "waiting_meta" | "missing";
export type PreviewWaitingReason = "awaiting_card_source" | "missing_media";
export type PreviewSourceReason =
  | "card_prefer_non_thumbnail"
  | "card_promoted_larger_thumbnail"
  | "table_thumbnail_preferred"
  | "fallback_static_source"
  | "unavailable";
export type AiTagKey =
  | "assetType"
  | "visualFormat"
  | "intendedAudience"
  | "messagingAngle"
  | "seasonality"
  | "offerType"
  | "hookTactic"
  | "headlineTactic";
export type MetaAiTags = Partial<Record<AiTagKey, string[]>>;
export type LegacyPreviewState = "preview" | "catalog" | "unavailable";
export type PreviewRenderMode = "video" | "image" | "unavailable";
export type NormalizedPreviewSource =
  | "preview_url"
  | "thumbnail_url"
  | "image_url"
  | "image_hash"
  | null;

// ── Preview observability ──────────────────────────────────────────────────────

export type PreviewResolutionStage =
  | "video_source"
  | "image_hash_lookup"
  | "object_story_spec"
  | "asset_feed"
  | "creative_image"
  | "creative_thumbnail"
  | "creative_image_fallback"
  | "creative_thumbnail_fallback"
  | "fallback"
  | "unavailable";

export type PreviewNullReason =
  | "catalog_without_assets"
  | "video_without_poster"
  | "no_candidates"
  | "no_renderable_image"
  | "unavailable";

export type PreviewResolutionReason =
  | "video_selected"
  | "best_image_candidate"
  | "thumbnail_candidate"
  | "resolved_thumbnail_fallback"
  | "generic_fallback"
  | "no_resolved_preview";

export type PreviewObservabilityStats = {
  total_rows: number;
  preview_ready_count: number;
  preview_waiting_count: number;
  preview_missing_count: number;
  render_mode_counts: { video: number; image: number; unavailable: number };
  resolution_stage_counts: Partial<Record<PreviewResolutionStage, number>>;
  null_reason_counts: Partial<Record<PreviewNullReason, number>>;
  resolution_reason_counts: Partial<Record<PreviewResolutionReason, number>>;
  selected_source_counts: Record<string, number>;
};

// ── Debug / patch types ────────────────────────────────────────────────────────

export type CreativeDebugInfo = {
  stage_fetch_source?: string | null;
  stage_has_raw_ad?: boolean;
  stage_raw_ad_id?: string | null;
  stage_raw_ad_creative?: boolean;
  stage_raw_ad_creative_thumbnail_url?: string | null;
  stage_enriched_ad_creative?: boolean;
  stage_enriched_ad_creative_thumbnail_url?: string | null;
  stage_row_input_thumbnail_url?: string | null;
  stage_final_thumbnail_url?: string | null;
  stage_null_reason?: PreviewNullReason | string | null;
  raw_creative_thumbnail_url?: string | null;
  enriched_creative_thumbnail_url?: string | null;
  resolved_thumbnail_source?: string | null;
  resolution_stage?: PreviewResolutionStage | string | null;
  creative_object_type?: string | null;
  creative_video_ids?: string[] | null;
  creative_effective_object_story_id?: string | null;
  creative_object_story_id?: string | null;
  creative_object_story_video_id?: string | null;
  creative_asset_video_ids?: string[] | null;
  preview_selected_source?: string | null;
  preview_selected_url?: string | null;
  preview_render_mode?: PreviewRenderMode | null;
  preview_candidates_count?: number;
  preview_resolution_reason?: PreviewResolutionReason | string | null;
};

export type CreativeClassificationSignals = {
  is_catalog_by_object_type: boolean;
  has_template_data: boolean;
  has_promoted_product_set_id: boolean;
  has_promoted_catalog_id: boolean;
  has_asset_feed_catalog_id: boolean;
  has_asset_feed_product_set_id: boolean;
  child_attachment_count: number;
  has_top_level_video_id: boolean;
  has_object_story_video_data: boolean;
  has_video_object_type: boolean;
  asset_feed_image_count: number;
  asset_feed_video_count: number;
  has_asset_feed_spec: boolean;
  has_mixed_asset_families: boolean;
  has_multi_image_assets: boolean;
  has_multi_video_assets: boolean;
};

export type PreviewDebugPatch = {
  stage_final_thumbnail_url?: string | null;
  stage_null_reason?: PreviewNullReason | string | null;
  resolved_thumbnail_source?: string | null;
  resolution_stage?: PreviewResolutionStage | string | null;
  preview_selected_source?: string | null;
  preview_selected_url?: string | null;
  preview_render_mode?: PreviewRenderMode | null;
  preview_candidates_count?: number;
  preview_resolution_reason?: PreviewResolutionReason | string | null;
};

// ── Preview payload ────────────────────────────────────────────────────────────

export interface NormalizedRenderPreviewPayload {
  render_mode: PreviewRenderMode;
  image_url: string | null;
  video_url: string | null;
  poster_url: string | null;
  source: NormalizedPreviewSource;
  is_catalog: boolean;
}

export interface UrlValidationResult {
  isValid: boolean;
  method: "HEAD" | "GET" | "none";
  status: number | null;
  finalUrl: string | null;
  contentType: string | null;
  contentLength: string | null;
  error: string | null;
}

export interface PreviewAuditCandidate {
  source: string;
  url: string;
  validation: UrlValidationResult;
}

export interface PreviewAuditSample {
  account_id: string;
  ad_id: string;
  creative_id: string | null;
  creative_name: string;
  creative_object_type: string | null;
  direct: {
    thumbnail_url: string | null;
    image_url: string | null;
    image_hash: string | null;
  };
  object_story_spec: {
    video_data_video_id: string | null;
    video_data_thumbnail_url: string | null;
    video_data_image_url: string | null;
    photo_data_image_url: string | null;
    link_data_picture: string | null;
    link_data_image_hash: string | null;
    link_data_child_attachments: Array<{ picture: string | null; image_url: string | null; image_hash: string | null }>;
  };
  asset_feed_spec: {
    catalog_id: string | null;
    product_set_id: string | null;
    images: Array<{ image_url: string | null; url: string | null; original_url: string | null; hash: string | null }>;
    videos: Array<{ video_id: string | null; thumbnail_url: string | null; image_url: string | null }>;
  };
  promoted_object: {
    promoted_product_set_id: string | null;
    promoted_catalog_id: string | null;
    adset_promoted_product_set_id: string | null;
    adset_promoted_catalog_id: string | null;
  };
  image_hash_lookup: Array<{ hash: string; resolved: boolean; resolved_url: string | null }>;
  candidates: PreviewAuditCandidate[];
  chosen_preview_source: string | null;
  chosen_preview_url: string | null;
  chosen_render_mode: PreviewRenderMode;
  is_catalog: boolean;
  format: CreativeFormat;
}

// ── Meta API raw record types ──────────────────────────────────────────────────

export type MetaPromotedObjectLike = {
  product_set_id?: string | null;
  catalog_id?: string | null;
  pixel_id?: string | null;
  custom_event_type?: string | null;
  custom_conversion_id?: string | null;
  smart_pse_enabled?: boolean | null;
} | null;

export interface MetaActionValue {
  action_type: string;
  value: string;
}

export interface MetaInsightRecord {
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
  video_thruplay_watched_actions?: MetaActionValue[];
  video_p25_watched_actions?: MetaActionValue[];
  video_p50_watched_actions?: MetaActionValue[];
  video_p75_watched_actions?: MetaActionValue[];
  video_p100_watched_actions?: MetaActionValue[];
}

export interface MetaAccountRecord {
  id?: string;
  name?: string;
  currency?: string | null;
}

export interface MetaAdImageRecord {
  hash?: string;
  url?: string | null;
  url_128?: string | null;
  url_256?: string | null;
  permalink_url?: string | null;
}

export interface MetaAdRecord {
  id?: string;
  name?: string;
  effective_status?: string | null;
  status?: string | null;
  bid_strategy?: string | null;
  optimization_goal?: string | null;
  attribution_setting?: string | null;
  object_story_id?: string | null;
  effective_object_story_id?: string | null;
  adset_id?: string;
  adset?: {
    id?: string;
    name?: string;
    daily_budget?: string | number | null;
    lifetime_budget?: string | number | null;
    bid_strategy?: string | null;
    optimization_goal?: string | null;
    promoted_object?: {
      product_set_id?: string | null;
      catalog_id?: string | null;
      pixel_id?: string | null;
      custom_event_type?: string | null;
      custom_conversion_id?: string | null;
      smart_pse_enabled?: boolean | null;
    } | null;
  } | null;
  campaign?: {
    id?: string;
    name?: string;
    objective?: string | null;
    daily_budget?: string | number | null;
    lifetime_budget?: string | number | null;
    bid_strategy?: string | null;
  } | null;
  promoted_object?: {
    product_set_id?: string | null;
    catalog_id?: string | null;
    pixel_id?: string | null;
    custom_event_type?: string | null;
    custom_conversion_id?: string | null;
    smart_pse_enabled?: boolean | null;
  } | null;
  created_time?: string;
  creative?: {
    id?: string;
    name?: string;
    body?: string | null;
    title?: string | null;
    text?: string | null;
    message?: string | null;
    description?: string | null;
    object_type?: string | null;
    video_id?: string | null;
    object_story_id?: string | null;
    effective_object_story_id?: string | null;
    thumbnail_id?: string | null;
    thumbnail_url?: string | null;
    image_url?: string | null;
    image_hash?: string | null;
    object_story_spec?: {
      link_data?: {
        link?: string | null;
        message?: string | null;
        name?: string | null;
        description?: string | null;
        picture?: string | null;
        image_hash?: string | null;
        call_to_action?: {
          type?: string | null;
          value?: {
            link?: string | null;
          } | null;
        } | null;
        child_attachments?: Array<{
          link?: string | null;
          picture?: string | null;
          image_url?: string | null;
          image_hash?: string | null;
        }> | null;
      } | null;
      video_data?: {
        video_id?: string | null;
        image_url?: string | null;
        thumbnail_url?: string | null;
        message?: string | null;
        title?: string | null;
        call_to_action?: {
          type?: string | null;
          value?: {
            link?: string | null;
          } | null;
        } | null;
      } | null;
      photo_data?: {
        image_url?: string | null;
        message?: string | null;
        caption?: string | null;
        call_to_action?: {
          type?: string | null;
          value?: {
            link?: string | null;
          } | null;
        } | null;
      } | null;
      template_data?: Record<string, unknown> | null;
    } | null;
    asset_feed_spec?: {
      catalog_id?: string | null;
      product_set_id?: string | null;
      bodies?: Array<{ text?: string | null }> | null;
      titles?: Array<{ text?: string | null }> | null;
      descriptions?: Array<{ text?: string | null }> | null;
      images?: Array<{
        url?: string | null;
        image_url?: string | null;
        original_url?: string | null;
        hash?: string | null;
        image_hash?: string | null;
      }> | null;
      videos?: Array<{ video_id?: string | null; thumbnail_url?: string | null; image_url?: string | null }> | null;
      link_urls?: Array<{
        website_url?: string | null;
        display_url?: string | null;
        url?: string | null;
      }> | null;
    } | null;
  } | null;
}

export interface MetaAdCreativeMediaOnlyRecord {
  id?: string;
  creative?: MetaAdRecord["creative"];
}

export interface MetaAccountMeta {
  id: string;
  name: string | null;
  currency: string | null;
}

export interface MetaCreativePreviewHtmlResponse {
  data?: Array<{ body?: string | null }>;
}

// ── Copy types ─────────────────────────────────────────────────────────────────

export type CopySourceLabel =
  | "asset_feed_spec.bodies"
  | "asset_feed_spec.titles"
  | "asset_feed_spec.descriptions"
  | "object_story_spec.message"
  | "object_story_spec.name"
  | "object_story_spec.description"
  | "creative.body"
  | "creative.title"
  | "creative.description"
  | "story_lookup"
  | "preview_html";

export type CopyExtraction = {
  copy_text: string | null;
  copy_variants: string[];
  headline_variants: string[];
  description_variants: string[];
  copy_source: CopySourceLabel | null;
};

export type StoryCopyPayload = {
  message: string[];
  headline: string[];
  description: string[];
};

// ── Shared row field groups ────────────────────────────────────────────────────

export interface CreativeIdentityFields {
  id: string;
  creative_id: string;
  real_ad_id?: string | null;
  object_story_id?: string | null;
  effective_object_story_id?: string | null;
  post_id?: string | null;
  associated_ads_count: number;
  account_id: string;
  account_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  currency: string | null;
  name: string;
  launch_date: string;
}

export interface CreativeCopyFields {
  copy_text: string | null;
  copy_variants: string[];
  headline_variants: string[];
  description_variants: string[];
  copy_source: CopySourceLabel | null;
  copy_debug_sources?: string[];
  unresolved_reason?: string | null;
}

/** preview_state: "catalog" | "preview" | "unavailable" — use this to drive UI rendering */
export interface CreativePreviewFields {
  preview_url: string | null;
  preview_source: string | null;
  thumbnail_url: string | null;
  image_url: string | null;
  table_thumbnail_url?: string | null;
  card_preview_url?: string | null;
  preview_contract_version?: PreviewContractVersion;
  preview_manifest?: CreativePreviewManifest | null;
  card_preview_source_kind?: PreviewSourceKind | null;
  card_preview_resolution_class?: PreviewResolutionClass | null;
  table_preview_source_kind?: PreviewSourceKind | null;
  preview_source_reason?: PreviewSourceReason | null;
  is_catalog: boolean;
  preview_state: LegacyPreviewState;
  preview: NormalizedRenderPreviewPayload;
  image_hash?: string | null;
  image_hashes?: string[];
}

export interface CreativeWarehouseCommonFields {
  reach?: number;
  frequency?: number | null;
  outbound_clicks?: number;
  effective_status?: string | null;
  objective?: string | null;
  attribution_setting?: string | null;
  quality_ranking?: string | null;
  engagement_rate_ranking?: string | null;
  conversion_rate_ranking?: string | null;
  bid_strategy?: string | null;
  optimization_goal?: string | null;
  campaign_daily_budget?: number | null;
  adset_daily_budget?: number | null;
  campaign_lifetime_budget?: number | null;
  adset_lifetime_budget?: number | null;
  destination_url?: string | null;
  destination_url_raw?: string | null;
  destination_url_source?: string | null;
  destination_url_confidence?: string | null;
  cta_type?: string | null;
}

export interface CreativePreviewManifest {
  table_src: string | null;
  card_src: string | null;
  detail_image_src: string | null;
  detail_video_src: string | null;
  render_state: PreviewManifestRenderState;
  card_state: PreviewCardState;
  waiting_reason: PreviewWaitingReason | null;
  table_source_kind: PreviewSourceKind | null;
  card_source_kind: PreviewSourceKind | null;
  resolution_class: PreviewResolutionClass | null;
  thumbnail_like: boolean;
  source_reason: PreviewSourceReason | null;
  needs_card_enrichment: boolean;
  live_html_available: boolean;
}

export interface CreativeClassificationFields {
  tags: string[];
  ai_tags: MetaAiTags;
  format: CreativeFormat;
  creative_type: CreativeType;
  creative_type_label: string;
  creative_delivery_type: CreativeDeliveryType;
  creative_visual_format: CreativeVisualFormat;
  creative_primary_type: CreativePrimaryType;
  creative_primary_label: string | null;
  creative_secondary_type: CreativeSecondaryType | null;
  creative_secondary_label: string | null;
  classification_signals?: CreativeClassificationSignals | null;
  taxonomy_version?: CreativeTaxonomyVersion;
  taxonomy_source?: CreativeTaxonomySource | null;
  taxonomy_reconciled_by_video_evidence?: boolean;
}

/**
 * Every numeric wire field whose availability can be stated separately.
 *
 * Wire names, not camelCase UI names, because the sidecar travels beside the
 * numbers on `MetaCreativeApiRow` and must be readable against them without a
 * translation table in between.
 */
export const CREATIVE_METRIC_PRESENCE_KEYS = [
  "spend",
  "purchase_value",
  "roas",
  "cpa",
  "clicks",
  "cpc_link",
  "cpm",
  "ctr_all",
  "purchases",
  "impressions",
  "link_clicks",
  "landing_page_views",
  "thruplay_actions",
  "view_content",
  "post_engagement",
  "add_to_cart",
  "initiate_checkout",
  "thumbstop",
  "click_to_atc",
  "atc_to_purchase",
  "leads",
  "messages",
  "frequency",
  "video25",
  "video50",
  "video75",
  "video100",
] as const;

export type CreativeMetricPresenceKey = (typeof CREATIVE_METRIC_PRESENCE_KEYS)[number];

/**
 * Which metrics on this row came from a real source value, per field.
 *
 * PRODUCED BEFORE COALESCING, at the point where the nullable source is still
 * in hand. That is the whole reason it exists: every numeric field below ends
 * up a `number` because `normalizeCreativeMetricFields` and
 * `buildMetaCreativeApiRow` finish with `?? 0` / `: 0`, so by the time a row is
 * on the wire the difference between "the account measured zero" and "no source
 * ever supplied this" has already been destroyed. A reader cannot recover it
 * from the number — 0 is a legitimate measurement — so the producer has to say
 * so separately.
 *
 * `true` means a real source supplied it (0 included: a paused, never-delivered
 * ad genuinely spent nothing, and an em dash there would hide a fact).
 * `false` means the producer manufactured the number with nothing behind it.
 * An absent key, or an absent map, means the producer does not publish
 * availability for that field and the legacy number stands — which is what
 * keeps every existing producer working unchanged.
 */
export type CreativeMetricPresence = Partial<Record<CreativeMetricPresenceKey, boolean>>;

/**
 * Was this field served by a real source?
 *
 * The default is `true`, deliberately. A row that carries no presence map comes
 * from a producer that does not publish availability, and withholding its
 * numbers would turn a silent producer into a blanked-out surface. Only an
 * explicit `false` withholds.
 *
 * Lives in the types module because both the producer chain
 * (`creatives-service-support`, `creatives-warehouse`) and the aggregator
 * (`creatives-row-mappers`) need it, and those two already import each other.
 */
export function isCreativeMetricAvailable(
  presence: CreativeMetricPresence | undefined,
  key: CreativeMetricPresenceKey,
): boolean {
  return presence?.[key] !== false;
}

/**
 * Did a producer STATE that this field is available?
 *
 * Distinct from `isCreativeMetricAvailable`, and the distinction is the whole
 * point. That function answers "may this number be shown", so an absent key
 * defaults to `true`. This one answers "did anything actually establish this
 * field", so an absent key is `false`.
 *
 * The difference matters wherever one source's silence is being used as
 * evidence FOR another source's number. `hydrateWarehouseCreativeMetrics` falls
 * back from a null fact column to the projection's number, and it may only
 * publish that as available if the projection SAID so. Reading the permissive
 * default there turned "nobody knows" into "the projection vouches for it",
 * which is how a genuinely unread funnel counter became a measured zero on
 * screen.
 */
export function isCreativeMetricDeclaredAvailable(
  presence: CreativeMetricPresence | undefined,
  key: CreativeMetricPresenceKey,
): boolean {
  return presence?.[key] === true;
}

/**
 * The presence map of a grouped row.
 *
 * THE AGGREGATION RULE, three-way and deliberate, because a creative-grain
 * bucket is a SUM over the window's day-rows:
 *
 *   1. any member states `false`  -> `false`. A sum over a set where one member
 *      never supplied the field is an understatement, not a measurement —
 *      three days of add-to-cart plus two days of nothing is not five days of
 *      add-to-cart — so one unavailable member makes the whole bucket
 *      unavailable. This is the "available only if it was available on the rows
 *      that fed it" half.
 *   2. else every member states `true` -> `true`.
 *   3. else the key is OMITTED — no member had an opinion, so the bucket has
 *      none either.
 *
 * Rule 3 is not the same as `true`, and collapsing it into `true` (which
 * `rows.every(isCreativeMetricAvailable)` did, because that helper defaults an
 * absent key to available) is what made silence look like a producer's
 * guarantee. Downstream, an omitted key still READS as available through
 * `isCreativeMetricAvailable` — the additive default is unchanged and no number
 * is withheld by this — but it can no longer be quoted back as evidence by
 * `isCreativeMetricDeclaredAvailable`.
 *
 * Returns undefined when no member published availability at all, so a group of
 * legacy rows stays a legacy row.
 */
export function intersectCreativeMetricPresence(
  rows: Array<{ metric_presence?: CreativeMetricPresence }>,
): CreativeMetricPresence | undefined {
  if (!rows.some((row) => row.metric_presence)) return undefined;
  const merged: CreativeMetricPresence = {};
  for (const key of CREATIVE_METRIC_PRESENCE_KEYS) {
    const stated = rows
      .map((row) => row.metric_presence?.[key])
      .filter((value): value is boolean => typeof value === "boolean");
    if (stated.length === 0) continue;
    merged[key] = stated.every((value) => value === true);
  }
  return merged;
}

export interface CreativeMetricFields {
  spend: number;
  purchase_value: number;
  roas: number;
  cpa: number;
  clicks: number;
  cpc_link: number;
  cpm: number;
  ctr_all: number;
  purchases: number;
  impressions: number;
  link_clicks: number;
  landing_page_views: number;
  thruplay_actions?: number;
  view_content?: number;
  post_engagement?: number;
  add_to_cart: number;
  initiate_checkout: number;
  thumbstop: number;
  click_to_atc: number;
  atc_to_purchase: number;
  leads: number;
  messages: number;
  video25: number;
  video50: number;
  video75: number;
  video100: number;
  /**
   * Per-field availability for the numbers above. Optional and additive: the
   * numeric fields keep their existing types and values, so nothing that reads
   * them today changes behaviour.
   */
  metric_presence?: CreativeMetricPresence;
}

// ── Row types ──────────────────────────────────────────────────────────────────

export interface RawCreativeRow
  extends CreativeIdentityFields,
    CreativeCopyFields,
    CreativePreviewFields,
    CreativeClassificationFields,
    CreativeMetricFields,
    CreativeWarehouseCommonFields {
  debug?: CreativeDebugInfo;
}

/**
 * Public API row uses the nested `debug` object.
 * Legacy flat debug fields remain internal-only for backward compatibility.
 */
export interface MetaCreativeApiRow
  extends CreativeIdentityFields,
    CreativePreviewFields,
    CreativeClassificationFields,
    CreativeMetricFields,
    CreativeWarehouseCommonFields {
  copy_text?: string | null;
  copy_variants?: string[];
  headline_variants?: string[];
  description_variants?: string[];
  copy_source?: CopySourceLabel | null;
  copy_debug_sources?: string[];
  unresolved_reason?: string | null;
  /** Internal cached URL. Prefer over thumbnail_url/image_url when available. */
  cached_thumbnail_url?: string | null;
  preview_status?: "ready" | "missing";
  preview_origin?: "snapshot" | "cache" | "live" | "fallback";
  debug?: CreativeDebugInfo;
}
