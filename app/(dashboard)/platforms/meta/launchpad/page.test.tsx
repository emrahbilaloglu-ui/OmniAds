import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { applyRecentAdActionsToRows } from "@/lib/launchpad/recent-ad-actions";
import { filterLaunchpadCreativeRows } from "@/components/launchpad/LaunchpadCreativeSelection";

const appState = {
  selectedBusinessId: "biz",
  businesses: [{ id: "biz", name: "IwaStore", currency: "USD" }],
};
const navigationState = vi.hoisted(() => ({ query: "" }));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(appState),
}));

vi.mock("@/app/(dashboard)/platforms/meta/creatives/page-support", () => ({
  fetchCreativeDecisionEngineV3: vi.fn(),
  fetchMetaCreatives: vi.fn(),
  mapApiRowToUiRow: (row: unknown) => row,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigationState.query),
}));

const { default: MetaLaunchpadPage } = await import("./legacy-page");
const { launchpadLibraryCount } = await import("./launchpad-library-count");

describe("MetaLaunchpadPage", () => {
  beforeEach(() => {
    navigationState.query = "";
    appState.selectedBusinessId = "biz";
    appState.businesses = [{ id: "biz", name: "IwaStore", currency: "USD" }];
  });

  it("withholds every Launchpad mode until an assigned account is explicit", () => {
    const html = renderToStaticMarkup(<MetaLaunchpadPage />);

    expect(html).toContain('data-testid="launchpad-account-required"');
    expect(html).toContain("Launchpad · read-only");
    expect(html).toContain(
      "Guarded write surface — everything launches PAUSED",
    );
    expect(html).toContain("Select one assigned Meta ad account");
    expect(html).not.toContain("From Decision");
    expect(html).not.toContain("New Campaign");
    expect(html).not.toContain("Create PAUSED · current");
    expect(html).toContain('href="/platforms/meta?businessId=biz"');
    expect(html).toContain('data-testid="meta-mobile-launchpad"');
    expect(html).toContain("No write controls are rendered on mobile");
    expect(html).toContain(
      'href="/platforms/meta/launchpad?launchpadMode=new_campaign&amp;launchpadStep=source"',
    );
    expect(html).not.toContain('data-testid="launchpad-mode-selector"');
    expect(html).not.toContain('data-testid="launchpad-source-step"');
  });

  it("preserves mode, step, account, and decision lineage in the mobile desktop link", () => {
    navigationState.query = new URLSearchParams({
      sourceDecisionId: "decision_1",
      sourceDecisionSnapshotId: "snapshot_1",
      creativeIds: "creative_1,creative_2",
      mode: "duplicate",
      providerAccountId: "act_1",
      launchpadMode: "add_to_existing",
      launchpadStep: "adsets",
    }).toString();

    const html = renderToStaticMarkup(<MetaLaunchpadPage />);
    const href = html
      .match(/href="([^"]*\/platforms\/meta\/launchpad\?[^"]*)"/)?.[1]
      ?.replaceAll("&amp;", "&");
    expect(href).toBeTruthy();
    const deepLink = new URL(href!, "https://adsecute.local");

    expect(deepLink.searchParams.get("launchpadMode")).toBe("add_to_existing");
    expect(deepLink.searchParams.get("launchpadStep")).toBe("adsets");
    expect(deepLink.searchParams.get("providerAccountId")).toBe("act_1");
    expect(deepLink.searchParams.get("sourceDecisionId")).toBe("decision_1");
    expect(deepLink.searchParams.get("sourceDecisionSnapshotId")).toBe(
      "snapshot_1",
    );
    expect(deepLink.searchParams.get("creativeIds")).toBe(
      "creative_1,creative_2",
    );
    expect(html).toContain("Current step");
    expect(html).toContain("adsets");
    expect(html).not.toContain("Launch action is in review");
  });

  it("renders an unavailable currency state instead of defaulting to USD", () => {
    appState.businesses = [{ id: "biz", name: "IwaStore", currency: "" }];
    const html = renderToStaticMarkup(<MetaLaunchpadPage />);

    expect(html).toContain("currency unavailable");
    expect(html).not.toContain("Meta · IwaStore · USD");
  });

  it("never reports unavailable launch storage as a zero count", () => {
    expect(
      launchpadLibraryCount({
        rowCount: 0,
        loading: false,
        capabilityStatus: "migration_required",
      }),
    ).toBe("Unavailable");
    expect(
      launchpadLibraryCount({
        rowCount: 0,
        loading: false,
        capabilityStatus: null,
      }),
    ).toBe("Unavailable");
    expect(
      launchpadLibraryCount({
        rowCount: 0,
        loading: true,
        capabilityStatus: null,
      }),
    ).toBe("Loading");
    expect(
      launchpadLibraryCount({
        rowCount: 5,
        loading: false,
        capabilityStatus: "migration_required",
      }),
    ).toBe(5);
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
