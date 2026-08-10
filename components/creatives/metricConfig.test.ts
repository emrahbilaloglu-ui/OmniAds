import { describe, expect, it } from "vitest";
import { METRIC_CONFIG } from "@/components/creatives/metricConfig";

describe("creative metric currency formatting", () => {
  it("formats every monetary metric in the row currency", () => {
    for (const metric of ["spend", "purchaseValue", "cpa", "cpcLink", "cpm"] as const) {
      const formatted = METRIC_CONFIG[metric].format(123.45, "GBP");
      expect(formatted).toContain("£");
      expect(formatted).not.toContain("$");
    }
  });

  it("fails explicitly when a monetary metric has no currency authority", () => {
    const formatted = METRIC_CONFIG.spend.format(123.45, null);
    expect(formatted).toContain("Currency unavailable");
    expect(formatted).not.toContain("$");
  });

  it("does not require a currency for non-monetary metrics", () => {
    expect(METRIC_CONFIG.roas.format(1.25, null)).toBe("1.25");
    expect(METRIC_CONFIG.ctrAll.format(3.5, null)).toBe("3.50%");
  });
});
