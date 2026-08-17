import { describe, expect, it } from "vitest";

import type { ProductRow } from "@/components/google-ads/google-ads-dashboard-support";
import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";
import {
  buildGoogleProductsExactViewModel,
  googleProductFeedStatus,
  type GoogleProductsExactInput,
} from "@/components/google-ads/google-products-exact-adapter";

const DASH = "—";

function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    itemId: "AT-104",
    title: "Aurora Tote — Sand",
    impressions: 51_000,
    clicks: 4210,
    spend: 3180,
    revenue: 14_890,
    roas: 4.68,
    conversions: 96,
    ...overrides,
  };
}

function recommendation(
  overrides: Partial<GoogleRecommendation> = {},
): GoogleRecommendation {
  return {
    id: "rec-1",
    title: "Isolate into a hero campaign",
    strategyLayer: "Shopping & Products",
    rankScore: 90,
    reasonCodes: ["Aurora Tote — Sand"],
    recommendedAction: "Split the hero SKU out",
    summary: "Hero SKU carries the account",
    ...overrides,
  } as GoogleRecommendation;
}

function input(
  overrides: Partial<GoogleProductsExactInput> = {},
): GoogleProductsExactInput {
  return {
    identity: {
      accountId: "4931182201",
      currencyCode: "USD",
      windowLabel: "28d",
      syncLabel: "Synced 26m ago",
    },
    products: [product()],
    advisorRecommendations: [recommendation()],
    roasTarget: 3.8,
    feed: null,
    ...overrides,
  };
}

describe("google products exact head", () => {
  it("prints the four canonical eyebrow segments", () => {
    expect(buildGoogleProductsExactViewModel(input()).eyebrow).toBe(
      "Google Ads · 4931182201 · USD · 28d window",
    );
  });
});

describe("google products exact feed tiles", () => {
  it("keeps the design's four labels in order", () => {
    expect(
      buildGoogleProductsExactViewModel(input()).tiles.map((tile) => [
        tile.label,
        tile.sub,
      ]),
    ).toEqual([
      ["Products serving", DASH],
      ["Limited", "missing GTIN · price mismatch"],
      ["Disapproved", "blocks their listing groups"],
      ["Feed synced", "Shopify → Merchant Center"],
    ]);
  });

  it("counts served products and dashes every Merchant Center fact", () => {
    const model = buildGoogleProductsExactViewModel(
      input({
        products: [
          product(),
          product({ itemId: "AT-105", impressions: 0, clicks: 0, spend: 0 }),
        ],
      }),
    );
    expect(model.tiles[0]!.value).toBe("1");
    expect(model.tiles[1]!.value).toBe(DASH);
    expect(model.tiles[2]!.value).toBe(DASH);
    expect(model.tiles[3]!.value).toBe(DASH);
  });

  it("never tints an unread count as a warning", () => {
    const model = buildGoogleProductsExactViewModel(input());
    expect(model.tiles[1]!.valueTone).toBe("ink");
    expect(model.tiles[2]!.valueTone).toBe("ink");
  });

  it("tints the counts once a Merchant Center read supplies them", () => {
    const model = buildGoogleProductsExactViewModel(
      input({
        feed: {
          totalItemsInFeed: 226,
          limitedItemCount: 9,
          disapprovedItemCount: 3,
          syncedLabel: "26m ago",
        },
      }),
    );
    expect(model.tiles.map((tile) => tile.value)).toEqual(["1", "9", "3", "26m ago"]);
    expect(model.tiles[0]!.sub).toBe("of 226 in feed");
    expect(model.tiles[1]!.valueTone).toBe("warning");
    expect(model.tiles[2]!.valueTone).toBe("danger");
  });
});

describe("google products exact feed status", () => {
  it("gives a serving item the positive tint the design pins", () => {
    expect(googleProductFeedStatus(product())).toEqual({
      label: "Serving",
      tone: "positive",
    });
  });

  it("carries the server-assigned hidden winner classification", () => {
    expect(googleProductFeedStatus(product({ classification: "hidden_winner" }))).toEqual(
      { label: "Hidden winner", tone: "auto" },
    );
  });

  it("prints an em dash rather than guessing why an item did not serve", () => {
    expect(
      googleProductFeedStatus(product({ impressions: 0, clicks: 0, conversions: 0 })),
    ).toEqual({ label: DASH, tone: "neutral" });
  });

  it("never substitutes a performance verdict for a feed state", () => {
    const model = buildGoogleProductsExactViewModel(
      input({
        products: [
          product({ conversions: 0, revenue: 0, roas: 0 }),
          product({ itemId: "CW-310", contributionState: "negative", roas: 0.4 }),
          product({ itemId: "CT-402", statusLabel: "scale" }),
        ],
      }),
    );
    expect(model.rows.map((row) => row.issue)).toEqual([
      "Serving",
      "Serving",
      "Serving",
    ]);
  });
});

describe("google products exact rows", () => {
  it("formats the design's columns and tints ROAS against the target", () => {
    const row = buildGoogleProductsExactViewModel(input()).rows[0]!;
    expect(row).toMatchObject({
      name: "Aurora Tote — Sand",
      sku: "AT-104",
      clicks: "4,210",
      cost: "$3,180",
      value: "$14,890",
      roas: "4.68",
      roasTone: "positive",
    });
  });

  it("dashes an unserved ROAS instead of printing a zero", () => {
    const row = buildGoogleProductsExactViewModel(
      input({ products: [product({ roas: 0, revenue: 0 })] }),
    ).rows[0]!;
    expect(row.roas).toBe(DASH);
    expect(row.roasTone).toBe("neutral");
  });
});

describe("google products exact allocation read", () => {
  it("reads only the Shopping & Products advisor layer, ranked", () => {
    const model = buildGoogleProductsExactViewModel(
      input({
        advisorRecommendations: [
          recommendation({ id: "low", title: "Reduce", rankScore: 10 }),
          recommendation({ id: "high", title: "Scale", rankScore: 99 }),
          recommendation({
            id: "other",
            title: "Search restructure",
            strategyLayer: "Search & Keywords" as GoogleRecommendation["strategyLayer"],
            rankScore: 100,
          }),
        ],
      }),
    );
    expect(model.allocation.map((block) => block.label)).toEqual(["Scale", "Reduce"]);
  });

  it("returns an empty allocation list so the card shell can still render", () => {
    const model = buildGoogleProductsExactViewModel(
      input({ advisorRecommendations: null }),
    );
    expect(model.allocation).toEqual([]);
  });
});
