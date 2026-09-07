import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LaunchpadAdSets,
  makeDefaultLaunchpadAdSet,
  resetHiddenAdSetBudgetFieldsForMode,
} from "@/components/launchpad/LaunchpadAdSets";
import type { LaunchpadBudgetState } from "@/components/launchpad/LaunchpadBudget";

const cbo: LaunchpadBudgetState = {
  mode: "CBO",
  schedule: "daily",
  amount: "50",
  bidStrategy: "LOWEST_COST_WITHOUT_CAP",
  bidAmount: "",
};

const abo: LaunchpadBudgetState = {
  mode: "ABO",
  schedule: undefined,
  amount: undefined,
  bidStrategy: undefined,
  bidAmount: undefined,
};

describe("LaunchpadAdSets", () => {
  it("renders attribution presets without exposing the provider payload", () => {
    const adset = {
      ...makeDefaultLaunchpadAdSet(1, "Campaign"),
      attributionPresetId: "custom" as const,
      attributionSpec: [{ event_type: "VIEW_THROUGH" as const, window_days: 1 as const }],
    };
    const html = renderToStaticMarkup(
      <LaunchpadAdSets
        value={[adset]}
        campaignName="Campaign"
        budget={abo}
        pixelOptions={[{ id: "pixel_1", name: "Primary", lastSpend28d: 100, lastUpdatedAt: null, isMostUsed: true }]}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("Click 7d + View 1d (e-commerce default)");
    expect(html).toContain("Engaged video view 1-day");
    expect(html).not.toContain("attribution_spec");
    expect(html).not.toContain("CLICK_THROUGH");
    expect(html).toContain("At least one click window is required");
  });

  it("renders one pixel as a read-only chip, multiple pixels as dropdown, and zero pixels as a blocker", () => {
    const onePixel = renderToStaticMarkup(
      <LaunchpadAdSets
        value={[{ ...makeDefaultLaunchpadAdSet(1, "Campaign"), pixelId: "pixel_1" }]}
        campaignName="Campaign"
        budget={cbo}
        pixelOptions={[{ id: "pixel_1", name: "Primary", lastSpend28d: 500, lastUpdatedAt: null, isMostUsed: true }]}
        onChange={vi.fn()}
      />,
    );
    expect(onePixel).toContain("Primary");
    expect(onePixel).not.toContain("Primary / pixel_1");

    const multiplePixels = renderToStaticMarkup(
      <LaunchpadAdSets
        value={[{ ...makeDefaultLaunchpadAdSet(1, "Campaign"), pixelId: "pixel_2" }]}
        campaignName="Campaign"
        budget={cbo}
        pixelOptions={[
          { id: "pixel_2", name: "Most used", lastSpend28d: 900, lastUpdatedAt: null, isMostUsed: true },
          { id: "pixel_1", name: "Backup", lastSpend28d: 50, lastUpdatedAt: null, isMostUsed: false },
        ]}
        onChange={vi.fn()}
      />,
    );
    expect(multiplePixels).toContain("Most used");
    expect(multiplePixels).not.toContain("Most used / pixel_2");
    expect(multiplePixels).not.toContain("Backup / pixel_1");
    expect(multiplePixels).toContain("most used");
    expect(multiplePixels).toContain("selected");

    const noPixels = renderToStaticMarkup(
      <LaunchpadAdSets
        value={[makeDefaultLaunchpadAdSet(1, "Campaign")]}
        campaignName="Campaign"
        budget={cbo}
        pixelOptions={[]}
        onChange={vi.fn()}
      />,
    );
    expect(noPixels).toContain("No active pixel found for this business");
  });

  it("hides per-adset budget inputs in CBO and shows them in ABO", () => {
    const adset = makeDefaultLaunchpadAdSet(1, "Campaign");
    const cboHtml = renderToStaticMarkup(
      <LaunchpadAdSets
        value={[adset]}
        campaignName="Campaign"
        budget={cbo}
        pixelOptions={[]}
        onChange={vi.fn()}
      />,
    );
    const aboHtml = renderToStaticMarkup(
      <LaunchpadAdSets
        value={[adset]}
        campaignName="Campaign"
        budget={abo}
        pixelOptions={[]}
        onChange={vi.fn()}
      />,
    );

    expect(cboHtml).not.toContain("Ad set budget");
    expect(aboHtml).toContain("Ad set budget");
    expect(aboHtml).toContain("Ad set bid strategy");
  });

  it("resets hidden per-adset budget fields when switching to CBO", () => {
    const adset = {
      ...makeDefaultLaunchpadAdSet(1, "Campaign"),
      budgetAmount: "100",
      bidStrategy: "COST_CAP" as const,
      bidAmount: "12",
    };

    expect(resetHiddenAdSetBudgetFieldsForMode([adset], "CBO")[0]).toMatchObject({
      budgetAmount: undefined,
      bidStrategy: undefined,
      bidAmount: undefined,
    });
    expect(resetHiddenAdSetBudgetFieldsForMode([{ ...adset, bidStrategy: undefined }], "ABO")[0]).toMatchObject({
      budgetAmount: "100",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      bidAmount: "12",
    });
  });
});
