import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import {
  LaunchpadCreativeSelection,
  getCreativeAdvisoryNotes,
} from "@/components/launchpad/LaunchpadCreativeSelection";

function makeRow(overrides: Partial<MetaCreativeRow> = {}): MetaCreativeRow {
  return {
    id: "row_1",
    creativeId: "creative_1",
    name: "Creative One",
    associatedAdsCount: 1,
    accountId: "act_1",
    accountName: "Main",
    campaignId: "cmp_1",
    campaignName: "Campaign 1",
    adSetId: "adset_1",
    adSetName: "Ad set 1",
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
    thumbnailUrl: null,
    previewUrl: null,
    imageUrl: null,
    isCatalog: false,
    previewState: "unavailable",
    preview: {
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
      source: null,
      is_catalog: false,
    },
    launchDate: "2026-05-01",
    tags: [],
    aiTags: {},
    spend: 100,
    purchaseValue: 240,
    roas: 2.4,
    cpa: 12,
    cpcLink: 1,
    cpm: 10,
    ctrAll: 1,
    linkCtr: 1,
    purchases: 8,
    impressions: 1000,
    clicks: 50,
    linkClicks: 40,
    landingPageViews: 0,
    addToCart: 0,
    initiateCheckout: 0,
    leads: 0,
    messages: 0,
    thumbstop: 0,
    clickToAddToCart: 0,
    clickToPurchase: 0,
    seeMoreRate: 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    atcToPurchaseRatio: 0,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<DecisionOutput> = {}): DecisionOutput {
  return {
    creativeId: "creative_1",
    creativeName: "Creative One",
    label: "scale",
    reason: "Strong winner.",
    confidence: 80,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 1.4,
    badges: [],
    metrics: {
      spend: 100,
      purchases: 8,
      roas: 2.4,
      recent7dRoas: 2.2,
    },
    engineVersion: "v3-test",
    generatedAt: "2026-05-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("LaunchpadCreativeSelection", () => {
  it("renders engine v3 label and below breakeven badges", () => {
    const decision = makeDecision({
      badges: [{ type: "below_breakeven", label: "Below breakeven", severity: "warning" }],
    });

    const html = renderToStaticMarkup(
      <LaunchpadCreativeSelection
        rows={[makeRow()]}
        selectedCreativeIds={["creative_1"]}
        decisionByCreativeId={new Map([["creative_1", decision]])}
        onToggleCreative={vi.fn()}
      />,
    );

    expect(html).toContain("Scale");
    expect(html).toContain("Below breakeven");
    expect(html).toContain("Engine: scale candidate");
  });

  it("maps cut and diagnose decisions to advisory notes", () => {
    expect(getCreativeAdvisoryNotes(makeDecision({ label: "cut" })).map((note) => note.text)).toContain(
      "Engine: cut candidate - confirm intent",
    );
    expect(getCreativeAdvisoryNotes(makeDecision({ label: "diagnose" })).map((note) => note.text)).toContain(
      "Engine: data anomaly - verify before launch",
    );
  });
});
