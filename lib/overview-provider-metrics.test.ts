import { describe, expect, it } from "vitest";

import {
  EMPTY_PROVIDER_SCALAR_SOURCES,
  EMPTY_PROVIDER_TREND_SOURCES,
  OVERVIEW_PROVIDER_METRIC_SPECS,
  buildBlendedProviderRoasSeries,
  buildPaidProviderSpendSeries,
  metaWarehouseSource,
  providerForMetricId,
  providerScalarSourceSetsComparable,
  providerScalarSourcesComparable,
  providerTrendMatchesScalar,
} from "@/lib/overview-provider-metrics";

describe("overview provider source contract", () => {
  it.each([
    ["meta", "warehouse_published_campaign_daily", "warehouse_published_campaign_daily", true],
    ["meta", "warehouse_published_account_daily", "warehouse_published_account_daily", true],
    // Same published label, different grain: never paired.
    ["meta", "warehouse_published_campaign_daily", "warehouse_published_account_daily", false],
    ["meta", "warehouse_published_account_daily", "warehouse_published_campaign_daily", false],
    // The unscoped legacy label is not a known source.
    ["meta", "warehouse_published", "warehouse_published", false],
    ["meta", "current_day_live", "warehouse_published_account_daily", false],
    ["meta", "live_historical_fallback", "warehouse_published_campaign_daily", false],
    ["google", "warehouse_account_aggregate", "warehouse_account_daily", true],
    ["google", "warehouse_campaign_aggregate_fallback", "warehouse_campaign_daily_fallback", true],
    ["google", "warehouse_account_aggregate", "warehouse_campaign_daily_fallback", false],
    ["google", "warehouse_campaign_aggregate_fallback", "warehouse_account_daily", false],
    ["google", "live_overlay_current_day", "warehouse_account_daily", false],
    ["google", "warehouse_account_aggregate", "projection_fallback", false],
    ["google", "warehouse_account_aggregate", "provider_truth_unavailable", false],
    // A source name from the other provider never matches.
    ["google", "warehouse_published_account_daily", "warehouse_published_account_daily", false],
    ["meta", "warehouse_account_aggregate", "warehouse_account_daily", false],
  ] as const)("%s scalar %s with trend %s → %s", (provider, scalar, trend, expected) => {
    expect(providerTrendMatchesScalar(provider, scalar, trend)).toBe(expected);
  });

  it("fails closed for missing or unknown sources", () => {
    expect(providerTrendMatchesScalar("meta", null, "warehouse_published_account_daily")).toBe(false);
    expect(providerTrendMatchesScalar("meta", "warehouse_published_account_daily", undefined)).toBe(false);
    expect(providerTrendMatchesScalar("google", "something_new", "something_new")).toBe(false);
    expect(EMPTY_PROVIDER_SCALAR_SOURCES).toEqual({ meta: null, google: null });
    expect(EMPTY_PROVIDER_TREND_SOURCES).toEqual({ meta: null, google: null });
  });

  it("names Meta warehouse sources by grain and rejects an unknown grain", () => {
    expect(metaWarehouseSource("campaign_daily")).toBe("warehouse_published_campaign_daily");
    expect(metaWarehouseSource("account_daily")).toBe("warehouse_published_account_daily");
    expect(metaWarehouseSource(undefined)).toBeNull();
    expect(metaWarehouseSource("ad_daily")).toBeNull();
  });

  it.each([
    ["google", "warehouse_account_aggregate", "warehouse_account_aggregate", true],
    ["google", "warehouse_campaign_aggregate_fallback", "warehouse_campaign_aggregate_fallback", true],
    ["google", "warehouse_account_aggregate", "warehouse_campaign_aggregate_fallback", false],
    ["google", "warehouse_campaign_aggregate_fallback", "warehouse_account_aggregate", false],
    ["google", "live_overlay_current_day", "warehouse_account_aggregate", false],
    ["meta", "warehouse_published_campaign_daily", "warehouse_published_campaign_daily", true],
    ["meta", "warehouse_published_account_daily", "warehouse_published_account_daily", true],
    ["meta", "warehouse_published_campaign_daily", "warehouse_published_account_daily", false],
    ["meta", "live_historical_fallback", "live_historical_fallback", true],
    ["meta", "live_historical_fallback", "warehouse_published_account_daily", false],
    ["meta", "current_day_live", "warehouse_published_account_daily", false],
    // Identical but unknown, or a source from the other provider, fails closed.
    ["meta", "warehouse_published", "warehouse_published", false],
    ["google", "warehouse_published_account_daily", "warehouse_published_account_daily", false],
    ["meta", null, null, false],
    ["google", "warehouse_account_aggregate", null, false],
  ] as const)("%s current %s vs previous %s comparable → %s", (provider, current, previous, expected) => {
    expect(providerScalarSourcesComparable(provider, current, previous)).toBe(expected);
  });

  it("maps only provider card ids to a provider", () => {
    expect(providerForMetricId("meta-cpm")).toBe("meta");
    expect(providerForMetricId("google-conversion-rate")).toBe("google");
    expect(providerForMetricId("pins-spend")).toBeNull();
    expect(providerForMetricId("web-conversion-rate")).toBeNull();
  });

  it("compares a blended window only when the same known provider set is present", () => {
    const both = {
      meta: "warehouse_published_campaign_daily",
      google: "warehouse_account_aggregate",
    };
    expect(providerScalarSourceSetsComparable(both, both)).toBe(true);
    expect(
      providerScalarSourceSetsComparable(both, {
        meta: "warehouse_published_account_daily",
        google: "warehouse_account_aggregate",
      }),
    ).toBe(false);
    expect(providerScalarSourceSetsComparable(both, { meta: both.meta, google: null })).toBe(false);
    expect(providerScalarSourceSetsComparable({ meta: null, google: null }, { meta: null, google: null })).toBe(false);
  });

  it("builds weighted blended ROAS from provider primitives rather than averaging ROAS", () => {
    expect(
      buildBlendedProviderRoasSeries({
        meta: [
          { date: "2026-03-01", spend: 100, revenue: 300, purchases: 3 },
          { date: "2026-03-02", spend: 0, revenue: 0, purchases: 0 },
        ],
        google: [
          { date: "2026-03-01", spend: 50, revenue: 100, purchases: 1 },
          { date: "2026-03-03", spend: 20, revenue: 30, purchases: 1 },
        ],
      }),
    ).toEqual([
      { date: "2026-03-01", value: 2.6667 },
    ]);
    expect(
      buildBlendedProviderRoasSeries({
        google: [{ date: "2026-03-03", spend: 20, revenue: 30, purchases: 1 }],
      }),
    ).toEqual([{ date: "2026-03-03", value: 1.5 }]);
  });

  it("builds paid spend from the same provider rows used by Blended ROAS", () => {
    expect(
      buildPaidProviderSpendSeries({
        meta: [
          { date: "2026-03-01", spend: 100, revenue: 300, purchases: 3 },
          { date: "2026-03-02", spend: 25, revenue: 50, purchases: 1 },
        ],
        google: [
          { date: "2026-03-01", spend: 50, revenue: 100, purchases: 1 },
          { date: "2026-03-03", spend: 20, revenue: 30, purchases: 1 },
        ],
      }),
    ).toEqual([
      { date: "2026-03-01", value: 150 },
    ]);
    expect(
      buildPaidProviderSpendSeries({
        google: [{ date: "2026-03-03", spend: 20, revenue: 30, purchases: 1 }],
      }),
    ).toEqual([{ date: "2026-03-03", value: 20 }]);
  });

  it("uses the full Google conversion-rate label and keeps Cost / conv.", () => {
    expect(OVERVIEW_PROVIDER_METRIC_SPECS.google.map((spec) => spec.title)).toEqual([
      "Spend",
      "Conversion value",
      "ROAS",
      "Conversions",
      "Cost / conv.",
      "CTR",
      "CPC",
      "Conversion rate",
    ]);
  });
});
