import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: ({
    name,
    assetFallbacks,
  }: {
    name: string;
    assetFallbacks?: Array<string | null | undefined>;
  }) => (
    <div data-testid="studio-real-media" data-fallbacks={(assetFallbacks ?? []).filter(Boolean).join("|")}>
      media:{name}
    </div>
  ),
}));

const {
  STUDIO_KPI_PRESETS,
  STUDIO_MORE_LINKS,
  STUDIO_ROW_PAGE_SIZES,
  StudioOsView,
  filterStudioUsageRows,
  resolveStudioSelectedRows,
} = await import("./StudioOsView");

function row(overrides: Partial<MetaCreativeRow> = {}): MetaCreativeRow {
  return {
    id: "row_1",
    creativeId: "creative_1",
    realAdId: "ad_1",
    name: "Studio asset",
    associatedAdsCount: 2,
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
    metricsAvailability: "available",
    spend: 250,
    purchaseValue: 900,
    roas: 3.6,
    cpa: 25,
    cpcLink: 1.5,
    cpm: 12,
    ctrAll: 2,
    linkCtr: 1.5,
    purchases: 10,
    impressions: 10_000,
    clicks: 300,
    frequency: 1.8,
    linkClicks: 150,
    landingPageViews: 100,
    addToCart: 30,
    initiateCheckout: 20,
    leads: 8,
    messages: 4,
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

type ServedCreativeDecision = NonNullable<BriefingCreativeCard["decisionCenterRow"]>;

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
    buyerLabel: "Move to winners",
    uiBucket: "scale",
    confidenceBand: "high",
    priority: "high",
    oneLine: "Server evidence",
    reasons: [],
    nextStep: "Open Decisions",
    missingData: [],
  };
}

function card(): BriefingCreativeCard {
  return {
    id: "row_1",
    creativeId: "creative_1",
    creativeName: "Studio asset",
    providerAccountId: "act_1",
    campaignName: "Prospecting",
    truthSource: "commercial_truth",
    thresholdQuality: "ready",
    engineVersion: "v3-studio",
    sourceAsOf: "2026-07-10",
    sourceDataSource: "warehouse",
    decisionCenterRow: decisionRow(),
  };
}

function assessedCard(): BriefingCreativeCard {
  return {
    ...card(),
    assessment: {
      value: "proven_winner",
      label: "Proven winner",
      tone: "pos",
      blockerCode: null,
      vocabularyVersion: "meta-decisions-classification-overlay.v2",
    },
  };
}

function decisions(killSwitchEngaged: boolean): React.ComponentProps<typeof StudioOsView>["decisions"] {
  return {
    system: { killSwitchEngaged, snapshotHealth: { status: "fresh" } },
  };
}

function renderStudio(overrides: Partial<React.ComponentProps<typeof StudioOsView>> = {}): string {
  return renderToStaticMarkup(
    <StudioOsView
      allRows={[row()]}
      briefingCards={[card()]}
      creativeBriefs={[]}
      creativeBriefsState="ready"
      defaultCurrency="EUR"
      account={{ name: "Account", id: "act_1", currency: "EUR" }}
      providerAccounts={[{ id: "act_1", name: "Account", currency: "EUR" }]}
      providerAccountId="act_1"
      accountsLoading={false}
      onSelectAccount={vi.fn()}
      dateRangeLabel="Last 30 days"
      dateStart="2026-06-11"
      dateEnd="2026-07-10"
      windowLabel="30d"
      freshnessLabel="updated today"
      engineVersion="v3-studio"
      dataSource="warehouse"
      groupBy="creative"
      onGroupByChange={vi.fn()}
      datePresets={[
        {
          key: "last30",
          label: "Last 30 days",
          value: { preset: "last30Days", customStart: "", customEnd: "", lastDays: 30, sinceDate: "" },
        },
      ]}
      currentDatePresetKey="last30"
      onDatePreset={vi.fn()}
      activeTab="assets"
      selectedRowIds={[]}
      onToggleRow={vi.fn()}
      onClearSelection={vi.fn()}
      loadUsageRows={vi.fn().mockResolvedValue([])}
      rowsState="ready"
      rowsError={null}
      briefingState="ready"
      briefingError={null}
      decisionsHref="/platforms/meta"
      launchpadHref="/platforms/meta/launchpad"
      automationHref="/platforms/meta/automation"
      onEditBrief={vi.fn()}
      onNewBrief={vi.fn()}
      onOpenGrant={vi.fn()}
      decisions={decisions(false)}
      decisionsState="ready"
      {...overrides}
    />,
  );
}

describe("StudioOsView bounded Studio contract", () => {
  it("renders one responsive read-only Studio surface without the fake mobile execution simulator", () => {
    const html = renderStudio();

    expect(html).toContain('data-responsive-studio="true"');
    expect(html).toContain('data-provider-writes="none"');
    expect(html).toContain('aria-label="Meta ad account for Creative Studio"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("1 creative");
    expect(html).toContain("Select creatives from the table to compare them here.");
    expect(html).toContain('href="/platforms/meta/automation"');
    expect(html).toContain('data-readonly="true"');
    expect(html).not.toContain("Mobile · Decisions");
    expect(html).not.toContain("Run preflight");
    expect(html).not.toContain("Confirm Pause");
    expect(html).not.toContain("Verified — provider confirmed");
    expect(html).not.toContain("Continue on desktop");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).toContain("bottom:0!important");
    expect(html).not.toContain("bottom:54px!important");
  });

  it("exposes only the supported Studio navigation, KPI presets, and row sizes", () => {
    expect(STUDIO_MORE_LINKS.map(({ label, href }) => ({ label, href }))).toEqual([
      { label: "Copy", href: "/platforms/meta/copies" },
      { label: "Landing Pages", href: "/platforms/meta/landing-pages" },
      { label: "Inbox", href: "/platforms/meta/creative-inbox" },
      { label: "Audiences", href: "/platforms/meta/audiences" },
    ]);
    expect(STUDIO_KPI_PRESETS.map(({ label }) => label)).toEqual(["Ecommerce", "Lead Gen", "Creative"]);
    expect(STUDIO_KPI_PRESETS.find(({ label }) => label === "Lead Gen")?.cols).toEqual(
      expect.arrayContaining(["leads", "messages", "costPerLead", "costPerMessage"]),
    );
    expect(STUDIO_ROW_PAGE_SIZES).toEqual([20, 50, 100]);

    const html = renderStudio();
    expect(html).toContain("Performance");
    expect(html).toContain("Winners");
    expect(html).toContain("Briefs");
    expect(html).toContain("Shares");
    expect(html).toContain("Ecommerce");
    expect(html).toContain("Optimization");
    expect(html).toContain("Lifecycle role");
  });

  it("preserves selected rows from all rows when the current filter excludes them", () => {
    const visible = row({ id: "visible", creativeId: "creative_visible", name: "Visible" });
    const outside = row({ id: "outside", creativeId: "creative_outside", name: "Outside" });

    expect(resolveStudioSelectedRows([visible, outside], ["outside"], [visible])).toEqual([
      { row: outside, outsideCurrentFilter: true },
    ]);
    expect(resolveStudioSelectedRows([visible, outside], ["visible"], [visible])).toEqual([
      { row: visible, outsideCurrentFilter: false },
    ]);
  });

  it("keeps usage rows inside the selected account, creative, and exact-ad grain", () => {
    const exact = row({ id: "exact", realAdId: "ad_exact" });
    const otherCreative = row({ id: "other_creative", creativeId: "creative_2" });
    const otherAccount = row({ id: "other_account", accountId: "act_2" });
    const aggregateOnly = row({ id: "aggregate", realAdId: null });

    expect(
      filterStudioUsageRows(
        [exact, otherCreative, otherAccount, aggregateOnly],
        "creative_1",
        "act_1",
      ),
    ).toEqual([exact]);
  });

  it("passes real row media through and keeps server action separate from server assessment", () => {
    const html = renderStudio({
      briefingCards: [assessedCard()],
      selectedRowIds: ["row_1"],
    });

    expect(html).toContain("media:Studio asset");
    expect(html).toContain("https://example.com/table.jpg");
    expect(html).toContain("Move to winners");
    expect(html).toContain('data-studio-assessment="Proven winner"');
    expect(html).toContain("Proven winner");
    expect(html).toContain('data-performance-tint="hybrid"');
  });

  it("shows account-stop authority as a read-only Automation link", () => {
    const html = renderStudio({ decisions: decisions(true) });

    expect(html).toContain("Business STOP engaged");
    expect(html).not.toContain("Account stop");
    expect(html).toContain("Review in Automation");
    expect(html).toContain('href="/platforms/meta/automation"');
    expect(html).not.toContain("Release account stop");
  });

  it("shows decision-context failures instead of silently rendering unavailable assessments", () => {
    const html = renderStudio({
      briefingState: "error",
      briefingError: "Account-scoped decision context failed.",
    });

    expect(html).toContain('data-testid="studio-decision-context-error"');
    expect(html).toContain("Account-scoped decision context failed.");
  });
});
