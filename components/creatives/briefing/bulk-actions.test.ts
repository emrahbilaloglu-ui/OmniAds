import { describe, expect, it, vi } from "vitest";
import {
  buildBulkLaunchpadHref,
  buildBulkPauseRequestBody,
  buildCompareDrawerItems,
  pauseBriefingCardsBulk,
  successfulBulkPauseCardIds,
  summarizeBulkPauseFailure,
} from "@/components/creatives/briefing/bulk-actions";
import type { DecisionOriginBriefingCard } from "@/components/creatives/briefing/action-handlers";

const DECISION_HASH = "c".repeat(64);

function card(
  overrides: Partial<DecisionOriginBriefingCard> = {},
): DecisionOriginBriefingCard {
  return {
    id: "row_1",
    creativeId: "creative_1",
    realAdId: "ad_1",
    providerAccountId: "act_123",
    name: "Aphrodite Hook",
    brand: "TheSwaf",
    label: "cut",
    primary: { kind: "cut", label: "Cut" },
    sourceDecisionSnapshotId: "snapshot_1",
    sourceDecisionEvaluationId: "evaluation_1",
    sourceDecisionSnapshotEngineVersion:
      "v3-ad-2026-07-12-native-provenance-shadow",
    sourceDecisionHash: DECISION_HASH,
    sourceDecisionSnapshotMatch: "matched",
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
  it("builds exact per-ad lineage and never emits fallback candidates", () => {
    const body = buildBulkPauseRequestBody({
      businessId: "biz_1",
      idempotencyKey: "bulk-1",
      cards: [
        card(),
        card({
          id: "row_2",
          creativeId: "creative_2",
          realAdId: "ad_2",
          name: "Second",
          sourceDecisionSnapshotId: "snapshot_2",
          sourceDecisionEvaluationId: "evaluation_2",
        }),
      ],
    });

    expect(body).toMatchObject({
      contractVersion: "meta-decision-origin-ad-execution.v1",
      businessId: "biz_1",
      providerAccountId: "act_123",
      action: "pause",
      idempotencyKey: "bulk-1",
    });
    expect(body.ads).toHaveLength(2);
    expect(body.ads[0]).toMatchObject({
      businessId: "biz_1",
      providerAccountId: "act_123",
      adId: "ad_1",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
    engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
      decisionHash: DECISION_HASH,
      action: "pause",
      creativeId: "creative_1",
      name: "Aphrodite Hook",
    });
    expect(body.ads[1]).toMatchObject({
      adId: "ad_2",
      snapshotId: "snapshot_2",
      evaluationId: "evaluation_2",
    });
    expect(body.ads[0]).not.toHaveProperty("candidateAdIds");
    expect(body.ads[1]).not.toHaveProperty("candidateAdIds");
  });

  it("rejects synthetic/alternate ids before calling the route", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      pauseBriefingCardsBulk({
        businessId: "biz_1",
        cards: [
          card({
            realAdId: null,
            metaAdId: "alternate_ad",
            effectiveAdId: "alternate_ad",
            adId: "warehouse_ad",
          }),
        ],
        fetchImpl,
      }),
    ).rejects.toThrow("missing_ad_id");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects mixed provider accounts before calling the route", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(() =>
      buildBulkPauseRequestBody({
        businessId: "biz_1",
        cards: [
          card(),
          card({ realAdId: "ad_2", providerAccountId: "act_456" }),
        ],
      }),
    ).toThrow("exactly one provider account");
    expect(fetchImpl).not.toHaveBeenCalled();
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
      cards: [
        card(),
        card({
          id: "row_2",
          creativeId: "creative_2",
          realAdId: "ad_2",
          sourceDecisionSnapshotId: "snapshot_2",
          sourceDecisionEvaluationId: "evaluation_2",
        }),
      ],
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/launchpad/meta/bulk-ad-status",
      expect.objectContaining({ method: "POST" }),
    );
    const requestBody = JSON.parse(
      String((vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit)?.body),
    );
    expect(requestBody).toMatchObject({
      contractVersion: "meta-decision-origin-ad-execution.v1",
      businessId: "biz_1",
      providerAccountId: "act_123",
      action: "pause",
      idempotencyKey: "bulk-1",
    });
    expect(requestBody.ads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adId: "ad_1", snapshotId: "snapshot_1" }),
        expect.objectContaining({ adId: "ad_2", snapshotId: "snapshot_2" }),
      ]),
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

  it("maps only exact-ad successes back to card ids", () => {
    const cards = [
      card({ id: "row_1", creativeId: "shared_creative", realAdId: "ad_1" }),
      card({ id: "row_2", creativeId: "shared_creative", realAdId: "ad_2" }),
    ];
    const result = {
      ok: false,
      successCount: 1,
      failedCount: 1,
      results: [
        {
          inputAdId: "ad_1",
          adId: "ad_1",
          creativeId: "shared_creative",
          ok: true,
          status: "PAUSED",
        },
        {
          inputAdId: "ad_2",
          creativeId: "shared_creative",
          ok: false,
          error: { code: "ad_not_found", message: "Ad was not found for this business." },
        },
      ],
    };

    expect(successfulBulkPauseCardIds(cards, result)).toEqual(["row_1"]);
    expect(summarizeBulkPauseFailure(result)).toBe("Ad was not found for this business.");
  });

  it("does not accept a success that resolved to another ad", () => {
    const cards = [card({ id: "row_1", realAdId: "ad_1" })];
    expect(
      successfulBulkPauseCardIds(cards, {
        ok: false,
        results: [
          {
            inputAdId: "ad_1",
            adId: "ad_2",
            ok: true,
            status: "PAUSED",
          },
        ],
      }),
    ).toEqual([]);
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
      label: "scale",
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
