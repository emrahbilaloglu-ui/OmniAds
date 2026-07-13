import { describe, expect, it } from "vitest";
import {
  buildH11PointInTimeFeatures,
  type H11CampaignFirstSeenSourceRow,
  type H11CampaignNameSourceRow,
  type H11CreativeSourceRow,
} from "./h11-campaign-context-challenger";

function creative(
  overrides: Partial<H11CreativeSourceRow> = {},
): H11CreativeSourceRow {
  return {
    businessId: "business",
    businessName: "Business",
    accountId: "account",
    campaignId: "campaign",
    adsetId: "adset",
    creativeId: "creative",
    date: "2026-03-20",
    spend: 100,
    firstSpendDate: "2026-03-01",
    ...overrides,
  };
}

const names: H11CampaignNameSourceRow[] = [
  {
    businessId: "business",
    accountId: "account",
    campaignId: "campaign",
    date: "2026-03-01",
    campaignName: "Historical Main",
  },
  {
    businessId: "business",
    accountId: "account",
    campaignId: "campaign",
    date: "2026-04-02",
    campaignName: "Future Test Rename",
  },
];

const firstSeen: H11CampaignFirstSeenSourceRow[] = [
  {
    businessId: "business",
    accountId: "account",
    campaignId: "campaign",
    firstSeenDate: "2026-01-01",
  },
];

describe("H11 point-in-time feature construction", () => {
  it("ignores appended future facts and future campaign renames", () => {
    const baselineRows = Array.from({ length: 10 }, (_, index) =>
      creative({
        creativeId: `creative-${index % 2}`,
        date: `2026-03-${String(20 + index).padStart(2, "0")}`,
      }),
    );
    const baseline = buildH11PointInTimeFeatures({
      creativeRows: baselineRows,
      campaignNameRows: names,
      campaignFirstSeenRows: firstSeen,
      asOf: "2026-03-31",
    });
    const withFuture = buildH11PointInTimeFeatures({
      creativeRows: [
        ...baselineRows,
        creative({
          creativeId: "future-creative",
          date: "2026-04-10",
          spend: 10_000,
        }),
      ],
      campaignNameRows: names,
      campaignFirstSeenRows: firstSeen,
      asOf: "2026-03-31",
    });

    expect(withFuture.features).toEqual(baseline.features);
    expect(withFuture.features[0]?.feature.campaignName).toBe(
      "Historical Main",
    );
    expect(withFuture.futureRowsIgnored).toBe(1);
  });

  it("fails closed on campaign ids that collide across provider accounts", () => {
    const result = buildH11PointInTimeFeatures({
      creativeRows: [
        creative(),
        creative({ accountId: "second-account", creativeId: "second" }),
      ],
      campaignNameRows: names,
      campaignFirstSeenRows: firstSeen,
      asOf: "2026-03-31",
    });
    expect(result.features).toEqual([]);
    expect(result.accountCollisionCampaignIds).toEqual(["campaign"]);
  });
});
