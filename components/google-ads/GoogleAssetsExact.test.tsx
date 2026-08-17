import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GoogleAssetsExact } from "@/components/google-ads/GoogleAssetsExact";
import {
  buildGoogleAssetsExactViewModel,
  type GoogleAssetsExactInput,
  type GoogleAssetsExactTab,
} from "@/components/google-ads/google-assets-exact-adapter";
import type {
  AssetGroupRow,
  AssetRow,
  AudienceRow,
} from "@/components/google-ads/google-ads-dashboard-support";

const source = readFileSync("components/google-ads/GoogleAssetsExact.tsx", "utf8");
const stylesheet = readFileSync(
  "components/google-ads/GoogleAssetsPlanExact.module.css",
  "utf8",
);

const assetGroups: AssetGroupRow[] = [
  {
    id: "ag_1",
    campaign: "PMax — Evergreen",
    name: "Best sellers — US",
    spend: 8120,
    revenue: 33_290,
    roas: 4.1,
    conversionRate: 0,
    coverageScore: 90,
    adStrength: "Excellent",
    searchThemes: [],
    searchThemeCount: 0,
    searchThemeAlignedCount: 0,
  },
];

const assets: AssetRow[] = [
  {
    id: "as_1",
    type: "Headline",
    assetText: "Carry less. Go further.",
    performanceLabel: "top",
    impressions: 412_000,
    spend: 0,
    conversions: 0,
    roas: 0,
  },
  {
    id: "im_1",
    type: "Image",
    impressions: 100,
    preview: null,
    spend: 0,
    conversions: 0,
    roas: 0,
  },
];

const audiences: AudienceRow[] = [
  {
    criterionId: "9001",
    name: "9001",
    type: "Remarketing",
    spend: 2932.8,
    revenue: 18_212,
    conversions: 312,
    roas: 6.21,
    cpa: 9.4,
  },
];

function render(tab: GoogleAssetsExactTab, overrides: Partial<GoogleAssetsExactInput> = {}) {
  const model = buildGoogleAssetsExactViewModel({
    identity: {
      accountId: "4931182201",
      currencyCode: "USD",
      windowLabel: "28d",
      syncLabel: "Synced 26m ago",
    },
    tab,
    assetGroups,
    assets,
    audiences,
    roasTarget: 3.8,
    queuedRestructures: ["Clearance — slow movers"],
    ...overrides,
  });
  return renderToStaticMarkup(
    React.createElement(GoogleAssetsExact, { model, syncTone: "positive" }),
  );
}

describe("GoogleAssetsExact structure", () => {
  it("opens on the canonical head", () => {
    const markup = render("groups");
    expect(markup).toContain('data-screen-label="Google Ads · Assets &amp; Audiences"');
    expect(markup).toContain("Google Ads · 4931182201 · USD · 28d window");
    expect(markup).toContain("Assets &amp; Audiences");
    expect(markup).toContain("writes guarded · receipt on every change");
    expect(markup).toContain("Synced 26m ago");
  });

  it("renders the reference's three tab captions with the solid dark active pill", () => {
    const markup = render("groups");
    expect(markup).toContain("Asset groups");
    expect(markup).toContain("Text &amp; image assets");
    expect(markup).toContain("Audiences");
    // The active pill is the reference's #0B1020 fill, not the pale accent tint.
    expect(stylesheet).toContain("background: #0b1020;");
    const active = markup.match(/data-google-asset-tab="groups"[^>]*class="([^"]+)"/);
    expect(active?.[1]).toContain("tabPillActive");
  });

  it("shows the asset-group table's six headers in order", () => {
    const headers = Array.from(
      render("groups").matchAll(/<th[^>]*>([^<]+)<\/th>/g),
    ).map((match) => match[1]);
    expect(headers).toEqual([
      "Asset group",
      "Campaign",
      "Spend",
      "Conv value",
      "ROAS",
      "Ad strength",
    ]);
  });

  it("shows the audience table's six headers in order", () => {
    const headers = Array.from(
      render("audiences").matchAll(/<th[^>]*>([^<]+)<\/th>/g),
    ).map((match) => match[1]);
    expect(headers).toEqual(["Audience", "Type", "Size", "Conv", "CPA", "ROAS"]);
  });

  it("carries the reference's card captions verbatim", () => {
    expect(render("groups")).toContain(
      "Performance Max · ad strength is Google-served",
    );
    const assetsMarkup = render("assets");
    expect(assetsMarkup).toContain("ratings are Google-served · refreshed each sync");
    expect(assetsMarkup).toContain("impression share");
    expect(assetsMarkup).toContain(
      "Thumbnails render from synced assets — drop real exports to replace",
    );
    const audiencesMarkup = render("audiences");
    expect(audiencesMarkup).toContain(
      "observation + targeting · lists sync from Shopify segments",
    );
    expect(audiencesMarkup).toContain(
      "Attach or detach applies from the Plan page as a guarded write — this",
    );
  });

  it("renders only the selected surface — no radar, no asset-read panel", () => {
    const groups = render("groups");
    expect(groups).toContain('data-google-asset-groups="true"');
    expect(groups).not.toContain('data-google-text-assets="true"');
    expect(groups).not.toContain('data-google-audiences="true"');

    const assetsMarkup = render("assets");
    expect(assetsMarkup).toContain('data-google-text-assets="true"');
    expect(assetsMarkup).toContain('data-google-image-assets="true"');
    expect(assetsMarkup).not.toContain('data-google-asset-groups="true"');

    const audiencesMarkup = render("audiences");
    expect(audiencesMarkup).toContain('data-google-audiences="true"');
    expect(audiencesMarkup).not.toContain('data-google-asset-groups="true"');

    for (const markup of [groups, assetsMarkup, audiencesMarkup]) {
      expect(markup).not.toContain("Asset Performance Radar");
      expect(markup).not.toContain("Asset read");
      expect(markup).not.toContain("Underperforming");
      expect(markup).not.toContain("Total assets");
    }
  });

  it("draws no account-scope banner or native select", () => {
    for (const tab of ["groups", "assets", "audiences"] as const) {
      const markup = render(tab);
      expect(markup).not.toContain("<select");
      expect(markup).not.toContain("Blended view");
      expect(markup).not.toContain('role="status"');
    }
  });

  it("keeps every column shell when nothing is served, printing the em dash", () => {
    const markup = render("audiences", {
      identity: {},
      assetGroups: null,
      assets: null,
      audiences: [
        {
          criterionId: "9002",
          type: "Affinity",
          spend: 0,
          conversions: 0,
          roas: 0,
        },
      ],
      roasTarget: null,
      queuedRestructures: [],
    });
    const headers = Array.from(markup.matchAll(/<th[^>]*>([^<]+)<\/th>/g)).map(
      (match) => match[1],
    );
    expect(headers).toHaveLength(6);
    expect(markup).toContain("—");
  });

  it("names the advisor's queued restructure under the asset-group table", () => {
    expect(render("groups")).toContain("Clearance — slow movers");
    // With none queued the line keeps its geometry and prints the em dash.
    expect(render("groups", { queuedRestructures: [] })).toMatch(
      /<p class="[^"]*footnote[^"]*">—<\/p>/,
    );
  });

  it("carries no styling of its own outside the stylesheet", () => {
    expect(source).not.toMatch(/style=\{\{/);
    expect(source).not.toMatch(/className="[a-z-]*(?:flex|grid|px-|py-|text-\[)/);
  });
});
