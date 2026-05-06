import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: (props: { name: string }) =>
    React.createElement("div", null, `preview:${props.name}`),
}));

const { CreativeAdBreakdownDrawer } = await import(
  "@/components/creatives/CreativeAdBreakdownDrawer"
);

function buildRow(overrides: Partial<MetaCreativeRow> = {}): MetaCreativeRow {
  return {
    id: "ad_1",
    creativeId: "creative_1",
    objectStoryId: null,
    effectiveObjectStoryId: null,
    postId: null,
    copyText: null,
    copyVariants: [],
    headlineVariants: [],
    descriptionVariants: [],
    name: "Since I hung",
    associatedAdsCount: 1,
    accountId: "act_123",
    accountName: "Main",
    campaignId: "campaign_1",
    campaignName: "US Test Campaign",
    adSetId: "adset_1",
    adSetName: "Broad Test Ad Set",
    effectiveStatus: "ACTIVE",
    currency: "USD",
    format: "image",
    creativeType: "feed",
    creativeTypeLabel: "Feed",
    creativeDeliveryType: "standard",
    creativeVisualFormat: "image",
    creativePrimaryType: "standard",
    creativePrimaryLabel: "Standard",
    creativeSecondaryType: null,
    creativeSecondaryLabel: null,
    taxonomyVersion: "v2",
    taxonomySource: "deterministic",
    taxonomyReconciledByVideoEvidence: false,
    thumbnailUrl: "https://example.com/thumb.jpg",
    previewUrl: "https://example.com/preview.jpg",
    imageUrl: "https://example.com/image.jpg",
    tableThumbnailUrl: "https://example.com/table.jpg",
    cardPreviewUrl: "https://example.com/card.jpg",
    previewManifest: null,
    cachedThumbnailUrl: null,
    previewStatus: "ready",
    previewOrigin: "snapshot",
    isCatalog: false,
    previewState: "preview",
    preview: {
      render_mode: "image",
      image_url: "https://example.com/image.jpg",
      video_url: null,
      poster_url: null,
      source: "image_url",
      is_catalog: false,
    },
    launchDate: "2026-04-01",
    tags: [],
    aiTags: {},
    spend: 100,
    purchaseValue: 250,
    roas: 2.5,
    cpa: 20,
    cpcLink: 2,
    cpm: 12,
    ctrAll: 1.5,
    linkCtr: 1.1,
    purchases: 5,
    impressions: 1000,
    clicks: 40,
    frequency: 1.2,
    linkClicks: 20,
    landingPageViews: 0,
    addToCart: 0,
    initiateCheckout: 0,
    leads: 0,
    messages: 0,
    thumbstop: 0,
    clickToAddToCart: 0,
    clickToPurchase: 25,
    seeMoreRate: 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    atcToPurchaseRatio: 0,
    ...overrides,
  };
}

function buildDecision(overrides: Partial<DecisionOutput> = {}): DecisionOutput {
  return {
    creativeId: "creative_1",
    creativeName: "Since I hung",
    label: "scale",
    reason: "Strong internal winner",
    confidence: 82,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 1.25,
    badges: [],
    metrics: {
      spend: 100,
      purchases: 5,
      roas: 2.5,
      recent7dRoas: 2.4,
    },
    engineVersion: "v3-test",
    generatedAt: "2026-05-06T00:00:00.000Z",
    ...overrides,
  };
}

function renderDrawer(props: {
  rows: MetaCreativeRow[];
  decisionsByCreativeId?: Map<string, DecisionOutput>;
}) {
  return renderToStaticMarkup(
    <CreativeAdBreakdownDrawer
      open
      creative={buildRow({ id: "creative_group", creativeId: "creative_group" })}
      rows={props.rows}
      defaultCurrency="USD"
      decisionsByCreativeId={props.decisionsByCreativeId}
      onOpenChange={() => {}}
      onOpenPlacement={() => {}}
    />,
  );
}

describe("CreativeAdBreakdownDrawer", () => {
  it("renders one placement card per ad with campaign, ad set, engine label, and badges", () => {
    const rows = [
      buildRow(),
      buildRow({
        id: "ad_2",
        creativeId: "creative_2",
        campaignName: "UK Retest Campaign",
        adSetName: "Lookalike",
        effectiveStatus: "CAMPAIGN_PAUSED",
        spend: 50,
        purchaseValue: 25,
        roas: 0.5,
        purchases: 1,
      }),
    ];
    const decisions = new Map<string, DecisionOutput>([
      [
        "creative_1",
        buildDecision({
          badges: [{ type: "below_breakeven", label: "Below breakeven", severity: "warning" }],
        }),
      ],
      ["creative_2", buildDecision({ creativeId: "creative_2", label: "cut" })],
    ]);

    const html = renderDrawer({ rows, decisionsByCreativeId: decisions });

    expect((html.match(/data-placement-row-id=/g) ?? []).length).toBe(2);
    expect(html).toContain("US Test Campaign");
    expect(html).toContain("Broad Test Ad Set");
    expect(html).toContain("UK Retest Campaign");
    expect(html).toContain("CAMPAIGN_PAUSED");
    expect(html).toContain("Scale");
    expect(html).toContain("Cut");
    expect(html).toContain("Below breakeven");
  });

  it("shows the single-placement empty state with the detail button", () => {
    const html = renderDrawer({ rows: [buildRow()] });

    expect(html).toContain("This creative runs in a single ad placement.");
    expect(html).toContain("Open creative detail");
    expect(html).not.toContain("data-placement-row-id=");
  });

  it("hides engine labels when no visible v3 decision map is provided", () => {
    const html = renderDrawer({
      rows: [
        buildRow(),
        buildRow({ id: "ad_2", creativeId: "creative_2", campaignName: "Second Campaign" }),
      ],
    });

    expect(html).not.toContain("Scale");
    expect(html).not.toContain("Below breakeven");
  });

  it("summarizes total spend and weighted ROAS across placements", () => {
    const html = renderDrawer({
      rows: [
        buildRow({ spend: 100, purchaseValue: 250, purchases: 5, roas: 2.5 }),
        buildRow({
          id: "ad_2",
          creativeId: "creative_2",
          spend: 50,
          purchaseValue: 25,
          purchases: 1,
          roas: 0.5,
        }),
      ],
    });

    expect(html).toContain("$150.00");
    expect(html).toContain("1.83x");
    expect(html).toContain("Placements");
    expect(html).toContain("2");
  });
});
