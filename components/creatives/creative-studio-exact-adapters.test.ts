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

  /**
   * REWRITTEN, and the law it used to break restated here.
   *
   * The old expectation was `spend: null` for an all-zero row, produced by the
   * heuristic "if every metric is zero then nothing was observed". That is a
   * guess about the provider dressed as a fact about the data, and it is wrong
   * in the common case: a copy line that was paused before delivery, or that
   * never entered delivery at all, really did spend 0 and really did get 0
   * impressions. Hiding a measured 0 behind an em dash withholds a fact — and
   * the mirror of the same heuristic was worse, letting one non-zero field
   * license every other field on the row, including ones the payload never
   * carried.
   *
   * The law: **a measured 0 renders 0; only a missing or unreadable value
   * renders an em dash.** Absence, not smallness, is what makes a number
   * unknown.
   *
   * The nulls that remain are a different rule and must survive: a ratio whose
   * denominator is 0 has no value. CTR needs impressions, CVR needs link
   * clicks, ROAS needs spend — none of those exist here, so those three stay
   * unavailable while the counts they were computed from stay 0.
   */
  it("keeps a measured zero on an all-zero copy row and withholds only the undefined ratios", () => {
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
          linkCtr: 0,
        }),
      ],
      state: "ready",
    });

    expect(model.rows[0]).toMatchObject({
      spend: 0,
      ctr: null,
      cvr: null,
      roas: null,
    });
  });

  /**
   * WHY: the row-level flag used to be all-or-nothing, so one absent field
   * withheld every number the payload did carry. A row that reports a real
   * spend and a real impression count must render both, even when an unrelated
   * metric never arrived.
   */
  it("withholds only the metrics a row did not serve", () => {
    const model = buildCreativeStudioAssetsModel({
      rows: [
        asset({
          observedMetrics: {
            spend: 250,
            impressions: 10_000,
            clicks: 100,
            purchases: 5,
            purchaseValue: 1_000,
            roas: 4,
            cpa: 50,
            cpm: 25,
            // Never served by this payload.
            thumbstop: null,
            frequency: null,
          },
        }),
      ],
      state: "ready",
    });

    expect(model.rows[0]?.metrics).toMatchObject({
      spend: 250,
      impressions: 10_000,
      roas: 4,
      cpa: 50,
      cpm: 25,
      aov: 200,
      thumbstop: null,
      frequency: null,
    });
  });

  /**
   * WHY: `normalizeCreativeMetricFields` (lib/meta/creatives-service-support.ts)
   * ends every ratio with `: 0`, so a creative that spent real money and bought
   * nothing published `cpa: 0`. CPA is a lower-is-better column, so the heat
   * ramp then painted the account's worst waste as its cost-per-purchase
   * leader. Zero purchases does not make acquisition free; it makes cost per
   * acquisition undefined, and undefined is an em dash. The spend beside it is
   * a real measurement and must survive.
   */
  it("withholds a ratio whose denominator was measured as zero", () => {
    const model = buildCreativeStudioAssetsModel({
      rows: [
        asset({
          observedMetrics: {
            spend: 33_500,
            impressions: 0,
            clicks: 0,
            purchases: 0,
            purchaseValue: 0,
            roas: 0,
            cpa: 0,
            cpm: 0,
            ctrAll: 0,
            thumbstop: 0,
          },
        }),
      ],
      state: "ready",
    });

    expect(model.rows[0]?.metrics).toMatchObject({
      spend: 33_500,
      purchases: 0,
      impressions: 0,
      cpa: null,
      aov: null,
      cpm: null,
      ctr: null,
      thumbstop: null,
      roas: 0,
    });
  });

  /**
   * WHY: `total + (value ?? 0)` made an unserved field indistinguishable from a
   * measured zero once it had been summed, so a destination whose ads reported
   * no spend at all rendered a confident "this destination cost nothing".
   */
  it("totals only the destination facts the ads actually reported", () => {
    const rows = [
      {
        id: "ad_1",
        destination_url: "https://shop.test/products/b",
        associated_ads_count: 1,
        currency: "USD",
        link_clicks: 10,
        landing_page_views: 4,
      },
      {
        id: "ad_2",
        destination_url: "https://shop.test/products/b",
        associated_ads_count: 1,
        currency: "USD",
        link_clicks: 0,
        landing_page_views: 0,
      },
    ] as unknown as MetaCreativeApiRow[];

    const model = buildCreativeStudioLandingModel({ rows, state: "ready" });

    expect(model.rows[0]).toMatchObject({
      // Never reported by either ad.
      spend: null,
      roas: null,
      cpa: null,
      // Reported by both, one of them as a real zero.
      linkClicks: 10,
      landingPageViewRate: 40,
    });
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
