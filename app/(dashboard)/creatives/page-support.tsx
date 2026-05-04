import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionResponse } from "@/lib/creative-decision-engine";
import {
  calculateCreativeAverageOrderValue,
  calculateCreativeClickToAddToCartRate,
  calculateCreativeClickToPurchaseRate,
  calculateCreativeCpcAll,
  calculateCreativeLinkCtr,
  calculateCreativePurchaseValueShare,
  hasCreativeVideoEvidence,
} from "@/components/creatives/creative-truth";
import type {
  ShareMetricKey,
  SharedCreative,
  SharedCreativeAnalysis,
} from "@/components/creatives/shareCreativeTypes";
import {
  getLegacyCreativeTypeLabel,
} from "@/lib/meta/creative-taxonomy";
import { getCreativeStaticPreviewState } from "@/lib/meta/creatives-preview";
import type { CreativeHistoricalWindow, CreativeHistoricalWindows } from "@/src/services";

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

export const SHARE_METRIC_IDS = new Set<ShareMetricKey>(["spend", "purchaseValue", "roas", "cpa", "ctrAll", "purchases"]);

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
    previewUrl: row.previewUrl ?? null,
    imageUrl: row.imageUrl ?? null,
    thumbnailUrl: row.thumbnailUrl ?? null,
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
    thumbstop: row.thumbstop,
    clickToAddToCart: row.clickToAddToCart,
    clickToPurchase: row.clickToPurchase,
    video25: row.video25,
    video50: row.video50,
    video75: row.video75,
    video100: row.video100,
    atcToPurchaseRatio: row.atcToPurchaseRatio,
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
    groupBy: "adName" | "creative" | "adSet";
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
  groupBy: "adName" | "creative" | "adSet";
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
  groupBy: "adName" | "creative" | "adSet";
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
}): Promise<MetaCreativeDetailResponse> {
  const query = new URLSearchParams({
    businessId: params.businessId,
    creativeId: params.creativeId,
  });

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

export function mapApiRowToUiRow(row: MetaCreativeApiRow): MetaCreativeRow {
  const taxonomySource = row.taxonomy_source ?? "legacy_fallback";
  const legacyCreativeType = row.creative_type ?? "feed";
  const legacyCreativeTypeLabel =
    row.creative_type_label ?? getLegacyCreativeTypeLabel(legacyCreativeType);
  const safeNumber = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const purchases = safeNumber(row.purchases);
  const impressions = safeNumber(row.impressions);
  const clicks = safeNumber(row.clicks);
  const linkClicks = safeNumber(row.link_clicks);
  const addToCart = safeNumber(row.add_to_cart);
  const clickToAddToCart = safeNumber(row.click_to_atc);
  const clickToPurchase = linkClicks > 0 ? (purchases / linkClicks) * 100 : 0;
  const linkCtr = impressions > 0 ? (linkClicks / impressions) * 100 : 0;

  return {
    id: row.id,
    creativeId: row.creative_id,
    objectStoryId: row.object_story_id ?? null,
    effectiveObjectStoryId: row.effective_object_story_id ?? null,
    postId: row.post_id ?? null,
    copyText: row.copy_text ?? null,
    copyVariants: row.copy_variants ?? [],
    headlineVariants: row.headline_variants ?? [],
    descriptionVariants: row.description_variants ?? [],
    name: row.name,
    associatedAdsCount: row.associated_ads_count,
    accountId: row.account_id ?? null,
    accountName: row.account_name ?? null,
    campaignId: row.campaign_id ?? null,
    campaignName: row.campaign_name ?? null,
    adSetId: row.adset_id ?? null,
    adSetName: row.adset_name ?? null,
    currency: row.currency ?? null,
    format: row.format ?? "image",
    creativeType: legacyCreativeType,
    creativeTypeLabel: legacyCreativeTypeLabel,
    creativeDeliveryType: row.creative_delivery_type ?? "standard",
    creativeVisualFormat: row.creative_visual_format ?? "image",
    creativePrimaryType: row.creative_primary_type ?? "standard",
    creativePrimaryLabel: row.creative_primary_label ?? null,
    creativeSecondaryType: row.creative_secondary_type ?? null,
    creativeSecondaryLabel: row.creative_secondary_label ?? null,
    taxonomyVersion: row.taxonomy_version,
    taxonomySource,
    taxonomyReconciledByVideoEvidence: row.taxonomy_reconciled_by_video_evidence ?? false,
    thumbnailUrl: row.thumbnail_url,
    previewUrl: row.preview_url,
    imageUrl: row.image_url,
    tableThumbnailUrl: row.table_thumbnail_url ?? row.thumbnail_url ?? null,
    cardPreviewUrl: row.card_preview_url ?? row.image_url ?? row.thumbnail_url ?? row.preview_url ?? null,
    previewManifest: row.preview_manifest ?? null,
    isCatalog: row.is_catalog,
    previewState: row.preview_state,
    preview: row.preview,
    launchDate: row.launch_date,
    tags: row.tags ?? [],
    aiTags: row.ai_tags ?? {},
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

export type DecisionEngineV3Response = DecisionResponse;

export async function fetchCreativeDecisionEngineV3(params: {
  businessId: string;
  asOf?: string;
  creativeIds?: string[];
}): Promise<DecisionEngineV3Response> {
  const url = new URL("/api/creatives/decision-engine-v3", window.location.origin);
  url.searchParams.set("businessId", params.businessId);
  if (params.asOf) url.searchParams.set("asOf", params.asOf);
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
