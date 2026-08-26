import { PublicSharePage, PublicShareUnavailable } from "@/components/zero-base/creative/public-share-page";
import { toPublicShare } from "@/lib/zero-base/creative/public-share";
import type { SharePayload } from "@/components/creatives/shareCreativeTypes";

function payload(overrides: Partial<SharePayload> = {}): SharePayload {
  return {
    token: "preview",
    title: "August creative review",
    dateRange: "Jul 24 – Aug 20, 2026",
    createdAt: "2026-08-20T15:32:00.000Z",
    expiresAt: "2026-08-27T15:32:00.000Z",
    metrics: ["spend", "purchaseValue", "roas", "cpa", "ctrAll", "purchases", "thumbstop"],
    includeNotes: true,
    note: "Two of these are wearing out — check where viewers stop watching before briefing the next round.",
    audience: "creative_team",
    allowCsv: true,
    benchmarks: { thumbstop: 28, videoCompletion50: 30, ctrAll: 1.34 },
    clientActions: [
      {
        what: "Paused an underperforming ad",
        why: "CPA was 3x the campaign target with no recovery over 5 days.",
        date: "2026-08-18",
        outcome: "Done",
        outcomeTone: "positive",
      },
    ],
    messages: [
      { id: "m1", who: "sender", name: "Emrah B.", text: "Two of these are wearing out — check where viewers stop watching before briefing the next round.", postedAt: "2026-08-13T18:10:00.000Z" },
      { id: "m2", who: "viewer", name: "Maya · Studio", text: "Is the carousel failing on the images or the copy?", postedAt: "2026-08-14T09:14:00.000Z" },
    ],
    creatives: [
      {
        id: "c1",
        name: "Hero video — product in motion",
        currency: "USD",
        format: "video",
        previewState: "preview",
        isCatalog: false,
        previewUrl: null,
        imageUrl: null,
        thumbnailUrl: null,
        preview: {
          render_mode: "video",
          image_url: null,
          video_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
          poster_url: "https://picsum.photos/seed/hero/400/700",
          source: "preview_url",
          is_catalog: false,
        },
        launchDate: "2026-07-13",
        tags: [],
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
        id: "c2",
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
          image_url: "https://picsum.photos/seed/static/600/600",
          video_url: null,
          poster_url: null,
          source: "image_url",
          is_catalog: false,
        },
        launchDate: "2026-06-02",
        tags: [],
        spend: 1210,
        purchaseValue: 1690,
        roas: 1.4,
        cpa: 22.1,
        ctrAll: 0.82,
        purchases: 55,
        thumbstop: 19,
      },
      // Realistic degraded case: a real catalog ad, real spend, but no
      // media captured and no benchmark-eligible signal — this is what most
      // rows on a real account actually look like, not the video/hero case
      // above. Kept unstyled deliberately so the gap between "curated demo"
      // and "real account" is visible in the same screenshot.
      {
        id: "c3",
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
        tags: [],
        spend: 640,
        purchaseValue: 980,
        roas: 1.53,
        cpa: 14.2,
        ctrAll: 1.1,
        purchases: 45,
      },
      {
        id: "c4",
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
        tags: [],
        spend: 730,
        purchaseValue: 1044,
        roas: 1.43,
        cpa: 16.2,
        ctrAll: 2.1,
        purchases: 45,
      },
    ],
    ...overrides,
  } as unknown as SharePayload;
}

export default async function DevPreviewSharePage({
  searchParams,
}: {
  searchParams: Promise<{ audience?: string; state?: string }>;
}) {
  const resolved = await searchParams;
  if (resolved?.state === "gone") {
    return <PublicShareUnavailable />;
  }
  const audience = (resolved?.audience as SharePayload["audience"]) || "creative_team";
  const share = toPublicShare(
    payload({
      audience,
      allowCsv: audience === "buyer",
      ...(resolved?.state === "empty" ? { creatives: [] } : {}),
    }),
  );
  const filteredShare =
    resolved?.state === "real"
      ? { ...share, creatives: share.creatives.filter((c) => c.format === "catalog") }
      : share;
  return (
    <PublicSharePage
      csvHref="/dev-preview-share/csv"
      // Not a real endpoint — this harness has no backend. It only needs to
      // be a non-null string so the composer renders for visual review;
      // actually sending a note will fail, which is fine here.
      messagesHref="/dev-preview-share/messages"
      share={filteredShare}
    />
  );
}
