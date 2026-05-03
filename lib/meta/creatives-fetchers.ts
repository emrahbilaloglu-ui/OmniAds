import { createHash } from "crypto";
import { getCachedValue, readThroughCache } from "@/lib/server-cache";
import {
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
  getProviderAccountAssignments,
} from "@/lib/provider-account-assignments";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { normalizeMediaUrl } from "@/lib/meta/creatives-utils";
import { logRuntimeDebug } from "@/lib/runtime-logging";
import type {
  MetaAccountMeta,
  MetaAccountRecord,
  MetaAdCreativeMediaOnlyRecord,
  MetaAdImageRecord,
  MetaAdRecord,
  MetaCreativePreviewHtmlResponse,
  MetaInsightRecord,
} from "@/lib/meta/creatives-types";

/**
 * Thin fetch wrapper for Meta Graph API calls.
 * Returns parsed JSON as T on success, or null on network/non-ok responses.
 * When `warnLabel` is provided, logs a console.warn on non-ok responses.
 */
async function metaGet<T>(
  url: URL,
  warnLabel?: string,
  warnCtx?: Record<string, unknown>
): Promise<T | null> {
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      if (warnLabel) {
        const raw = await res.text().catch(() => "");
        console.warn(`[meta-creatives] ${warnLabel} non-ok`, {
          status: res.status,
          raw: raw.slice(0, 300),
          ...warnCtx,
        });
      }
      return null;
    }
    return (await res.json().catch(() => null)) as T | null;
  } catch (e: unknown) {
    if (warnLabel) {
      console.warn(`[meta-creatives] ${warnLabel} threw`, {
        message: e instanceof Error ? e.message : String(e),
        ...warnCtx,
      });
    }
    return null;
  }
}

export function hashForCache(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

export function metaCacheKey(parts: Array<string | number | boolean | null | undefined>): string {
  return parts
    .map((part) => (part === null || part === undefined ? "null" : String(part)))
    .join(":");
}

const META_BATCH_ADS_FIELDSET_VERSION = "v5";
const META_CREATIVE_INSIGHTS_FIELDSET_VERSION = "v2";
const META_CREATIVE_INSIGHTS_MAX_PAGES = 20;

export function toAdAccountNodeId(accountId: string): string {
  return accountId.startsWith("act_") ? accountId : `act_${accountId}`;
}

function pickAdImageUrl(record: MetaAdImageRecord | null | undefined): string | null {
  if (!record) return null;
  return (
    normalizeMediaUrl(record.url) ??
    normalizeMediaUrl(record.url_256) ??
    normalizeMediaUrl(record.url_128) ??
    normalizeMediaUrl(record.permalink_url)
  );
}

export function getCreativeMediaFields(): string {
  return [
    "id",
    "name",
    "object_type",
    "video_id",
    "object_story_spec{link_data{link,message,name,description,picture,call_to_action{type,value{link}},child_attachments{link,picture}},video_data{video_id,message,title,call_to_action{type,value{link}}},photo_data{message,caption,call_to_action{type,value{link}}},template_data}",
    "asset_feed_spec{catalog_id,product_set_id,bodies{text},titles{text},descriptions{text},videos{video_id}}",
  ].join(",");
}

export function getCreativeSummaryFields(): string {
  return [
    "id",
    "name",
    "object_type",
    "video_id",
    "object_story_spec{link_data{child_attachments{link,picture}},video_data{video_id},template_data}",
    "asset_feed_spec{images{hash},videos{video_id},bodies{text},titles{text},descriptions{text}}",
  ].join(",");
}

export function getCreativeDetailFields(): string {
  return [
    "id",
    "name",
    "object_type",
    "video_id",
    "object_story_spec{link_data{link,message,name,description,picture,call_to_action{type,value{link}},child_attachments{link,picture}},video_data{video_id,message,title,call_to_action{type,value{link}}},photo_data{message,caption,call_to_action{type,value{link}}},template_data}",
    // Keep this set conservative for adcreative IDs endpoint stability.
    "asset_feed_spec{bodies{text},titles{text},descriptions{text},videos{video_id}}",
  ].join(",");
}

export function getNestedCreativeMediaFields(): string {
  return [
    "id",
    "name",
    "object_type",
    "video_id",
    "object_story_spec{link_data{link,message,name,description,picture,call_to_action{type,value{link}},child_attachments{link,picture}},video_data{video_id,message,title,call_to_action{type,value{link}}},photo_data{message,caption,call_to_action{type,value{link}}},template_data}",
    "asset_feed_spec{bodies{text},titles{text},descriptions{text},videos{video_id}}",
  ].join(",");
}

export function getNestedCreativeSummaryFields(): string {
  return [
    "id",
    "name",
    "object_type",
    "video_id",
    "object_story_spec{link_data{child_attachments{link,picture}},video_data{video_id},template_data}",
    "asset_feed_spec{images{hash},videos{video_id},bodies{text},titles{text},descriptions{text}}",
  ].join(",");
}

export function getCreativeDetailAdvancedFields(): string {
  return [
    "id",
    "asset_feed_spec{catalog_id,product_set_id}",
  ].join(",");
}

export async function fetchAssignedAccountIds(businessId: string): Promise<string[]> {
  return readThroughCache({
    key: metaCacheKey(["meta-assigned-accounts", businessId]),
    ttlMs: 30_000,
    loader: async () => {
      try {
        const row = await getProviderAccountAssignments(businessId, "meta");
        return row?.account_ids ?? [];
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("does not exist") || message.includes("relation")) {
          const readiness = await getDbSchemaReadiness({
            tables: [...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES],
          }).catch(() => null);
          if (!readiness?.ready) {
            return [];
          }
          const row = await getProviderAccountAssignments(businessId, "meta").catch(() => null);
          return row?.account_ids ?? [];
        }
        return [];
      }
    },
  });
}

export async function fetchAccountInsights(
  accountId: string,
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<MetaInsightRecord[]> {
  return getCachedValue({
    key: metaCacheKey([
      "meta-insights",
      META_CREATIVE_INSIGHTS_FIELDSET_VERSION,
      accountId,
      startDate,
      endDate,
      hashForCache(accessToken),
    ]),
    ttlMs: 120_000,
    staleWhileRevalidateMs: 300_000,
    loader: async () => {
      logRuntimeDebug("meta-creatives", "insights_query", {
        account_id: accountId,
        time_range: { since: startDate, until: endDate },
        level: "ad",
        fields: "ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,spend,cpm,cpc,ctr,clicks,reach,frequency,date_start,actions,action_values,purchase_roas,outbound_clicks,attribution_setting,quality_ranking,engagement_rate_ranking,conversion_rate_ranking",
      });

      const url = new URL(`https://graph.facebook.com/v25.0/${accountId}/insights`);
      url.searchParams.set(
        "fields",
        "ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,spend,cpm,cpc,ctr,clicks,impressions,reach,frequency,inline_link_clicks,outbound_clicks,attribution_setting,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,date_start,actions,action_values,purchase_roas,video_play_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions"
      );
      url.searchParams.set("level", "ad");
      url.searchParams.set("time_range", JSON.stringify({ since: startDate, until: endDate }));
      url.searchParams.set("limit", "500");
      url.searchParams.set("access_token", accessToken);

      const rows: MetaInsightRecord[] = [];
      let nextUrl: string | null = url.toString();
      let pageCount = 0;
      while (nextUrl && pageCount < META_CREATIVE_INSIGHTS_MAX_PAGES) {
        const pageUrl: URL = new URL(nextUrl);
        const payload: {
          data?: MetaInsightRecord[];
          paging?: { next?: string };
        } | null = await metaGet(pageUrl, "insights", { accountId, page: pageCount });
        if (!payload) break;
        rows.push(...(payload.data ?? []));
        nextUrl = payload.paging?.next ?? null;
        pageCount += 1;
      }
      logRuntimeDebug("meta-creatives", "insights_response", {
        account_id: accountId,
        rows: rows.length,
        pages: pageCount,
        truncated: Boolean(nextUrl),
      });
      return rows;
    },
  }).then((result) => result.value);
}

export async function fetchAccountMeta(
  accountId: string,
  accessToken: string
): Promise<MetaAccountMeta> {
  return readThroughCache({
    key: metaCacheKey(["meta-account-meta", accountId, hashForCache(accessToken)]),
    ttlMs: 30 * 60_000,
    loader: async () => {
      const url = new URL(`https://graph.facebook.com/v25.0/${accountId}`);
      url.searchParams.set("fields", "id,name,currency");
      url.searchParams.set("access_token", accessToken);

      const payload = await metaGet<MetaAccountRecord>(url);
      return {
        id: payload?.id ?? accountId,
        name: payload?.name ?? null,
        currency: typeof payload?.currency === "string" ? payload.currency : null,
      };
    },
  });
}

export async function fetchAdImageUrlMap(
  accountId: string,
  imageHashes: string[],
  accessToken: string
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>();
  const uniqueHashes = Array.from(new Set(imageHashes.map((hash) => hash.trim()).filter(Boolean)));
  if (uniqueHashes.length === 0) return urlMap;

  const chunkSize = 80;
  for (let i = 0; i < uniqueHashes.length; i += chunkSize) {
    const chunk = uniqueHashes.slice(i, i + chunkSize);
    const url = new URL(`https://graph.facebook.com/v25.0/${toAdAccountNodeId(accountId)}/adimages`);
    url.searchParams.set("fields", "hash,url,url_128,url_256,permalink_url");
    url.searchParams.set("hashes", JSON.stringify(chunk));
    url.searchParams.set("access_token", accessToken);

    const payload = await metaGet<{ data?: MetaAdImageRecord[]; images?: Record<string, MetaAdImageRecord> }>(
      url,
      "adimages",
      { accountId, chunk: i, count: chunk.length }
    );
    if (!payload) continue;

    for (const record of payload.data ?? []) {
      const hash = record?.hash?.trim();
      const imageUrl = pickAdImageUrl(record);
      if (hash && imageUrl) {
        urlMap.set(hash, imageUrl);
        urlMap.set(hash.toLowerCase(), imageUrl);
      }
    }

    const imagesMap = payload.images;
    if (imagesMap && typeof imagesMap === "object") {
      for (const [hashKey, record] of Object.entries(imagesMap)) {
        const hash = hashKey?.trim() || record?.hash?.trim();
        const imageUrl = pickAdImageUrl(record);
        if (hash && imageUrl) {
          urlMap.set(hash, imageUrl);
          urlMap.set(hash.toLowerCase(), imageUrl);
        }
      }
    }
  }

  return urlMap;
}

export async function fetchAccountAdsMap(
  accountId: string,
  accessToken: string
): Promise<Map<string, MetaAdRecord>> {
  const map = new Map<string, MetaAdRecord>();
  let nextUrl: string | null = null;

  do {
    const url: URL = nextUrl ? new URL(nextUrl) : new URL(`https://graph.facebook.com/v25.0/${accountId}/ads`);
    if (!nextUrl) {
      url.searchParams.set(
        "fields",
        [
          "id",
          "name",
          "effective_status",
          "status",
          "adset_id",
          "adset{id,name,daily_budget,lifetime_budget,bid_strategy,optimization_goal,promoted_object{product_set_id,catalog_id}}",
          "campaign{id,name,objective,daily_budget,lifetime_budget,bid_strategy}",
          "promoted_object{product_set_id,catalog_id}",
          "created_time",
          `creative{${getNestedCreativeMediaFields()}}`,
        ].join(",")
      );
      url.searchParams.set("limit", "500");
      url.searchParams.set(
        "effective_status",
        // Meta /ads endpoint rejects DELETED objects for this query shape (error_subcode 1815001)
        JSON.stringify(["ACTIVE", "PAUSED", "ARCHIVED", "PENDING_REVIEW", "DISAPPROVED"])
      );
      url.searchParams.set("thumbnail_width", "150");
      url.searchParams.set("thumbnail_height", "150");
      url.searchParams.set("access_token", accessToken);
    }

    const payload: { data?: MetaAdRecord[]; paging?: { next?: string } } | null = await metaGet(
      url,
      "ads",
      { accountId }
    );
    if (!payload) return map;

    for (const ad of payload.data ?? []) {
      if (typeof ad.id === "string") {
        map.set(ad.id, ad);
      }
    }

    nextUrl = payload.paging?.next ?? null;
  } while (nextUrl);

  return map;
}

export async function fetchVideoSourceMap(
  videoIds: string[],
  accessToken: string
): Promise<Map<string, { source: string | null; picture: string | null }>> {
  const map = new Map<string, { source: string | null; picture: string | null }>();
  const uniqueIds = Array.from(new Set(videoIds.filter((id) => id.trim().length > 0)));
  if (uniqueIds.length === 0) return map;
  return readThroughCache({
    key: metaCacheKey(["meta-video-sources", hashForCache(accessToken), hashForCache(uniqueIds.join(","))]),
    ttlMs: 30 * 60_000,
    loader: async () => {
      const chunkSize = 40;
      for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const idsChunk = uniqueIds.slice(i, i + chunkSize);
        const url = new URL("https://graph.facebook.com/v25.0/");
        url.searchParams.set("ids", idsChunk.join(","));
        url.searchParams.set("fields", "source,picture");
        url.searchParams.set("access_token", accessToken);

        const payload = await metaGet<Record<string, { source?: string | null; picture?: string | null }>>(
          url,
          "video details",
          { chunk: i, count: idsChunk.length }
        );
        if (!payload || typeof payload !== "object") continue;

        for (const [videoId, video] of Object.entries(payload)) {
          if (!video || typeof video !== "object") continue;
          map.set(videoId, {
            source: normalizeMediaUrl(video.source ?? null),
            picture: normalizeMediaUrl(video.picture ?? null),
          });
        }
      }
      return Array.from(map.entries());
    },
  }).then((entries) => new Map(entries));
}

/**
 * Batch-fetch ads by their IDs using the `?ids=` endpoint.
 * Used as a fallback when fetchAccountAdsMap misses ads that appear in insights.
 */
export async function batchFetchAdsByIds(
  adIds: string[],
  accessToken: string,
  mode: "metadata" | "full" = "full"
): Promise<Map<string, MetaAdRecord>> {
  const map = new Map<string, MetaAdRecord>();
  const uniqueIds = Array.from(new Set(adIds.filter((id) => id.trim().length > 0)));
  if (uniqueIds.length === 0) return map;

  const fields = [
    "id",
    "name",
    "effective_status",
    "status",
    "adset_id",
    "adset{id,name,daily_budget,lifetime_budget,bid_strategy,optimization_goal}",
    "campaign{id,name,objective,daily_budget,lifetime_budget,bid_strategy}",
    ...(mode === "full" ? ["created_time"] : []),
    `creative{${mode === "full" ? getNestedCreativeMediaFields() : getNestedCreativeSummaryFields()}}`,
  ].join(",");

  return readThroughCache({
    key: metaCacheKey([
      "meta-batch-ads",
      META_BATCH_ADS_FIELDSET_VERSION,
      mode,
      hashForCache(accessToken),
      hashForCache(uniqueIds.join(",")),
    ]),
    ttlMs: mode === "metadata" ? 5 * 60_000 : 10 * 60_000,
    loader: async () => {
      const chunkSize = 40;
      for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const idsChunk = uniqueIds.slice(i, i + chunkSize);
        const buildUrl = (ids: string[]) => {
          const url = new URL("https://graph.facebook.com/v25.0/");
          url.searchParams.set("ids", ids.join(","));
          url.searchParams.set("fields", fields);
          url.searchParams.set("thumbnail_width", "150");
          url.searchParams.set("thumbnail_height", "150");
          url.searchParams.set("access_token", accessToken);
          return url;
        };

        try {
          const res = await fetch(buildUrl(idsChunk).toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
          });
          if (!res.ok) {
            const errorPayload = (await res.json().catch(() => null)) as
              | { error?: { code?: number; error_subcode?: number; message?: string } }
              | null;
            const isDeletedObjectsError =
              errorPayload?.error?.code === 100 && errorPayload?.error?.error_subcode === 1815001;
            console.warn("[meta-creatives] batchFetchAdsByIds non-ok", {
              status: res.status,
              chunk: i,
              count: idsChunk.length,
              error_code: errorPayload?.error?.code ?? null,
              error_subcode: errorPayload?.error?.error_subcode ?? null,
              error_message: errorPayload?.error?.message ?? null,
            });
            if (isDeletedObjectsError && idsChunk.length > 1) {
              for (const adId of idsChunk) {
                const onePayload = await metaGet<Record<string, MetaAdRecord>>(buildUrl([adId]));
                const oneAd = onePayload?.[adId];
                if (oneAd && typeof oneAd === "object") {
                  map.set(adId, { ...oneAd, id: oneAd.id ?? adId });
                }
              }
            }
            continue;
          }
          const payload = (await res.json().catch(() => null)) as Record<string, MetaAdRecord> | null;
          if (!payload || typeof payload !== "object") continue;

          for (const [adId, ad] of Object.entries(payload)) {
            if (!ad || typeof ad !== "object") continue;
            map.set(adId, { ...ad, id: ad.id ?? adId });
          }
        } catch (e: unknown) {
          console.warn("[meta-creatives] batchFetchAdsByIds threw", {
            chunk: i,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }

      return Array.from(map.entries());
    },
  }).then((entries) => new Map(entries));
}

export async function fetchCreativeDetailsMap(
  creativeIds: string[],
  accessToken: string
): Promise<Map<string, NonNullable<MetaAdRecord["creative"]>>> {
  const map = new Map<string, NonNullable<MetaAdRecord["creative"]>>();
  const uniqueIds = Array.from(new Set(creativeIds.filter((id) => id.trim().length > 0)));
  if (uniqueIds.length === 0) return map;

  const safeFields = getCreativeDetailFields();
  const advancedFields = getCreativeDetailAdvancedFields();
  return readThroughCache({
    key: metaCacheKey(["meta-creative-details", hashForCache(accessToken), hashForCache(uniqueIds.join(","))]),
    ttlMs: 15 * 60_000,
    loader: async () => {
      const chunkSize = 40;
      for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const idsChunk = uniqueIds.slice(i, i + chunkSize);
        const url = new URL("https://graph.facebook.com/v25.0/");
        url.searchParams.set("ids", idsChunk.join(","));
        url.searchParams.set("fields", safeFields);
        url.searchParams.set("thumbnail_width", "150");
        url.searchParams.set("thumbnail_height", "150");
        url.searchParams.set("access_token", accessToken);

        const payload = await metaGet<Record<string, MetaAdRecord["creative"]>>(
          url,
          "creative details",
          { chunk: i, count: idsChunk.length }
        );
        if (!payload || typeof payload !== "object") continue;

        for (const [creativeId, creative] of Object.entries(payload)) {
          if (!creative || typeof creative !== "object") continue;
          map.set(creativeId, creative as NonNullable<MetaAdRecord["creative"]>);
        }

        const advancedUrl = new URL("https://graph.facebook.com/v25.0/");
        advancedUrl.searchParams.set("ids", idsChunk.join(","));
        advancedUrl.searchParams.set("fields", advancedFields);
        advancedUrl.searchParams.set("access_token", accessToken);

        const advancedPayload = await metaGet<Record<string, MetaAdRecord["creative"]>>(
          advancedUrl,
          "creative details advanced",
          { chunk: i, count: idsChunk.length }
        );
        if (!advancedPayload || typeof advancedPayload !== "object") continue;

        for (const [creativeId, creative] of Object.entries(advancedPayload)) {
          if (!creative || typeof creative !== "object") continue;
          const existing = map.get(creativeId);
          if (!existing) {
            map.set(creativeId, creative as NonNullable<MetaAdRecord["creative"]>);
            continue;
          }
          map.set(creativeId, {
            ...existing,
            ...creative,
            asset_feed_spec: {
              ...(existing.asset_feed_spec ?? {}),
              ...(creative.asset_feed_spec ?? {}),
            },
          } as NonNullable<MetaAdRecord["creative"]>);
        }
      }
      return Array.from(map.entries());
    },
  }).then((entries) => new Map(entries));
}

export async function fetchCreativeThumbnailMap(
  creativeIds: string[],
  accessToken: string,
  width = 150,
  height = 120,
  debug = false
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniqueIds = Array.from(new Set(creativeIds.filter((id) => id.trim().length > 0)));
  if (uniqueIds.length === 0) return map;
  return readThroughCache({
    key: metaCacheKey([
      "meta-creative-thumbs",
      width,
      height,
      hashForCache(accessToken),
      hashForCache(uniqueIds.join(",")),
    ]),
    ttlMs: 30 * 60_000,
    loader: async () => {
      const chunkSize = 20;
      for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const idsChunk = uniqueIds.slice(i, i + chunkSize);
        if (debug) {
          logRuntimeDebug("meta-creatives", "thumb_debug_chunk_start", {
            chunk_index: i / chunkSize + 1,
            chunk_size: idsChunk.length,
            width,
            height,
          });
        }
        const chunkResults = await Promise.all(
          idsChunk.map(async (creativeId) => {
            const url = new URL(`https://graph.facebook.com/v25.0/${creativeId}`);
            url.searchParams.set("thumbnail_width", String(width));
            url.searchParams.set("thumbnail_height", String(height));
            url.searchParams.set("fields", "thumbnail_url");
            url.searchParams.set("access_token", accessToken);
            if (debug) {
              const safeUrl = new URL(url.toString());
              safeUrl.searchParams.set("access_token", "<REDACTED>");
              logRuntimeDebug("meta-creatives", "thumb_debug_request", {
                creative_id: creativeId,
                url: safeUrl.toString(),
              });
            }
            try {
              const res = await fetch(url.toString(), {
                method: "GET",
                headers: { Accept: "application/json" },
                cache: "no-store",
              });
              if (!res.ok) {
                const raw = await res.text().catch(() => "");
                if (debug) {
                  logRuntimeDebug("meta-creatives", "thumb_debug_response_non_ok", {
                    creative_id: creativeId,
                    status: res.status,
                    body_sample: raw.slice(0, 220),
                  });
                }
                return { creativeId, thumbnailUrl: null };
              }
              const payload = (await res.json().catch(() => null)) as { thumbnail_url?: string | null } | null;
              const thumbnailUrl = normalizeMediaUrl(payload?.thumbnail_url ?? null);
              if (debug) {
                logRuntimeDebug("meta-creatives", "thumb_debug_response_ok", {
                  creative_id: creativeId,
                  status: res.status,
                  thumbnail_url_present: Boolean(thumbnailUrl),
                  thumbnail_url_sample: thumbnailUrl ? thumbnailUrl.slice(0, 180) : null,
                });
              }
              return { creativeId, thumbnailUrl };
            } catch (error: unknown) {
              if (debug) {
                logRuntimeDebug("meta-creatives", "thumb_debug_request_failed", {
                  creative_id: creativeId,
                  message: error instanceof Error ? error.message : String(error),
                });
              }
              return { creativeId, thumbnailUrl: null };
            }
          })
        );

        for (const result of chunkResults) {
          if (result.thumbnailUrl) {
            map.set(result.creativeId, result.thumbnailUrl);
          }
        }
      }

      return Array.from(map.entries());
    },
  }).then((entries) => new Map(entries));
}

export async function fetchAdCreativeMediaByAdIds(
  adIds: string[],
  accessToken: string
): Promise<Map<string, MetaAdCreativeMediaOnlyRecord>> {
  const map = new Map<string, MetaAdCreativeMediaOnlyRecord>();
  const uniqueIds = Array.from(new Set(adIds.filter((id) => id.trim().length > 0)));
  if (uniqueIds.length === 0) return map;

  const fields = [
    "id",
    `creative{${getNestedCreativeMediaFields()}}`,
  ].join(",");

  const chunkSize = 40;
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const idsChunk = uniqueIds.slice(i, i + chunkSize);
    const buildUrl = (ids: string[]) => {
      const url = new URL("https://graph.facebook.com/v25.0/");
      url.searchParams.set("ids", ids.join(","));
      url.searchParams.set("fields", fields);
      url.searchParams.set("thumbnail_width", "150");
      url.searchParams.set("thumbnail_height", "150");
      url.searchParams.set("access_token", accessToken);
      return url;
    };

    try {
      const res = await fetch(buildUrl(idsChunk).toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        const errorPayload = (await res.json().catch(() => null)) as
          | { error?: { code?: number; error_subcode?: number; message?: string } }
          | null;
        const isDeletedObjectsError =
          errorPayload?.error?.code === 100 && errorPayload?.error?.error_subcode === 1815001;
        console.warn("[meta-creatives] ad creative media fallback non-ok", {
          status: res.status,
          chunk: i,
          count: idsChunk.length,
          error_code: errorPayload?.error?.code ?? null,
          error_subcode: errorPayload?.error?.error_subcode ?? null,
          error_message: errorPayload?.error?.message ?? null,
        });
        if (isDeletedObjectsError && idsChunk.length > 1) {
          // Retry per-id; skip deleted ads but keep valid ones.
          for (const adId of idsChunk) {
            const onePayload = await metaGet<Record<string, MetaAdCreativeMediaOnlyRecord>>(buildUrl([adId]));
            const oneAd = onePayload?.[adId];
            if (oneAd && typeof oneAd === "object") {
              map.set(adId, { ...oneAd, id: oneAd.id ?? adId });
            }
          }
        }
        continue;
      }

      const payload = (await res.json().catch(() => null)) as Record<string, MetaAdCreativeMediaOnlyRecord> | null;
      if (!payload || typeof payload !== "object") continue;

      for (const [adId, ad] of Object.entries(payload)) {
        if (!ad || typeof ad !== "object") continue;
        map.set(adId, { ...ad, id: ad.id ?? adId });
      }
    } catch (e: unknown) {
      console.warn("[meta-creatives] ad creative media fallback threw", {
        chunk: i,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return map;
}

export async function fetchAdCreativeBasicsByAdIds(
  adIds: string[],
  accessToken: string
): Promise<Map<string, MetaAdRecord>> {
  const map = new Map<string, MetaAdRecord>();
  const uniqueIds = Array.from(new Set(adIds.filter((id) => id.trim().length > 0)));
  if (uniqueIds.length === 0) return map;

  const fields = [
    "id",
    "adset{id,name}",
    `creative{${getNestedCreativeSummaryFields()}}`,
  ].join(",");
  const concurrency = 20;
  for (let i = 0; i < uniqueIds.length; i += concurrency) {
    const chunk = uniqueIds.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (adId) => {
        const url = new URL(`https://graph.facebook.com/v25.0/${adId}`);
        url.searchParams.set("fields", fields);
        url.searchParams.set("thumbnail_width", "150");
        url.searchParams.set("thumbnail_height", "150");
        url.searchParams.set("access_token", accessToken);
        const payload = await metaGet<MetaAdRecord>(url);
        if (!payload || typeof payload !== "object") return null;
        return { adId, payload: { ...payload, id: payload.id ?? adId } };
      })
    );
    for (const item of results) {
      if (!item) continue;
      map.set(item.adId, item.payload);
    }
  }

  return map;
}

export async function fetchAdCreativeMediaDirectByAdIds(
  adIds: string[],
  accessToken: string
): Promise<Map<string, MetaAdCreativeMediaOnlyRecord>> {
  const map = new Map<string, MetaAdCreativeMediaOnlyRecord>();
  const uniqueIds = Array.from(new Set(adIds.filter((id) => id.trim().length > 0)));
  if (uniqueIds.length === 0) return map;

  const fields = [
    "id",
    `creative{${getNestedCreativeMediaFields()}}`,
  ].join(",");

  const concurrency = 20;
  for (let i = 0; i < uniqueIds.length; i += concurrency) {
    const chunk = uniqueIds.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (adId) => {
        const url = new URL(`https://graph.facebook.com/v25.0/${adId}`);
        url.searchParams.set("fields", fields);
        url.searchParams.set("thumbnail_width", "150");
        url.searchParams.set("thumbnail_height", "150");
        url.searchParams.set("access_token", accessToken);
        const payload = await metaGet<MetaAdCreativeMediaOnlyRecord>(url);
        if (!payload || typeof payload !== "object") return null;
        return { adId, payload: { ...payload, id: payload.id ?? adId } };
      })
    );
    for (const item of results) {
      if (!item) continue;
      map.set(item.adId, item.payload);
    }
  }

  return map;
}

export async function fetchCreativeDetailPreviewHtml(
  creativeId: string,
  accessToken: string
): Promise<{ html: string; adFormat: string; source: "meta_creative_previews" } | null> {
  const adFormats = [
    "DESKTOP_FEED_STANDARD",
    "MOBILE_FEED_STANDARD",
    "INSTAGRAM_STANDARD",
  ];

  for (const adFormat of adFormats) {
    const url = new URL(`https://graph.facebook.com/v25.0/${creativeId}/previews`);
    url.searchParams.set("ad_format", adFormat);
    url.searchParams.set("access_token", accessToken);

    const payload = await metaGet<MetaCreativePreviewHtmlResponse>(url);
    const body = payload?.data?.find((item) => typeof item?.body === "string" && item.body.trim().length > 0)?.body?.trim();
    if (!body) continue;
    return {
      html: body,
      adFormat,
      source: "meta_creative_previews",
    };
  }

  return null;
}
