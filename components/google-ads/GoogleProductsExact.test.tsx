import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GoogleProductsExact } from "@/components/google-ads/GoogleProductsExact";
import type { ProductRow } from "@/components/google-ads/google-ads-dashboard-support";
import { buildGoogleProductsExactViewModel } from "@/components/google-ads/google-products-exact-adapter";

const source = readFileSync("components/google-ads/GoogleProductsExact.tsx", "utf8");
const stylesheet = readFileSync(
  "components/google-ads/GoogleSearchProductsExact.module.css",
  "utf8",
);

const products: ProductRow[] = [
  {
    itemId: "AT-104",
    title: "Aurora Tote — Sand",
    impressions: 51_000,
    clicks: 4210,
    spend: 3180,
    revenue: 14_890,
    roas: 4.68,
    conversions: 96,
    classification: "scale_product",
  },
];

function render(rows: ProductRow[] | null = products) {
  const model = buildGoogleProductsExactViewModel({
    identity: {
      accountId: "4931182201",
      currencyCode: "USD",
      windowLabel: "28d",
      syncLabel: "Synced 26m ago",
    },
    products: rows,
    roasTarget: 3.8,
    feed: null,
  });
  return renderToStaticMarkup(
    React.createElement(GoogleProductsExact, { model, syncTone: "positive" }),
  );
}

describe("GoogleProductsExact structure", () => {
  it("opens on the canonical head", () => {
    const markup = render();
    expect(markup).toContain('data-screen-label="Google Ads · Products"');
    expect(markup).toContain("Google Ads · 4931182201 · USD · 28d window");
    expect(markup).toContain("Products &amp; feed");
    expect(markup).toContain("writes guarded · receipt on every change");
  });

  it("renders the design's four feed tiles in order", () => {
    const labels = Array.from(
      render().matchAll(/data-google-feed-tile="([^"]+)"/g),
    ).map((match) => match[1]);
    expect(labels).toEqual(["serving", "limited", "disapproved", "synced"]);
    const markup = render();
    expect(markup).toContain("Products serving");
    expect(markup).toContain("Limited");
    expect(markup).toContain("Disapproved");
    expect(markup).toContain("Feed synced");
    expect(markup).not.toContain("Products with spend");
    expect(markup).not.toContain("Draining spend");
    expect(markup).not.toContain("Scale candidates");
  });

  it("prints the canonical product column headers in order", () => {
    const headers = Array.from(
      render().matchAll(/<th[^>]*>([^<]+)<\/th>/g),
    ).map((match) => match[1]);
    expect(headers).toEqual([
      "Product",
      "Clicks",
      "Cost",
      "Conv value",
      "ROAS",
      "Feed status",
    ]);
  });

  it("keeps the two-column grid to exactly the table and the allocation read", () => {
    const markup = render();
    expect(markup).toContain('data-google-allocation-read="true"');
    expect(markup).toContain("advisor · product allocation");
    expect(markup).toContain("Shopping + PMax · feed from Shopify");
  });

  it("keeps the allocation card mounted when nothing was read", () => {
    const markup = render(null);
    expect(markup).toContain("Allocation read");
    expect(markup).toContain(
      "Cluster reads are directional — restructures apply from Advisor → Plan as guarded writes.",
    );
  });

  it("always draws the design's four allocation buckets, in order", () => {
    for (const rows of [products, null]) {
      const markup = render(rows);
      const buckets = Array.from(
        markup.matchAll(/data-google-allocation-bucket="([^"]+)"/g),
      ).map((match) => match[1]);
      expect(buckets).toEqual(["isolate", "scale", "reduce", "hidden"]);
      expect(markup).toContain("Isolate into a hero campaign");
      expect(markup).toContain(">Scale<");
      expect(markup).toContain(">Reduce<");
      expect(markup).toContain("Hidden winners");
    }
  });

  it("prints the em dash inside an empty bucket rather than collapsing it", () => {
    // One scale_product row: Scale names it, the other three buckets keep their
    // chip row and print `—`.
    const blocks = render(products)
      .split('data-google-allocation-bucket="')
      .slice(1);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toContain("Isolate into a hero campaign");
    expect(blocks[0]).toContain(">—<");
    expect(blocks[1]).toContain("Aurora Tote — Sand");
    expect(blocks[2]).toContain(">—<");
    expect(blocks[3]).toContain(">—<");
    expect(render(null)).toContain("Isolate into a hero campaign");
  });

  it("puts product names in the allocation chips, never advisor prose", () => {
    const markup = render(products);
    expect(markup).not.toContain("PMAX_SCALING_PROPOSED");
    expect(markup).not.toContain("FAMILY_PMAX_SCALING");
    expect(markup).not.toContain("DIAGNOSTIC_");
    expect(markup).not.toContain("Shopping control lane");
  });

  it("closes on the Merchant Center boundary note", () => {
    expect(render()).toContain(
      "A disapproval blocks the whole listing group — the fix lives in Merchant Center, never edited here.",
    );
  });
});

describe("GoogleProductsExact has none of the invented chrome", () => {
  it("embeds no advisor panel, empty state or queue", () => {
    expect(source).not.toContain("GoogleAdvisorPanel");
    expect(source).not.toContain("EmptyState");
    expect(source).not.toContain("Skeleton");
    const markup = render();
    expect(markup).not.toContain("Opportunity Queue");
    expect(markup).not.toContain("Account decisions");
  });

  it("draws no row cap notice, focus tint or sort control", () => {
    const markup = render();
    expect(markup).not.toContain("Showing the top");
    expect(source).not.toContain("focusedTitles");
    expect(markup).not.toContain("<button");
  });
});

describe("GoogleProductsExact geometry", () => {
  it("pins the reference product table width and grid tracks", () => {
    expect(stylesheet).toContain("min-width: 640px");
    expect(stylesheet).toContain("grid-template-columns: minmax(0, 1.6fr) minmax(290px, 1fr)");
  });

  it("keeps the closing note in the reference mono face at 11px", () => {
    expect(stylesheet).toMatch(/\.tileSub, \.footnote \{[^}]*font-size: 11px/);
  });
});
