import { describe, expect, it } from "vitest";

import type { ProductRow } from "@/components/google-ads/google-ads-dashboard-support";
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
    expect(row.roasTone).toBe("unserved");
  });

  it("keeps a served in-band ROAS in the neutral ink, not the unserved ink", () => {
    const row = buildGoogleProductsExactViewModel(
      input({ products: [product({ roas: 3.17 })], roasTarget: 3.8 }),
    ).rows[0]!;
    expect(row.roas).toBe("3.17");
    expect(row.roasTone).toBe("neutral");
  });
});

describe("google products exact allocation read", () => {
  const classified: ProductRow[] = [
    product({ itemId: "AT-104", title: "Aurora Tote — Sand", classification: "scale_product" }),
    product({ itemId: "WH-509", title: "Waterproof Hiking Pack", classification: "scale_product" }),
    product({
      itemId: "CW-310",
      title: "Canvas Weekender",
      classification: "underperforming_product",
    }),
    product({
      itemId: "CT-402",
      title: "Compact Travel Pack",
      classification: "hidden_winner",
    }),
    product({ itemId: "TK-201", title: "Travel Kit — Slate", classification: "stable_product" }),
  ];

  it("keeps the design's four bucket labels, in order, whatever was served", () => {
    for (const products of [classified, [], null]) {
      const model = buildGoogleProductsExactViewModel(input({ products }));
      expect(model.allocation.map((block) => block.label)).toEqual([
        "Isolate into a hero campaign",
        "Scale",
        "Reduce",
        "Hidden winners",
      ]);
      expect(model.allocation.map((block) => block.key)).toEqual([
        "isolate",
        "scale",
        "reduce",
        "hidden",
      ]);
    }
  });

  it("fills the buckets with product names from the server classification", () => {
    const model = buildGoogleProductsExactViewModel(input({ products: classified }));
    expect(model.allocation.map((block) => block.items)).toEqual([
      [],
      ["Aurora Tote — Sand", "Waterproof Hiking Pack"],
      ["Canvas Weekender"],
      ["Compact Travel Pack"],
    ]);
  });

  it("leaves the hero-isolation bucket empty because no classification names it", () => {
    const model = buildGoogleProductsExactViewModel(input({ products: classified }));
    // `stable_product` is the residual bucket, not a hero-isolation candidate,
    // so it never leaks into a bucket it does not answer.
    expect(model.allocation[0]!.items).toEqual([]);
    expect(
      model.allocation.some((block) => block.items.includes("Travel Kit — Slate")),
    ).toBe(false);
  });

  it("keeps an unbacked bucket's shell rather than dropping it", () => {
    const model = buildGoogleProductsExactViewModel(
      input({ products: [product({ classification: "scale_product" })] }),
    );
    expect(model.allocation).toHaveLength(4);
    expect(model.allocation[2]!).toMatchObject({ label: "Reduce", items: [] });
    expect(model.allocation[3]!).toMatchObject({ label: "Hidden winners", items: [] });
  });

  it("never prints an advisor sentence or a reason code as a bucket label", () => {
    const model = buildGoogleProductsExactViewModel(input({ products: classified }));
    const text = JSON.stringify(model.allocation);
    expect(text).not.toContain("PMAX");
    expect(text).not.toContain("DIAGNOSTIC");
    expect(text).not.toContain("Shopping control lane");
  });

  it("names a title-less product by its served item id", () => {
    const model = buildGoogleProductsExactViewModel(
      input({
        products: [product({ title: undefined, itemId: "AT-999", classification: "scale_product" })],
      }),
    );
    expect(model.allocation[1]!.items).toEqual(["AT-999"]);
  });

  it("does not cap a bucket, so it names every product the classification covers", () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      product({
        itemId: `SKU-${index}`,
        title: `Product ${index}`,
        classification: "underperforming_product",
      }),
    );
    const model = buildGoogleProductsExactViewModel(input({ products: many }));
    expect(model.allocation[2]!.items).toHaveLength(7);
  });
});

describe("google products exact merchant center state", () => {
  it("prints the provider's own reason for a limited item", () => {
    expect(
      googleProductFeedStatus(
        product({ feedState: "limited", feedStatusLabel: "Missing GTIN" }),
      ),
    ).toEqual({ label: "Missing GTIN", tone: "warning" });
  });

  it("falls back to the state when the provider named no reason", () => {
    expect(
      googleProductFeedStatus(
        product({ feedState: "limited", feedStatusLabel: null }),
      ),
    ).toEqual({ label: "Limited", tone: "warning" });
  });

  it("prints a disapproval even for an item that took traffic in the window", () => {
    expect(
      googleProductFeedStatus(
        product({ feedState: "disapproved", impressions: 51_000, clicks: 4210 }),
      ),
    ).toEqual({ label: "Disapproved", tone: "negative" });
  });

  it("lets a disapproval outrank the hidden-winner classification", () => {
    expect(
      googleProductFeedStatus(
        product({ feedState: "disapproved", classification: "hidden_winner" }),
      ),
    ).toEqual({ label: "Disapproved", tone: "negative" });
  });

  it("does not let an unknown Merchant Center state overwrite the served facts", () => {
    expect(
      googleProductFeedStatus(
        product({ feedState: "unknown", classification: "hidden_winner" }),
      ),
    ).toEqual({ label: "Hidden winner", tone: "auto" });
    expect(
      googleProductFeedStatus(
        product({ feedState: "unknown", impressions: 0, clicks: 0 }),
      ),
    ).toEqual({ label: DASH, tone: "neutral" });
  });

  it("takes the serving numerator from Merchant Center once it is read", () => {
    const model = buildGoogleProductsExactViewModel(
      input({
        // Only one of these two took traffic; the feed says 214 are serving.
        products: [product(), product({ itemId: "AT-105", impressions: 0, clicks: 0 })],
        feed: {
          totalItemsInFeed: 226,
          servingItemCount: 214,
          limitedItemCount: 9,
          disapprovedItemCount: 3,
          syncedAt: "2026-08-17T11:34:00.000Z",
        },
        nowMs: Date.parse("2026-08-17T12:00:00.000Z"),
      }),
    );
    expect(model.tiles.map((tile) => tile.value)).toEqual([
      "214",
      "9",
      "3",
      "26m ago",
    ]);
    expect(model.tiles[0]!.sub).toBe("of 226 in feed");
  });

  it("tints a real zero and dashes an unread count", () => {
    const read = buildGoogleProductsExactViewModel(
      input({
        feed: {
          totalItemsInFeed: 226,
          servingItemCount: 226,
          limitedItemCount: 0,
          disapprovedItemCount: 0,
          syncedAt: "2026-08-17T11:34:00.000Z",
        },
        nowMs: Date.parse("2026-08-17T12:00:00.000Z"),
      }),
    );
    expect(read.tiles[1]!.value).toBe("0");
    expect(read.tiles[1]!.valueTone).toBe("warning");
    expect(read.tiles[2]!.value).toBe("0");
    expect(read.tiles[2]!.valueTone).toBe("danger");

    const unread = buildGoogleProductsExactViewModel(input({ feed: null }));
    expect(unread.tiles[1]!.value).toBe(DASH);
    expect(unread.tiles[1]!.valueTone).toBe("ink");
  });

  it("keeps the design's relative shape across the whole age range", () => {
    const label = (syncedAt: string) =>
      buildGoogleProductsExactViewModel(
        input({
          feed: { syncedAt },
          nowMs: Date.parse("2026-08-17T12:00:00.000Z"),
        }),
      ).tiles[3]!.value;

    expect(label("2026-08-17T11:59:40.000Z")).toBe("just now");
    expect(label("2026-08-17T11:34:00.000Z")).toBe("26m ago");
    expect(label("2026-08-17T05:00:00.000Z")).toBe("7h ago");
    expect(label("2026-08-14T12:00:00.000Z")).toBe("3d ago");
    expect(label("not-a-timestamp")).toBe(DASH);
  });

  it("keeps the em dash on every Merchant Center tile when nothing was read", () => {
    const model = buildGoogleProductsExactViewModel(input({ feed: null }));
    expect(model.tiles[0]!.sub).toBe(DASH);
    expect(model.tiles[3]!.value).toBe(DASH);
  });
});
