import { hashForCache, metaCacheKey, toAdAccountNodeId } from "@/lib/meta/creatives-fetchers";
import { readThroughCache } from "@/lib/server-cache";
import type { MetaAdRecord } from "@/lib/meta/creatives-types";

export type MetaLandingPageAdRecord = Pick<MetaAdRecord, "id" | "name" | "creative">;

export const META_LANDING_PAGE_FIELDSET_VERSION = "v2_minimal_supported_url_fields";
export const META_LANDING_PAGE_BLOCKED_FIELDS = [
  "catalog_id",
  "image_url",
  "thumbnail_url",
  "picture",
  "image_hash",
] as const;

export interface MetaLandingPageFetchMeta {
  accountId: string;
  fieldSetVersion: string;
  status: "ok" | "partial" | "failed";
  pagesFetched: number;
  adsFetched: number;
  errorSample: string | null;
}

export interface MetaLandingPageFetchResult {
  adsMap: Map<string, MetaLandingPageAdRecord>;
  meta: MetaLandingPageFetchMeta;
}

interface MetaGetResult<T> {
  payload: T | null;
  status: number | null;
  errorSample: string | null;
}

async function metaGet<T>(
  url: URL,
  warnLabel?: string,
  warnCtx?: Record<string, unknown>
): Promise<MetaGetResult<T>> {
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      if (warnLabel) {
        console.warn(`[meta-landing-pages] ${warnLabel} non-ok`, {
          status: res.status,
          raw: raw.slice(0, 300),
          ...warnCtx,
        });
      }
      return {
        payload: null,
        status: res.status,
        errorSample: raw.slice(0, 300) || `HTTP ${res.status}`,
      };
    }
    return {
      payload: (await res.json().catch(() => null)) as T | null,
      status: res.status,
      errorSample: null,
    };
  } catch (error: unknown) {
    if (warnLabel) {
      console.warn(`[meta-landing-pages] ${warnLabel} threw`, {
        message: error instanceof Error ? error.message : String(error),
        ...warnCtx,
      });
    }
    return {
      payload: null,
      status: null,
      errorSample: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getMetaLandingPageCreativeFields(): string {
  const fields = [
    "id",
    "name",
    "object_type",
    "object_story_id",
    "effective_object_story_id",
    "object_story_spec{link_data{link,call_to_action{type,value{link}},child_attachments{link}},video_data{call_to_action{type,value{link}}},photo_data{call_to_action{type,value{link}}},template_data}",
    "asset_feed_spec{link_urls{website_url,display_url}}",
  ].join(",");

  for (const blockedField of META_LANDING_PAGE_BLOCKED_FIELDS) {
    if (fields.includes(blockedField)) {
      throw new Error(
        `[meta-landing-pages] blocked field leaked into landing page creative field set: ${blockedField}`
      );
    }
  }

  return fields;
}

export async function fetchMetaLandingPageAdsMap(
  accountId: string,
  accessToken: string
): Promise<MetaLandingPageFetchResult> {
  const cacheKey = metaCacheKey([
    "meta-landing-pages-ads",
    META_LANDING_PAGE_FIELDSET_VERSION,
    toAdAccountNodeId(accountId),
    hashForCache(accessToken),
  ]);

  return readThroughCache({
    key: cacheKey,
    ttlMs: 2 * 60_000,
    loader: async () => {
      const rows: Array<[string, MetaLandingPageAdRecord]> = [];
      let pagesFetched = 0;
      let errorSample: string | null = null;
      let nextUrl: string | null = null;

      do {
        const url: URL = nextUrl
          ? new URL(nextUrl)
          : new URL(`https://graph.facebook.com/v25.0/${toAdAccountNodeId(accountId)}/ads`);

        if (!nextUrl) {
          url.searchParams.set(
            "fields",
            ["id", "name", `creative{${getMetaLandingPageCreativeFields()}}`].join(",")
          );
          url.searchParams.set("limit", "500");
          url.searchParams.set(
            "effective_status",
            JSON.stringify(["ACTIVE", "PAUSED", "ARCHIVED", "PENDING_REVIEW", "DISAPPROVED"])
          );
          url.searchParams.set("access_token", accessToken);
        }

        const result = await metaGet<{
          data?: MetaLandingPageAdRecord[];
          paging?: { next?: string };
        }>(url, "landing page ads", { accountId });

        const payload = result.payload;
        if (!payload) {
          errorSample = errorSample ?? result.errorSample ?? "Meta landing page ads request returned no payload.";
          break;
        }
        pagesFetched += 1;

        for (const ad of payload.data ?? []) {
          if (typeof ad.id === "string") {
            rows.push([ad.id, ad]);
          }
        }

        nextUrl = payload.paging?.next ?? null;
      } while (nextUrl);

      const status: MetaLandingPageFetchMeta["status"] =
        rows.length > 0 ? (errorSample ? "partial" : "ok") : "failed";

      return {
        rows,
        meta: {
          accountId,
          fieldSetVersion: META_LANDING_PAGE_FIELDSET_VERSION,
          status,
          pagesFetched,
          adsFetched: rows.length,
          errorSample,
        },
      };
    },
  }).then((result) => ({
    adsMap: new Map(result.rows),
    meta: result.meta,
  }));
}
