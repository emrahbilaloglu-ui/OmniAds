import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  LaunchpadAddToExistingTarget,
  makeDefaultAddToExistingTargetState,
  type LaunchpadExistingAdSet,
  type LaunchpadExistingCampaign,
} from "@/components/launchpad/LaunchpadAddToExistingTarget";

function creative(): MetaCreativeRow {
  return {
    id: "row_1",
    creativeId: "creative_1",
    name: "Creative One",
    associatedAdsCount: 1,
    accountId: "act_1",
    accountName: "Main",
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
    purchaseValue: 200,
    roas: 2,
    cpa: 10,
    cpcLink: 1,
    cpm: 10,
    ctrAll: 1,
    linkCtr: 1,
    purchases: 5,
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
  };
}

const campaign: LaunchpadExistingCampaign = {
  id: "cmp_1",
  name: "Sales Campaign",
  objective: "OUTCOME_SALES",
  status: "ACTIVE",
  effectiveStatus: "ACTIVE",
  dailyBudgetMinor: 5000,
  lifetimeBudgetMinor: null,
  isAdsetBudgetSharingEnabled: true,
  adsetCount: 2,
  lastSpend28d: 1200,
};

const adset: LaunchpadExistingAdSet = {
  id: "adset_1",
  name: "Prospecting",
  status: "ACTIVE",
  effectiveStatus: "ACTIVE",
  optimizationGoal: "OFFSITE_CONVERSIONS",
  billingEvent: "IMPRESSIONS",
  pixelId: "pixel_1",
  customEventType: "PURCHASE",
  dailyBudgetMinor: 2500,
  lifetimeBudgetMinor: null,
  attributionSpec: [
    { event_type: "CLICK_THROUGH", window_days: 7 },
    { event_type: "VIEW_THROUGH", window_days: 1 },
  ],
  targeting: {
    geoCountries: ["US"],
    ageMin: 18,
    ageMax: 65,
    advantageAudience: true,
    placementSummary: "Advantage+ placements",
  },
  currentAdCount: 9,
  last7dSpend: 300,
  last7dRoas: 2.1,
};

describe("LaunchpadAddToExistingTarget", () => {
  it("disables the ad set picker until a campaign is chosen", () => {
    const html = renderToStaticMarkup(
      <LaunchpadAddToExistingTarget
        businessId="biz"
        value={makeDefaultAddToExistingTargetState()}
        selectedCreatives={[creative()]}
        campaignOptions={[campaign]}
        adsetOptions={[]}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("Choose a campaign first");
    expect(html).toContain("disabled");
  });

  it("renders the selected ad set preview and after-launch count", () => {
    const html = renderToStaticMarkup(
      <LaunchpadAddToExistingTarget
        businessId="biz"
        value={{ targetCampaign: campaign, targetAdset: adset, nameOverrides: {} }}
        selectedCreatives={[creative()]}
        campaignOptions={[campaign]}
        adsetOptions={[adset]}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("Prospecting");
    expect(html).toContain("pixel_1 / PURCHASE");
    expect(html).toContain("1 creatives -&gt; 10 ads");
    expect(html).toContain("Creative One (added)");
  });
});
