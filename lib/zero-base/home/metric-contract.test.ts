import { describe, expect, it } from "vitest";

import {
  buildBannerStack,
  comparisonSentiment,
  comparisonUnavailableCopy,
  toHomeMetric,
  NEUTRAL_BY_POLICY,
  type HomeSourceState,
} from "@/lib/zero-base/home/metric-contract";
import { deltaSentiment, getMetricDirection } from "@/lib/metric-semantics";
import type { OverviewMetricCardData } from "@/src/types/models";

function card(overrides: Partial<OverviewMetricCardData> = {}): OverviewMetricCardData {
  return {
    id: "pins-revenue",
    title: "Revenue",
    value: 1000,
    previousValue: 800,
    changePct: 25,
    sparklineData: [],
    trendDirection: "up",
    dataSource: { key: "shopify_ledger", label: "Shopify ledger" },
    status: "available",
    unit: "currency",
    ...overrides,
  };
}

const base = {
  mode: "previous_period" as const,
  currency: "USD",
  currencyProof: "configured-only" as const,
};

describe("a rise is not automatically good", () => {
  it("colours a rising cost metric negative and a rising revenue metric positive", () => {
    const revenue = toHomeMetric({ ...base, metricKey: "revenue", card: card() });
    const cpa = toHomeMetric({
      ...base,
      metricKey: "cpa",
      card: card({ id: "custom-blended-cpa", title: "CPA", value: 50, previousValue: 40, changePct: 25 }),
    });

    // Same arithmetic direction, opposite meaning.
    expect(revenue.comparison.available && revenue.comparison.arrow).toBe("up");
    expect(cpa.comparison.available && cpa.comparison.arrow).toBe("up");
    expect(comparisonSentiment(revenue)).toBe("positive");
    expect(comparisonSentiment(cpa)).toBe("negative");
  });

  it("treats rising refunds as negative", () => {
    // Refunds are money going the wrong way; direction must not decide colour.
    expect(getMetricDirection("refunds")).not.toBe("higher_is_better");
    expect(deltaSentiment(getMetricDirection("refunds"), 25)).toBe("negative");
  });

  it("keeps spend neutral in both directions", () => {
    const up = toHomeMetric({
      ...base,
      metricKey: "spend",
      card: card({ id: "pins-spend", title: "Spend", value: 500, previousValue: 400, changePct: 25 }),
    });
    const down = toHomeMetric({
      ...base,
      metricKey: "spend",
      card: card({ id: "pins-spend", title: "Spend", value: 300, previousValue: 400, changePct: -25 }),
    });
    // Spending more is not by itself good or bad; colouring it misleads pacing.
    expect(comparisonSentiment(up)).toBe("neutral");
    expect(comparisonSentiment(down)).toBe("neutral");
    expect(NEUTRAL_BY_POLICY.has("spend")).toBe(true);
  });

  it("never colours from the arrow", () => {
    // A down arrow on a cost metric is a good outcome.
    const cpa = toHomeMetric({
      ...base,
      metricKey: "cpa",
      card: card({ id: "custom-blended-cpa", value: 30, previousValue: 40, changePct: -25 }),
    });
    expect(cpa.comparison.available && cpa.comparison.arrow).toBe("down");
    expect(comparisonSentiment(cpa)).toBe("positive");
  });
});

describe("a missing comparison is never zero", () => {
  it("reports the reason instead of 0.0% when there is no baseline", () => {
    const metric = toHomeMetric({
      ...base,
      metricKey: "revenue",
      card: card({ previousValue: null, changePct: null }),
    });
    expect(metric.comparison.available).toBe(false);
    expect(metric.comparison.available === false && metric.comparison.reason).toBe(
      "missing_baseline_value",
    );
    expect(comparisonUnavailableCopy(metric.comparison)).toBe("No comparable earlier window");
    expect(comparisonUnavailableCopy(metric.comparison)).not.toContain("0");
  });

  it("reports no-comparison-mode rather than a flat delta", () => {
    const metric = toHomeMetric({
      ...base,
      mode: "none",
      metricKey: "revenue",
      card: card({ previousValue: null, changePct: null }),
    });
    expect(metric.comparison.available === false && metric.comparison.reason).toBe(
      "no_comparison_mode",
    );
    expect(comparisonSentiment(metric)).toBe("neutral");
  });

  it("distinguishes a zero baseline from a missing one", () => {
    const metric = toHomeMetric({
      ...base,
      metricKey: "revenue",
      card: card({ value: 100, previousValue: 0, changePct: null }),
    });
    // Dividing by zero is not a 100% rise; it is not a percentage at all.
    expect(metric.comparison.available === false && metric.comparison.reason).toBe("baseline_zero");
  });

  it("does not inherit the legacy `changePct ?? 0` coercion", () => {
    // The legacy support module computes deltaSentiment(direction, changePct ?? 0),
    // so a metric with no comparison gets the sentiment of a flat one. The
    // contract must return an *unavailable* comparison instead.
    const metric = toHomeMetric({
      ...base,
      metricKey: "cpa",
      card: card({ id: "custom-blended-cpa", previousValue: null, changePct: null }),
    });
    expect(metric.comparison.available).toBe(false);
    expect(metric.comparison).not.toHaveProperty("changePercent");
  });
});

describe("a missing value is never zero", () => {
  it("renders unavailable with a reason rather than a numeric zero", () => {
    const metric = toHomeMetric({
      ...base,
      metricKey: "revenue",
      card: card({ status: "unavailable", value: null }),
      unavailableReason: "Shopify is not connected.",
    });
    expect(metric.availability).toBe("unavailable");
    expect(metric.value).toBeNull();
    expect(metric.reason).toBe("Shopify is not connected.");
  });

  it("keeps a partial metric's value but states why it is partial", () => {
    const metric = toHomeMetric({
      ...base,
      metricKey: "revenue",
      card: card({ status: "partial", helperText: "GA4 window incomplete." }),
    });
    expect(metric.availability).toBe("partial");
    expect(metric.value).toBe(1000);
    expect(metric.reason).toBe("GA4 window incomplete.");
  });

  it("treats a missing card as unavailable, not as 0", () => {
    const metric = toHomeMetric({ ...base, metricKey: "orders", card: undefined });
    expect(metric.value).toBeNull();
    expect(metric.availability).toBe("unavailable");
  });
});

describe("money carries its proof", () => {
  it("marks a configured-only currency as unproven", () => {
    const metric = toHomeMetric({ ...base, metricKey: "revenue", card: card() });
    expect(metric.money).toEqual({ currency: "USD", proven: false, proof: "configured-only" });
  });

  it("marks an observed currency as proven", () => {
    const metric = toHomeMetric({
      ...base,
      currencyProof: "proven",
      metricKey: "revenue",
      card: card(),
    });
    expect(metric.money?.proven).toBe(true);
  });

  it("never invents a currency when none is known", () => {
    const metric = toHomeMetric({
      ...base,
      currency: null,
      currencyProof: "unknown",
      metricKey: "revenue",
      card: card(),
    });
    expect(metric.money?.currency).toBeNull();
    expect(metric.money?.proven).toBe(false);
  });

  it("attaches no money to a non-currency metric", () => {
    const metric = toHomeMetric({
      ...base,
      metricKey: "orders",
      card: card({ id: "pins-orders", unit: "count" }),
    });
    expect(metric.money).toBeNull();
  });
});

describe("banner stack keeps both severities", () => {
  const sources: HomeSourceState[] = [
    { key: "meta", label: "Meta", state: "unavailable", reason: "Token expired.", freshness: "unknown", lastUpdatedAt: null },
    { key: "ga4", label: "GA4", state: "partial", reason: "Window incomplete.", freshness: "stale", lastUpdatedAt: "2026-08-01" },
    { key: "shopify", label: "Shopify", state: "ok", reason: null, freshness: "fresh", lastUpdatedAt: "2026-08-11" },
  ];

  it("shows hard and partial banners at the same time", () => {
    const banners = buildBannerStack(sources);
    expect(banners.map((banner) => banner.severity)).toEqual(["hard", "partial"]);
    // A hard failure does not make a partial source stop mattering.
    expect(banners.map((banner) => banner.key)).toEqual(["meta", "ga4"]);
  });

  it("orders hard first without dropping partial", () => {
    const banners = buildBannerStack(sources);
    expect(banners[0].severity).toBe("hard");
    expect(banners).toHaveLength(2);
  });

  it("emits nothing when every source is serving", () => {
    expect(buildBannerStack([sources[2]])).toEqual([]);
  });

  it("carries each source's reason into its banner", () => {
    const banners = buildBannerStack(sources);
    expect(banners[0].message).toContain("Token expired.");
    expect(banners[1].message).toContain("Window incomplete.");
  });
});
