import { describe, expect, it } from "vitest";

import {
  buildGeoCallouts,
  buildGeoFilters,
  buildGeoHighlights,
  buildGeoIntentBand,
  buildGeoKpis,
  buildGeoMethodology,
  buildGeoPages,
  buildGeoPlays,
  buildGeoPriorities,
  buildGeoQueries,
  buildGeoSources,
  buildGeoTopics,
  buildInsightsGeoExactModel,
  geoQueryFilterTags,
  heat,
  momentumCaption,
  scoreTone,
  GEO_QUERY_FILTERS,
  GEO_QUERY_TABLE_ROWS,
  GEO_TABS,
  type GeoOverviewInput,
  type GeoQueryInput,
} from "@/components/geo/insights-geo-exact-adapter";

const OVERVIEW: GeoOverviewInput = {
  kpis: {
    aiSessions: 3_840,
    previousAiSessions: 2_783,
    aiSessionsDelta: 0.38,
    aiEngagementRate: 0.742,
    aiPurchaseCvr: 0.0294,
    geoScore: 62,
    aiPageCount: 34,
    topAiSource: "ChatGPT",
    topAiSourceSessions: 2_148,
    topAiSourceShare: 0.5594,
    siteAvgEngagementRate: 0.656,
    siteAvgPurchaseCvr: 0.0177,
    aiStyleQueryCount: 41,
    totalQueryCount: 220,
  },
  insights: [
    { type: "positive", text: "AI-source visitors convert 1.7× the site average." },
    { type: "neutral", text: "Perplexity sessions doubled after the materials rewrite." },
  ],
  top3Priorities: [
    {
      title: "Answer-first FAQ on /pages/materials",
      description: "Materials questions drive 9 of your top AI-intent queries.",
      priority: "high",
      effort: "Low",
      impact: "+15–25% AI citations",
    },
  ],
  highlights: {
    strongestGeoQuery: { query: "how to clean a canvas tote", geoScore: 78, impressions: 8_140 },
    strongestGeoTopic: {
      topic: "Tote care",
      geoScore: 74,
      impressions: 24_300,
      coverageStrength: "Strong",
    },
    highestAiValueSource: { engine: "ChatGPT", label: "elite", score: 82 },
  },
};

describe("GEO sub-tabs and filters", () => {
  it("names and orders the six sub-tabs exactly as the design does", () => {
    expect(GEO_TABS.map((tab) => [tab.id, tab.label])).toEqual([
      ["overview", "Overview"],
      ["sources", "AI Sources"],
      ["pages", "Pages"],
      ["queries", "Query Intelligence"],
      ["topics", "Topic Authority"],
      ["plays", "Playbook"],
    ]);
  });

  it("leads the query filters with AI intent, not All queries", () => {
    expect([...GEO_QUERY_FILTERS]).toEqual(["ai", "all", "hi", "weak", "rising"]);
  });
});

describe("buildGeoKpis", () => {
  it("gives all six cards a sub-line, including the two static ones", () => {
    const kpis = buildGeoKpis(OVERVIEW, 28);
    expect(kpis.map((kpi) => [kpi.label, kpi.value, kpi.sub])).toEqual([
      ["AI-source sessions", "3,840", "+38% vs prev 28d"],
      ["AI engagement rate", "74.2%", "site avg 65.6%"],
      ["AI purchase CVR", "2.94%", "site avg 1.77%"],
      ["GEO opportunity score", "62 / 100", "composite · deterministic"],
      ["Pages with GEO signals", "34", "proxy · capped at 50"],
      ["Top AI source", "ChatGPT", "2,148 sessions · 56% of AI traffic"],
    ]);
    expect(kpis[3]!.highlighted).toBe(true);
    expect(kpis.filter((kpi) => kpi.highlighted)).toHaveLength(1);
  });

  it("renders the em-dash rather than a design seed when nothing is served", () => {
    const kpis = buildGeoKpis(null);
    expect(kpis).toHaveLength(6);
    expect(kpis[0]).toMatchObject({ value: "—", sub: "—" });
    expect(kpis[5]).toMatchObject({ value: "—", sub: "—" });
    // The static explanatory sub-lines survive because they are copy.
    expect(kpis[3]!.sub).toBe("composite · deterministic");
  });
});

describe("buildGeoIntentBand", () => {
  it("reads both counts and sizes the bar from their ratio", () => {
    expect(buildGeoIntentBand(OVERVIEW)).toEqual({
      aiQueries: "41",
      totalQueries: "220",
      barWidth: "18.6%",
    });
  });

  it("collapses the bar rather than guessing when the counts are absent", () => {
    expect(buildGeoIntentBand(null)).toEqual({
      aiQueries: "—",
      totalQueries: "—",
      barWidth: "0%",
    });
  });
});

describe("buildGeoPriorities / buildGeoHighlights / buildGeoCallouts", () => {
  it("renders a priority card with its real impact and effort", () => {
    expect(buildGeoPriorities(OVERVIEW)[0]).toMatchObject({
      priorityLabel: "High",
      tone: "negative",
      impact: "+15–25% AI citations",
      effort: "low effort",
    });
  });

  it("keeps all three highlight cards and quotes the query", () => {
    const highlights = buildGeoHighlights(OVERVIEW);
    expect(highlights.map((row) => [row.label, row.main, row.pill])).toEqual([
      ["Strongest GEO query", "“how to clean a canvas tote”", "GEO 78"],
      ["Strongest GEO topic", "Tote care", "GEO 74"],
      ["Highest AI-value source", "ChatGPT", "value 82/100"],
    ]);
    expect(highlights[1]!.sub).toBe("24.3K impressions · Strong coverage");
  });

  it("keeps the three highlight slots when nothing is served", () => {
    const highlights = buildGeoHighlights(null);
    expect(highlights).toHaveLength(3);
    expect(highlights.every((row) => row.main === "—")).toBe(true);
  });

  it("maps insight types to the design's kind chips", () => {
    expect(buildGeoCallouts(OVERVIEW).map((row) => row.kind)).toEqual(["Positive", "Info"]);
  });
});

describe("buildGeoSources", () => {
  it("renders the value chip as label · score and a compact momentum caption", () => {
    const [row] = buildGeoSources([
      {
        engine: "Perplexity",
        sessions: 842,
        engagementRate: 0.748,
        purchases: 24,
        revenue: 1_900,
        purchaseCvr: 0.0285,
        aiTrafficValueScore: 71,
        aiTrafficValueLabel: "strong",
        momentum: { status: "breakout", growthRate: 1.04 },
        recommendation: "Add spec tables to PDPs.",
      },
    ]);
    expect(row).toMatchObject({
      engine: "Perplexity",
      engineTone: "violet",
      value: "strong · 71",
      valueTone: "positive",
      momentum: "Breakout · +104%",
      momentumTone: "violet",
      sessions: "842",
      engagement: "74.8%",
      cvr: "2.85%",
    });
    expect(row.engagementHeat).toMatch(/^rgba\(14,159,110,/);
  });

  it("prints Stable without a percentage, matching the design", () => {
    expect(momentumCaption("stable", 0.04)).toBe("Stable");
    expect(momentumCaption(null, 1)).toBe("—");
  });
});

describe("buildGeoPages", () => {
  it("renders the design's six fields, including Sourced by", () => {
    const [row] = buildGeoPages([
      {
        path: "/blogs/tote-care-guide",
        aiSessions: 1_214,
        engagementRate: 0.81,
        purchaseCvr: 0.021,
        geoScore: 84,
        sourcedBy: ["ChatGPT", "Perplexity"],
      },
    ]);
    expect(row).toMatchObject({
      page: "/blogs/tote-care-guide",
      aiSessions: "1,214",
      engagement: "81%",
      cvr: "2.1%",
      score: "AIV 84",
      scoreTone: "positive",
      sourcedBy: "ChatGPT · Perplexity",
    });
  });

  it("renders the em-dash in Sourced by when no engine is attributed", () => {
    expect(buildGeoPages([{ path: "/a" }])[0]!.sourcedBy).toBe("—");
  });

  it("uses the design's scorePill thresholds", () => {
    expect(scoreTone(84)).toBe("positive");
    expect(scoreTone(40)).toBe("warning");
    expect(scoreTone(10)).toBe("neutral");
    expect(scoreTone(null)).toBe("neutral");
  });
});

const QUERIES: GeoQueryInput[] = [
  {
    query: "how to clean a canvas tote",
    impressions: 8_140,
    ctr: 0.046,
    position: 2.8,
    isAiStyle: true,
    classification: { intentLabel: "Informational", formatLabel: "How-to" },
    geoScore: 78,
    geoScoreBreakdown: { impressions: 26, positionQuality: 20, ctrGap: 14, intent: 18 },
    momentum: { status: "rising", growthRate: 0.26 },
    priority: "high",
    recommendation: "Add step-list schema to the guide.",
  },
  {
    query: "weekender bag",
    impressions: 186_000,
    ctr: 0.017,
    position: 7.8,
    isAiStyle: false,
    classification: { intentLabel: "Commercial", formatLabel: "Category" },
    geoScore: 41,
    geoScoreBreakdown: { impressions: 18, positionQuality: 12, ctrGap: 7, intent: 4 },
    momentum: { status: "stable", growthRate: 0 },
    priority: "low",
  },
];

describe("buildGeoQueries", () => {
  it("tags each query deterministically for the design's filter pills", () => {
    expect(geoQueryFilterTags(QUERIES[0]!).sort()).toEqual(["ai", "all", "hi", "rising"]);
    expect(geoQueryFilterTags(QUERIES[1]!).sort()).toEqual(["all", "hi", "weak"]);
  });

  it("counts every filter over the whole dataset, not the filtered view", () => {
    const filters = buildGeoFilters(QUERIES, "ai");
    expect(filters.map((filter) => [filter.label, filter.count])).toEqual([
      ["AI intent", "1"],
      ["All queries", "2"],
      ["High impressions", "2"],
      ["Weak CTR", "1"],
      ["Rising ↑", "1"],
    ]);
    expect(filters[0]!.active).toBe(true);
  });

  it("makes the All queries and AI intent pills agree with the intent band", () => {
    // Both restate the same served fact, so both must print the same number as
    // "N of M ranking queries have AI / answer intent" on the Overview tab.
    const band = buildGeoIntentBand(OVERVIEW);
    const filters = buildGeoFilters(QUERIES, "ai", OVERVIEW);
    const count = (label: string) =>
      filters.find((filter) => filter.label === label)!.count;
    expect(count("All queries")).toBe(band.totalQueries);
    expect(count("AI intent")).toBe(band.aiQueries);
    expect([count("All queries"), count("AI intent")]).toEqual(["220", "41"]);
    // The three filters with no served count still read the scored rows.
    expect(count("High impressions")).toBe("2");
  });

  it("falls back to the served rows when the overview has no counts", () => {
    const filters = buildGeoFilters(QUERIES, "ai", { kpis: null });
    expect(filters.map((filter) => filter.count)).toEqual(["1", "2", "2", "1", "1"]);
  });

  it("combines intent and format into one badge and stars answer-shaped queries", () => {
    const [row] = buildGeoQueries(QUERIES, "ai");
    expect(row).toMatchObject({
      query: "how to clean a canvas tote",
      star: "✦ ",
      intent: "Informational · How-to",
      intentTone: "violet",
      momentum: "Rising · +26%",
      score: "78",
      position: "2.8",
      positionTone: "positive",
    });
  });

  it("builds the score breakdown from the real component maxima", () => {
    const [row] = buildGeoQueries(QUERIES, "ai");
    expect(row.bars).toEqual([
      { key: "impressions", label: "Impressions", value: "26", width: "87%" },
      { key: "positionQuality", label: "Position", value: "20", width: "80%" },
      { key: "ctrGap", label: "CTR gap", value: "14", width: "56%" },
      { key: "intent", label: "Intent", value: "18", width: "90%" },
    ]);
  });

  it("shows the top rows by GEO score, as the footnote says — bounded and re-sorted", () => {
    // The route leads with breakout/rising AI-style rows, which is not score
    // order; a table whose footnote promises "the top rows by GEO score" has to
    // sort by score itself.
    const dataset: GeoQueryInput[] = Array.from({ length: 12 }, (_, index) => ({
      query: `q${index}`,
      impressions: 5_000,
      ctr: 0.05,
      position: 4,
      geoScore: index, // ascending, i.e. the worst row arrives first
      momentum: { status: "stable", growthRate: 0 },
    }));

    const rows = buildGeoQueries(dataset, "all");
    expect(rows).toHaveLength(GEO_QUERY_TABLE_ROWS);
    expect(rows.map((row) => row.score)).toEqual([
      "11",
      "10",
      "9",
      "8",
      "7",
      "6",
      "5",
      "4",
    ]);
  });
});

describe("buildGeoTopics", () => {
  it("sizes the coverage bar against the strongest cluster's demand", () => {
    const topics = buildGeoTopics([
      {
        topic: "Tote care",
        queryCount: 12,
        impressions: 24_300,
        clicks: 1_180,
        avgPosition: 3.4,
        geoScore: 74,
        coverageStrength: "Strong",
        authorityStrength: "Strong",
        coverageGap: "low",
        priority: "low",
        queries: ["how to clean a canvas tote", "canvas tote washing", "tote stain removal", "extra"],
        momentum: { status: "rising", growthRate: 0.26 },
        recommendation: { title: "Add an FAQ block.", effort: "Low", impact: "+15% answer eligibility" },
      },
      {
        topic: "Bag materials",
        queryCount: 9,
        impressions: 12_800,
        clicks: 412,
        avgPosition: 6.1,
        geoScore: 61,
        coverageStrength: "Moderate",
        authorityStrength: "Moderate",
        coverageGap: "high",
        priority: "high",
        queries: ["what is recycled sailcloth"],
        momentum: { status: "breakout", growthRate: 0.58 },
        recommendation: null,
      },
    ]);
    expect(topics[0]).toMatchObject({
      coverage: "Strong",
      coverageTone: "positive",
      queryCount: "12 queries",
      barWidth: "100%",
      score: "GEO 74",
      impressions: "24.3K",
      clicks: "1,180",
      position: "3.4",
      authority: "strong authority",
      recommendationEffort: "low effort",
    });
    // L2274-2276 renders every chip the cluster carries; the design's own
    // fourth topic has two (script L4082), so `hint-placeholder-count="3"` is
    // a preview hint, not a cap.
    expect(topics[0]!.chips).toEqual([
      "how to clean a canvas tote",
      "canvas tote washing",
      "tote stain removal",
      "extra",
    ]);
    expect(topics[1]!.chips).toEqual(["what is recycled sailcloth"]);
    expect(topics[1]).toMatchObject({
      barWidth: "53%",
      gap: "↑ High gap",
      gapTone: "negative",
      priority: "High priority",
      recommendationTitle: "—",
    });
  });
});

describe("buildGeoPlays", () => {
  it("numbers each play and prefixes evidence and expected outcome", () => {
    const [play] = buildGeoPlays([
      {
        title: "Restructure /pages/materials into answer-first Q&A",
        evidence: "9 of the top AI-intent queries are materials questions.",
        recommendation: "+15–25% AI citations within 60 days.",
        effort: "Low",
        impact: "+15–25% AI citations",
        priority: "high",
      },
    ]);
    expect(play).toMatchObject({
      ordinal: "01",
      why: "Evidence: 9 of the top AI-intent queries are materials questions.",
      outcome: "Expected: +15–25% AI citations within 60 days.",
    });
    expect(play.chips).toEqual([
      { label: "low effort", tone: "neutral" },
      { label: "+15–25% AI citations", tone: "positive" },
    ]);
  });
});

describe("buildGeoMethodology", () => {
  it("names the four paragraphs and reads the engine list from the shipped map", () => {
    const paragraphs = buildGeoMethodology();
    expect(paragraphs.map((paragraph) => paragraph.lead)).toEqual([
      "AI referral traffic",
      "GEO scores",
      "Query intent classification",
      "Direct citation visibility",
    ]);
    expect(paragraphs[0]!.rest).toContain("chat.openai.com");
    expect(paragraphs[0]!.rest).toContain("perplexity.ai");
  });
});

describe("heat", () => {
  it("reproduces the design's own ramp", () => {
    expect(heat(0.8, 0.8)).toBe("rgba(14,159,110,0.350)");
    expect(heat(0, 0.8)).toBe("");
    expect(heat(null, 0.8)).toBe("");
  });
});

describe("buildInsightsGeoExactModel", () => {
  it("marks the active sub-tab and reports the dataset size for the footnote", () => {
    const model = buildInsightsGeoExactModel({
      activeTab: "queries",
      queryFilter: "all",
      overview: OVERVIEW,
      queries: QUERIES,
    });
    expect(model.tabs.filter((tab) => tab.active).map((tab) => tab.id)).toEqual(["queries"]);
    // The footnote's "full N-query dataset" is the served ranking-query count,
    // never the number of rows the table happens to be showing.
    expect(model.queryDatasetSize).toBe("220");
    expect(model.queries).toHaveLength(2);
    expect(model.methodology).toHaveLength(4);
  });

  it("prints the em-dash rather than a row count when no dataset size is served", () => {
    const model = buildInsightsGeoExactModel({
      activeTab: "queries",
      queryFilter: "all",
      overview: null,
      queries: QUERIES,
    });
    expect(model.queryDatasetSize).toBe("—");
  });
});
