// @vitest-environment jsdom

import React, { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  LaunchpadAddToExistingTarget,
  makeDefaultAddToExistingTargetState,
  type LaunchpadAddToExistingState,
  type LaunchpadExistingAdSet,
  type LaunchpadExistingCampaign,
} from "@/components/launchpad/LaunchpadAddToExistingTarget";

/**
 * What a verified handoff's campaign / ad-set ids are allowed to do here.
 *
 * A Scale decision authorizes `add_to_existing`, and the campaign and ad set it
 * is duplicating INTO are exactly what made that workflow useful — without them
 * the operator lands on a full account list and has to find the target again by
 * hand, which is indistinguishable from the handoff doing nothing.
 *
 * But an id is not a target. Every assertion below is about the same law: the
 * selection is built by FILTERING the account-scoped list this component
 * actually loaded, never by constructing a target row out of the id. So an id
 * this account does not own selects NOTHING — no fabricated campaign name, no
 * phantom ad set — and an operator who has already chosen is never overwritten.
 */

afterEach(cleanup);

const campaignOne: LaunchpadExistingCampaign = {
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

const campaignTwo: LaunchpadExistingCampaign = {
  ...campaignOne,
  id: "cmp_2",
  name: "Retargeting Campaign",
};

const adsetOne: LaunchpadExistingAdSet = {
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
  attributionSpec: [],
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

const adsetTwo: LaunchpadExistingAdSet = {
  ...adsetOne,
  id: "adset_2",
  name: "Retargeting Warm",
};

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
  } as unknown as MetaCreativeRow;
}

/**
 * A controlled host, because the preselect is a real state transition: the
 * component asks its parent to change, and only then can the ad-set level see a
 * selected campaign. A `vi.fn()` onChange would stop the chain after one step
 * and prove only half the law.
 */
function Host(props: {
  initial?: LaunchpadAddToExistingState;
  preselectedCampaignIds?: readonly string[];
  preselectedAdsetIds?: readonly string[];
  campaigns?: LaunchpadExistingCampaign[];
  adsets?: LaunchpadExistingAdSet[];
  onValue?: (value: LaunchpadAddToExistingState) => void;
}) {
  const [value, setValue] = useState<LaunchpadAddToExistingState>(
    props.initial ?? makeDefaultAddToExistingTargetState(),
  );
  return (
    <LaunchpadAddToExistingTarget
      businessId="biz"
      providerAccountId="act_1"
      value={value}
      selectedCreatives={[creative()]}
      campaignOptions={props.campaigns ?? [campaignOne, campaignTwo]}
      adsetOptions={props.adsets ?? [adsetOne, adsetTwo]}
      preselectedCampaignIds={props.preselectedCampaignIds}
      preselectedAdsetIds={props.preselectedAdsetIds}
      onChange={(next) => {
        setValue(next);
        props.onValue?.(next);
      }}
    />
  );
}

describe("LaunchpadAddToExistingTarget · verified handoff preselection", () => {
  it("selects the campaign and ad set the handoff names, from the loaded list", async () => {
    const seen: LaunchpadAddToExistingState[] = [];
    render(
      <Host
        preselectedCampaignIds={["cmp_2"]}
        preselectedAdsetIds={["adset_2"]}
        onValue={(value) => seen.push(value)}
      />,
    );

    await waitFor(() => {
      const latest = seen[seen.length - 1];
      expect(latest?.targetCampaigns?.map((c) => c.id)).toEqual(["cmp_2"]);
      expect(latest?.targetAdsetsByCampaignId?.cmp_2?.id).toBe("adset_2");
    });
    // The name comes from the account's own list, never from the id.
    expect(seen[seen.length - 1]?.targetCampaign?.name).toBe(
      "Retargeting Campaign",
    );
    expect(await screen.findByText("Retargeting Warm")).toBeTruthy();
  });

  /**
   * The fail-closed half. A handoff can name a campaign that has since been
   * deleted, archived, or moved to another ad account — and the id is all the
   * record has. Constructing a target from it would put a campaign on screen
   * that this account does not own and that the launch would fail against at
   * Create time.
   */
  it("selects nothing for a campaign this account does not own", async () => {
    const seen: LaunchpadAddToExistingState[] = [];
    render(
      <Host
        preselectedCampaignIds={["cmp_from_another_account"]}
        preselectedAdsetIds={["adset_1"]}
        onValue={(value) => seen.push(value)}
      />,
    );

    // Give every effect a chance to run before concluding nothing happened.
    await screen.findByText("Sales Campaign");
    expect(seen).toHaveLength(0);
  });

  it("selects no ad set when the named one is not in the campaign's own list", async () => {
    const seen: LaunchpadAddToExistingState[] = [];
    render(
      <Host
        preselectedCampaignIds={["cmp_1"]}
        preselectedAdsetIds={["adset_from_another_campaign"]}
        onValue={(value) => seen.push(value)}
      />,
    );

    await waitFor(() => {
      expect(seen[seen.length - 1]?.targetCampaigns?.map((c) => c.id)).toEqual([
        "cmp_1",
      ]);
    });
    // The campaign is honoured; the unmatched ad set is simply not selected.
    await waitFor(() => {
      const latest = seen[seen.length - 1];
      expect(latest?.targetAdsetsByCampaignId?.cmp_1 ?? null).toBeNull();
    });
  });

  // A prefill may never overwrite a choice the operator has already made.
  it("leaves an existing selection alone", async () => {
    const seen: LaunchpadAddToExistingState[] = [];
    render(
      <Host
        initial={{
          targetCampaign: campaignOne,
          targetAdset: adsetOne,
          targetCampaigns: [campaignOne],
          targetAdsetsByCampaignId: { cmp_1: adsetOne },
          copyMode: "reuse_creative",
          nameOverrides: {},
        }}
        preselectedCampaignIds={["cmp_2"]}
        onValue={(value) => seen.push(value)}
      />,
    );

    // The already-chosen campaign renders in both the picker and the selected
    // summary, so this waits on the list rather than on a unique node.
    await waitFor(() =>
      expect(screen.getAllByText("Sales Campaign").length).toBeGreaterThan(0),
    );
    expect(seen).toHaveLength(0);
  });

  it("does nothing at all when no handoff named anything", async () => {
    const seen: LaunchpadAddToExistingState[] = [];
    render(<Host onValue={(value) => seen.push(value)} />);

    await screen.findByText("Sales Campaign");
    expect(seen).toHaveLength(0);
  });
});
