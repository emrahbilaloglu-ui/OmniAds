import {
  SHARE_AUDIENCES,
  type ShareAudience,
  type SharePayload,
  type SharedMessage,
} from "@/components/creatives/shareCreativeTypes";
import { sanitizeCreativeSharePayloadForRead } from "@/lib/creative-share-store";

export const DEV_PREVIEW_SHARE_MESSAGES = [
  {
    id: "preview-message-1",
    who: "sender",
    name: "Emrah B.",
    text: "Two of these are wearing out — check where viewers stop watching before briefing the next round.",
    postedAt: "2026-08-20T18:10:00.000Z",
  },
  {
    id: "preview-message-2",
    who: "viewer",
    name: "Maya · Studio",
    text: "Is the carousel failing on the images or the copy?",
    postedAt: "2026-08-21T09:14:00.000Z",
  },
] satisfies SharedMessage[];

export function resolveDevPreviewShareAudience(value: string | undefined): ShareAudience {
  return SHARE_AUDIENCES.find((audience) => audience === value) ?? "creative_team";
}

/**
 * Build a fixture through the same read projection as a real public share.
 *
 * The raw object deliberately contains internal identity and buyer metrics.
 * `sanitizeCreativeSharePayloadForRead` must remove those fields for creator
 * audiences before `toPublicShare` can render them. That keeps this preview a
 * contract harness instead of a prettier, less safe parallel implementation.
 */
export function buildDevPreviewSharePayload(audience: ShareAudience): SharePayload {
  const raw: SharePayload = {
    token: "preview0000000000000000000000000",
    title: "August creative review",
    dateRange: "Jul 24 – Aug 20, 2026",
    createdAt: "2026-08-20T15:32:00.000Z",
    frozenAt: "2026-08-20T15:32:00.000Z",
    expiresAt: "2099-08-27T15:32:00.000Z",
    businessId: "dev_preview_internal_business",
    providerAccountId: "act_dev_preview_internal",
    businessName: "Private preview workspace",
    clientEmail: "private-preview@example.com",
    metrics: [
      "spend",
      "purchaseValue",
      "roas",
      "cpa",
      "ctrAll",
      "purchases",
      "thumbstop",
      "video25",
      "video50",
      "video75",
      "video100",
    ],
    includeNotes: true,
    note: "Two of these are wearing out — check where viewers stop watching before briefing the next round.",
    audience,
    allowCsv: true,
    benchmarks: {
      thumbstop: 28,
      videoCompletion50: 30,
      ctrAll: 1.34,
    },
    clientActions: [
      {
        what: "Paused an underperforming ad",
        why: "CPA was 3x the campaign target with no recovery over 5 days.",
        date: "2026-08-18",
        outcome: "Done",
        outcomeTone: "positive",
      },
    ],
    creatives: [
      {
        id: "internal-video-creative",
        name: "Hero video — product in motion",
        currency: "USD",
        format: "video",
        previewState: "unavailable",
        isCatalog: false,
        previewUrl: null,
        imageUrl: null,
        thumbnailUrl: null,
        preview: {
          render_mode: "video",
          image_url: null,
          video_url: null,
          poster_url: "/demo/urbantrail/adventure-backpack.svg",
          source: "preview_url",
          is_catalog: false,
        },
        launchDate: "2026-07-13",
        tags: ["internal-winner"],
        spend: 4820,
        purchaseValue: 15320,
        roas: 3.18,
        cpa: 18.4,
        ctrAll: 2.05,
        purchases: 262,
        thumbstop: 41,
        video25: 78,
        video50: 46,
        video75: 22,
        video100: 9,
      },
      {
        id: "internal-static-creative",
        name: "Static hero — discount banner",
        currency: "USD",
        format: "image",
        previewState: "preview",
        isCatalog: false,
        previewUrl: null,
        imageUrl: null,
        thumbnailUrl: null,
        preview: {
          render_mode: "image",
          image_url: "/demo/urbantrail/carry-on-backpack.svg",
          video_url: null,
          poster_url: null,
          source: "image_url",
          is_catalog: false,
        },
        launchDate: "2026-06-02",
        tags: ["internal-discount"],
        spend: 1210,
        purchaseValue: 1690,
        roas: 1.4,
        cpa: 22.1,
        ctrAll: 0.82,
        purchases: 55,
        thumbstop: 19,
      },
      {
        id: "internal-catalog-bestsellers",
        name: "Catalog — bestsellers",
        currency: "USD",
        format: "catalog",
        previewState: "catalog",
        isCatalog: true,
        previewUrl: null,
        imageUrl: null,
        thumbnailUrl: null,
        preview: {
          render_mode: "unavailable",
          image_url: null,
          video_url: null,
          poster_url: null,
          source: null,
          is_catalog: true,
        },
        launchDate: "2026-08-01",
        tags: ["internal-catalog"],
        spend: 640,
        purchaseValue: 980,
        roas: 1.53,
        cpa: 14.2,
        ctrAll: 1.1,
        purchases: 45,
        thumbstop: 24,
      },
      {
        id: "internal-catalog-new-arrivals",
        name: "Catalog — new arrivals",
        currency: "USD",
        format: "catalog",
        previewState: "catalog",
        isCatalog: true,
        previewUrl: null,
        imageUrl: null,
        thumbnailUrl: null,
        preview: {
          render_mode: "unavailable",
          image_url: null,
          video_url: null,
          poster_url: null,
          source: null,
          is_catalog: true,
        },
        launchDate: "2026-07-20",
        tags: ["internal-catalog"],
        spend: 730,
        purchaseValue: 1044,
        roas: 1.43,
        cpa: 16.2,
        ctrAll: 2.1,
        purchases: 45,
        thumbstop: 31,
      },
    ],
  };

  const sanitized = sanitizeCreativeSharePayloadForRead(raw);
  if (!sanitized) {
    throw new Error("dev_preview_share_fixture_rejected");
  }

  // The real store merges the live notes column after sanitizing the frozen
  // payload. Mirror that ordering so creator audiences can exercise the same
  // thread without putting messages into the frozen snapshot contract.
  return {
    ...sanitized,
    messages: DEV_PREVIEW_SHARE_MESSAGES.map((message) => ({ ...message })),
  };
}
