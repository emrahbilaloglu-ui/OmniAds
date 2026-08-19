import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  fetchLaunchpadCampaignAdsets,
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

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

describe("LaunchpadAddToExistingTarget", () => {
  it("defaults to the receipt-complete clone path", () => {
    expect(makeDefaultAddToExistingTargetState().copyMode).toBe(
      "reuse_creative",
    );
  });

  it("waits for campaign selection before rendering ad set pickers", () => {
    const html = renderToStaticMarkup(
      <LaunchpadAddToExistingTarget
        businessId="biz"
        providerAccountId="act_1"
        value={makeDefaultAddToExistingTargetState()}
        selectedCreatives={[creative()]}
        campaignOptions={[campaign]}
        adsetOptions={[]}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("Select campaigns first.");
    expect(html).toContain("0 selected");
  });

  it("renders the selected ad set preview and after-launch count", () => {
    const html = renderToStaticMarkup(
      <LaunchpadAddToExistingTarget
        businessId="biz"
        providerAccountId="act_1"
        value={{ targetCampaign: campaign, targetAdset: adset, copyMode: "rebuild_creative", nameOverrides: {} }}
        selectedCreatives={[creative()]}
        campaignOptions={[campaign]}
        adsetOptions={[adset]}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("Prospecting");
    expect(html).toContain("pixel_1");
    expect(html).toContain("1 creatives -&gt; 10 ads");
    expect(html).toContain("Creative One (added)");
  });

  it("renders multiple selected campaign targets", () => {
    const secondCampaign: LaunchpadExistingCampaign = {
      ...campaign,
      id: "cmp_2",
      name: "Retargeting Campaign",
    };
    const secondAdset: LaunchpadExistingAdSet = {
      ...adset,
      id: "adset_2",
      name: "Retargeting",
      currentAdCount: 3,
      pixelId: "pixel_2",
    };
    const html = renderToStaticMarkup(
      <LaunchpadAddToExistingTarget
        businessId="biz"
        providerAccountId="act_1"
        value={{
          targetCampaign: campaign,
          targetAdset: adset,
          targetCampaigns: [campaign, secondCampaign],
          targetAdsetsByCampaignId: {
            cmp_1: adset,
            cmp_2: secondAdset,
          },
          copyMode: "rebuild_creative",
          nameOverrides: {},
        }}
        selectedCreatives={[creative()]}
        campaignOptions={[campaign, secondCampaign]}
        adsetOptions={[adset, secondAdset]}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("2 selected");
    expect(html).toContain("2 target ad sets");
    expect(html).toContain("2 campaigns");
    expect(html).toContain("1 creatives -&gt; 14 ads");
    expect(html).toContain("Retargeting Campaign");
  });

  it("renders copy mode choices", () => {
    const html = renderToStaticMarkup(
      <LaunchpadAddToExistingTarget
        businessId="biz"
        providerAccountId="act_1"
        value={{ targetCampaign: campaign, targetAdset: adset, copyMode: "reuse_creative", nameOverrides: {} }}
        selectedCreatives={[creative()]}
        campaignOptions={[campaign]}
        adsetOptions={[adset]}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("Creative copy mode");
    expect(html).toContain("Duplicate");
    expect(html).toContain("Recreate exact ad · review-only");
    expect(html).toContain(
      "image, creative, and ad writes each have a durable step receipt",
    );
    expect(html).toContain("disabled");
  });

  it("retries an empty ad set response when the campaign reports active ad sets", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ adsets: [] }))
      .mockResolvedValueOnce(jsonResponse({ adsets: [adset] }));

    const result = await fetchLaunchpadCampaignAdsets({
      businessId: "biz",
      providerAccountId: "act_1",
      campaign: { id: "cmp_1", adsetCount: 1 },
      retryDelaysMs: [0],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.adsets).toEqual([adset]);
    expect(result.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Every launch is written into exactly one ad account, and `meta-validation`
  // refuses a target belonging to any other one at Create time. The target
  // lists must therefore be read account-scoped, or the operator builds a whole
  // launch against a campaign the launch account never owned and only learns it
  // from a Create-time blocker naming an account they never chose.
  it("reads ad sets scoped to the launch account", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ adsets: [adset] }));

    await fetchLaunchpadCampaignAdsets({
      businessId: "biz",
      providerAccountId: "act_1",
      campaign: { id: "cmp_1", adsetCount: 1 },
      retryDelaysMs: [],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "providerAccountId=act_1",
    );
  });

  it("does not cache an empty result as loaded when active ad sets were expected", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ adsets: [] })));

    const result = await fetchLaunchpadCampaignAdsets({
      businessId: "biz",
      providerAccountId: "act_1",
      campaign: { id: "cmp_1", adsetCount: 1 },
      retryDelaysMs: [0],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.adsets).toEqual([]);
    expect(result.error).toContain("Campaign reported active ad sets");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
