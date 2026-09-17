import { describe, expect, it } from "vitest";

import { getDemoAiInsight, getDemoOverview, getDemoSparklines } from "@/lib/demo-business";

function sum<T>(rows: T[], select: (row: T) => number) {
  return rows.reduce((total, row) => total + select(row), 0);
}

describe("demo Overview efficiency contracts", () => {
  it("keeps Shopify MER separate from paid-platform Blended ROAS", () => {
    const overview = getDemoOverview();
    const paidRows = overview.platformEfficiency.filter(
      (row) => row.platform === "Meta" || row.platform === "Google",
    );
    const spend = paidRows.reduce((sum, row) => sum + row.spend, 0);
    const conversionValue = paidRows.reduce((sum, row) => sum + row.revenue, 0);
    const conversions = paidRows.reduce((sum, row) => sum + row.purchases, 0);
    const impressions = paidRows.reduce((sum, row) => sum + (row.impressions ?? 0), 0);
    const clicks = paidRows.reduce((sum, row) => sum + (row.clicks ?? 0), 0);

    expect(overview.totals).toEqual(
      expect.objectContaining({
        spend,
        revenue: conversionValue,
        purchases: conversions,
        conversions,
        impressions,
        clicks,
        roas: Number((conversionValue / spend).toFixed(2)),
      }),
    );
    expect(overview.kpis.spend).toBe(spend);
    expect(overview.kpis.roas).toBe(Number((overview.kpis.revenue / spend).toFixed(2)));
    expect(overview.kpis.roas).not.toBe(overview.totals.roas);
    expect(getDemoAiInsight().summary).toContain("Blended ROAS sits at 3.32x on $36.0K spend");
  });

  it("keeps demo chart series on the same denominators as their scalar cards", () => {
    const overview = getDemoOverview();
    const sparklines = getDemoSparklines();
    const meta = sparklines.providerTrends.meta;
    const google = sparklines.providerTrends.google;
    const metaScalar = overview.platformEfficiency.find((row) => row.platform === "Meta")!;
    const googleScalar = overview.platformEfficiency.find((row) => row.platform === "Google")!;

    sparklines.combined.forEach((day, index) => {
      expect(day.spend).toBeCloseTo(meta[index]!.spend + google[index]!.spend, 8);
    });

    expect(sum(meta, (day) => day.spend)).toBeCloseTo(metaScalar.spend, 8);
    expect(sum(meta, (day) => day.revenue)).toBeCloseTo(metaScalar.revenue, 8);
    expect(sum(meta, (day) => day.purchases)).toBeCloseTo(metaScalar.purchases, 8);
    expect(sum(google, (day) => day.spend)).toBeCloseTo(googleScalar.spend, 8);
    expect(sum(google, (day) => day.revenue)).toBeCloseTo(googleScalar.revenue, 8);
    expect(sum(google, (day) => day.purchases)).toBeCloseTo(googleScalar.purchases, 8);
    expect(sum(sparklines.combined, (day) => day.spend)).toBeCloseTo(overview.kpis.spend, 8);
    expect(sum(sparklines.combined, (day) => day.revenue)).toBeCloseTo(overview.kpis.revenue, 8);
    expect(sum(sparklines.combined, (day) => day.purchases)).toBeCloseTo(overview.kpis.purchases, 8);
    expect(overview.trends.custom).toEqual(sparklines.combined);
  });
});
