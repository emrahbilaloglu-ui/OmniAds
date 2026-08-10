import { describe, expect, it } from "vitest";
import {
  comparisonBasisLabel,
  deltaSentiment,
  getMetricDirection,
  resolveComparison,
} from "@/lib/metric-semantics";

describe("getMetricDirection", () => {
  it("treats cost and efficiency metrics as lower-is-better", () => {
    expect(getMetricDirection("cpa")).toBe("lower_is_better");
    expect(getMetricDirection("CPC")).toBe("lower_is_better");
    expect(getMetricDirection("cost_per_purchase")).toBe("lower_is_better");
    expect(getMetricDirection("frequency")).toBe("lower_is_better");
  });

  it("treats outcome metrics as higher-is-better", () => {
    expect(getMetricDirection("roas")).toBe("higher_is_better");
    expect(getMetricDirection("revenue")).toBe("higher_is_better");
    expect(getMetricDirection("purchases")).toBe("higher_is_better");
  });

  it("keeps spend neutral so pacing review is not miscoloured", () => {
    expect(getMetricDirection("spend")).toBe("neutral");
    expect(getMetricDirection("amount_spent")).toBe("neutral");
  });

  it("defaults unknown metrics to neutral rather than guessing", () => {
    expect(getMetricDirection("some_new_metric")).toBe("neutral");
    expect(getMetricDirection(null)).toBe("neutral");
    expect(getMetricDirection(undefined)).toBe("neutral");
  });
});

describe("deltaSentiment", () => {
  it("inverts sentiment for lower-is-better metrics", () => {
    expect(deltaSentiment("lower_is_better", 22)).toBe("negative");
    expect(deltaSentiment("lower_is_better", -22)).toBe("positive");
  });

  it("follows the sign for higher-is-better metrics", () => {
    expect(deltaSentiment("higher_is_better", 10)).toBe("positive");
    expect(deltaSentiment("higher_is_better", -10)).toBe("negative");
  });

  it("never assigns sentiment to neutral metrics or zero change", () => {
    expect(deltaSentiment("neutral", 50)).toBe("neutral");
    expect(deltaSentiment("higher_is_better", 0)).toBe("neutral");
    expect(deltaSentiment("lower_is_better", Number.NaN)).toBe("neutral");
  });
});

describe("resolveComparison", () => {
  it("returns no comparison for Compare=None instead of a zero delta", () => {
    const result = resolveComparison({
      metricKey: "spend",
      mode: "none",
      currentValue: 1200,
      baselineValue: 1000,
    });
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe("no_comparison_mode");
      expect(result.basisLabel).toBeNull();
    }
  });

  it("never produces a 0.0% delta when the comparison is absent", () => {
    const result = resolveComparison({
      metricKey: "roas",
      mode: "none",
      currentValue: 2.7,
      changePercent: null,
    });
    expect(result).not.toHaveProperty("changePercent", 0);
    expect(result.available).toBe(false);
  });

  it("names the comparison basis on every available delta", () => {
    const result = resolveComparison({
      metricKey: "revenue",
      mode: "previous_year_weekday_match",
      currentValue: 1500,
      baselineValue: 1000,
    });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.basisLabel).toBe("vs previous year (weekday match)");
      expect(result.changePercent).toBeCloseTo(50);
      expect(result.sentiment).toBe("positive");
      expect(result.arrow).toBe("up");
    }
  });

  it("colours a rising cost metric as a worse outcome", () => {
    const result = resolveComparison({
      metricKey: "cpa",
      mode: "previous_period",
      currentValue: 24.4,
      baselineValue: 20,
    });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.arrow).toBe("up");
      expect(result.sentiment).toBe("negative");
    }
  });

  it("colours a falling cost metric as a better outcome", () => {
    const result = resolveComparison({
      metricKey: "cpa",
      mode: "previous_period",
      currentValue: 16,
      baselineValue: 20,
    });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.arrow).toBe("down");
      expect(result.sentiment).toBe("positive");
    }
  });

  it("keeps a spend change directionally uncoloured", () => {
    const result = resolveComparison({
      metricKey: "spend",
      mode: "previous_period",
      currentValue: 1500,
      baselineValue: 1000,
    });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.arrow).toBe("up");
      expect(result.sentiment).toBe("neutral");
    }
  });

  it("distinguishes a missing baseline from a real zero change", () => {
    const missing = resolveComparison({
      metricKey: "revenue",
      mode: "previous_period",
      currentValue: 500,
      baselineValue: null,
    });
    expect(missing.available).toBe(false);
    if (!missing.available) expect(missing.reason).toBe("missing_baseline_value");

    const flat = resolveComparison({
      metricKey: "revenue",
      mode: "previous_period",
      currentValue: 500,
      baselineValue: 500,
    });
    expect(flat.available).toBe(true);
    if (flat.available) {
      expect(flat.changePercent).toBe(0);
      expect(flat.sentiment).toBe("neutral");
      expect(flat.arrow).toBe("flat");
    }
  });

  it("refuses a percent delta against a zero baseline", () => {
    const result = resolveComparison({
      metricKey: "revenue",
      mode: "previous_period",
      currentValue: 500,
      baselineValue: 0,
    });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe("baseline_zero");
  });

  it("uses a server-supplied percent when the baseline value is not exposed", () => {
    const result = resolveComparison({
      metricKey: "cpc",
      mode: "previous_period",
      currentValue: 1.4,
      changePercent: 12,
    });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.changePercent).toBe(12);
      expect(result.sentiment).toBe("negative");
    }
  });
});

describe("comparisonBasisLabel", () => {
  it("has no label for none and a distinct label per mode", () => {
    expect(comparisonBasisLabel("none")).toBeNull();
    expect(comparisonBasisLabel("previous_period")).toBe("vs previous period");
    expect(comparisonBasisLabel("previous_week")).toBe("vs previous week");
  });
});
