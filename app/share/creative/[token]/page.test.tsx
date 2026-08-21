import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SharePayload } from "@/components/creatives/shareCreativeTypes";

vi.mock("@/lib/creative-share-store", () => ({
  getCreativeShareSnapshot: vi.fn(),
}));

const shareStore = await import("@/lib/creative-share-store");
const { default: ShareCreativePage } = await import(
  "@/app/share/creative/[token]/page"
);

const TOKEN = "2".repeat(32);

function buyerPayload(): SharePayload {
  return {
    token: TOKEN,
    title: "Frozen buyer snapshot",
    dateRange: "2026-08-01 - 2026-08-19",
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    metrics: ["spend"],
    includeNotes: false,
    audience: "buyer",
    allowCsv: true,
    creatives: [
      {
        id: "internal_creative",
        name: "Hero",
        currency: "USD",
        format: "image",
        previewState: "preview",
        isCatalog: false,
        previewUrl: null,
        imageUrl: null,
        thumbnailUrl: null,
        preview: {
          render_mode: "image",
          image_url: "/api/media/cache/hero.jpg",
          video_url: null,
          poster_url: null,
          source: "image_url",
          is_catalog: false,
        },
        launchDate: "2026-08-01",
        tags: [],
        spend: 100,
        purchaseValue: 250,
        roas: 2.5,
        cpa: 20,
        ctrAll: 1.5,
        purchases: 5,
      },
    ],
  };
}

describe("/share/creative/[token]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the frozen snapshot, records the open, and exposes its permitted CSV", async () => {
    vi.mocked(shareStore.getCreativeShareSnapshot).mockResolvedValue(
      buyerPayload(),
    );

    const page = await ShareCreativePage({
      params: Promise.resolve({ token: TOKEN }),
    });
    const html = renderToStaticMarkup(page);

    expect(shareStore.getCreativeShareSnapshot).toHaveBeenCalledWith(TOKEN, {
      recordOpen: true,
    });
    expect(html).toContain('data-public-share="ready"');
    expect(html).toContain(`/share/creative/${TOKEN}/csv`);
    // The messages endpoint lives under a different route tree than the
    // page itself (/api/creatives/share, not /share/creative) — this once
    // silently pointed at the page's own path and 404'd on every post.
    expect(html).toContain(`/api/creatives/share/${TOKEN}/messages`);
    expect(html).toContain("$100.00");
    expect(html).not.toContain("internal_creative");
  });

  it("uses the same non-disclosing unavailable page for any failed read", async () => {
    vi.mocked(shareStore.getCreativeShareSnapshot).mockRejectedValue(
      new Error("database detail that must not leak"),
    );

    const page = await ShareCreativePage({
      params: Promise.resolve({ token: TOKEN }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('data-public-share="unavailable"');
    expect(html).not.toContain("database detail");
    expect(html).not.toContain(TOKEN);
  });
});
