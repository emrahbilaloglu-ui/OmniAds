/**
 * The public creative-share composition contract.
 *
 * Everything here exists because the audience is outside the workspace. Two
 * rules follow from that and shape the whole module:
 *
 * 1. **Sanitize.** The stored `SharePayload` carries `businessId`,
 *    `providerAccountId`, `businessName` and `clientEmail` — internal ids, an
 *    internal account identifier, the workspace's own name and a workspace-only
 *    contact address. None of them may reach the public page, and none may leak
 *    sideways through alt text, a data attribute, an error string or page
 *    metadata. `toPublicShare` is the only way the page gets its data, so the
 *    fields are dropped rather than merely not rendered.
 * 2. **Serve only what exists.** The payload contract has **no captions
 *    field**. So the public surface mounts no `<track>` at all and claims no
 *    caption support — inventing one would promise an accessibility affordance
 *    that silently does nothing.
 */
import type { SharePayload, SharePayloadCreative } from "@/components/creatives/shareCreativeTypes";
import type { ShareMediaSource } from "@/components/zero-base/creative/share-media";
import { BUYER_FINANCIAL_WARNING } from "@/lib/zero-base/creative/share-acknowledgement";
import { PUBLIC_SHARE_GONE } from "@/lib/zero-base/creative/studio-adapters";

/** Fields that must never appear in public output, in any form. */
export const WORKSPACE_IDENTITY_FIELDS = [
  "businessId",
  "providerAccountId",
  "businessName",
  "clientEmail",
] as const;

export interface PublicShareCreative {
  /** Opaque row key. Not an internal account or business identifier. */
  key: string;
  /** The creative's own name — content, not workspace identity. */
  name: string;
  media: ShareMediaSource | null;
  /** Stated when no media could be served for this creative. */
  mediaUnavailableReason: string | null;
  /** Only metrics explicitly selected for the public payload. */
  metrics: Array<{ key: "purchases" | "spend" | "roas"; label: string; value: string }>;
}

export interface PublicShare {
  title: string;
  dateRange: string;
  expiresAt: string;
  audience: "buyer" | "creator";
  /** Present for buyer shares only. */
  financialWarning: string | null;
  creatives: PublicShareCreative[];
  /** True when the contract served no captions for any creative. */
  captionsSupported: false;
}

function clean(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * Map one served creative onto a public media source.
 *
 * `preview.render_mode` is the served decision about what this is. A video
 * without a `video_url` is not silently downgraded to its poster: it has no
 * playable source, and saying so is more useful than showing a still frame the
 * viewer cannot play.
 */
export function toPublicMedia(creative: SharePayloadCreative): {
  media: ShareMediaSource | null;
  reason: string | null;
} {
  const preview = creative.preview;
  const name = clean(creative.name) ?? "this creative";

  if (preview?.render_mode === "video") {
    const video = clean(preview.video_url);
    if (!video) {
      return { media: null, reason: "This video has no playable source in this share." };
    }
    return {
      media: {
        kind: "video",
        url: video,
        // The payload contract carries no captions field. No track is mounted
        // and no caption support is claimed.
        captionsUrl: null,
        captionsLabel: null,
        // Alt text is the creative's own name, never an account or business.
        alt: `Video creative: ${name}`,
      },
      reason: null,
    };
  }

  const image =
    clean(preview?.image_url) ??
    clean(creative.mediaPreviewUrl) ??
    clean(creative.previewUrl) ??
    clean(creative.imageUrl) ??
    clean(creative.thumbnailUrl);

  if (!image) {
    return { media: null, reason: "No preview was captured for this creative." };
  }
  return {
    media: { kind: "image", url: image, captionsUrl: null, captionsLabel: null, alt: `Creative: ${name}` },
    reason: null,
  };
}

/**
 * Build the public view of a stored share.
 *
 * Returns only what a stranger may see. The internal fields are not copied at
 * all, so a later edit to the page cannot accidentally render one.
 */
export function toPublicShare(payload: SharePayload): PublicShare {
  const audience = payload.audience === "buyer" ? "buyer" : "creator";
  return {
    title: clean(payload.title) ?? "Shared creatives",
    dateRange: clean(payload.dateRange) ?? "",
    expiresAt: clean(payload.expiresAt) ?? "",
    audience,
    // The buyer disclosure travels with the numbers it qualifies.
    financialWarning: audience === "buyer" ? BUYER_FINANCIAL_WARNING : null,
    creatives: (payload.creatives ?? []).map((creative, index) => {
      const { media, reason } = toPublicMedia(creative);
      const selected = new Set(payload.metrics ?? []);
      const metrics: PublicShareCreative["metrics"] = [];
      if (selected.has("purchases") && typeof creative.purchases === "number") metrics.push({ key: "purchases", label: "Purchases", value: String(creative.purchases) });
      if (selected.has("spend") && typeof creative.spend === "number") metrics.push({ key: "spend", label: "Spend", value: new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(creative.spend) });
      if (selected.has("roas") && typeof creative.roas === "number") metrics.push({ key: "roas", label: "ROAS", value: creative.roas.toFixed(2) });
      return {
        // Index-based, so an internal creative id is not published either.
        key: `c${index + 1}`,
        name: clean(creative.name) ?? `Creative ${index + 1}`,
        media,
        mediaUnavailableReason: reason,
        metrics,
      };
    }),
    captionsSupported: false,
  };
}

/**
 * Whether any workspace identity survived into a public object.
 *
 * Used by tests against the real fixture, and cheap enough to be a genuine
 * guard rather than a one-off assertion.
 */
export function findLeakedIdentity(
  publicValue: unknown,
  secrets: readonly (string | null | undefined)[],
): string[] {
  const serialized = JSON.stringify(publicValue) ?? "";
  return secrets
    .map((secret) => secret?.trim())
    .filter((secret): secret is string => Boolean(secret && secret.length >= 4))
    .filter((secret) => serialized.includes(secret));
}

export { PUBLIC_SHARE_GONE };
