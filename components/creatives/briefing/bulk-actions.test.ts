import { describe, expect, it, vi } from "vitest";
import {
  buildBulkLaunchpadHref,
  buildBulkPauseRequestBody,
  buildCompareDrawerItems,
  pauseBriefingCardsBulk,
} from "@/components/creatives/briefing/bulk-actions";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "row_1",
    creativeId: "creative_1",
    realAdId: "ad_1",
    name: "Aphrodite Hook",
    brand: "TheSwaf",
    label: "scale",
    spend: 1200,
    roas: 3.4,
    ctr: 1.8,
    cpa: 14.2,
    purchases: 30,
    frequency: 1.6,
    sparkline: [2.8, 3.1, 3.4],
    ...overrides,
  };
}

describe("bulk briefing actions", () => {
  it("builds the bulk pause body with resolved ad ids and dedupes", () => {
    expect(
      buildBulkPauseRequestBody({
        businessId: "biz_1",
        idempotencyKey: "bulk-1",
        cards: [
          card(),
          card({ id: "row_2", creativeId: "creative_2", realAdId: "ad_2", name: "Second" }),
          card({ id: "row_dup", creativeId: "creative_dup", realAdId: "ad_2", name: "Duplicate" }),
        ],
      }),
    ).toEqual({
      businessId: "biz_1",
      action: "pause",
      idempotencyKey: "bulk-1",
      ads: [
        {
          adId: "ad_1",
          candidateAdIds: ["ad_1", "creative_1", "row_1"],
          creativeId: "creative_1",
          name: "Aphrodite Hook",
        },
        {
          adId: "ad_2",
          candidateAdIds: ["ad_2", "creative_dup", "row_dup"],
          creativeId: "creative_dup",
          name: "Duplicate",
        },
      ],
    });
  });

  it("keeps fallback ids in the bulk pause request body", () => {
    expect(
      buildBulkPauseRequestBody({
        businessId: "biz_1",
        idempotencyKey: "bulk-2",
        cards: [
          card({
            id: "synthetic_row_1",
            creativeId: "creative_1",
            realAdId: null,
            metaAdId: "meta_ad_1",
            effectiveAdId: "meta_ad_1",
            adId: "warehouse_ad_1",
          }),
        ],
      }).ads,
    ).toEqual([
      {
        adId: "meta_ad_1",
        candidateAdIds: ["meta_ad_1", "warehouse_ad_1", "creative_1", "synthetic_row_1"],
        creativeId: "creative_1",
        name: "Aphrodite Hook",
      },
    ]);
  });

  it("posts bulk cut through the existing bulk-ad-status endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        successCount: 2,
        failedCount: 0,
        results: [
          { inputAdId: "ad_1", adId: "ad_1", ok: true, status: "PAUSED" },
          { inputAdId: "ad_2", adId: "ad_2", ok: true, status: "PAUSED" },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await pauseBriefingCardsBulk({
      businessId: "biz_1",
      idempotencyKey: "bulk-1",
      cards: [card(), card({ id: "row_2", creativeId: "creative_2", realAdId: "ad_2" })],
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/launchpad/meta/bulk-ad-status",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          businessId: "biz_1",
          action: "pause",
          idempotencyKey: "bulk-1",
          ads: [
            {
              adId: "ad_1",
              candidateAdIds: ["ad_1", "creative_1", "row_1"],
              creativeId: "creative_1",
              name: "Aphrodite Hook",
            },
            {
              adId: "ad_2",
              candidateAdIds: ["ad_2", "creative_2", "row_2"],
              creativeId: "creative_2",
              name: "Aphrodite Hook",
            },
          ],
        }),
      }),
    );
  });

  it("throws on endpoint errors so callers can rollback optimistic bulk state", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: "bulk failed" } }),
    })) as unknown as typeof fetch;

    await expect(
      pauseBriefingCardsBulk({
        businessId: "biz_1",
        cards: [card()],
        fetchImpl,
      }),
    ).rejects.toThrow("bulk failed");
  });

  it("builds bulk Launchpad URLs for 1, 3, and 5 selected creatives", () => {
    expect(buildBulkLaunchpadHref([card()], "demote")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_1&mode=demote&fromBriefing=true",
    );
    expect(
      buildBulkLaunchpadHref(
        [
          card(),
          card({ id: "row_2", creativeId: "creative_2" }),
          card({ id: "row_3", creativeId: "creative_3" }),
        ],
        "fresh_test",
      ),
    ).toBe("/platforms/meta/launchpad?creativeIds=creative_1,creative_2,creative_3&mode=fresh_test&fromBriefing=true");
    expect(
      buildBulkLaunchpadHref(
        [
          card(),
          card({ id: "row_2", creativeId: "creative_2" }),
          card({ id: "row_3", creativeId: "creative_3" }),
          card({ id: "row_4", creativeId: "creative_4" }),
          card({ id: "row_5", creativeId: "creative_5" }),
        ],
        "add_existing",
      ),
    ).toBe("/platforms/meta/launchpad?creativeIds=creative_1,creative_2,creative_3,creative_4,creative_5&mode=add_existing&fromBriefing=true");
  });

  it("maps selected cards into CompareDrawer metrics", () => {
    expect(buildCompareDrawerItems([card({
      mediaPreviewUrl: "https://cdn.example.test/card.jpg",
      tableThumbnailUrl: "https://cdn.example.test/thumb.jpg",
      format: "image",
      creativeVisualFormat: "video",
      creativePrimaryType: "video",
      creativePrimaryLabel: "Video",
      preview: {
        render_mode: "image",
        image_url: "https://cdn.example.test/preview.jpg",
        video_url: null,
        poster_url: null,
        source: "test",
        is_catalog: false,
      },
    })])).toEqual([
      {
        id: "creative_1",
        name: "Aphrodite Hook",
        brand: "TheSwaf",
        label: "scale",
        spend: 1200,
        roas: 3.4,
        ctr: 1.8,
        cpa: 14.2,
        purchases: 30,
        frequency: 1.6,
        sparkline: [2.8, 3.1, 3.4],
        mediaPreviewUrl: "https://cdn.example.test/card.jpg",
        thumbnailUrl: null,
        tableThumbnailUrl: "https://cdn.example.test/thumb.jpg",
        cardPreviewUrl: null,
        previewUrl: null,
        imageUrl: null,
        cachedThumbnailUrl: null,
        format: "image",
        creativeVisualFormat: "video",
        creativePrimaryType: "video",
        creativePrimaryLabel: "Video",
        creativeSecondaryType: null,
        creativeSecondaryLabel: null,
        creativeDeliveryType: null,
        isCatalog: null,
        preview: {
          render_mode: "image",
          image_url: "https://cdn.example.test/preview.jpg",
          video_url: null,
          poster_url: null,
          source: "test",
          is_catalog: false,
        },
      },
    ]);
  });
});
