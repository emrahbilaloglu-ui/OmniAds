import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type {
  DecisionOutput,
  EngineV3Flags,
} from "@/lib/creative-decision-engine";

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: (props: { name: string }) =>
    React.createElement("div", null, `preview:${props.name}`),
}));

const { CreativesTopGrid } = await import("@/components/creatives/CreativesTopGrid");

function makeRow(overrides: Partial<MetaCreativeRow> = {}): MetaCreativeRow {
  return {
    id: "cr_1",
    creativeId: "cr_1",
    name: "Creative One",
    associatedAdsCount: 1,
    accountId: "act_1",
    accountName: "Main",
    campaignId: "cmp_1",
    campaignName: "Campaign 1",
    adSetId: "adset_1",
    adSetName: "Ad Set 1",
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
    launchDate: "2026-05-01",
    tags: [],
    aiTags: {},
    spend: 100,
    purchaseValue: 250,
    roas: 2.5,
    cpa: 10,
    cpcLink: 2,
    cpm: 12,
    ctrAll: 1.5,
    linkCtr: 1.2,
    purchases: 10,
    impressions: 1000,
    clicks: 75,
    linkClicks: 50,
    landingPageViews: 0,
    addToCart: 15,
    initiateCheckout: 0,
    leads: 0,
    messages: 0,
    thumbstop: 12,
    clickToAddToCart: 20,
    clickToPurchase: 20,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    atcToPurchaseRatio: 66,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<DecisionOutput> = {}): DecisionOutput {
  return {
    creativeId: "cr_1",
    creativeName: "Creative One",
    label: "scale",
    preAuthorityLabel:
      overrides.preAuthorityLabel ?? overrides.label ?? "scale",
    authorityBlocker: overrides.authorityBlocker ?? null,
    reason: "Strong relative winner.",
    confidence: 72,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.2,
    ratioToTarget: 1.4,
    badges: [],
    metrics: {
      spend: 100,
      purchases: 10,
      roas: 3.1,
      recent7dRoas: 2.8,
    },
    engineVersion: "v3-test",
    generatedAt: "2026-05-04T12:30:00.000Z",
    ...overrides,
  };
}

function makeFlags(overrides: Partial<EngineV3Flags> = {}): EngineV3Flags {
  return {
    businessId: "biz-1",
    enabled: true,
    surfaceVisible: true,
    shadowOnly: false,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "business_override",
      shadowOnly: "business_override",
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: false,
      shadowOnly: true,
    },
    ...overrides,
  };
}

function renderGrid({
  rows = [makeRow()],
  v3Decisions = null,
  v3Flags = makeFlags(),
}: {
  rows?: MetaCreativeRow[];
  v3Decisions?: DecisionOutput[] | null;
  v3Flags?: EngineV3Flags | null;
} = {}) {
  return renderToStaticMarkup(
    <CreativesTopGrid
      rows={rows}
      selectedIds={[]}
      onToggleSelect={vi.fn()}
      onOpenRow={vi.fn()}
      v3Decisions={v3Decisions}
      v3Flags={v3Flags}
    />,
  );
}

function badgeCount(html: string): number {
  return (html.match(/data-testid="creative-decision-label-badge"/g) ?? []).length;
}

describe("CreativesTopGrid", () => {
  it("renders cards without badges when v3Decisions is null", () => {
    const html = renderGrid({ v3Decisions: null });

    expect(badgeCount(html)).toBe(0);
  });

  it("renders cards without badges when v3Flags.surfaceVisible is false", () => {
    const html = renderGrid({
      v3Decisions: [makeDecision()],
      v3Flags: makeFlags({ surfaceVisible: false }),
    });

    expect(badgeCount(html)).toBe(0);
  });

  it("renders cards without badges when v3Flags.enabled is false", () => {
    const html = renderGrid({
      v3Decisions: [makeDecision()],
      v3Flags: makeFlags({ enabled: false }),
    });

    expect(badgeCount(html)).toBe(0);
  });

  it("renders a matching label badge when v3Decisions match row ids", () => {
    const html = renderGrid({
      rows: [makeRow({ id: "cr_scale", creativeId: "cr_scale", name: "Winner" })],
      v3Decisions: [makeDecision({ creativeId: "cr_scale", label: "scale" })],
    });

    expect(badgeCount(html)).toBe(1);
    expect(html).toContain(">Scale<");
  });

  it("renders no badge for a card without a matching decision while siblings with matches do", () => {
    const html = renderGrid({
      rows: [
        makeRow({ id: "cr_refresh", creativeId: "cr_refresh", name: "Refresh row" }),
        makeRow({ id: "cr_missing", creativeId: "cr_missing", name: "No decision row" }),
      ],
      v3Decisions: [makeDecision({ creativeId: "cr_refresh", label: "refresh" })],
    });

    expect(badgeCount(html)).toBe(1);
    expect(html).toContain(">Refresh<");
  });
});
