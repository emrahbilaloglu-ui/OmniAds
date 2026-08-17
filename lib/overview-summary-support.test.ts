import { describe, expect, it } from "vitest";
import {
  aggregateOverviewProviderRow,
  buildAttributionRows,
  buildPlatformSections,
} from "@/lib/overview-summary-support";

function overview(
  rows: Array<{
    platform: string;
    spend: number;
    revenue: number;
    purchases: number;
    roas: number;
    cpa: number;
  }>
) {
  return {
    platformEfficiency: rows,
    providerTrends: { meta: [], google: [] },
  } as never;
}

describe("Dashboard v2 Overview provider contracts", () => {
  it("aggregates account-grain rows into one provider total", () => {
    const source = overview([
      {
        platform: "meta",
        spend: 60,
        revenue: 180,
        purchases: 6,
        roas: 3,
        cpa: 10,
      },
      {
        platform: "meta",
        spend: 40,
        revenue: 80,
        purchases: 2,
        roas: 2,
        cpa: 20,
      },
    ]);

    expect(aggregateOverviewProviderRow(source, "meta")).toEqual({
      platform: "meta",
      spend: 100,
      revenue: 260,
      purchases: 8,
      roas: 2.6,
      cpa: 12.5,
    });
  });

  it("returns only the four canonical channels and derives share from spend", () => {
    const rows = buildAttributionRows(
      overview([
        {
          platform: "meta",
          spend: 60,
          revenue: 180,
          purchases: 6,
          roas: 3,
          cpa: 10,
        },
        {
          platform: "google_ads",
          spend: 40,
          revenue: 80,
          purchases: 2,
          roas: 2,
          cpa: 20,
        },
        {
          platform: "tiktok",
          spend: 900,
          revenue: 9_000,
          purchases: 100,
          roas: 10,
          cpa: 9,
        },
      ]),
      { revenue: null, conversions: null }
    );

    expect(rows.map((row) => row.channel)).toEqual(["Meta Ads", "Google Ads", "Klaviyo", "Organic · GA4"]);
    expect(rows.map((row) => row.spendShare)).toEqual([60, 40, null, null]);
    expect(rows[2]).toEqual(
      expect.objectContaining({
        spend: null,
        revenue: null,
        conversions: null,
      })
    );
  });

  it("keeps exactly two five-stat platform shells when provider data is absent", () => {
    const sections = buildPlatformSections(overview([]), null, "none");

    expect(sections.map((section) => section.provider)).toEqual(["meta", "google"]);
    expect(sections.map((section) => section.metrics.map((metric) => metric.title))).toEqual([
      ["Spend", "Revenue", "ROAS", "Purchases", "CPA"],
      ["Spend", "Revenue", "ROAS", "Purchases", "CPA"],
    ]);
    expect(
      sections
        .flatMap((section) => section.metrics)
        .every((metric) => metric.value === null && metric.status === "unavailable")
    ).toBe(true);
  });
});
