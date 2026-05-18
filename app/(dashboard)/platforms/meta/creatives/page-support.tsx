import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";
import {
  META_AI_TAG_KEYS,
  type MetaAiTags,
  type MetaCreativeRow,
} from "@/components/creatives/metricConfig";
import type { DecisionEngineV3Response } from "@/lib/creative-decision-engine";
import {
  calculateCreativeAverageOrderValue,
  calculateCreativeClickToAddToCartRate,
  calculateCreativeClickToPurchaseRate,
  calculateCreativeCpcAll,
  calculateCreativeLinkCtr,
  calculateCreativePurchaseValueShare,
  hasCreativeVideoEvidence,
} from "@/components/creatives/creative-truth";
import {
  SHARE_METRIC_KEYS,
  type ShareMetricKey,
  type SharedCreative,
  type SharedCreativeAnalysis,
} from "@/components/creatives/shareCreativeTypes";
import { getLegacyCreativeTypeLabel } from "@/lib/meta/creative-taxonomy";
import { getCreativeStaticPreviewState } from "@/lib/meta/creatives-preview";
import type {
  AiCreativeHistoricalWindow as CreativeHistoricalWindow,
  AiCreativeHistoricalWindows as CreativeHistoricalWindows,
} from "@/lib/meta/creative-scoring";

export interface MetaCreativesResponse {
  status?: string;
  message?: string;
  rows: MetaCreativeApiRow[];
  media_mode?: "metadata" | "full";
  media_hydrated?: boolean;
  snapshot_level?: "metadata" | "full";
  snapshot_source?: "persisted" | "live" | "refresh";
  freshness_state?: "fresh" | "stale" | "expired";
  is_refreshing?: boolean;
  preview_coverage?: {
    totalCreatives: number;
    previewReadyCount: number;
    previewWaitingCount: number;
    previewMissingCount: number;
    previewCoverage: number;
  };
}

export interface MetaCreativeDetailResponse {
  status?: string;
  detail_preview?: {
    creative_id?: string;
    target_id?: string | null;
    target_type?: "ad" | "creative" | string | null;
    mode?: "html" | "unavailable";
    source?: string | null;
    ad_format?: string | null;
    html?: string | null;
  };
}

export type CreativeHistoryWindowKey = "last3" | "last7" | "last14" | "last30" | "last90" | "allHistory";

export type PreviewStripState = "data_loading" | "ready" | "missing";

export const PLATFORM_LABELS: Record<string, string> = {
  meta: "Meta",
  google: "Google",
  tiktok: "TikTok",
  pinterest: "Pinterest",
  snapchat: "Snapchat",
};

export const SHARE_METRIC_IDS = new Set<ShareMetricKey>(SHARE_METRIC_KEYS);

export function hasRenderablePreview(row: MetaCreativeRow): boolean {
  return getCreativeStaticPreviewState(row, "grid") === "ready";
}

export function shouldPollForPreviewReadiness(payload: MetaCreativesResponse | undefined): boolean {
  if (!payload || !Array.isArray(payload.rows) || payload.rows.length === 0) return false;
  const previewWaitingCount = payload.preview_coverage?.previewWaitingCount ?? 0;
  const previewMissingCount = payload.preview_coverage?.previewMissingCount ?? 0;
  if (previewWaitingCount <= 0 && previewMissingCount <= 0) return false;
  if (payload.snapshot_level === "metadata") return true;
  return Boolean(payload.is_refreshing || payload.freshness_state === "stale");
}

export function getPreviewPollingInterval(
  payload: MetaCreativesResponse | undefined
): number | false {
  if (!shouldPollForPreviewReadiness(payload)) return false;
  const previewWaitingCount = payload?.preview_coverage?.previewWaitingCount ?? 0;
  const previewMissingCount = payload?.preview_coverage?.previewMissingCount ?? 0;
  if (previewWaitingCount <= 0 && previewMissingCount <= 0) return false;
  if (payload?.snapshot_level === "metadata") return 2500;
  if (!payload?.is_refreshing && payload?.freshness_state !== "stale") return false;
  return payload.is_refreshing ? 2500 : 8000;
}

export function toCsv(rows: MetaCreativeRow[]): string {
  const headers = [
    "Creative / Ad Name",
    "Launch date",
    "Tags",
    "Spend",
    "Purchase value",
    "ROAS",
    "Cost per purchase",
    "Cost per link click",
    "CPM",
    "Cost per click (all)",
    "Average order value",
    "Clicks (all)",
    "Link clicks",
    "Click through rate (all)",
    "Click through rate (link clicks)",
    "Click to add-to-cart ratio",
    "Add-to-cart to purchase ratio",
    "Click to purchase ratio",
    "Purchases",
    "Impressions",
    "Thumbstop ratio",
    "25% video plays (rate)",
    "50% video plays (rate)",
    "75% video plays (rate)",
    "100% video plays (rate)",
    "% purchase value",
  ];

  const totalPurchaseValue = rows.reduce((sum, row) => sum + row.purchaseValue, 0);
  const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;

  const body = rows.map((row) => {
    const videoApplicable = hasCreativeVideoEvidence(row);
    const aov = calculateCreativeAverageOrderValue(row);
    const cpcAll = calculateCreativeCpcAll(row);
    const linkCtr = calculateCreativeLinkCtr(row);
    const clickToAddToCart = calculateCreativeClickToAddToCartRate(row);
    const clickToPurchase = calculateCreativeClickToPurchaseRate(row);
    const purchaseValueShare = calculateCreativePurchaseValueShare(row, totalPurchaseValue);
    const values = [
      row.name,
      row.launchDate,
      (row.tags ?? []).join(" | "),
      row.spend.toFixed(2),
      row.purchaseValue.toFixed(2),
      row.roas.toFixed(2),
      row.cpa.toFixed(2),
      row.cpcLink.toFixed(2),
      row.cpm.toFixed(2),
      cpcAll.toFixed(2),
      aov.toFixed(2),
      row.clicks,
      row.linkClicks,
      row.ctrAll.toFixed(2),
      linkCtr.toFixed(2),
      clickToAddToCart.toFixed(2),
      row.atcToPurchaseRatio.toFixed(2),
      clickToPurchase.toFixed(2),
      row.purchases,
      row.impressions,
      videoApplicable ? row.thumbstop.toFixed(2) : "",
      videoApplicable ? row.video25.toFixed(2) : "",
      videoApplicable ? row.video50.toFixed(2) : "",
      videoApplicable ? row.video75.toFixed(2) : "",
      videoApplicable ? row.video100.toFixed(2) : "",
      purchaseValueShare.toFixed(2),
    ];
    return values.map(escape).join(",");
  });

  return [headers.map(escape).join(","), ...body].join("\n");
}

export function toSharedCreative(
  row: MetaCreativeRow,
  analysis?: SharedCreativeAnalysis | null,
): SharedCreative {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency ?? null,
    format: row.format,
    previewState: row.previewState,
    isCatalog: row.isCatalog,
    mediaPreviewUrl: row.cardPreviewUrl ?? row.imageUrl ?? row.previewUrl ?? row.cachedThumbnailUrl ?? row.thumbnailUrl ?? row.tableThumbnailUrl ?? null,
    previewUrl: row.previewUrl ?? null,
    imageUrl: row.imageUrl ?? null,
    thumbnailUrl: row.thumbnailUrl ?? null,
    cardPreviewUrl: row.cardPreviewUrl ?? null,
    tableThumbnailUrl: row.tableThumbnailUrl ?? null,
    cachedThumbnailUrl: row.cachedThumbnailUrl ?? null,
    preview: row.preview,
    launchDate: row.launchDate,
    tags: row.tags ?? [],
    spend: row.spend,
    purchaseValue: row.purchaseValue,
    roas: row.roas,
    cpa: row.cpa,
    cpcLink: row.cpcLink,
    cpm: row.cpm,
    ctrAll: row.ctrAll,
    linkCtr: row.linkCtr,
    purchases: row.purchases,
    impressions: row.impressions,
    clicks: row.clicks,
    linkClicks: row.linkClicks,
    addToCart: row.addToCart,
    initiateCheckout: row.initiateCheckout,
    leads: row.leads,
    messages: row.messages,
    thumbstop: row.thumbstop,
    clickToAddToCart: row.clickToAddToCart,
    clickToPurchase: row.clickToPurchase,
    video25: row.video25,
    video50: row.video50,
    video75: row.video75,
    video100: row.video100,
    atcToPurchaseRatio: row.atcToPurchaseRatio,
    hookScore: row.hookScore ?? row.creativeScores?.hook ?? null,
    ctaScore: row.ctaScore ?? row.creativeScores?.cta ?? null,
    offerScore: row.offerScore ?? row.creativeScores?.offer ?? null,
    clickScore: row.clickScore ?? row.creativeScores?.click ?? null,
    watchScore: row.watchScore ?? row.creativeScores?.watch ?? null,
    creativeScoreGap: row.creativeScoreGap?.label
      ? { label: row.creativeScoreGap.label, severity: row.creativeScoreGap.severity ?? null }
      : null,
    analysis: analysis ?? null,
  };
}

function hasMessage(payload: unknown): payload is { message: string } {
  if (!payload || typeof payload !== "object") return false;
  return "message" in payload && typeof payload.message === "string";
}

async function fetchCreativesLikeResponse(
  path: string,
  params: {
    businessId: string;
    start: string;
    end: string;
    groupBy: "adName" | "ad" | "creative" | "adSet";
    format: "all" | "image" | "video";
    sort: "roas" | "spend" | "ctrAll" | "purchaseValue";
    mediaMode?: "metadata" | "full";
  }
): Promise<MetaCreativesResponse> {
  const query = new URLSearchParams({
    businessId: params.businessId,
    start: params.start,
    end: params.end,
    groupBy: params.groupBy,
    format: params.format,
    sort: params.sort,
  });

  if (params.mediaMode) {
    query.set("mediaMode", params.mediaMode);
  }

  const response = await fetch(`${path}?${query.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = hasMessage(payload)
      ? payload.message
      : `Could not load creatives (${response.status}).`;
    throw new Error(message);
  }

  if (!payload || typeof payload !== "object" || !Array.isArray((payload as MetaCreativesResponse).rows)) {
    throw new Error("Invalid creatives response received from backend.");
  }

  return payload as MetaCreativesResponse;
}

export async function fetchMetaCreatives(params: {
  businessId: string;
  start: string;
  end: string;
  groupBy: "adName" | "ad" | "creative" | "adSet";
  format: "all" | "image" | "video";
  sort: "roas" | "spend" | "ctrAll" | "purchaseValue";
  mediaMode?: "metadata" | "full";
}): Promise<MetaCreativesResponse> {
  return fetchCreativesLikeResponse("/api/meta/creatives", {
    ...params,
    mediaMode: params.mediaMode ?? "full",
  });
}

export async function fetchMetaCreativesHistory(params: {
  businessId: string;
  start: string;
  end: string;
  groupBy: "adName" | "ad" | "creative" | "adSet";
  format: "all" | "image" | "video";
  sort: "roas" | "spend" | "ctrAll" | "purchaseValue";
  mediaMode?: "metadata" | "full";
}): Promise<MetaCreativesResponse> {
  return fetchCreativesLikeResponse("/api/meta/creatives/history", {
    ...params,
    mediaMode: params.mediaMode ?? "metadata",
  });
}

export async function fetchMetaCreativeDetailPreview(params: {
  businessId: string;
  creativeId: string;
  adId?: string | null;
  adFormat?: string | null;
}): Promise<MetaCreativeDetailResponse> {
  const query = new URLSearchParams({
    businessId: params.businessId,
    creativeId: params.creativeId,
  });
  if (params.adId?.trim()) query.set("adId", params.adId.trim());
  if (params.adFormat?.trim()) query.set("adFormat", params.adFormat.trim());

  const response = await fetch(`/api/meta/creatives/detail?${query.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = hasMessage(payload)
      ? payload.message
      : `Could not load creative detail (${response.status}).`;
    throw new Error(message);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid creative detail response received from backend.");
  }

  return payload as MetaCreativeDetailResponse;
}

function toHistoricalWindow(row: MetaCreativeRow): CreativeHistoricalWindow {
  return {
    spend: row.spend,
    purchaseValue: row.purchaseValue,
    roas: row.roas,
    cpa: row.cpa,
    ctr: row.ctrAll,
    purchases: row.purchases,
    impressions: row.impressions,
    linkClicks: row.linkClicks,
    hookRate: row.thumbstop,
    holdRate: row.video100,
    video25Rate: row.video25,
    watchRate: row.video50,
    video75Rate: row.video75,
    clickToPurchaseRate: row.clickToPurchase,
    atcToPurchaseRate: row.atcToPurchaseRatio,
  };
}

export function buildCreativeHistoryById(input: Partial<Record<CreativeHistoryWindowKey, MetaCreativeRow[]>>) {
  const map = new Map<string, CreativeHistoricalWindows>();
  const windowKeys = Object.keys(input) as CreativeHistoryWindowKey[];

  for (const windowKey of windowKeys) {
    const rows = input[windowKey] ?? [];
    for (const row of rows) {
      const existing = map.get(row.id) ?? {};
      existing[windowKey] = toHistoricalWindow(row);
      map.set(row.id, existing);
    }
  }

  return map;
}

function safeString(value: unknown, fallback = "") {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function nullableString(value: unknown) {
  const text = safeString(value);
  return text || null;
}

function safeNumber(value: unknown, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function safeNullableNumber(value: unknown) {
  const parsed = safeNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  if (typeof value === "number") return value === 1;
  return false;
}

function safeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => safeString(item)).filter(Boolean);
  }
  const text = safeString(value);
  return text ? [text] : [];
}

function safeAiTags(value: unknown): MetaAiTags {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const next: MetaAiTags = {};
  for (const key of META_AI_TAG_KEYS) {
    const values = safeStringArray(source[key]);
    if (values.length > 0) next[key] = values;
  }
  return next;
}

function safePreview(value: unknown, isCatalog: boolean): MetaCreativeRow["preview"] {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const renderMode = source.render_mode === "video" || source.render_mode === "image"
    ? source.render_mode
    : "unavailable";
  return {
    render_mode: renderMode,
    image_url: nullableString(source.image_url),
    video_url: nullableString(source.video_url),
    poster_url: nullableString(source.poster_url),
    source: nullableString(source.source) as MetaCreativeRow["preview"]["source"],
    is_catalog: safeBoolean(source.is_catalog) || isCatalog,
  };
}

export function mapApiRowToUiRow(row: MetaCreativeApiRow): MetaCreativeRow {
  const taxonomySource = row.taxonomy_source ?? "legacy_fallback";
  const legacyCreativeType = row.creative_type ?? "feed";
  const legacyCreativeTypeLabel =
    row.creative_type_label ?? getLegacyCreativeTypeLabel(legacyCreativeType);
  const isCatalog = safeBoolean(row.is_catalog);
  const preview = safePreview(row.preview, isCatalog);
  const id = safeString(row.id, safeString(row.creative_id, "creative"));
  const creativeId = safeString(row.creative_id, id);
  const name = safeString(row.name, safeString(row.copy_text, `Creative ${creativeId}`));
  const purchases = safeNumber(row.purchases);
  const impressions = safeNumber(row.impressions);
  const clicks = safeNumber(row.clicks);
  const linkClicks = safeNumber(row.link_clicks);
  const addToCart = safeNumber(row.add_to_cart);
  const clickToAddToCart = safeNumber(row.click_to_atc);
  const clickToPurchase = linkClicks > 0 ? (purchases / linkClicks) * 100 : 0;
  const linkCtr = impressions > 0 ? (linkClicks / impressions) * 100 : 0;

  return {
    id,
    creativeId,
    realAdId: nullableString(row.real_ad_id),
    objectStoryId: nullableString(row.object_story_id),
    effectiveObjectStoryId: nullableString(row.effective_object_story_id),
    postId: nullableString(row.post_id),
    copyText: nullableString(row.copy_text),
    copyVariants: safeStringArray(row.copy_variants),
    headlineVariants: safeStringArray(row.headline_variants),
    descriptionVariants: safeStringArray(row.description_variants),
    name,
    associatedAdsCount: Math.max(1, Math.round(safeNumber(row.associated_ads_count, 1))),
    accountId: nullableString(row.account_id),
    accountName: nullableString(row.account_name),
    campaignId: nullableString(row.campaign_id),
    campaignName: nullableString(row.campaign_name),
    adSetId: nullableString(row.adset_id),
    adSetName: nullableString(row.adset_name),
    effectiveStatus: nullableString(row.effective_status),
    currency: nullableString(row.currency),
    format: safeString(row.format, "image") as MetaCreativeRow["format"],
    creativeType: legacyCreativeType,
    creativeTypeLabel: legacyCreativeTypeLabel,
    creativeDeliveryType: safeString(row.creative_delivery_type, "standard") as MetaCreativeRow["creativeDeliveryType"],
    creativeVisualFormat: safeString(row.creative_visual_format, "image") as MetaCreativeRow["creativeVisualFormat"],
    creativePrimaryType: safeString(row.creative_primary_type, "standard") as MetaCreativeRow["creativePrimaryType"],
    creativePrimaryLabel: nullableString(row.creative_primary_label),
    creativeSecondaryType: nullableString(row.creative_secondary_type) as MetaCreativeRow["creativeSecondaryType"],
    creativeSecondaryLabel: nullableString(row.creative_secondary_label),
    taxonomyVersion: row.taxonomy_version,
    taxonomySource,
    taxonomyReconciledByVideoEvidence: row.taxonomy_reconciled_by_video_evidence ?? false,
    thumbnailUrl: nullableString(row.thumbnail_url),
    previewUrl: nullableString(row.preview_url),
    imageUrl: nullableString(row.image_url),
    tableThumbnailUrl: nullableString(row.table_thumbnail_url) ?? nullableString(row.thumbnail_url),
    cardPreviewUrl: nullableString(row.card_preview_url) ?? nullableString(row.image_url) ?? nullableString(row.thumbnail_url) ?? nullableString(row.preview_url),
    previewManifest:
      row.preview_manifest && typeof row.preview_manifest === "object" && !Array.isArray(row.preview_manifest)
        ? row.preview_manifest
        : null,
    isCatalog,
    previewState:
      row.preview_state === "preview" || row.preview_state === "catalog"
        ? row.preview_state
        : row.card_preview_url || row.table_thumbnail_url || row.cached_thumbnail_url || row.preview_url || row.thumbnail_url || row.image_url
          ? "preview"
          : "unavailable",
    preview,
    launchDate: safeString(row.launch_date),
    tags: safeStringArray(row.tags),
    aiTags: safeAiTags(row.ai_tags),
    spend: safeNumber(row.spend),
    purchaseValue: safeNumber(row.purchase_value),
    roas: safeNumber(row.roas),
    cpa: safeNumber(row.cpa),
    cpcLink: safeNumber(row.cpc_link),
    cpm: safeNumber(row.cpm),
    ctrAll: safeNumber(row.ctr_all),
    linkCtr,
    purchases,
    impressions,
    clicks,
    frequency: safeNullableNumber(row.frequency),
    linkClicks,
    landingPageViews: safeNumber(row.landing_page_views),
    addToCart,
    initiateCheckout: safeNumber(row.initiate_checkout),
    leads: safeNumber(row.leads),
    messages: safeNumber(row.messages),
    thumbstop: safeNumber(row.thumbstop),
    clickToAddToCart,
    clickToPurchase,
    seeMoreRate: 0,
    video25: safeNumber(row.video25),
    video50: safeNumber(row.video50),
    video75: safeNumber(row.video75),
    video100: safeNumber(row.video100),
    atcToPurchaseRatio: safeNumber(row.atc_to_purchase),
    cachedThumbnailUrl: row.cached_thumbnail_url ?? null,
    previewStatus: row.preview_status ?? (row.preview_url || row.thumbnail_url || row.image_url ? "ready" : "missing"),
    previewOrigin: row.preview_origin ?? null,
  };
}

export function CreativesTableShell() {
  return (
    <div className="rounded-xl border bg-white">
      <div className="border-b px-4 py-3">
        <div className="h-4 w-48 animate-pulse rounded bg-slate-200" />
      </div>
      <div className="divide-y">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3">
            <div className="h-4 w-4 animate-pulse rounded bg-slate-200" />
            <div className="h-10 w-10 animate-pulse rounded-md bg-slate-200" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-56 animate-pulse rounded bg-slate-200" />
              <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
            </div>
            <div className="hidden gap-3 md:flex">
              <div className="h-4 w-16 animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-14 animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-12 animate-pulse rounded bg-slate-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export async function fetchCreativeDecisionEngineV3(params: {
  businessId: string;
  asOf?: string;
  creativeIds?: string[];
  campaignId?: string | null;
}): Promise<DecisionEngineV3Response> {
  const url = new URL("/api/creatives/decision-engine-v3", window.location.origin);
  url.searchParams.set("businessId", params.businessId);
  if (params.asOf) url.searchParams.set("asOf", params.asOf);
  if (params.campaignId) url.searchParams.set("campaignId", params.campaignId);
  if (params.creativeIds && params.creativeIds.length > 0) {
    url.searchParams.set("creativeIds", params.creativeIds.join(","));
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`decision engine v3 fetch failed: ${response.status} ${text}`);
  }

  return (await response.json()) as DecisionEngineV3Response;
}
export type { DecisionEngineV3Response };
