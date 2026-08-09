import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  deltaSentiment,
  getMetricDirection,
  isKnownMetricKey,
} from "@/lib/metric-semantics";

/**
 * A-3, checked across the product rather than on the two surfaces it was
 * originally applied to.
 *
 * The criterion is one sentence — a cost increase never receives positive
 * treatment — and it is the kind of rule that is easy to get right once and
 * then lose, because every surface that colours a delta has to know it. The
 * Copies surface carried three separate inline rules (ROAS up is good, CPA up
 * is bad, CTR up is good): correct on the day they were written, and three
 * places for the next metric to be coloured by arithmetic sign alone.
 *
 * So this asserts the rule directly over every cost-like metric name the
 * product uses, and separately asserts that surfaces defer to the shared
 * helper rather than re-deriving it.
 */
const COST_LIKE = [
  "cpa",
  "cpc",
  "cpm",
  "cpp",
  "costperpurchase",
  "costperresult",
  "cac",
  "spendperorder",
  "refundrate",
  "cancellationrate",
  "bouncerate",
  "frequency",
  "unsubscriberate",
];

const VALUE_LIKE = [
  "revenue",
  "roas",
  "roi",
  "mer",
  "aov",
  "purchases",
  "conversions",
  "orders",
  "ctr",
  "cvr",
  "conversionrate",
  "netprofit",
  "grossprofit",
  "contributionmargin",
];

describe("a cost increase never receives positive treatment", () => {
  for (const metric of COST_LIKE) {
    it(`${metric} rising is negative, falling is positive`, () => {
      expect(getMetricDirection(metric)).toBe("lower_is_better");
      expect(deltaSentiment(getMetricDirection(metric), 12)).toBe("negative");
      expect(deltaSentiment(getMetricDirection(metric), -12)).toBe("positive");
    });
  }

  for (const metric of VALUE_LIKE) {
    it(`${metric} rising is positive, falling is negative`, () => {
      expect(getMetricDirection(metric)).toBe("higher_is_better");
      expect(deltaSentiment(getMetricDirection(metric), 12)).toBe("positive");
      expect(deltaSentiment(getMetricDirection(metric), -12)).toBe("negative");
    });
  }

  it("treats spend itself as directionless", () => {
    // Spend going up is neither good nor bad without an efficiency metric
    // beside it. Colouring it green would celebrate spending more; red would
    // condemn scaling a profitable account.
    expect(getMetricDirection("spend")).toBe("neutral");
    expect(deltaSentiment("neutral", 500)).toBe("neutral");
  });

  it("never colours an unrecognised metric by arithmetic sign", () => {
    // The default has to be neutral. A metric added to a surface but not to
    // the catalog would otherwise be coloured by whichever way the number
    // happened to move.
    expect(isKnownMetricKey("some_new_metric")).toBe(false);
    expect(getMetricDirection("some_new_metric")).toBe("neutral");
    expect(deltaSentiment(getMetricDirection("some_new_metric"), 99)).toBe(
      "neutral",
    );
  });

  it("is insensitive to how a surface spells the key", () => {
    for (const spelling of ["CPA", "cost_per_purchase", "Cost-Per-Purchase", "cost per purchase"]) {
      expect(
        deltaSentiment(getMetricDirection(spelling), 5),
        `${spelling} was not recognised as cost-like`,
      ).toBe("negative");
    }
  });

  it("a zero change is neutral whichever direction the metric has", () => {
    expect(deltaSentiment("lower_is_better", 0)).toBe("neutral");
    expect(deltaSentiment("higher_is_better", 0)).toBe("neutral");
  });
});

describe("surfaces defer to the shared direction instead of re-deriving it", () => {
  it("Copies colours its deltas through the helper", () => {
    const copies = readFileSync(
      "app/(dashboard)/platforms/meta/copies/page.tsx",
      "utf8",
    );
    expect(copies).toContain("function toneForDelta(");
    expect(copies).toContain("deltaSentiment(getMetricDirection(metricKey)");
    // The three inline rules are gone.
    expect(copies).not.toContain('tone: diff >= 0 ? ("pos" as const) : ("neg" as const)');
    expect(copies).not.toContain('tone: diff > 0 ? ("neg" as const) : diff < 0 ? ("pos" as const)');
  });

  it("the Overview metric card colours through the helper", () => {
    const card = readFileSync("components/overview/MetricCard.tsx", "utf8");
    expect(card).toMatch(/metric-semantics|sentiment/);
  });

  it("the arrow glyph and the colour are decided separately", () => {
    // An arrow shows which way the number moved; the colour shows whether that
    // is good. Deriving the colour from the arrow is how a falling CPA ends up
    // red.
    const semantics = readFileSync("lib/metric-semantics.ts", "utf8");
    expect(semantics).toContain("Drives the arrow glyph only");
    expect(semantics).toContain("Business meaning of the change. Drives colour");
  });
});
