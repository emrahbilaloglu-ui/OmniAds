import { describe, expect, it } from "vitest";

import { buildAssetGroupCoreQuery } from "@/lib/google-ads/query-builders";
import { normalizeAssetGroupAdStrength } from "@/lib/google-ads/reporting";
import { analyzeAssetGroups } from "@/lib/google-ads/tab-analysis";

/**
 * The design's Ad strength column says the verdict is Google-served, and it is.
 * `asset_group.ad_strength` was previously absent from the read and hardcoded
 * to null; these assertions keep the whole path — GAQL select, normaliser,
 * classifier passthrough — from silently dropping it again.
 */
describe("asset group ad strength", () => {
  it("selects Google's own ad_strength on the asset group core query", () => {
    const query = buildAssetGroupCoreQuery("2026-03-11", "2026-04-07");
    expect(query.query).toContain("asset_group.ad_strength");
    expect(query.resource).toBe("asset_group");
  });

  it("keeps Google's own wording and treats a non-verdict as an absence", () => {
    expect(normalizeAssetGroupAdStrength("EXCELLENT")).toBe("Excellent");
    expect(normalizeAssetGroupAdStrength("GOOD")).toBe("Good");
    expect(normalizeAssetGroupAdStrength("AVERAGE")).toBe("Average");
    expect(normalizeAssetGroupAdStrength("POOR")).toBe("Poor");
    expect(normalizeAssetGroupAdStrength("PENDING")).toBe("Pending");
    expect(normalizeAssetGroupAdStrength("NO_ADS")).toBe("No ads");
    expect(normalizeAssetGroupAdStrength("UNSPECIFIED")).toBeNull();
    expect(normalizeAssetGroupAdStrength("UNKNOWN")).toBeNull();
    expect(normalizeAssetGroupAdStrength(null)).toBeNull();
  });

  it("carries the served verdict through the serving-layer classifier", () => {
    const analysed = analyzeAssetGroups([
      {
        id: "ag_1",
        adStrength: "Excellent",
        spend: 100,
        revenue: 400,
        roas: 4,
        spendShare: 10,
        revenueShare: 20,
        assetCount: 8,
        coverageScore: 90,
      },
    ]);
    expect(analysed.rows[0]?.adStrength).toBe("Excellent");
  });
});
