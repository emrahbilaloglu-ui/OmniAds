import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
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
  it("renders filter chrome, search, sort, view toggle, and wrapped table rows", () => {
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

    expect(html).toContain("Asset Library");
    expect(html).toContain("Status");
    expect(html).toContain("Format");
    expect(html).toContain("Engine v3 label");
    expect(html).toContain("Badge");
    expect(html).toContain("Search creatives, campaigns, tags");
    expect(html).toContain("Sort: spend");
    expect(html).toContain("aria-label=\"Grid view\"");
    expect(html).toContain("data-mocked-creatives-table");
    expect(html).toContain("Aphrodite Hook");
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
        search: "loser",
        sort: "spend_desc",
      }).map((item) => item.id),
    ).toEqual(["cut"]);
    expect(sortAssetLibraryRows(rows, "roas_asc").map((item) => item.id)).toEqual(["cut", "video", "scale"]);
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
        search: "",
        sort: "spend_desc",
      }).map((item) => item.id),
    ).toEqual(["malformed"]);
    expect(sortAssetLibraryRows([malformed], "name_asc")).toHaveLength(1);
    expect(sortAssetLibraryRows([malformed], "launch_desc")).toHaveLength(1);
  });

  it("exposes count summary and view persistence key", () => {
    expect(assetLibraryCountSummary(2, 8)).toBe("Showing 2 of 2 (filtered from 8)");
    expect(ASSET_LIBRARY_VIEW_STORAGE_KEY).toBe("creatives-briefing-asset-library-view");
  });
});
