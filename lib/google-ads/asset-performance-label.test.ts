import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { googleAssetPerformanceView } from "@/components/google-ads/google-assets-exact-adapter";
import {
  asString,
  getCompatObject,
  getCompatValue,
} from "@/lib/google-ads/normalizers";
import { buildAssetPerformanceCoreQuery } from "@/lib/google-ads/query-builders";
import { normalizeServedAssetPerformanceLabel } from "@/lib/google-ads/reporting";
import { analyzeAssets } from "@/lib/google-ads/tab-analysis";

/**
 * The design's Text assets card says "ratings are Google-served", so the chip
 * above that caption has to be Google's `asset_group_asset.performance_label`
 * and not this product's derived ROAS/CTR verdict. These assertions pin the
 * whole path — GAQL select, normaliser, warehouse projection, serving
 * classifier, view — so the served field cannot be dropped again and the
 * derived one cannot quietly take its place.
 */
describe("Google-served asset performance label", () => {
  it("selects Google's own performance_label on the asset performance query", () => {
    const query = buildAssetPerformanceCoreQuery("2026-03-11", "2026-04-07");
    expect(query.query).toContain("asset_group_asset.performance_label");
    expect(query.resource).toBe("asset_group_asset");
  });

  it("keeps Google's own wording and treats a non-verdict as an absence", () => {
    expect(normalizeServedAssetPerformanceLabel("BEST")).toBe("Best");
    expect(normalizeServedAssetPerformanceLabel("GOOD")).toBe("Good");
    expect(normalizeServedAssetPerformanceLabel("LOW")).toBe("Low");
    expect(normalizeServedAssetPerformanceLabel("LEARNING")).toBe("Learning");
    expect(normalizeServedAssetPerformanceLabel("PENDING")).toBe("Pending");
    expect(normalizeServedAssetPerformanceLabel("UNSPECIFIED")).toBeNull();
    expect(normalizeServedAssetPerformanceLabel("UNKNOWN")).toBeNull();
    expect(normalizeServedAssetPerformanceLabel(null)).toBeNull();
  });

  it("reads the field off both shapes the API returns, under its own name", () => {
    // The reporting layer's own read, on the snake_case and camelCase shapes
    // `runNamedQuery` can hand back.
    for (const row of [
      { asset_group_asset: { performance_label: "BEST" } },
      { assetGroupAsset: { performanceLabel: "BEST" } },
    ]) {
      const assetGroupAsset = getCompatObject(row, "asset_group_asset");
      expect(
        normalizeServedAssetPerformanceLabel(
          asString(getCompatValue(assetGroupAsset, "performance_label")),
        ),
      ).toBe("Best");
    }

    const reporting = readFileSync("lib/google-ads/reporting.ts", "utf8");
    expect(reporting).toContain("servedPerformanceLabel: normalizeServedAssetPerformanceLabel(");
  });

  it("carries the served verdict through the warehouse projection", () => {
    const warehouse = readFileSync("lib/google-ads/warehouse.ts", "utf8");
    // The projection whitelist is the gate between the synced payload and the
    // served row: a key missing here never reaches the screen.
    const projection = warehouse.slice(
      warehouse.indexOf("function payloadProjectionSqlForScope"),
    );
    const assetStart = projection.indexOf('case "asset_daily":');
    expect(assetStart).toBeGreaterThan(-1);
    const assetScope = projection.slice(
      assetStart,
      projection.indexOf('case "asset_group_daily":', assetStart),
    );
    expect(assetScope).toContain(
      "'servedPerformanceLabel', payload_json -> 'servedPerformanceLabel'",
    );
    // The derived label keeps its own key; the two are separate facts.
    expect(assetScope).toContain("'performanceLabel', payload_json -> 'performanceLabel'");
  });

  it("carries both labels through the serving-layer classifier", () => {
    const analysed = analyzeAssets([
      {
        id: "ag_1:as_1",
        servedPerformanceLabel: "Low",
        performanceLabel: "top",
        spend: 100,
        revenue: 400,
        roas: 4,
        conversions: 10,
      },
    ]);
    expect(analysed.rows[0]?.servedPerformanceLabel).toBe("Low");
    expect(analysed.rows[0]?.performanceLabel).toBe("top");
  });

  it("chips the served verdict and refuses the derived vocabulary", () => {
    expect(googleAssetPerformanceView("Low")).toEqual({
      label: "Low",
      tone: "warning",
    });
    expect(googleAssetPerformanceView("top")).toEqual({
      label: "—",
      tone: "unserved",
    });
  });
});
