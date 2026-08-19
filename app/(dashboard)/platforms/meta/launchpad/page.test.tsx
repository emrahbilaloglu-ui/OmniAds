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
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const { default: MetaLaunchpadPage } = await import("./legacy-page");

describe("MetaLaunchpadPage", () => {
  beforeEach(() => {
    navigationState.query = "";
    appState.selectedBusinessId = "biz";
    appState.businesses = [{ id: "biz", name: "IwaStore", currency: "USD" }];
  });

  it("keeps the canonical landing shape and withholds actions until account scope is explicit", () => {
    const html = renderToStaticMarkup(<MetaLaunchpadPage />);

    expect(html).toContain('data-testid="launchpad-exact"');
    expect(html).toContain("Launchpad · read-only");
    expect(html).toContain("Meta · Guarded write surface");
    expect(html).toContain("Launches create PAUSED campaigns.");
    // No routed entity means no name — the card carries its own, rather than
    // a pair of quotes around a dash, which reads as a value that failed to load.
    expect(html).toContain("Rebuild");
    expect(html).toContain("Duplicate");
    expect(html).not.toContain("Rebuild “—”");
    expect(html).not.toContain("Duplicate “—”");
    expect(html).toContain("Start from scratch");
    expect(html).toContain("validation runs before any provider call");
    expect(html).toContain("Launch receipts");
    expect(html).not.toContain("Templates");
    expect(html).not.toContain("Continue from evidence or start manually");
    expect(html).not.toContain('data-testid="launchpad-wizard"');
    expect(html).not.toContain("Delete draft");
    expect(html).toContain('data-testid="meta-mobile-launchpad"');
    expect(html).toContain("No write controls are rendered on mobile");
    expect(html).toContain(
      'href="/platforms/meta/launchpad?launchpadMode=new_campaign&amp;launchpadStep=source"',
    );
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("fails closed and strips URL-only decision handoff authority from the desktop link", () => {
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

    expect(deepLink.searchParams.get("launchpadMode")).toBe("new_campaign");
    expect(deepLink.searchParams.get("launchpadStep")).toBe("source");
    expect(deepLink.searchParams.get("providerAccountId")).toBe("act_1");
    expect(deepLink.searchParams.get("sourceDecisionId")).toBeNull();
    expect(deepLink.searchParams.get("sourceDecisionSnapshotId")).toBeNull();
    expect(deepLink.searchParams.get("creativeIds")).toBeNull();
    expect(deepLink.searchParams.get("mode")).toBeNull();
    expect(html).toContain("Current step");
    expect(html).toContain("source");
    expect(html).not.toContain('data-testid="launchpad-wizard"');
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("treats an authorized null account as authoritative over the URL", () => {
    navigationState.query = "providerAccountId=act_unassigned";

    const html = renderToStaticMarkup(
      <MetaLaunchpadPage
        businessId="biz"
        businessName="Authorized business"
        providerAccountId={null}
      />,
    );

    expect(html).toContain("Authorized business");
    expect(html).not.toContain("act_unassigned");
    expect(html).toContain('data-testid="launchpad-exact"');
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("renders an unavailable currency state instead of defaulting to USD", () => {
    appState.businesses = [{ id: "biz", name: "IwaStore", currency: "" }];
    const html = renderToStaticMarkup(<MetaLaunchpadPage />);

    expect(html).toContain("Unavailable");
    expect(html).not.toContain("Meta · IwaStore · USD");
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
