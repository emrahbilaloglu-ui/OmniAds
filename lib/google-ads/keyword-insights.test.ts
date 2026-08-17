import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { countGoogleAdsKeywordInsights } from "@/lib/google-ads/keyword-insights";

describe("google ads keyword insight tallies", () => {
  it("counts high-CTR keywords that never converted", () => {
    const counts = countGoogleAdsKeywordInsights([
      { ctr: 6.1, clicks: 40, conversions: 0, spend: 300, impressionShare: 0.6 },
      // Below the click floor: not enough evidence to call the CTR high.
      { ctr: 9, clicks: 4, conversions: 0, spend: 20, impressionShare: 0.6 },
      { ctr: 6.1, clicks: 40, conversions: 3, spend: 300, impressionShare: 0.6 },
    ]);
    expect(counts.highCtrLowConvCount).toBe(1);
  });

  it("counts converting keywords whose impression share is withheld", () => {
    const counts = countGoogleAdsKeywordInsights([
      { conversions: 4, impressionShare: 0.29, ctr: 3, clicks: 100, spend: 400 },
      { conversions: 4, impressionShare: 0.88, ctr: 3, clicks: 100, spend: 400 },
      // No served impression share is not a low impression share.
      { conversions: 4, impressionShare: null, ctr: 3, clicks: 100, spend: 400 },
    ]);
    expect(counts.highConvLowBudgetCount).toBe(1);
  });

  it("counts keywords with enough proven volume and spend to isolate", () => {
    const counts = countGoogleAdsKeywordInsights([
      { conversions: 6, spend: 220, ctr: 4, clicks: 200, impressionShare: 0.5 },
      { conversions: 6, spend: 40, ctr: 4, clicks: 200, impressionShare: 0.5 },
      { conversions: 1, spend: 900, ctr: 4, clicks: 200, impressionShare: 0.5 },
    ]);
    expect(counts.deserveOwnAdGroupCount).toBe(1);
  });

  it("returns zeroes rather than throwing on an empty report", () => {
    expect(countGoogleAdsKeywordInsights([])).toEqual({
      highCtrLowConvCount: 0,
      highConvLowBudgetCount: 0,
      deserveOwnAdGroupCount: 0,
    });
  });
});

describe("both Google keyword readers share one definition", () => {
  it("computes the tallies on the live report path from the shared module", () => {
    const reporting = readFileSync("lib/google-ads/reporting.ts", "utf8");
    expect(reporting).toContain(
      'import { countGoogleAdsKeywordInsights } from "@/lib/google-ads/keyword-insights"',
    );
    expect(reporting).toContain("...countGoogleAdsKeywordInsights(rows)");
  });

  it("now serves the same tallies from the warehouse path the route reads", () => {
    const serving = readFileSync("lib/google-ads/serving.ts", "utf8");
    expect(serving).toContain("countGoogleAdsKeywordInsights");
    expect(serving).toMatch(
      /getGoogleAdsKeywordsReport[\s\S]{0,900}countGoogleAdsKeywordInsights/,
    );
  });
});
