import { describe, expect, it } from "vitest";
import { applyRecentAdActionsToRows } from "@/lib/launchpad/recent-ad-actions";

describe("Launchpad recent provider-result rows", () => {
  it("marks a newly returned ad as metrics-unavailable", () => {
    const rows = applyRecentAdActionsToRows(
      [],
      [
        {
          action: "launch_ad",
          requestedAt: "2026-07-10T10:00:00.000Z",
          sourceAdId: null,
          sourceName: "Source creative",
          resultingAdId: "ad_new",
          creativeId: "creative_1",
          adName: "New ad",
          status: "PAUSED",
          accountId: "act_1",
          targetCampaignId: "campaign_1",
          targetCampaignName: "Main",
          targetAdsetId: "adset_1",
          targetAdsetName: "Broad",
        },
      ],
      null,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      realAdId: "ad_new",
      effectiveStatus: "PAUSED",
      currency: null,
      metricsAvailability: "unavailable",
    });
  });
});
