import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ASSET_PRESETS,
  ASSET_LIBRARY_VIEW_STORAGE_KEY,
  AssetLibrarySection,
  assetLibraryCountSummary,
  filterAssetLibraryRows,
  sortAssetLibraryRows,
  toggleArrayFilter,
} from "@/components/creatives/briefing/AssetLibrarySection";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

vi.mock("@/components/creatives/CreativesTableSection", () => ({
  CreativesTableSection: ({ rows }: { rows: MetaCreativeRow[] }) => (
    <div data-mocked-creatives-table>
      {rows.map((row) => (
        <span key={row.id}>{row.name}</span>
      ))}
    </div>
  ),
}));

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: (props: { assetFallbacks?: Array<string | null | undefined> }) => (
    <div data-testid="creative-render-surface">
      {(props.assetFallbacks ?? []).filter(Boolean).join("|")}
    </div>
  ),
}));

function row(overrides: Partial<MetaCreativeRow> & Record<string, unknown>): MetaCreativeRow {
  return {
    id: "row_1",
    creativeId: "creative_1",
    name: "Aphrodite Hook",
    associatedAdsCount: 1,
    accountId: "act_1",
    accountName: "TheSwaf",
    campaignName: "ASC",
    adSetName: "Broad",
    effectiveStatus: "ACTIVE",
    currency: "USD",
    format: "image",
    creativeType: "feed",
    creativeTypeLabel: "Feed",
    creativeDeliveryType: "standard",
    creativeVisualFormat: "image",
    creativePrimaryType: "standard",
    creativePrimaryLabel: null,
    creativeSecondaryType: null,
    creativeSecondaryLabel: null,
    thumbnailUrl: null,
    previewUrl: null,
    imageUrl: null,
    isCatalog: false,
    previewState: "unavailable",
    preview: { render_mode: "unavailable", image_url: null, video_url: null, poster_url: null, source: null, is_catalog: false },
    launchDate: "2026-05-01",
    tags: [],
    aiTags: {},
    spend: 100,
    purchaseValue: 300,
    roas: 3,
    cpa: 12,
    cpcLink: 1,
    cpm: 10,
    ctrAll: 1.2,
    linkCtr: 1.1,
    purchases: 10,
    impressions: 1000,
    clicks: 20,
    frequency: 1.2,
    linkClicks: 12,
    landingPageViews: 8,
    addToCart: 4,
    initiateCheckout: 2,
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
  } as MetaCreativeRow;
}

describe("AssetLibrarySection", () => {
  it("renders the preset bar, KPI summary tiles, share view button, and wrapped table rows", () => {
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[row({ name: "Aphrodite Hook" })]}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("preset-bar");
    expect(html).toContain("Customize columns");
    expect(html).toContain("· 2 KPIs");
    expect(html).toContain("creative / campaign / ad set");
    expect(html).toContain("Closed 30d");
    expect(html).toContain("Total Spend");
    expect(html).toContain("asset-table");
    expect(html).toContain("Aphrodite Hook");
  });

  it("recognizes preset-specific KPI selections instead of collapsing every preset to the same metrics", () => {
    const videoPreset = ASSET_PRESETS.find((preset) => preset.id === "video");
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[
          row({
            name: "Video Hook",
            format: "video",
            creativeVisualFormat: "video",
            spend: 120,
            thumbstop: 66,
            video25: 45,
            video50: 28,
            video100: 12,
            ctrAll: 2.5,
          }),
        ]}
        defaultCurrency="USD"
        selectedMetricIds={videoPreset?.metricIds ?? []}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("Facebook Video");
    expect(html).toContain("· 6 KPIs");
    expect(html).toContain("Thumbstop");
    expect(html).toContain("25% views");
    expect(html).not.toContain("Avg CPA");
  });

  it("renders Asset Library thumbnails from optimized media fallbacks", () => {
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[
          row({
            name: "Media Ready",
            tableThumbnailUrl: "https://example.com/table.jpg",
            thumbnailUrl: "https://example.com/thumb.jpg",
            previewState: "preview",
          }),
        ]}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("row-thumb--media");
    expect(html).toContain("https://example.com/table.jpg");
  });

  it("uses canonical creative taxonomy for format labels even when legacy format is image", () => {
    const videoRow = row({
      id: "video-taxonomy",
      name: "Taxonomy Video",
      format: "image",
      creativeVisualFormat: "video",
      creativePrimaryType: "video",
      creativePrimaryLabel: "Video",
      preview: {
        render_mode: "image",
        image_url: "https://example.com/poster.jpg",
        video_url: null,
        poster_url: "https://example.com/poster.jpg",
        source: "thumbnail_url",
        is_catalog: false,
      },
    });
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[videoRow]}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("Taxonomy Video");
    expect(html).toContain(">VID<");
    expect(html).toContain("2026-05-01 · Video");
    expect(
      filterAssetLibraryRows([videoRow], {
        status: "all",
        formats: ["video"],
        labels: [],
        badges: [],
        search: "",
        sort: "spend_desc",
      }).map((item) => item.id),
    ).toEqual(["video-taxonomy"]);
  });

  it("filters rows by chips/search and sorts rows", () => {
    const rows = [
      row({ id: "scale", name: "Scale Winner", spend: 500, roas: 4, engineLabel: "scale", tags: ["fatigue"] }),
      row({ id: "cut", name: "Cut Loser", spend: 900, roas: 0.6, engineLabel: "cut", tags: ["below_breakeven"], effectiveStatus: "PAUSED" }),
      row({ id: "video", name: "Video Test", spend: 100, roas: 2, format: "video", creativeVisualFormat: "video", engineLabel: "test_more" }),
    ];

    expect(toggleArrayFilter(["image"], "video")).toEqual(["image", "video"]);
    expect(toggleArrayFilter(["image", "video"], "image")).toEqual(["video"]);
    expect(
      filterAssetLibraryRows(rows, {
        status: "all",
        formats: [],
        labels: ["cut"],
        badges: ["below_breakeven"],
        campaignLabel: "all",
        search: "loser",
        sort: "spend_desc",
      }).map((item) => item.id),
    ).toEqual(["cut"]);
    expect(sortAssetLibraryRows(rows, "roas_asc").map((item) => item.id)).toEqual(["cut", "video", "scale"]);
  });

  it("renders a clear empty message when no Asset Library rows are available", () => {
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[]}
        emptyMessage="No Meta ad account is assigned to this workspace."
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("0 · 0 sel");
    expect(html).toContain("No Meta ad account is assigned to this workspace.");
    expect(html).toContain("asset-table");
  });

  it("tolerates malformed runtime row fields from live Meta data", () => {
    const malformed = row({
      id: "malformed",
      name: null as never,
      tags: ["Fatigue", null, { label: "ignored" }] as never,
      engineBadges: [null, "Below breakeven"] as never,
      spend: "20" as never,
      roas: "4" as never,
      launchDate: null as never,
    });

    expect(() =>
      filterAssetLibraryRows([malformed], {
        status: "all",
        formats: [],
        labels: [],
        badges: ["fatigue"],
        campaignLabel: "all",
        search: "",
        sort: "spend_desc",
      }),
    ).not.toThrow();
    expect(
      filterAssetLibraryRows([malformed], {
        status: "all",
        formats: [],
        labels: [],
        badges: ["fatigue"],
        campaignLabel: "all",
        search: "",
        sort: "spend_desc",
      }).map((item) => item.id),
    ).toEqual(["malformed"]);
    expect(sortAssetLibraryRows([malformed], "name_asc")).toHaveLength(1);
    expect(sortAssetLibraryRows([malformed], "launch_desc")).toHaveLength(1);
  });

  it("exposes count summary and view persistence key", () => {
    expect(assetLibraryCountSummary(3, 7)).toBe("Showing 3 of 7");
    expect(ASSET_LIBRARY_VIEW_STORAGE_KEY).toBe(
      "creatives-briefing-asset-library-view",
    );
  });
});
