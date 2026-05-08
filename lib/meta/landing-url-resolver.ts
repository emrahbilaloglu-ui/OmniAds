import type { MetaAdRecord } from "@/lib/meta/creatives-types";

export type MetaLandingUrlSource =
  | "object_story_spec.link_data.link"
  | "object_story_spec.link_data.call_to_action.value.link"
  | "object_story_spec.video_data.call_to_action.value.link"
  | "object_story_spec.photo_data.call_to_action.value.link"
  | "object_story_spec.link_data.child_attachments[].link"
  | "object_story_spec.template_data"
  | "asset_feed_spec.link_urls[].website_url"
  | "asset_feed_spec.link_urls[].display_url"
  | "asset_feed_spec.link_urls[].url"
  | "story.call_to_action.value.link"
  | "story.attachments[].target.url"
  | "story.attachments[].unshimmed_url"
  | "story.attachments[].url"
  | "unresolved";

export type MetaLandingUrlConfidence = "high" | "medium" | "low" | "unresolved";

export interface ResolvedMetaLandingUrl {
  rawUrl: string | null;
  canonicalUrl: string | null;
  source: MetaLandingUrlSource;
  confidence: MetaLandingUrlConfidence;
  ctaType?: string | null;
}

export interface MetaLandingUrlDiagnosticSignals {
  objectType: string | null;
  hasObjectStoryId: boolean;
  hasEffectiveObjectStoryId: boolean;
  hasObjectStorySpec: boolean;
  hasLinkData: boolean;
  hasVideoData: boolean;
  hasPhotoData: boolean;
  hasTemplateData: boolean;
  hasAssetFeedLinkUrls: boolean;
  hasChildAttachments: boolean;
  hasDirectLink: boolean;
  hasLinkDataCtaLink: boolean;
  hasVideoCtaLink: boolean;
  hasPhotoCtaLink: boolean;
}

const TRACKING_PARAM_PREFIXES = ["utm_", "fbclid", "gclid", "msclkid", "ttclid"];

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalizedInput = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;

  try {
    const url = new URL(normalizedInput);
    if (!/^https?:$/i.test(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function canonicalizeLandingUrl(value: string | null): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();

    const paramsToDelete: string[] = [];
    url.searchParams.forEach((_, key) => {
      const lowered = key.toLowerCase();
      if (TRACKING_PARAM_PREFIXES.some((prefix) => lowered === prefix || lowered.startsWith(prefix))) {
        paramsToDelete.push(key);
      }
    });
    for (const key of paramsToDelete) {
      url.searchParams.delete(key);
    }

    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    const search = url.searchParams.toString();
    return `${url.origin}${url.pathname}${search ? `?${search}` : ""}`;
  } catch {
    return null;
  }
}

function findTemplateDataUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const preferredKeys = new Set(["link", "url", "website_url", "websiteurl", "destination_url"]);
  const visited = new Set<unknown>();
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }

    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      if (preferredKeys.has(key.toLowerCase())) {
        const normalized = normalizeHttpUrl(entry);
        if (normalized) return normalized;
      }
      if (typeof entry === "string") {
        const normalized = normalizeHttpUrl(entry);
        if (normalized) return normalized;
      } else if (entry && typeof entry === "object") {
        queue.push(entry);
      }
    }
  }

  return null;
}

function buildResolved(
  rawUrl: string | null,
  source: MetaLandingUrlSource,
  confidence: MetaLandingUrlConfidence,
  ctaType: string | null = null
): ResolvedMetaLandingUrl {
  const normalizedRaw = normalizeHttpUrl(rawUrl);
  return {
    rawUrl: normalizedRaw,
    canonicalUrl: canonicalizeLandingUrl(normalizedRaw),
    source: normalizedRaw ? source : "unresolved",
    confidence: normalizedRaw ? confidence : "unresolved",
    ctaType: normalizedRaw ? ctaType : null,
  };
}

export function getMetaLandingUrlDiagnosticSignals(
  creative: MetaAdRecord["creative"] | null | undefined
): MetaLandingUrlDiagnosticSignals {
  const story = creative?.object_story_spec;
  const childAttachments = story?.link_data?.child_attachments ?? [];
  return {
    objectType: typeof creative?.object_type === "string" ? creative.object_type : null,
    hasObjectStoryId: typeof creative?.object_story_id === "string" && creative.object_story_id.trim().length > 0,
    hasEffectiveObjectStoryId:
      typeof creative?.effective_object_story_id === "string" &&
      creative.effective_object_story_id.trim().length > 0,
    hasObjectStorySpec: Boolean(story),
    hasLinkData: Boolean(story?.link_data),
    hasVideoData: Boolean(story?.video_data),
    hasPhotoData: Boolean(story?.photo_data),
    hasTemplateData: Boolean(story?.template_data),
    hasAssetFeedLinkUrls: Boolean((creative?.asset_feed_spec?.link_urls ?? []).length),
    hasChildAttachments: childAttachments.length > 0,
    hasDirectLink: Boolean(normalizeHttpUrl(story?.link_data?.link ?? null)),
    hasLinkDataCtaLink: Boolean(normalizeHttpUrl(story?.link_data?.call_to_action?.value?.link ?? null)),
    hasVideoCtaLink: Boolean(normalizeHttpUrl(story?.video_data?.call_to_action?.value?.link ?? null)),
    hasPhotoCtaLink: Boolean(normalizeHttpUrl(story?.photo_data?.call_to_action?.value?.link ?? null)),
  };
}

export function resolveMetaLandingUrl(
  creative: MetaAdRecord["creative"] | null | undefined
): ResolvedMetaLandingUrl {
  if (!creative?.object_story_spec) {
    return buildResolved(null, "unresolved", "unresolved");
  }

  const { object_story_spec: story } = creative;
  const directLink = story.link_data?.link ?? null;
  if (normalizeHttpUrl(directLink)) {
    return buildResolved(directLink, "object_story_spec.link_data.link", "high");
  }

  const linkDataCtaLink = story.link_data?.call_to_action?.value?.link ?? null;
  if (normalizeHttpUrl(linkDataCtaLink)) {
    return buildResolved(
      linkDataCtaLink,
      "object_story_spec.link_data.call_to_action.value.link",
      "high",
      story.link_data?.call_to_action?.type ?? null
    );
  }

  const videoCtaLink = story.video_data?.call_to_action?.value?.link ?? null;
  if (normalizeHttpUrl(videoCtaLink)) {
    return buildResolved(
      videoCtaLink,
      "object_story_spec.video_data.call_to_action.value.link",
      "high",
      story.video_data?.call_to_action?.type ?? null
    );
  }

  const photoCtaLink = story.photo_data?.call_to_action?.value?.link ?? null;
  if (normalizeHttpUrl(photoCtaLink)) {
    return buildResolved(
      photoCtaLink,
      "object_story_spec.photo_data.call_to_action.value.link",
      "high",
      story.photo_data?.call_to_action?.type ?? null
    );
  }

  const assetFeedLinkCandidates: Array<{
    url: string | null;
    source: ResolvedMetaLandingUrl["source"];
  }> = [];
  for (const item of creative.asset_feed_spec?.link_urls ?? []) {
    assetFeedLinkCandidates.push(
      {
        url: item?.website_url ?? null,
        source: "asset_feed_spec.link_urls[].website_url",
      },
      {
        url: item?.url ?? null,
        source: "asset_feed_spec.link_urls[].url",
      },
      {
        url: item?.display_url ?? null,
        source: "asset_feed_spec.link_urls[].display_url",
      },
    );
  }
  const assetFeedLink = assetFeedLinkCandidates.find((item) => normalizeHttpUrl(item.url));
  if (assetFeedLink) {
    return buildResolved(assetFeedLink.url, assetFeedLink.source, "high");
  }

  const attachmentLink = (story.link_data?.child_attachments ?? [])
    .map((attachment) => attachment?.link ?? null)
    .find((link) => normalizeHttpUrl(link));
  if (attachmentLink) {
    return buildResolved(
      attachmentLink,
      "object_story_spec.link_data.child_attachments[].link",
      "medium"
    );
  }

  const templateDataLink = findTemplateDataUrl(story.template_data);
  if (templateDataLink) {
    return buildResolved(templateDataLink, "object_story_spec.template_data", "low");
  }

  return buildResolved(null, "unresolved", "unresolved");
}
