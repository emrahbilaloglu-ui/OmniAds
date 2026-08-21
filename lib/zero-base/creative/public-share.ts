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
import type {
  ShareAudience,
  ShareMetricKey,
  SharedMessage,
  SharePayload,
  SharePayloadCreative,
} from "@/components/creatives/shareCreativeTypes";
import type { ShareMediaSource } from "@/components/zero-base/creative/share-media";
import { BUYER_FINANCIAL_WARNING } from "@/lib/zero-base/creative/share-acknowledgement";
import { PUBLIC_SHARE_GONE } from "@/lib/zero-base/creative/studio-adapters";
import { buildCreativeStory, type CreativeStory } from "@/lib/zero-base/creative/public-share-story";

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
  format: "image" | "video" | "catalog";
  launchDate: string;
  media: ShareMediaSource | null;
  /** Stated when no media could be served for this creative. */
  mediaUnavailableReason: string | null;
  /** Only metrics explicitly selected for the public payload. */
  metrics: Array<{
    key: ShareMetricKey;
    label: string;
    value: string;
    rawValue: number;
  }>;
  /**
   * The attention narrative, built only for the creative_team audience and
   * only when the served metrics support it. Null is a real answer, not a
   * loading state — see `buildCreativeStory`.
   */
  story: CreativeStory | null;
}

export interface PublicShare {
  title: string;
  dateRange: string;
  /** When this snapshot was frozen. Empty string when the payload carries neither field. */
  frozenAt: string;
  expiresAt: string;
  audience: ShareAudience;
  /** Present for buyer shares only. */
  financialWarning: string | null;
  allowCsv: boolean;
  /** Buyer-safe, persisted write-ledger entries; internal ledger ids excluded. */
  actions: Array<{
    what: string;
    why: string;
    date: string;
    outcome: string | null;
    outcomeTone: "positive" | "neutral";
  }>;
  creatives: PublicShareCreative[];
  /** True when the contract served no captions for any creative. */
  captionsSupported: false;
  /** The sender's one-way note, fixed at creation. Null when none was set. */
  note: string | null;
  /** The live public thread. Empty array, never withheld. */
  messages: SharedMessage[];
}

type PublicMetricKind = "count" | "money" | "ratio" | "percent" | "score";

/**
 * The one place a metric key becomes a human label.
 *
 * Exported so the share-creation modal can list "what this will include" using
 * the SAME labels the public page renders — a hand-typed second copy is how
 * the two drift and the modal starts promising a name the recipient never
 * sees.
 */
export const PUBLIC_METRICS: Record<
  ShareMetricKey,
  { label: string; kind: PublicMetricKind }
> = {
  spend: { label: "Spend", kind: "money" },
  purchaseValue: { label: "Revenue", kind: "money" },
  roas: { label: "ROAS", kind: "ratio" },
  cpa: { label: "CPA", kind: "money" },
  cpcLink: { label: "Link CPC", kind: "money" },
  cpm: { label: "CPM", kind: "money" },
  ctrAll: { label: "CTR", kind: "percent" },
  linkCtr: { label: "Link CTR", kind: "percent" },
  purchases: { label: "Purchases", kind: "count" },
  impressions: { label: "Impressions", kind: "count" },
  clicks: { label: "Clicks", kind: "count" },
  linkClicks: { label: "Link clicks", kind: "count" },
  addToCart: { label: "Adds to cart", kind: "count" },
  thumbstop: { label: "Thumbstop", kind: "percent" },
  clickToAddToCart: { label: "Click to ATC", kind: "percent" },
  clickToPurchase: { label: "Click to purchase", kind: "percent" },
  video25: { label: "Video 25%", kind: "percent" },
  video50: { label: "Video 50%", kind: "percent" },
  video75: { label: "Video 75%", kind: "percent" },
  video100: { label: "Video 100%", kind: "percent" },
  atcToPurchaseRatio: { label: "ATC to purchase", kind: "percent" },
  leads: { label: "Leads", kind: "count" },
  messages: { label: "Messages", kind: "count" },
  hookScore: { label: "Hook score", kind: "score" },
  ctaScore: { label: "CTA score", kind: "score" },
  offerScore: { label: "Offer score", kind: "score" },
  clickScore: { label: "Click score", kind: "score" },
  watchScore: { label: "Watch score", kind: "score" },
};

function formatMetricNumber(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function formatPublicMetric(
  key: ShareMetricKey,
  value: number,
  currency: string | null | undefined,
): string {
  const kind = PUBLIC_METRICS[key].kind;
  if (kind === "money") {
    const code = currency?.trim().toUpperCase() ?? "";
    if (/^[A-Z]{3}$/.test(code)) {
      try {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: code,
          maximumFractionDigits: 2,
        }).format(value);
      } catch {
        // An unknown provider currency remains a plain amount, never USD.
      }
    }
    return formatMetricNumber(value);
  }
  if (kind === "ratio") return `${formatMetricNumber(value)}x`;
  if (kind === "percent") return `${formatMetricNumber(value)}%`;
  return formatMetricNumber(value, kind === "count" ? 0 : 1);
}

function publicMetricsForCreative(
  payload: SharePayload,
  creative: SharePayloadCreative,
): PublicShareCreative["metrics"] {
  const selected = new Set(payload.metrics ?? []);
  return (payload.metrics ?? []).flatMap((key) => {
    if (!selected.has(key)) return [];
    const raw = (creative as unknown as Record<string, unknown>)[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return [];
    return [
      {
        key,
        label: PUBLIC_METRICS[key].label,
        value: formatPublicMetric(key, raw, creative.currency),
        rawValue: raw,
      },
    ];
  });
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
        posterUrl: clean(preview.poster_url),
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
  // Missing audience is the pre-audience buyer contract. Explicit audience
  // values have already passed the store's closed-enum validation before this
  // projection is reached.
  const audience: ShareAudience =
    payload.audience === "creative_team" || payload.audience === "external"
      ? payload.audience
      : "buyer";
  return {
    title: clean(payload.title) ?? "Shared creatives",
    dateRange: clean(payload.dateRange) ?? "",
    frozenAt: clean(payload.frozenAt) ?? clean(payload.createdAt) ?? "",
    expiresAt: clean(payload.expiresAt) ?? "",
    audience,
    // The buyer disclosure travels with the numbers it qualifies.
    financialWarning: audience === "buyer" ? BUYER_FINANCIAL_WARNING : null,
    allowCsv: audience === "buyer" && payload.allowCsv === true,
    actions:
      audience === "buyer"
        ? (payload.clientActions ?? []).flatMap((action) => {
            const what = clean(action.what);
            const why = clean(action.why);
            if (!what || !why) return [];
            return [
              {
                what,
                why,
                date: clean(action.date) ?? "",
                outcome: clean(action.outcome),
                outcomeTone:
                  action.outcomeTone === "positive" ? "positive" : "neutral",
              },
            ];
          })
        : [],
    creatives: (payload.creatives ?? []).map((creative, index) => {
      const { media, reason } = toPublicMedia(creative);
      return {
        // Index-based, so an internal creative id is not published either.
        key: `c${index + 1}`,
        name: clean(creative.name) ?? `Creative ${index + 1}`,
        format: creative.format,
        launchDate: clean(creative.launchDate) ?? "",
        media,
        mediaUnavailableReason: reason,
        metrics: publicMetricsForCreative(payload, creative),
        story:
          audience === "creative_team"
            ? buildCreativeStory(creative, payload.benchmarks)
            : null,
      };
    }),
    captionsSupported: false,
    // `includeNotes` is the sender's own choice at creation time; an empty
    // note left in the field regardless is not something they asked to send.
    note: payload.includeNotes ? clean(payload.note) : null,
    messages: payload.messages ?? [],
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
