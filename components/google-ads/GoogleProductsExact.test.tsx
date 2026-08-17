import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GoogleProductsExact } from "@/components/google-ads/GoogleProductsExact";
import type { ProductRow } from "@/components/google-ads/google-ads-dashboard-support";
import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";
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
  },
];

function render(recommendations: GoogleRecommendation[] | null) {
  const model = buildGoogleProductsExactViewModel({
    identity: {
      accountId: "4931182201",
      currencyCode: "USD",
      windowLabel: "28d",
      syncLabel: "Synced 26m ago",
    },
    products,
    advisorRecommendations: recommendations,
    roasTarget: 3.8,
    feed: null,
  });
  return renderToStaticMarkup(
    React.createElement(GoogleProductsExact, { model, syncTone: "positive" }),
  );
}

const allocation = [
  {
    id: "rec-1",
    title: "Isolate into a hero campaign",
    strategyLayer: "Shopping & Products",
    rankScore: 90,
    reasonCodes: ["Aurora Tote — Sand"],
    recommendedAction: "Split the hero SKU out",
    summary: "Hero SKU carries the account",
  } as GoogleRecommendation,
];

describe("GoogleProductsExact structure", () => {
  it("opens on the canonical head", () => {
    const markup = render(allocation);
    expect(markup).toContain('data-screen-label="Google Ads · Products"');
    expect(markup).toContain("Google Ads · 4931182201 · USD · 28d window");
    expect(markup).toContain("Products &amp; feed");
    expect(markup).toContain("writes guarded · receipt on every change");
  });

  it("renders the design's four feed tiles in order", () => {
    const labels = Array.from(
      render(allocation).matchAll(/data-google-feed-tile="([^"]+)"/g),
    ).map((match) => match[1]);
    expect(labels).toEqual(["serving", "limited", "disapproved", "synced"]);
    const markup = render(allocation);
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
      render(allocation).matchAll(/<th[^>]*>([^<]+)<\/th>/g),
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
    const markup = render(allocation);
    expect(markup).toContain('data-google-allocation-read="true"');
    expect(markup).toContain("advisor · product allocation");
    expect(markup).toContain("Shopping + PMax · feed from Shopify");
  });

  it("keeps the allocation card mounted when no finding is scoped", () => {
    const markup = render(null);
    expect(markup).toContain("Allocation read");
    expect(markup).toContain(
      "Cluster reads are directional — restructures apply from Advisor → Plan as guarded writes.",
    );
  });

  it("closes on the Merchant Center boundary note", () => {
    expect(render(allocation)).toContain(
      "A disapproval blocks the whole listing group — the fix lives in Merchant Center, never edited here.",
    );
  });
});

describe("GoogleProductsExact has none of the invented chrome", () => {
  it("embeds no advisor panel, empty state or queue", () => {
    expect(source).not.toContain("GoogleAdvisorPanel");
    expect(source).not.toContain("EmptyState");
    expect(source).not.toContain("Skeleton");
    const markup = render(allocation);
    expect(markup).not.toContain("Opportunity Queue");
    expect(markup).not.toContain("Account decisions");
  });

  it("draws no row cap notice, focus tint or sort control", () => {
    const markup = render(allocation);
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
