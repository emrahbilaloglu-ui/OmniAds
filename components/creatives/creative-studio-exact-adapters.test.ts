import { describe, expect, it } from "vitest";

import type { CopyMotionRow } from "@/app/(dashboard)/platforms/meta/copies/page-support";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import {
  buildCreativeStudioAssetsModel,
  buildCreativeStudioCopiesModel,
  buildCreativeStudioLandingModel,
} from "./creative-studio-exact-adapters";

function asset(overrides: Partial<MetaCreativeRow> = {}): MetaCreativeRow {
  return {
    id: "creative_1",
    creativeId: "creative_1",
    name: "Served asset",
    creativePrimaryLabel: "Video",
    creativeVisualFormat: "vertical",
    effectiveStatus: "ACTIVE",
    aiTags: { messagingAngle: ["Server angle"] },
    currency: "USD",
    metricsAvailability: "available",
    spend: 100,
    purchaseValue: 400,
    purchases: 4,
    impressions: 1_000,
    clicks: 50,
    linkClicks: 40,
    addToCart: 8,
    roas: 4,
    cpa: 25,
    cpm: 10,
    ctrAll: 5,
    thumbstop: 32,
    frequency: 2.1,
    tableThumbnailUrl: null,
    cardPreviewUrl: null,
    imageUrl: null,
    thumbnailUrl: null,
    cachedThumbnailUrl: null,
    ...overrides,
  } as MetaCreativeRow;
}

function copy(overrides: Partial<CopyMotionRow> = {}): CopyMotionRow {
  return {
    ...asset(),
    id: "copy_1",
    copyText: "A real served line",
    copyAssetType: "primary_text",
    copyAngle: null,
    associatedAdsCount: 0,
    associatedAdsCountAvailable: false,
    usedInAds: [],
    usedInCampaigns: [],
    copyHeadline: null,
    copyDescription: null,
    copySource: null,
    normalizedCopyKey: null,
    unresolvedReason: null,
    ...overrides,
  } as CopyMotionRow;
}

describe("Creative Studio exact adapters", () => {
  it("withholds every numeric asset field when the producer marks metrics unavailable", () => {
    const model = buildCreativeStudioAssetsModel({
      rows: [asset({ metricsAvailability: "unavailable", spend: 999, roas: 9 })],
      state: "ready",
    });

    expect(model.rows[0]?.metrics).toMatchObject({
      spend: null,
      roas: null,
      purchases: null,
      aov: null,
      cvr: null,
    });
  });

  it("projects only served asset identity and never substitutes a video proxy for Hold 15s", () => {
    const model = buildCreativeStudioAssetsModel({ rows: [asset()], state: "ready" });

    expect(model.rows[0]).toMatchObject({
      status: "Active",
      statusTone: "positive",
      marketingAngle: "Server angle",
      metrics: {
        spend: 100,
        aov: 100,
        atcRate: 20,
        cvr: 10,
        hold: null,
      },
    });
  });

  it("keeps unsupported copy columns unavailable and preserves an observed true zero", () => {
    const model = buildCreativeStudioCopiesModel({
      rows: [
        copy({ spend: 20, purchaseValue: 0, purchases: 0, roas: 0, linkClicks: 10 }),
      ],
      state: "ready",
    });

    expect(model.rows[0]).toMatchObject({
      ads: null,
      seeMore: null,
      engagement: null,
      roas: 0,
      cvr: 0,
      angle: null,
    });
    expect(model.angles).toEqual([]);
    expect(model.angleGaps).toEqual([]);
  });

  it("treats an all-zero copy bundle as unavailable instead of fabricating measured zeros", () => {
    const model = buildCreativeStudioCopiesModel({
      rows: [
        copy({
          spend: 0,
          purchaseValue: 0,
          purchases: 0,
          impressions: 0,
          linkClicks: 0,
          addToCart: 0,
          roas: 0,
        }),
      ],
      state: "ready",
    });

    expect(model.rows[0]).toMatchObject({ spend: null, ctr: null, cvr: null, roas: null });
  });

  it("aggregates Meta destination facts without minting signal, tests, gaps, or history", () => {
    const rows = [
      {
        id: "ad_1",
        destination_url: "https://shop.test/products/a",
        associated_ads_count: 1,
        currency: "USD",
        spend: 50,
        purchase_value: 150,
        purchases: 3,
        link_clicks: 20,
        landing_page_views: 15,
      },
      {
        id: "ad_2",
        destination_url: "https://shop.test/products/a",
        associated_ads_count: 1,
        currency: "USD",
        spend: 50,
        purchase_value: 50,
        purchases: 1,
        link_clicks: 20,
        landing_page_views: 10,
      },
    ] as unknown as MetaCreativeApiRow[];

    const model = buildCreativeStudioLandingModel({ rows, state: "ready" });

    expect(model.rows).toEqual([
      expect.objectContaining({
        destination: "/products/a",
        ads: 2,
        spend: 100,
        linkClicks: 40,
        landingPageViewRate: 62.5,
        cvr: 16,
        cpa: 25,
        roas: 2,
        signal: null,
      }),
    ]);
    expect(model.gaps).toEqual([]);
    expect(model.tests).toEqual([]);
    expect(model.history).toEqual([]);
  });
});
