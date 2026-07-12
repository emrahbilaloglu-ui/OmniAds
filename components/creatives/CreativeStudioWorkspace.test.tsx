import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { MetaCreativeBrief } from "@/lib/meta/creative-brief-contract";

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: ({ name }: { name: string }) => <div>preview:{name}</div>,
}));

vi.mock("@/components/creatives/CreativesTableSection", () => ({
  CreativesTableSection: () => <div data-testid="table-mock">table</div>,
}));

const { CreativeStudioWorkspace } = await import("./CreativeStudioWorkspace");

function row(overrides: Partial<MetaCreativeRow> = {}): MetaCreativeRow {
  return {
    id: "row_1",
    creativeId: "creative_1",
    name: "Studio asset",
    associatedAdsCount: 1,
    accountId: "act_1",
    accountName: "Account",
    campaignId: "campaign_1",
    campaignName: "Prospecting",
    adSetId: "adset_1",
    adSetName: "Broad",
    currency: "EUR",
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
    launchDate: "2026-07-01",
    tags: [],
    aiTags: {},
    spend: 250,
    purchaseValue: 900,
    roas: 3.6,
    cpa: 25,
    cpcLink: 1.5,
    cpm: 12,
    ctrAll: 2,
    linkCtr: 1.5,
    purchases: 10,
    impressions: 10000,
    clicks: 300,
    linkClicks: 150,
    landingPageViews: 100,
    addToCart: 30,
    initiateCheckout: 20,
    leads: 0,
    messages: 0,
    thumbstop: 0,
    clickToAddToCart: 20,
    clickToPurchase: 6.67,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    atcToPurchaseRatio: 33.3,
    ...overrides,
  };
}

type ServedCreativeDecision = NonNullable<
  BriefingCreativeCard["decisionCenterRow"]
>;

function decisionRow(): ServedCreativeDecision {
  return {
    scope: "creative",
    creativeId: "creative_1",
    identityGrain: "creative",
    engine: {
      contractVersion: "creative-decision-os.v2.1",
      engineVersion: "v3-studio",
      primaryDecision: "Scale",
      actionability: "review_only",
      problemClass: "performance",
      confidence: 80,
      maturity: "mature",
      priority: "high",
      reasonTags: [],
      evidenceSummary: "Server evidence",
      blockerReasons: [],
      missingData: [],
      queueEligible: false,
      applyEligible: false,
    },
    buyerAction: "scale",
    buyerLabel: "Scale budget",
    uiBucket: "scale",
    confidenceBand: "high",
    priority: "high",
    oneLine: "Server evidence",
    reasons: [],
    nextStep: "Open Decisions",
    missingData: [],
  };
}

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "row_1",
    creativeId: "creative_1",
    creativeName: "Studio asset",
    campaignName: "Prospecting",
    providerAccountId: "act_1",
    truthSource: "commercial_truth",
    thresholdQuality: "ready",
    engineVersion: "v3-studio",
    sourceAsOf: "2026-07-10",
    sourceDataSource: "warehouse",
    decisionCenterRow: decisionRow(),
    ...overrides,
  };
}

function brief(overrides: Partial<MetaCreativeBrief> = {}): MetaCreativeBrief {
  return {
    contractVersion: "meta-creative-brief.v1",
    id: "11111111-1111-4111-8111-111111111111",
    businessId: "biz_1",
    providerAccountId: "act_1",
    sourceDecision: {
      decisionId: "mdd_1",
      snapshotId: "22222222-2222-4222-8222-222222222222",
      creativeId: "creative_1",
      engineVersion: "v3-studio",
      snapshotAsOf: "2026-07-10",
      scopeType: "account",
      scopeId: "*",
      publishedLabel: "refresh",
      rawLabel: "refresh",
      reason: "Server fatigue composite",
      badges: [],
      trigger: "creative_studio_detail",
    },
    content: { keep: "Hook", change: "Pacing", next: "New opening" },
    status: "reviewed",
    version: 2,
    createdBy: "user_1",
    updatedBy: "user_1",
    reviewedBy: "user_1",
    createdAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T11:00:00.000Z",
    reviewedAt: "2026-07-10T11:00:00.000Z",
    ...overrides,
  };
}

function renderWorkspace(overrides: Partial<React.ComponentProps<typeof CreativeStudioWorkspace>> = {}) {
  return renderToStaticMarkup(
    <CreativeStudioWorkspace
      businessId="biz_1"
      rows={[row()]}
      allRowCount={1}
      briefingCards={[card()]}
      briefingSource={{ dataSource: "warehouse", asOf: "2026-07-10" }}
      decisionContextState="ready"
      defaultCurrency="EUR"
      workspaceView="assets"
      assetView="gallery"
      search=""
      formatFilter="all"
      sort="spend"
      selectedRowIds={[]}
      selectedMetricIds={["spend", "roas"]}
      onWorkspaceViewChange={vi.fn()}
      onAssetViewChange={vi.fn()}
      onSearchChange={vi.fn()}
      onFormatFilterChange={vi.fn()}
      onSortChange={vi.fn()}
      onSelectedMetricIdsChange={vi.fn()}
      onToggleRow={vi.fn()}
      onToggleAll={vi.fn()}
      onOpenRow={vi.fn()}
      onSortedRowsChange={vi.fn()}
      onShare={vi.fn()}
      onCsv={vi.fn()}
      onCompare={vi.fn()}
      {...overrides}
      providerAccountId={overrides.providerAccountId ?? "act_1"}
      creativeBriefs={overrides.creativeBriefs ?? []}
      creativeBriefsState={overrides.creativeBriefsState ?? "ready"}
      onCreateBrief={overrides.onCreateBrief ?? vi.fn()}
      onEditBrief={overrides.onEditBrief ?? vi.fn()}
    />,
  );
}

describe("CreativeStudioWorkspace", () => {
  it("defaults to a visual gallery and renders only the server decision badge", () => {
    const html = renderWorkspace();

    expect(html).toContain("data-testid=\"creative-assets-gallery\"");
    expect(html).toContain("preview:Studio asset");
    expect(html).toContain("data-decision-source=\"server\"");
    expect(html).toContain("Scale budget");
    expect(html).toContain("current winner evidence");
    expect(html).not.toContain("data-testid=\"table-mock\"");
  });

  it("bounds a large gallery to 48 rendered assets per page", () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      row({
        id: `row_${index + 1}`,
        creativeId: `creative_${index + 1}`,
        name: `Studio asset ${index + 1}`,
      }),
    );
    const html = renderWorkspace({ rows, allRowCount: rows.length });

    expect(html.match(/preview:Studio asset/g)).toHaveLength(48);
    expect(html).toContain("Showing 1-48 of 100");
    expect(html).toContain("data-testid=\"creative-assets-gallery-pager\"");
    expect(html).not.toContain("preview:Studio asset 49");
  });

  it("keeps a server badge but withholds winner language under global truth", () => {
    const html = renderWorkspace({
      briefingCards: [card({ truthSource: "global_default" })],
    });

    expect(html).toContain("Scale budget");
    expect(html).not.toContain("current winner evidence");
  });

  it("shows historical provenance and the persisted Brief workflow honestly", () => {
    const winnerHtml = renderWorkspace({
      workspaceView: "winner_eras",
      briefingCards: [
        card({
          decisionHistory: [
            { date: "2026-07-01", previousLabel: "keep", currentLabel: "scale" },
          ],
        }),
      ],
    });
    expect(winnerHtml).toContain("Historical events omit per-event engine version");
    expect(winnerHtml).not.toContain("truth-qualified historical winner events");

    const fatigueHtml = renderWorkspace({
      workspaceView: "fatigue_brief",
      briefingCards: [card({ fatigue: true, reason: "Server fatigue composite" })],
    });
    expect(fatigueHtml).toContain("Server fatigue composite");
    expect(fatigueHtml).toContain("meta-creative-brief.v1");
    expect(fatigueHtml).toContain("A matching persisted decision snapshot is required");
    expect(fatigueHtml).toContain("Studio never stores row-level brief variation");
    expect(fatigueHtml).not.toContain("Contract missing");
  });

  it("lists reviewed account-scoped briefs with immutable Launchpad lineage", () => {
    const html = renderWorkspace({
      workspaceView: "fatigue_brief",
      creativeBriefs: [brief()],
    });

    expect(html).toContain("reviewed");
    expect(html).toContain("Launchpad");
    expect(html).toContain("providerAccountId=act_1");
    expect(html).toContain("creativeBriefId=11111111-1111-4111-8111-111111111111");
    expect(html).toContain("sourceDecisionSnapshotId=22222222-2222-4222-8222-222222222222");
  });
});
