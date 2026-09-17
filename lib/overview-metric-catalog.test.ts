import { describe, expect, it } from "vitest";

import type { OverviewMetricCardData, OverviewSummaryData } from "@/src/types/models";
import { buildOverviewMetricCatalog } from "./overview-metric-catalog";

function metric(
  id: string,
  title: string,
  overrides: Partial<OverviewMetricCardData> = {},
): OverviewMetricCardData {
  return {
    id,
    title,
    value: 10,
    previousValue: 9,
    changePct: 11.1,
    sparklineData: [],
    previousSparklineData: [],
    trendDirection: "up",
    trendSentiment: "positive",
    dataSource: { key: "fixture", label: "Fixture" },
    status: "available",
    unit: "count",
    ...overrides,
  };
}

function summaryFixture(): OverviewSummaryData {
  return {
    businessId: "business-1",
    dateRange: { startDate: "2026-09-01", endDate: "2026-09-16" },
    comparison: { mode: "previous_period", startDate: "2026-08-16", endDate: "2026-08-31" },
    pins: [
      metric("pins-revenue", "Revenue", { unit: "currency" }),
      metric("pins-spend", "Ad Spend", { unit: "currency" }),
      metric("pins-mer", "MER", { unit: "ratio" }),
      metric("pins-blended-roas", "Blended ROAS", { unit: "ratio" }),
      metric("pins-orders", "Orders"),
      metric("pins-conversion-rate", "Conversion Rate", {
        value: null,
        status: "unavailable",
        helperText: "Shopify session tracking unavailable",
        unit: "percent",
      }),
    ],
    storeMetrics: [
      metric("store-aov", "Average Order Value", { unit: "currency" }),
      metric("store-gross-sales", "Gross Sales", { unit: "currency" }),
      metric("store-refund-rate", "Refund Rate", {
        value: null,
        status: "unavailable",
        unit: "percent",
      }),
    ],
    attribution: [],
    ltv: [metric("ltv-repeat-rate", "Repeat Customer Rate", { unit: "percent" })],
    platforms: [
      {
        id: "meta",
        title: "Meta Ads",
        provider: "meta",
        metrics: [metric("meta-reach", "Reach")],
      },
      {
        id: "google",
        title: "Google Ads",
        provider: "google_ads",
        metrics: [metric("google-impressions", "Impressions")],
      },
    ],
    expenses: [
      metric("expense-cogs", "COGS", { unit: "currency" }),
      metric("expenses-ad-spend", "Ad Spend", { unit: "currency" }),
      metric("expenses-mer", "MER", { unit: "ratio" }),
    ],
    costModel: { configured: false, values: null },
    customMetrics: [
      metric("custom-blended-cpa", "Blended CPA", { unit: "currency" }),
      metric("custom-mer", "MER", { unit: "ratio" }),
      metric("custom-contribution-margin", "Contribution Margin", { unit: "currency" }),
    ],
    webAnalytics: [
      metric("web-sessions", "Sessions"),
      metric("web-engagement-rate", "Engagement Rate", { unit: "percent" }),
      metric("web-average-session", "Average Session Duration", { unit: "duration_seconds" }),
    ],
    insights: [],
    shopifyServing: null,
  };
}

describe("buildOverviewMetricCatalog", () => {
  it("filters unavailable metrics by default while exposing every available metric section", () => {
    const catalog = buildOverviewMetricCatalog(summaryFixture());
    const keys = catalog.map((entry) => entry.key);

    expect(keys).not.toContain("conversion_rate");
    expect(keys).not.toContain("store-refund-rate");
    expect(keys).toEqual(
      expect.arrayContaining([
        "store-gross-sales",
        "ltv-repeat-rate",
        "expense-cogs",
        "custom-contribution-margin",
        "web-average-session",
        "meta-reach",
        "google-impressions",
      ]),
    );
    expect(catalog.find((entry) => entry.key === "store-gross-sales")?.section).toBe("storeMetrics");
    expect(catalog.find((entry) => entry.key === "ltv-repeat-rate")?.section).toBe("ltv");
    expect(catalog.find((entry) => entry.key === "expense-cogs")?.section).toBe("expenses");
    expect(catalog.find((entry) => entry.key === "web-average-session")?.section).toBe("webAnalytics");
    expect(catalog.find((entry) => entry.key === "meta-reach")?.section).toBe("platform:meta");
    expect(catalog.find((entry) => entry.key === "google-impressions")?.section).toBe("platform:google_ads");
    expect(keys).not.toContain("expenses-ad-spend");
    expect(keys).not.toContain("expenses-mer");
    expect(keys).not.toContain("custom-mer");
  });

  it("includes unavailable metrics when requested", () => {
    const catalog = buildOverviewMetricCatalog(summaryFixture(), { includeUnavailable: true });

    expect(catalog.find((entry) => entry.key === "conversion_rate")?.metric).toMatchObject({
      id: "pins-conversion-rate",
      status: "unavailable",
      helperText: "Shopify session tracking unavailable",
    });
    expect(catalog.find((entry) => entry.key === "store-refund-rate")?.metric.status).toBe("unavailable");
  });

  it("keeps known KPI choices honest and selectable when the summary omits them", () => {
    const catalog = buildOverviewMetricCatalog(
      {
        ...summaryFixture(),
        pins: [],
        storeMetrics: [],
        customMetrics: [],
        webAnalytics: [],
      },
      { includeUnavailable: true },
    );
    const byKey = new Map(catalog.map((entry) => [entry.key, entry.metric]));

    expect([...byKey.keys()]).toEqual(
      expect.arrayContaining([
        "revenue",
        "spend",
        "mer",
        "blended_roas",
        "orders",
        "conversion_rate",
        "aov",
        "cpa",
        "sessions",
      ]),
    );
    expect(byKey.get("revenue")).toMatchObject({
      id: "pins-revenue",
      unit: "currency",
      status: "unavailable",
      value: null,
      helperText: "No verified data for this window",
    });
    expect(byKey.get("blended_roas")?.subtitle).toBe("Platform-attributed conversion value ÷ paid spend");
    expect(byKey.get("mer")?.subtitle).toBe("Store revenue ÷ total ad spend");
  });

  it("provides known unavailable choices after an empty summary read", () => {
    const catalog = buildOverviewMetricCatalog(undefined, { includeUnavailable: true });

    expect(catalog.map((entry) => entry.key)).toEqual([
      "revenue",
      "spend",
      "mer",
      "blended_roas",
      "orders",
      "conversion_rate",
      "aov",
      "cpa",
      "sessions",
      "engagement_rate",
    ]);
    expect(catalog.every((entry) => entry.metric.status === "unavailable")).toBe(true);
  });

  it("keeps persisted legacy keys while preserving the source metric ids", () => {
    const catalog = buildOverviewMetricCatalog(summaryFixture());
    const byKey = new Map(catalog.map((entry) => [entry.key, entry]));

    expect(
      [
        "revenue",
        "spend",
        "mer",
        "blended_roas",
        "orders",
        "aov",
        "cpa",
        "sessions",
        "engagement_rate",
      ].map((key) => [key, byKey.get(key)?.metric.id]),
    ).toEqual([
      ["revenue", "pins-revenue"],
      ["spend", "pins-spend"],
      ["mer", "pins-mer"],
      ["blended_roas", "pins-blended-roas"],
      ["orders", "pins-orders"],
      ["aov", "store-aov"],
      ["cpa", "custom-blended-cpa"],
      ["sessions", "web-sessions"],
      ["engagement_rate", "web-engagement-rate"],
    ]);
    expect(byKey.has("store-aov")).toBe(false);
    expect(byKey.has("custom-blended-cpa")).toBe(false);
    expect(byKey.has("web-sessions")).toBe(false);
  });
});
