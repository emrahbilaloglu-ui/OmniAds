import { hashForCache, metaCacheKey } from "@/lib/meta/creatives-fetchers";
import type { MetaAdRecord } from "@/lib/meta/creatives-types";
import { readThroughCache } from "@/lib/server-cache";
import {
  canonicalizeLandingUrl,
  resolveMetaLandingUrl,
  type ResolvedMetaLandingUrl,
} from "@/lib/meta/landing-url-resolver";

interface MetaPageTokenRecord {
  id?: string;
  name?: string | null;
  access_token?: string | null;
}

interface MetaStoryAttachment {
  url?: string | null;
  unshimmed_url?: string | null;
  target?: {
    url?: string | null;
  } | null;
}

interface MetaStoryRecord {
  id?: string;
  call_to_action?: {
    type?: string | null;
    value?: {
      link?: string | null;
    } | null;
  } | null;
  attachments?: {
    data?: MetaStoryAttachment[];
  } | null;
}

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
    if (!/^https?:$/i.test(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function unresolved(): ResolvedMetaLandingUrl {
  return {
    rawUrl: null,
    canonicalUrl: null,
    source: "unresolved",
    confidence: "unresolved",
    ctaType: null,
  };
}

function resolved(
  rawUrl: string | null | undefined,
  source: ResolvedMetaLandingUrl["source"],
  ctaType: string | null = null,
): ResolvedMetaLandingUrl {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return unresolved();
  return {
    rawUrl: normalized,
    canonicalUrl: canonicalizeLandingUrl(normalized),
    source,
    confidence: "medium",
    ctaType,
  };
}

export function resolveMetaStoryLandingUrl(story: MetaStoryRecord | null | undefined): ResolvedMetaLandingUrl {
  const ctaLink = story?.call_to_action?.value?.link ?? null;
  if (normalizeHttpUrl(ctaLink)) {
    return resolved(ctaLink, "story.call_to_action.value.link", story?.call_to_action?.type ?? null);
  }

  for (const attachment of story?.attachments?.data ?? []) {
    const targetUrl = attachment?.target?.url ?? null;
    if (normalizeHttpUrl(targetUrl)) return resolved(targetUrl, "story.attachments[].target.url");

    const unshimmedUrl = attachment?.unshimmed_url ?? null;
    if (normalizeHttpUrl(unshimmedUrl)) return resolved(unshimmedUrl, "story.attachments[].unshimmed_url");

    const url = attachment?.url ?? null;
    if (normalizeHttpUrl(url)) return resolved(url, "story.attachments[].url");
  }

  return unresolved();
}

function extractPageIdFromStoryId(storyId: string | null | undefined): string | null {
  if (!storyId || !storyId.includes("_")) return null;
  const [pageId] = storyId.split("_");
  return pageId?.trim() || null;
}

async function fetchPageAccessTokenMap(accessToken: string): Promise<Map<string, string>> {
  return readThroughCache({
    key: metaCacheKey(["meta-page-token-map", hashForCache(accessToken)]),
    ttlMs: 10 * 60_000,
    loader: async () => {
      const entries: Array<[string, string]> = [];
      let nextUrl: string | null = null;
      do {
        const url = nextUrl ? new URL(nextUrl) : new URL("https://graph.facebook.com/v25.0/me/accounts");
        if (!nextUrl) {
          url.searchParams.set("fields", "id,name,access_token");
          url.searchParams.set("limit", "500");
          url.searchParams.set("access_token", accessToken);
        }

        const res = await fetch(url.toString(), { cache: "no-store" });
        if (!res.ok) break;
        const payload = (await res.json().catch(() => null)) as
          | { data?: MetaPageTokenRecord[]; paging?: { next?: string } }
          | null;
        for (const page of payload?.data ?? []) {
          if (page.id && page.access_token) entries.push([page.id, page.access_token]);
        }
        nextUrl = payload?.paging?.next ?? null;
      } while (nextUrl);
      return entries;
    },
  }).then((entries) => new Map(entries));
}

async function fetchStoryWithPageToken(storyId: string, pageAccessToken: string): Promise<MetaStoryRecord | null> {
  const url = new URL(`https://graph.facebook.com/v25.0/${storyId}`);
  url.searchParams.set(
    "fields",
    "id,call_to_action,attachments{url,target,unshimmed_url,media_type,type,title,description}",
  );
  url.searchParams.set("access_token", pageAccessToken);
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) return null;
  const payload = (await res.json().catch(() => null)) as MetaStoryRecord | null;
  return payload && typeof payload === "object" ? payload : null;
}

export async function resolveMetaLandingUrlWithStoryFallback(input: {
  creative: MetaAdRecord["creative"] | null | undefined;
  accessToken: string;
}): Promise<ResolvedMetaLandingUrl> {
  const direct = resolveMetaLandingUrl(input.creative);
  if (direct.rawUrl) return direct;

  const storyId =
    typeof input.creative?.effective_object_story_id === "string" && input.creative.effective_object_story_id.trim()
      ? input.creative.effective_object_story_id.trim()
      : typeof input.creative?.object_story_id === "string" && input.creative.object_story_id.trim()
        ? input.creative.object_story_id.trim()
        : null;
  const pageId = extractPageIdFromStoryId(storyId);
  if (!storyId || !pageId) return direct;

  const fallback = await resolveMetaStoryIdLandingUrl({
    storyId,
    accessToken: input.accessToken,
  });
  return fallback.rawUrl ? fallback : direct;
}

export async function resolveMetaStoryIdLandingUrl(input: {
  storyId: string | null | undefined;
  accessToken: string;
}): Promise<ResolvedMetaLandingUrl> {
  const storyId = input.storyId?.trim() || null;
  const pageId = extractPageIdFromStoryId(storyId);
  if (!storyId || !pageId) return unresolved();

  const pageAccessToken = (await fetchPageAccessTokenMap(input.accessToken)).get(pageId);
  if (!pageAccessToken) return unresolved();

  const story = await fetchStoryWithPageToken(storyId, pageAccessToken);
  return resolveMetaStoryLandingUrl(story);
}
