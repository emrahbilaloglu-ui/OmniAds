import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { applyRecentAdActionsToRows } from "@/lib/launchpad/recent-ad-actions";
import { filterLaunchpadCreativeRows } from "@/components/launchpad/LaunchpadCreativeSelection";

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: "biz",
      businesses: [{ id: "biz", name: "IwaStore", currency: "USD" }],
    }),
}));

vi.mock("@/app/(dashboard)/platforms/meta/creatives/page-support", () => ({
  fetchCreativeDecisionEngineV3: vi.fn(),
  fetchMetaCreatives: vi.fn(),
  mapApiRowToUiRow: (row: unknown) => row,
}));

const { default: MetaLaunchpadPage } = await import("./page");

describe("MetaLaunchpadPage", () => {
  it("renders the Launchpad index with mode cards and endpoint-backed library sections", () => {
    const html = renderToStaticMarkup(<MetaLaunchpadPage />);

    expect(html).toContain('data-testid="meta-mobile-launchpad"');
    expect(html).toContain("Launchpad · read-only");
    expect(html).toContain("Writes and uploads stay on desktop");
    expect(html).toContain("Write posture is guarded, not hydrated");
    expect(html).toContain("Guarded write surface — everything launches PAUSED");
    expect(html).toContain("Launch new campaign");
    expect(html).toContain("Add ads to existing");
    expect(html).toContain("Manage existing ads");
    expect(html).toContain("everything launches PAUSED");
    expect(html).toContain('href="/platforms/meta"');
    expect(html).toContain("Drafts");
    expect(html).toContain("Templates");
    expect(html).toContain("No drafts yet.");
    expect(html).toContain("No templates yet.");
  });

  it("shows the source creative name for recently duplicated target ads", () => {
    const baseRow = {
      id: "source_ad_1",
      realAdId: "source_ad_1",
      creativeId: "creative_1",
      name: "X",
      accountId: "act_1",
    } as MetaCreativeRow;
    const duplicatedRow = {
      ...baseRow,
      id: "new_ad_1",
      realAdId: "new_ad_1",
      name: "X ---",
      campaignId: "cmp_target",
      campaignName: "Target campaign",
    } as MetaCreativeRow;

    const rows = applyRecentAdActionsToRows(
      [baseRow, duplicatedRow],
      [
        {
          action: "launch_ad",
          requestedAt: "2026-05-06T12:00:00.000Z",
          sourceAdId: "source_ad_1",
          sourceName: "X",
          resultingAdId: "new_ad_1",
          creativeId: "creative_1",
          adName: "X ---",
          status: "PAUSED",
          accountId: "act_1",
          targetCampaignId: "cmp_target",
          targetCampaignName: "Target campaign",
          targetAdsetId: "adset_target",
          targetAdsetName: "Target ad set",
        },
      ],
      "USD",
    );

    const duplicated = rows.find((row) => row.realAdId === "new_ad_1");
    expect(duplicated?.name).toBe("X");
    expect(duplicated?.launchpadRecentAction?.sourceName).toBe("X");
  });

  it("filters recently duplicated source creatives in add-to-existing mode", () => {
    const baseRow = {
      id: "source_ad_1",
      realAdId: "source_ad_1",
      creativeId: "creative_1",
      name: "X",
      accountId: "act_1",
      effectiveStatus: "ACTIVE",
    } as MetaCreativeRow;
    const duplicatedRow = {
      ...baseRow,
      id: "new_ad_1",
      realAdId: "new_ad_1",
      name: "X ---",
      effectiveStatus: "PAUSED",
    } as MetaCreativeRow;
    const rows = applyRecentAdActionsToRows(
      [baseRow, duplicatedRow],
      [
        {
          action: "launch_ad",
          requestedAt: "2026-05-06T12:00:00.000Z",
          sourceAdId: "source_ad_1",
          sourceName: "X",
          resultingAdId: "new_ad_1",
          creativeId: "creative_1",
          adName: "X ---",
          status: "PAUSED",
          accountId: "act_1",
          targetCampaignId: "cmp_target",
          targetCampaignName: "Target campaign",
          targetAdsetId: "adset_target",
          targetAdsetName: "Target ad set",
        },
      ],
      "USD",
      { surface: "source_creatives" },
    );

    expect(
      filterLaunchpadCreativeRows({
        rows,
        decisionByCreativeId: new Map(),
        statusFilter: "recently_duplicated",
      }).map((row) => row.name),
    ).toEqual(["X"]);
  });
});
