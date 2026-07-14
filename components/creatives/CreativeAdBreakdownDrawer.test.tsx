import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: (props: { name: string }) =>
    React.createElement("div", null, `preview:${props.name}`),
}));

const {
  COPY_FEEDBACK_MS,
  CreativeAdBreakdownDrawer,
  buildMetaAdsManagerUrl,
  getPlacementCopyState,
  handlePlacementCopy,
} = await import(
  "@/components/creatives/CreativeAdBreakdownDrawer"
);

function buildRow(overrides: Partial<MetaCreativeRow> = {}): MetaCreativeRow {
  return {
    id: "ad_1",
    creativeId: "creative_1",
    realAdId: "120000000000001",
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
    preAuthorityLabel:
      overrides.preAuthorityLabel ?? overrides.label ?? "scale",
    authorityBlocker: overrides.authorityBlocker ?? null,
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
  creative?: MetaCreativeRow;
}) {
  return renderToStaticMarkup(
    <CreativeAdBreakdownDrawer
      open
      creative={
        props.creative ??
        buildRow({
          id: "creative_group",
          creativeId: "creative_group",
          associatedAdsCount: props.rows.length,
        })
      }
      rows={props.rows}
      defaultCurrency="USD"
      decisionsByCreativeId={props.decisionsByCreativeId}
      onOpenChange={() => {}}
      onOpenPlacement={() => {}}
    />,
  );
}

describe("CreativeAdBreakdownDrawer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders one placement card per ad with campaign, ad set, engine label, and badges", () => {
    const rows = [
      buildRow(),
      buildRow({
        id: "ad_2",
        creativeId: "creative_2",
        realAdId: "120000000000002",
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
        buildRow({
          id: "ad_2",
          creativeId: "creative_2",
          realAdId: "120000000000002",
          campaignName: "Second Campaign",
        }),
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
          realAdId: "120000000000002",
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

  it("shows selected-window count against source lifetime count when they differ", () => {
    const html = renderDrawer({
      creative: buildRow({
        id: "creative_group",
        creativeId: "creative_group",
        associatedAdsCount: 8,
      }),
      rows: [
        buildRow(),
        buildRow({ id: "ad_2", realAdId: "120000000000002", creativeId: "creative_2" }),
        buildRow({ id: "ad_3", realAdId: "120000000000003", creativeId: "creative_3" }),
        buildRow({ id: "ad_4", realAdId: "120000000000004", creativeId: "creative_4" }),
      ],
    });

    expect(html).toContain("4 of 8 ads (selected window)");
  });

  it("shows a plain count when source and window counts match", () => {
    const html = renderDrawer({
      rows: [
        buildRow(),
        buildRow({ id: "ad_2", realAdId: "120000000000002", creativeId: "creative_2" }),
      ],
    });

    expect(html).toContain("2 ads");
    expect(html).not.toContain("selected window");
  });

  it("sets and clears copy feedback state after the timeout", () => {
    vi.useFakeTimers();
    let copiedValue: string | null = null;
    const setCopiedValue = vi.fn(
      (next: string | null | ((current: string | null) => string | null)) => {
        copiedValue = typeof next === "function" ? next(copiedValue) : next;
      },
    );
    const writeText = vi.fn(() => Promise.resolve());

    handlePlacementCopy("120000000000001", setCopiedValue, writeText);

    expect(writeText).toHaveBeenCalledWith("120000000000001");
    expect(copiedValue).toBe("120000000000001");
    expect(getPlacementCopyState("120000000000001", copiedValue).label).toBe("Copied");

    vi.advanceTimersByTime(COPY_FEEDBACK_MS);

    expect(copiedValue).toBeNull();
    expect(getPlacementCopyState("120000000000001", copiedValue).label).toBe("Copy");
  });

  it("builds direct Meta edit links only with a resolved real ad id", () => {
    expect(
      buildMetaAdsManagerUrl(
        buildRow({ accountId: "act_123456789", realAdId: "120000000000001" }),
      ),
    ).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=123456789&selected_ad_ids=120000000000001",
    );

    expect(buildMetaAdsManagerUrl(buildRow({ realAdId: null }))).toBeNull();
    expect(buildMetaAdsManagerUrl(buildRow({ realAdId: " " }))).toBeNull();
  });

  it("uses real ad ids for Meta links and hides links when missing", () => {
    const withLink = renderDrawer({
      rows: [
        buildRow({ id: "synthetic_row", realAdId: "120000000000001" }),
        buildRow({ id: "ad_2", realAdId: "120000000000002", creativeId: "creative_2" }),
      ],
    });
    const withoutLink = renderDrawer({
      rows: [
        buildRow({ id: "synthetic_row", realAdId: null }),
        buildRow({ id: "ad_2", realAdId: null, creativeId: "creative_2" }),
      ],
    });

    expect(withLink).toContain("/adsmanager/manage/ads/edit?");
    expect(withLink).toContain("selected_ad_ids=120000000000001");
    expect(withoutLink).not.toContain("Open in Meta Ads Manager");
  });

  it("labels performance bars by campaign when creative names collide across placements", () => {
    const html = renderDrawer({
      rows: [
        buildRow({ name: "Catalog New Collection", campaignName: "US Campaign", adSetName: "Broad" }),
        buildRow({
          id: "ad_2",
          realAdId: "120000000000002",
          creativeId: "creative_2",
          name: "Catalog New Collection",
          campaignName: "UK Campaign",
          adSetName: "Lookalike",
        }),
      ],
    });

    expect(html).toContain('data-chart-row-label="US Campaign"');
    expect(html).toContain('data-chart-row-label="UK Campaign"');
    expect(html).toContain("Broad");
    expect(html).toContain("Lookalike");
  });
});
