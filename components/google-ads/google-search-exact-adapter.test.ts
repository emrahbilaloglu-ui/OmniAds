import { describe, expect, it } from "vitest";

import type { SearchIntelligenceRow } from "@/components/google-ads/google-ads-dashboard-support";
import {
  buildGoogleSearchExactViewModel,
  googleSearchRoasTone,
  googleSearchTermTags,
  type GoogleSearchExactInput,
  type GoogleSearchExactKeywordSource,
} from "@/components/google-ads/google-search-exact-adapter";

const DASH = "—";

function term(overrides: Partial<SearchIntelligenceRow> = {}): SearchIntelligenceRow {
  return {
    key: overrides.key ?? `${overrides.searchTerm ?? "term"}-key`,
    searchTerm: "canvas tote with zip",
    campaign: "Search — Non-brand",
    spend: 540,
    revenue: 3120,
    conversions: 38,
    clicks: 412,
    roas: 5.78,
    ctr: 6.1,
    intent: "transactional",
    keywordOpportunityFlag: true,
    wasteFlag: false,
    ...overrides,
  };
}

function keyword(
  overrides: Partial<GoogleSearchExactKeywordSource> = {},
): GoogleSearchExactKeywordSource {
  return {
    criterionId: "kw-1",
    keywordText: "canvas tote bag",
    matchType: "Exact",
    campaignName: "Search — Non-brand",
    spend: 2410,
    conversions: 186,
    cpa: 12.96,
    roas: 4.62,
    ctr: 5.8,
    impressionShare: 0.52,
    qualityScore: 8,
    expectedCtr: "above avg CTR",
    adRelevance: "high relevance",
    landingPageExperience: "good LP",
    ...overrides,
  };
}

function input(overrides: Partial<GoogleSearchExactInput> = {}): GoogleSearchExactInput {
  return {
    identity: {
      accountId: "4931182201",
      currencyCode: "USD",
      windowLabel: "28d",
      syncLabel: "Synced 26m ago",
    },
    tab: "terms",
    termFilter: "all",
    terms: [term()],
    keywords: [keyword()],
    keywordInsights: {
      highCtrLowConvCount: 4,
      highConvLowBudgetCount: 3,
      deserveOwnAdGroupCount: 2,
    },
    roasTarget: 3.8,
    ...overrides,
  };
}

describe("google search exact eyebrow", () => {
  it("prints the four canonical segments with no timezone", () => {
    expect(buildGoogleSearchExactViewModel(input()).eyebrow).toBe(
      "Google Ads · 4931182201 · USD · 28d window",
    );
  });

  it("renders an em dash for each segment the server did not report", () => {
    const model = buildGoogleSearchExactViewModel(
      input({ identity: { accountId: null, currencyCode: null, windowLabel: null } }),
    );
    expect(model.eyebrow).toBe(`Google Ads · ${DASH} · ${DASH} · ${DASH} window`);
    expect(model.syncLabel).toBe(DASH);
  });
});

describe("google search exact tabs", () => {
  it("marks exactly one of Search terms / Keywords active", () => {
    const model = buildGoogleSearchExactViewModel(input({ tab: "keywords" }));
    expect(model.tabs.map((tab) => tab.label)).toEqual(["Search terms", "Keywords"]);
    expect(model.tabs.filter((tab) => tab.active).map((tab) => tab.key)).toEqual([
      "keywords",
    ]);
  });
});

describe("google search exact stats", () => {
  it("reports wasted spend on zero-conversion terms, harvest count and high performers", () => {
    const model = buildGoogleSearchExactViewModel(
      input({
        terms: [
          term({ key: "a", conversions: 38, roas: 5.78, spend: 540 }),
          term({
            key: "b",
            searchTerm: "refund policy",
            conversions: 0,
            revenue: 0,
            roas: 0,
            spend: 212,
            keywordOpportunityFlag: false,
            wasteFlag: true,
          }),
        ],
      }),
    );

    expect(model.stats.map((stat) => stat.label)).toEqual([
      "wasted on zero-conv terms · 28d",
      "converting terms not yet keywords",
      "high-performing terms",
    ]);
    expect(model.stats[0]!.value).toBe("$212");
    expect(model.stats[1]!.value).toBe("1");
    expect(model.stats[2]!.value).toBe("1");
  });

  it("keeps the three shells and prints the em dash when the report is unread", () => {
    const model = buildGoogleSearchExactViewModel(input({ terms: null }));
    expect(model.stats).toHaveLength(3);
    expect(model.stats.map((stat) => stat.value)).toEqual([DASH, DASH, DASH]);
    expect(model.filters.map((filter) => filter.count)).toEqual([
      DASH,
      DASH,
      DASH,
      DASH,
    ]);
  });
});

describe("google search exact filters", () => {
  it("uses the canonical labels", () => {
    expect(
      buildGoogleSearchExactViewModel(input()).filters.map((filter) => filter.label),
    ).toEqual(["All terms", "Wasteful", "KW opportunity", "High performing"]);
  });

  it("counts a pill from exactly the rows pressing it produces, uncapped", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      term({
        key: `waste-${index}`,
        searchTerm: `waste ${index}`,
        conversions: 0,
        revenue: 0,
        roas: 0,
        spend: 100,
        wasteFlag: true,
        keywordOpportunityFlag: false,
      }),
    );
    const counts = buildGoogleSearchExactViewModel(input({ terms: rows }));
    const wastefulPill = counts.filters.find((filter) => filter.key === "wasteful")!;
    expect(wastefulPill.count).toBe("12");

    const filtered = buildGoogleSearchExactViewModel(
      input({ terms: rows, termFilter: "wasteful" }),
    );
    expect(filtered.termRows).toHaveLength(12);
  });

  it("tags high performers from converting rows at or above target", () => {
    const above = term({ conversions: 4, roas: 3.93 });
    const below = term({ key: "below", conversions: 4, roas: 3.17 });
    expect(googleSearchTermTags(above, 3.8)).toContain("high");
    expect(googleSearchTermTags(below, 3.8)).not.toContain("high");
  });
});

describe("google search exact term rows", () => {
  it("renders the design's intent taxonomy, not the ownership taxonomy", () => {
    const model = buildGoogleSearchExactViewModel(
      input({
        terms: [term({ intent: "informational", ownershipClass: "non_brand" })],
      }),
    );
    expect(model.termRows[0]!.intent).toBe("Informational");
    expect(model.termRows[0]!.intentTone).toBe("auto");
  });

  it("formats CPA from spend over conversions and dashes it when nothing converted", () => {
    const model = buildGoogleSearchExactViewModel(
      input({
        terms: [
          term({ spend: 540, conversions: 38 }),
          term({ key: "zero", conversions: 0, spend: 212, roas: 0, revenue: 0 }),
        ],
      }),
    );
    expect(model.termRows[0]!.cpa).toBe("$14.21");
    expect(model.termRows[1]!.cpa).toBe(DASH);
    expect(model.termRows[1]!.roas).toBe(DASH);
  });

  it("treats the served CTR as an already-percent value", () => {
    const model = buildGoogleSearchExactViewModel(
      input({ terms: [term({ ctr: 21.28 })] }),
    );
    expect(model.termRows[0]!.ctr).toBe("21.3%");
  });
});

describe("google search exact ROAS tint", () => {
  it("spreads the canonical four tones around the operator's target", () => {
    expect(googleSearchRoasTone(5.78, 3.8, 3)).toBe("positive");
    expect(googleSearchRoasTone(3.17, 3.8, 3)).toBe("neutral");
    expect(googleSearchRoasTone(2.99, 3.8, 3)).toBe("warning");
    expect(googleSearchRoasTone(0.59, 3.8, 3)).toBe("negative");
  });

  it("stays neutral rather than warning when no target exists", () => {
    expect(googleSearchRoasTone(4.2, null)).toBe("neutral");
    expect(googleSearchRoasTone(0.4, null)).toBe("neutral");
  });

  it("falls back to 80% of target when the pack declares no break-even", () => {
    expect(googleSearchRoasTone(3.2, 3.8)).toBe("neutral");
    expect(googleSearchRoasTone(2.99, 3.8)).toBe("warning");
  });

  it("separates a served in-band ROAS from a row that served none", () => {
    // The reference draws two greys: neu[1] #45526B for the measured 3.17, and
    // the lighter #7A869E only where the ROAS cell prints the em dash.
    expect(googleSearchRoasTone(3.17, 3.8, 3)).toBe("neutral");
    expect(googleSearchRoasTone(null, 3.8)).toBe("unserved");
    expect(googleSearchRoasTone(0, 3.8)).toBe("unserved");
    expect(googleSearchRoasTone(null, null)).toBe("unserved");
  });

  it("gives every em-dashed ROAS cell the unserved tone and every printed one an ink tone", () => {
    const model = buildGoogleSearchExactViewModel(
      input({
        terms: [
          term({ key: "band", conversions: 9, roas: 3.17, revenue: 688, spend: 217 }),
          term({ key: "none", conversions: 0, roas: 0, revenue: 0, spend: 212 }),
        ],
      }),
    );
    expect(model.termRows[0]!.roas).toBe("3.17");
    expect(model.termRows[0]!.roasTone).toBe("neutral");
    expect(model.termRows[1]!.roas).toBe(DASH);
    expect(model.termRows[1]!.roasTone).toBe("unserved");
  });

  it("applies the same split to the keywords table", () => {
    const model = buildGoogleSearchExactViewModel(
      input({
        tab: "keywords",
        keywords: [
          keyword({ criterionId: "band", roas: 3.17, conversions: 44, spend: 980 }),
          keyword({ criterionId: "none", roas: 0, conversions: 0, spend: 310 }),
        ],
      }),
    );
    expect(model.keywordRows[0]!.roasTone).toBe("neutral");
    expect(model.keywordRows[1]!.roas).toBe(DASH);
    expect(model.keywordRows[1]!.roasTone).toBe("unserved");
  });
});

describe("google search exact keyword body", () => {
  it("prints the three server tallies with the design's wording", () => {
    const model = buildGoogleSearchExactViewModel(input());
    expect(model.keywordStats.map((stat) => [stat.count, stat.label])).toEqual([
      ["4", "keywords: high CTR, zero conversions"],
      ["3", "with conversions but low impression share"],
      ["2", "may deserve their own ad group"],
    ]);
  });

  it("keeps the three pills and prints the em dash when the summary is unread", () => {
    const model = buildGoogleSearchExactViewModel(input({ keywordInsights: null }));
    expect(model.keywordStats.map((stat) => stat.count)).toEqual([DASH, DASH, DASH]);
  });

  it("renders Title-Case match types, a QS with denominator and a percent IS", () => {
    const model = buildGoogleSearchExactViewModel(input());
    const row = model.keywordRows[0]!;
    expect(row.matchType).toBe("Exact");
    expect(row.matchTone).toBe("info");
    expect(row.qualityScore).toBe("8/10");
    expect(row.qualityTone).toBe("positive");
    expect(row.impressionShare).toBe("52%");
  });

  it("does not multiply the already-percent keyword CTR by a hundred", () => {
    const model = buildGoogleSearchExactViewModel(
      input({ keywords: [keyword({ ctr: 5.8 })] }),
    );
    expect(model.keywordRows[0]!.ctr).toBe("5.8%");
  });

  it("dashes an unserved quality score and its components", () => {
    const model = buildGoogleSearchExactViewModel(
      input({
        keywords: [
          keyword({
            qualityScore: null,
            expectedCtr: null,
            adRelevance: null,
            landingPageExperience: null,
            matchType: null,
          }),
        ],
      }),
    );
    const row = model.keywordRows[0]!;
    expect(row.qualityScore).toBe(DASH);
    expect(row.qualityTone).toBe("neutral");
    expect(row.components).toBe(DASH);
    expect(row.matchType).toBe(DASH);
  });

  it("dashes money when the account currency was never resolved", () => {
    const model = buildGoogleSearchExactViewModel(
      input({ identity: { accountId: "1", currencyCode: null, windowLabel: "28d" } }),
    );
    expect(model.termRows[0]!.spend).toBe(DASH);
    expect(model.keywordRows[0]!.spend).toBe(DASH);
  });
});
