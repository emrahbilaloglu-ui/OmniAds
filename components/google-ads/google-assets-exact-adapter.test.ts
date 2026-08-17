import { describe, expect, it } from "vitest";

import type {
  AssetGroupRow,
  AssetRow,
  AudienceRow,
} from "@/components/google-ads/google-ads-dashboard-support";
import {
  buildGoogleAssetsExactViewModel,
  googleAssetGroupQueueNote,
  googleAssetPerformanceView,
  googleAssetStrengthTone,
  GOOGLE_ASSETS_EXACT_TABS,
} from "@/components/google-ads/google-assets-exact-adapter";

const identity = {
  accountId: "4931182201",
  currencyCode: "USD",
  windowLabel: "28d",
  syncLabel: "Synced 26m ago",
};

function assetGroup(overrides: Partial<AssetGroupRow> = {}): AssetGroupRow {
  return {
    id: "ag_1",
    campaign: "PMax — Evergreen",
    name: "Best sellers — US",
    spend: 8120,
    revenue: 33_290,
    roas: 4.1,
    conversionRate: 0,
    coverageScore: 80,
    adStrength: "Excellent",
    searchThemes: [],
    searchThemeCount: 0,
    searchThemeAlignedCount: 0,
    ...overrides,
  };
}

function asset(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "as_1",
    type: "Headline",
    assetText: "Carry less. Go further.",
    performanceLabel: "top",
    impressions: 412_000,
    spend: 0,
    conversions: 0,
    roas: 0,
    ...overrides,
  };
}

function audience(overrides: Partial<AudienceRow> = {}): AudienceRow {
  return {
    criterionId: "9001",
    name: "9001",
    type: "Remarketing",
    spend: 2932.8,
    revenue: 18_212,
    conversions: 312,
    roas: 6.21,
    cpa: 9.4,
    ...overrides,
  };
}

function build(overrides: Parameters<typeof buildGoogleAssetsExactViewModel>[0]) {
  return buildGoogleAssetsExactViewModel(overrides);
}

describe("buildGoogleAssetsExactViewModel", () => {
  it("names the account, currency and window in the reference's four segments", () => {
    const model = build({
      identity,
      tab: "groups",
      assetGroups: [],
      assets: [],
      audiences: [],
      roasTarget: 3.8,
    });
    expect(model.eyebrow).toBe("Google Ads · 4931182201 · USD · 28d window");
    expect(model.syncLabel).toBe("Synced 26m ago");
  });

  it("prints the em dash for every identity segment the read did not serve", () => {
    const model = build({
      tab: "groups",
      assetGroups: null,
      assets: null,
      audiences: null,
      roasTarget: null,
    });
    expect(model.eyebrow).toBe("Google Ads · — · — · — window");
    expect(model.syncLabel).toBe("—");
  });

  it("carries the reference's three tab captions in order", () => {
    const model = build({
      tab: "assets",
      assetGroups: null,
      assets: null,
      audiences: null,
      roasTarget: null,
    });
    expect(model.tabs.map((tab) => tab.label)).toEqual([
      "Asset groups",
      "Text & image assets",
      "Audiences",
    ]);
    expect(model.tabs.filter((tab) => tab.active).map((tab) => tab.key)).toEqual([
      "assets",
    ]);
    expect(GOOGLE_ASSETS_EXACT_TABS).toHaveLength(3);
  });

  it("maps served asset-group columns and keeps Google's own ad-strength word", () => {
    const model = build({
      identity,
      tab: "groups",
      assetGroups: [assetGroup()],
      assets: null,
      audiences: null,
      roasTarget: 3.8,
    });
    expect(model.groupRows).toEqual([
      {
        key: "ag_1",
        name: "Best sellers — US",
        campaign: "PMax — Evergreen",
        spend: "$8,120",
        value: "$33,290",
        roas: "4.10",
        roasTone: "positive",
        strength: "Excellent",
        strengthTone: "positive",
      },
    ]);
  });

  it("prints the em dash rather than a verdict when ad strength is unread", () => {
    const model = build({
      identity,
      tab: "groups",
      assetGroups: [assetGroup({ adStrength: null, roas: 0 })],
      assets: null,
      audiences: null,
      roasTarget: 3.8,
    });
    expect(model.groupRows[0]?.strength).toBe("—");
    expect(model.groupRows[0]?.strengthTone).toBe("unserved");
    expect(model.groupRows[0]?.roas).toBe("—");
    expect(model.groupRows[0]?.roasTone).toBe("unserved");
  });

  it("tones ad strength the reference's way and leaves red unused", () => {
    expect(googleAssetStrengthTone("Excellent")).toBe("positive");
    expect(googleAssetStrengthTone("Good")).toBe("info");
    expect(googleAssetStrengthTone("Average")).toBe("auto");
    expect(googleAssetStrengthTone("Pending")).toBe("auto");
    expect(googleAssetStrengthTone("Poor")).toBe("warning");
    expect(googleAssetStrengthTone("No ads")).toBe("warning");
    for (const value of ["Excellent", "Good", "Average", "Pending", "Poor", "No ads"]) {
      expect(googleAssetStrengthTone(value)).not.toBe("negative");
    }
  });

  it("gives the four performance chips the reference's four tones", () => {
    expect(googleAssetPerformanceView("top")).toEqual({
      label: "Best",
      tone: "positive",
    });
    expect(googleAssetPerformanceView("average")).toEqual({
      label: "Good",
      tone: "info",
    });
    expect(googleAssetPerformanceView("underperforming")).toEqual({
      label: "Low",
      tone: "warning",
    });
    expect(googleAssetPerformanceView("learning")).toEqual({
      label: "Learning",
      tone: "auto",
    });
    expect(googleAssetPerformanceView(null)).toEqual({
      label: "—",
      tone: "unserved",
    });
  });

  it("splits headlines and descriptions from images and shares impressions", () => {
    const model = build({
      identity,
      tab: "assets",
      assetGroups: null,
      assets: [
        asset(),
        asset({
          id: "as_2",
          type: "Description",
          assetText: "Free 60-day returns on every order",
          performanceLabel: "average",
          impressions: 241_000,
        }),
        asset({ id: "im_1", type: "Image", impressions: 75, preview: "https://x/1.png" }),
        asset({ id: "im_2", type: "Image", impressions: 25, preview: "no-url" }),
        asset({ id: "vd_1", type: "Video", impressions: 10 }),
      ],
      audiences: null,
      roasTarget: 3.8,
    });

    expect(model.textRows.map((row) => row.kind)).toEqual([
      "Headline",
      "Description",
    ]);
    expect(model.textRows[0]).toMatchObject({
      text: "Carry less. Go further.",
      impressions: "412,000 impr",
      performance: "Best",
    });
    expect(model.imageRows).toEqual([
      {
        key: "im_1",
        imageUrl: "https://x/1.png",
        swatch: 0,
        share: "75%",
        label: "Carry less. Go further.",
      },
      {
        key: "im_2",
        imageUrl: null,
        swatch: 1,
        share: "25%",
        label: "Carry less. Go further.",
      },
    ]);
  });

  it("prints the em dash for image share when nothing took an impression", () => {
    const model = build({
      identity,
      tab: "assets",
      assetGroups: null,
      assets: [asset({ id: "im_1", type: "Image", impressions: 0 })],
      audiences: null,
      roasTarget: null,
    });
    expect(model.imageRows[0]?.share).toBe("—");
  });

  it("keeps the audience Size cell and prints the em dash the read cannot fill", () => {
    const model = build({
      identity,
      tab: "audiences",
      assetGroups: null,
      assets: null,
      audiences: [audience()],
      roasTarget: 3.8,
    });
    expect(model.audienceRows).toEqual([
      {
        key: "9001",
        name: "9001",
        type: "Remarketing",
        size: "—",
        conversions: "312",
        cpa: "$9.40",
        roas: "6.21",
        roasTone: "positive",
      },
    ]);
  });

  it("derives CPA from served spend and conversions when the report omits it", () => {
    const model = build({
      identity,
      tab: "audiences",
      assetGroups: null,
      assets: null,
      audiences: [audience({ cpa: undefined, spend: 100, conversions: 4 })],
      roasTarget: 3.8,
    });
    expect(model.audienceRows[0]?.cpa).toBe("$25.00");
  });

  it("names the advisor's queued restructures, and the em dash when it names none", () => {
    expect(googleAssetGroupQueueNote(["Clearance — slow movers"])).toBe(
      "The advisor has 1 restructure queued for “Clearance — slow movers” — see Advisor · Do next.",
    );
    expect(googleAssetGroupQueueNote(["A", "B"])).toBe(
      "The advisor has 2 restructures queued for “A” and “B” — see Advisor · Do next.",
    );
    expect(googleAssetGroupQueueNote([])).toBe("—");

    const model = build({
      identity,
      tab: "groups",
      assetGroups: [],
      assets: null,
      audiences: null,
      roasTarget: null,
      queuedRestructures: ["Clearance — slow movers"],
    });
    expect(model.groupNote).toContain("Clearance — slow movers");
  });
});
