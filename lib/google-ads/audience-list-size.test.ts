import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildGoogleAssetsExactViewModel,
  googleAudienceSizeLabel,
} from "@/components/google-ads/google-assets-exact-adapter";
import type { AudienceRow } from "@/components/google-ads/google-ads-dashboard-support";
import {
  formatGoogleAdsAudienceSize,
  resolveGoogleAdsUserListSize,
} from "@/lib/google-ads/audience-list-size";
import {
  buildAudienceCoreQuery,
  buildAudienceUserListLinkQuery,
  buildUserListSizeQuery,
} from "@/lib/google-ads/query-builders";
import { buildGoogleAdsAudienceUserListIndex } from "@/lib/google-ads/reporting";

/**
 * The design's Audiences table names each audience and prints its membership
 * size (markup lines 1598-1600, model line 3870). `ad_group_audience_view`
 * serves neither: it has a criterion id, a type and metrics. Both facts live on
 * `user_list`, reached through `ad_group_criterion.user_list.user_list`.
 *
 * These assertions pin the whole path — the two GAQL reads, the join, the
 * warehouse projection whitelist, and the two cells — so the size cannot be
 * dropped again and, just as importantly, so no other number can take its place
 * when Google serves none.
 */

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

describe("Google audience list size and name", () => {
  it("reads the list off the criterion and its size off user_list", () => {
    const link = buildAudienceUserListLinkQuery();
    expect(link.resource).toBe("ad_group_criterion");
    expect(link.query).toContain("ad_group_criterion.user_list.user_list");
    expect(link.query).toContain("ad_group_criterion.criterion_id");
    expect(link.query).toContain("ad_group_criterion.type = 'USER_LIST'");

    const sizes = buildUserListSizeQuery();
    expect(sizes.resource).toBe("user_list");
    expect(sizes.query).toContain("user_list.size_for_display");
    expect(sizes.query).toContain("user_list.size_for_search");
    expect(sizes.query).toContain("user_list.name");
    expect(sizes.query).toContain("user_list.resource_name");

    // They are separate named queries so a criterion-config or list failure
    // cannot take the audience metrics down with it.
    expect(link.name).not.toBe(sizes.name);
    const core = buildAudienceCoreQuery("2026-07-21", "2026-08-17");
    expect(core.resource).toBe("ad_group_audience_view");
    expect(core.name).not.toBe(link.name);
  });

  it("joins criterion → list on both shapes the API returns", () => {
    for (const [linkRow, listRow] of [
      [
        {
          ad_group_criterion: {
            criterion_id: "9001",
            user_list: { user_list: "customers/123/userLists/55" },
          },
        },
        {
          user_list: {
            id: "55",
            resource_name: "customers/123/userLists/55",
            name: "Past purchasers — 180d",
            size_for_display: 48_000,
            size_for_search: 31_000,
          },
        },
      ],
      [
        {
          adGroupCriterion: {
            criterionId: "9001",
            userList: { userList: "customers/123/userLists/55" },
          },
        },
        {
          userList: {
            id: "55",
            resourceName: "customers/123/userLists/55",
            name: "Past purchasers — 180d",
            sizeForDisplay: 48_000,
            sizeForSearch: 31_000,
          },
        },
      ],
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
      const { listByCriterionId } = buildGoogleAdsAudienceUserListIndex({
        linkRows: [linkRow],
        listRows: [listRow],
      });
      expect(listByCriterionId.get("9001")).toEqual({
        id: "55",
        resourceName: "customers/123/userLists/55",
        name: "Past purchasers — 180d",
        sizeForDisplay: 48_000,
        sizeForSearch: 31_000,
      });
    }
  });

  it("indexes nothing for a criterion whose list the account did not serve", () => {
    const { listByCriterionId } = buildGoogleAdsAudienceUserListIndex({
      linkRows: [
        {
          ad_group_criterion: {
            criterion_id: "9002",
            user_list: { user_list: "customers/123/userLists/77" },
          },
        },
      ],
      listRows: [],
    });
    // A resource name is not an audience name and carries no size, so the row
    // must reach the screen with nothing rather than with half an answer.
    expect(listByCriterionId.size).toBe(0);
  });

  it("resolves the single Size cell from Google's two per-network counts", () => {
    expect(
      resolveGoogleAdsUserListSize({ sizeForDisplay: 48_000, sizeForSearch: 31_000 }),
    ).toBe(48_000);
    // Search stands in only when Display was not served.
    expect(
      resolveGoogleAdsUserListSize({ sizeForDisplay: null, sizeForSearch: 31_000 }),
    ).toBe(31_000);
    expect(resolveGoogleAdsUserListSize({ sizeForDisplay: 0, sizeForSearch: 31_000 })).toBe(0);
    expect(resolveGoogleAdsUserListSize({ sizeForDisplay: null, sizeForSearch: null })).toBeNull();
    expect(resolveGoogleAdsUserListSize(null)).toBeNull();
    // Never a sum of the two networks.
    expect(
      resolveGoogleAdsUserListSize({ sizeForDisplay: 48_000, sizeForSearch: 31_000 }),
    ).not.toBe(79_000);
  });

  it("prints the reference's own size notation", () => {
    expect(formatGoogleAdsAudienceSize(48_000)).toBe("48k");
    expect(formatGoogleAdsAudienceSize(12_000)).toBe("12k");
    expect(formatGoogleAdsAudienceSize(210_000)).toBe("210k");
    expect(formatGoogleAdsAudienceSize(1_200_000)).toBe("1.2M");
    expect(formatGoogleAdsAudienceSize(940)).toBe("940");
    // An unsized list is not a list of zero members.
    expect(formatGoogleAdsAudienceSize(null)).toBe("—");
    expect(formatGoogleAdsAudienceSize(0)).toBe("0");
  });

  it("selects the join and the sizes in the reporting layer", () => {
    const reporting = readFileSync("lib/google-ads/reporting.ts", "utf8");
    expect(reporting).toContain("buildAudienceUserListLinkQuery()");
    expect(reporting).toContain("buildUserListSizeQuery()");
    expect(reporting).toContain("listSize: resolveGoogleAdsUserListSize(userList)");
    expect(reporting).toContain("listName: userList?.name ?? null");
  });

  it("carries the list fields through the warehouse projection", () => {
    const warehouse = readFileSync("lib/google-ads/warehouse.ts", "utf8");
    // The projection whitelist is the gate between the synced payload and the
    // served row: a key missing here never reaches the screen.
    const projection = warehouse.slice(
      warehouse.indexOf("function payloadProjectionSqlForScope"),
    );
    const start = projection.indexOf('case "audience_daily":');
    expect(start).toBeGreaterThan(-1);
    const scope = projection.slice(start, projection.indexOf("default:", start));
    for (const key of [
      "listSize",
      "listSizeForDisplay",
      "listSizeForSearch",
      "listName",
      "userListId",
      "criterionId",
      "type",
    ]) {
      expect(scope).toContain(`'${key}', payload_json -> '${key}'`);
    }
  });

  it("prints the served size and the list's real name in the design's cells", () => {
    const model = buildGoogleAssetsExactViewModel({
      identity: { accountId: "4931182201", currencyCode: "USD", windowLabel: "28d" },
      tab: "audiences",
      assetGroups: null,
      assets: null,
      audiences: [
        audience({
          listName: "Past purchasers — 180d",
          listSize: 48_000,
          listSizeForDisplay: 48_000,
          listSizeForSearch: 31_000,
        }),
      ],
      roasTarget: 3.8,
    });
    const row = model.audienceRows[0]!;
    expect(row.name).toBe("Past purchasers — 180d");
    expect(row.size).toBe("48k");
    expect(row.type).toBe("Remarketing");
  });

  it("keeps the em dash for an audience that is not a user list", () => {
    const model = buildGoogleAssetsExactViewModel({
      identity: { accountId: "4931182201", currencyCode: "USD", windowLabel: "28d" },
      tab: "audiences",
      assetGroups: null,
      assets: null,
      // An affinity audience has no user list on any Google resource.
      audiences: [audience({ criterionId: "80421", name: "80421", type: "Affinity" })],
      roasTarget: 3.8,
    });
    const row = model.audienceRows[0]!;
    expect(row.size).toBe("—");
    // The criterion id is the audience's own served identity; the ad group and
    // campaign name different things and must not stand in for it.
    expect(row.name).toBe("80421");
    // Nothing derived from this product's own numbers may fill the cell.
    expect(row.size).not.toBe(row.conversions);
  });

  it("resolves the cell from the raw pair when the row carries no resolved size", () => {
    // A row read straight off a provider shape, before the resolved key is set.
    expect(
      googleAudienceSizeLabel(
        audience({ listSizeForDisplay: null, listSizeForSearch: 1_200_000 }),
      ),
    ).toBe("1.2M");
    expect(googleAudienceSizeLabel(audience())).toBe("—");
  });
});
