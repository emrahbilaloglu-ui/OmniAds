import { describe, expect, it } from "vitest";

import {
  ANALYTICS_DEMO_DIMENSIONS,
  ANALYTICS_TABS,
  analyticsHeat,
  buildInsightsAnalyticsExactModel,
  buildOpportunities,
  formatCohortMonth,
  formatCohortWeek,
  landingSignal,
  retentionPill,
  type InsightsAnalyticsAdapterInput,
} from "./insights-analytics-exact-adapter";

function input(
  overrides: Partial<InsightsAnalyticsAdapterInput> = {},
): InsightsAnalyticsAdapterInput {
  return {
    activeTab: "overview",
    demoDimension: "country",
    windowDays: 28,
    ...overrides,
  };
}

describe("analytics sub-tabs", () => {
  it("matches the design's seven captions in order", () => {
    expect(ANALYTICS_TABS.map((tab) => tab.label)).toEqual([
      "Overview",
      "Products",
      "Landing pages",
      "Audience",
      "Demographics",
      "Cohorts",
      "Opportunities",
    ]);
  });
});

describe("heat ramp", () => {
  it("reproduces the design's alpha formula", () => {
    expect(analyticsHeat(0, 0.12)).toBe("rgba(14,159,110,0.050)");
    expect(analyticsHeat(0.12, 0.12)).toBe("rgba(14,159,110,0.350)");
    expect(analyticsHeat(0.24, 0.12)).toBe("rgba(14,159,110,0.350)");
    expect(analyticsHeat(0.06, 0.12)).toBe("rgba(14,159,110,0.200)");
  });

  it("shades nothing when the provider gave nothing", () => {
    expect(analyticsHeat(null, 0.12)).toBe("");
    expect(analyticsHeat(undefined, 0.12)).toBe("");
  });
});

describe("retention pill", () => {
  it("uses the design's four steps, with a readable 25-40% tier", () => {
    expect(retentionPill(0.45)).toEqual(["#0E9F6E", "#ffffff"]);
    expect(retentionPill(0.3)).toEqual(["#BFE5D6", "#065F46"]);
    expect(retentionPill(0.2)).toEqual(["#F5E1B0", "#92400E"]);
    expect(retentionPill(0.05)).toEqual(["#F6C6D2", "#9F1239"]);
  });
});

describe("KPI cards", () => {
  it("renders the design's six labels in sentence case", () => {
    const model = buildInsightsAnalyticsExactModel(input());
    expect(model.kpis.map((kpi) => kpi.label)).toEqual([
      "Sessions",
      "Engaged sessions",
      "Engagement rate",
      "Purchases",
      "Purchase CVR",
      "Revenue",
    ]);
  });

  it("fills the third line from the served comparison window", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({
        overview: {
          kpis: {
            sessions: 241_800,
            engagementRate: 0.656,
            purchaseCvr: 0.0177,
            revenue: 326_400,
          },
          previousKpis: {
            sessions: 223_500,
            engagementRate: 0.664,
            purchaseCvr: 0.0172,
            revenue: 297_300,
          },
        },
      }),
    );
    const [sessions, , engagement, , cvr] = model.kpis;
    expect(sessions.value).toBe("241.8K");
    expect(sessions.delta).toBe("+8.2% vs prev 28d");
    expect(sessions.deltaTone).toBe("positive");
    expect(engagement.value).toBe("65.6%");
    expect(engagement.delta).toBe("−0.80 pt");
    expect(engagement.deltaTone).toBe("warning");
    expect(cvr.value).toBe("1.77%");
  });

  it("renders the em-dash rather than inventing a comparison", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({ overview: { kpis: { sessions: 100 } } }),
    );
    expect(model.kpis[0]?.delta).toBe("—");
    expect(model.kpis[0]?.deltaTone).toBe("neutral");
    expect(model.kpis[5]?.value).toBe("—");
  });
});

describe("new vs returning cards", () => {
  it("is a three-up grid including engagement, with the badge on returning only", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({
        overview: {
          newVsReturning: {
            new: { sessions: 178_400, purchaseCvr: 0.0121, engagementRate: 0.612 },
            returning: {
              sessions: 63_400,
              purchaseCvr: 0.0336,
              engagementRate: 0.781,
            },
          },
        },
      }),
    );
    expect(model.segments).toHaveLength(2);
    expect(model.segments[0]).toMatchObject({
      label: "New visitors",
      badge: null,
      sessions: "178.4K",
      engagement: "61.2%",
      cvr: "1.21%",
      cvrHighlighted: false,
    });
    expect(model.segments[1]).toMatchObject({
      label: "Returning visitors",
      badge: "2.8× better CVR",
      engagement: "78.1%",
      cvr: "3.36%",
      cvrHighlighted: true,
    });
  });

  it("prefers the audience endpoint's segments when that tab fetched them", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({
        activeTab: "audience",
        overview: {
          newVsReturning: {
            new: { sessions: 1, purchaseCvr: 0.01 },
            returning: { sessions: 1, purchaseCvr: 0.01 },
          },
        },
        audience: {
          segments: {
            new: { sessions: 900, engagementRate: 0.5, purchaseCvr: 0.01 },
            returning: { sessions: 100, engagementRate: 0.9, purchaseCvr: 0.02 },
          },
        },
      }),
    );
    expect(model.segments[0]?.sessions).toBe("900");
    expect(model.segments[1]?.engagement).toBe("90.0%");
  });

  it("shows the em-dash when the property refuses the engagement metric", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({
        overview: {
          newVsReturning: {
            new: { sessions: 10, purchaseCvr: 0 },
            returning: { sessions: 5, purchaseCvr: 0 },
          },
        },
      }),
    );
    expect(model.segments[0]?.engagement).toBe("—");
  });
});

describe("callouts", () => {
  it("carries the design's three text kinds, never an icon", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({
        overview: {
          insights: [
            { type: "positive", text: "Returning users convert 2.8× better." },
            { type: "warning", text: "Engagement slipped." },
            { type: "neutral", text: "Content is doing silent selling." },
          ],
        },
      }),
    );
    expect(model.callouts.map((callout) => callout.kind)).toEqual([
      "Positive",
      "Warning",
      "Info",
    ]);
    expect(model.callouts.map((callout) => callout.tone)).toEqual([
      "positive",
      "warning",
      "neutral",
    ]);
  });
});

describe("landing pages", () => {
  it("uses the design's Healthy / Watch / Leaking vocabulary", () => {
    expect(
      landingSignal({ sessions: 22_140, engagementRate: 0.71, purchases: 642, purchaseCvr: 0.029 }),
    ).toEqual({ label: "Healthy", tone: "positive" });
    expect(
      landingSignal({ sessions: 31_260, engagementRate: 0.58, purchases: 469, purchaseCvr: 0.015 }),
    ).toEqual({ label: "Watch", tone: "warning" });
    expect(
      landingSignal({ sessions: 14_270, engagementRate: 0.38, purchases: 128, purchaseCvr: 0.009 }),
    ).toEqual({ label: "Leaking", tone: "negative" });
    expect(
      landingSignal({ sessions: 900, engagementRate: 0.62, purchases: 0, purchaseCvr: 0 }),
    ).toEqual({ label: "Leaking", tone: "negative" });
  });

  it("renders the six design columns and the design's footer note", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({
        activeTab: "landing",
        landingPages: [
          {
            path: "/collections/new",
            sessions: 22_140,
            engagementRate: 0.71,
            purchases: 642,
            purchaseCvr: 0.029,
          },
        ],
      }),
    );
    expect(model.landing[0]).toMatchObject({
      page: "/collections/new",
      sessions: "22,140",
      engagement: "71%",
      purchases: "642",
      cvr: "2.90%",
    });
    expect(model.landingNote).toBe(
      "Showing 1 of up to 50 rows · sorted by sessions · page fixes route to Launchpad as lander drafts.",
    );
  });
});

describe("products", () => {
  it("shades the three rate cells with the design's ceilings", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({
        activeTab: "products",
        products: [
          {
            name: "Aurora Tote",
            views: 48_210,
            addToCarts: 4_630,
            checkouts: 2_410,
            purchases: 1_552,
            revenue: 118_000,
            atcRate: 0.096,
            checkoutRate: 0.521,
            purchaseRate: 0.032,
          },
        ],
      }),
    );
    expect(model.products[0]).toMatchObject({
      name: "Aurora Tote",
      views: "48,210",
      atcRate: "9.6%",
      checkoutRate: "52.1%",
      purchaseRate: "3.2%",
      revenue: "$118.0K",
    });
    expect(model.products[0]?.atcHeat).toBe("rgba(14,159,110,0.290)");
    expect(model.productsNote).toBe(
      "Showing 1 of up to 50 rows · GA4 item-scoped events · higher rates are better, weak cells are where users leave.",
    );
  });
});

describe("demographics", () => {
  it("offers the design's seven chips in order", () => {
    const model = buildInsightsAnalyticsExactModel(input({ activeTab: "demo" }));
    expect(model.demoChips.map((chip) => chip.label)).toEqual([
      "Country",
      "Region",
      "City",
      "Language",
      "Age group",
      "Gender",
      "Interests",
    ]);
    expect(ANALYTICS_DEMO_DIMENSIONS).toHaveLength(7);
  });

  it("says 'site avg', and names the column in the singular for interests", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({
        activeTab: "demo",
        demoDimension: "brandingInterest",
        demographics: {
          summary: {
            topValue: "Travel Buffs",
            topValuePurchaseCvr: 0.0264,
            avgPurchaseCvr: 0.0177,
          },
        },
      }),
    );
    expect(model.demoColumn).toBe("Interest");
    expect(model.demoSummary).toBe(
      "Interest “Travel Buffs” has the highest purchase rate at 2.64% (site avg 1.77%).",
    );
  });

  it("draws no summary band when the endpoint had nothing to summarise", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({ activeTab: "demo", demographics: { rows: [], summary: null } }),
    );
    expect(model.demoSummary).toBeNull();
  });
});

describe("cohorts", () => {
  it("formats GA4 week and month keys the way the design prints them", () => {
    expect(formatCohortWeek("202627")).toBe("W27 '26");
    expect(formatCohortMonth("202603")).toBe("Mar '26");
    expect(formatCohortWeek(undefined)).toBe("—");
  });

  it("carries both tables so they can sit side by side", () => {
    const model = buildInsightsAnalyticsExactModel(
      input({
        activeTab: "cohorts",
        cohorts: {
          cohortWeeks: [
            {
              week: "202627",
              newSessions: 20_140,
              returningSessions: 6_890,
              newPurchases: 214,
              returningPurchases: 231,
              retentionRate: 0.245,
            },
          ],
          monthlyData: [
            {
              month: "202603",
              newUsers: 48_200,
              activeUsers: 71_400,
              sessions: 198_400,
              purchases: 3_214,
              revenue: 238_100,
              purchaseCvr: 0.0162,
            },
          ],
        },
      }),
    );
    expect(model.cohortWeeks[0]).toMatchObject({
      week: "W27 '26",
      retention: "24.5%",
      retentionBg: "#F5E1B0",
      retentionFg: "#92400E",
    });
    expect(model.cohortMonths[0]).toMatchObject({
      month: "Mar '26",
      newUsers: "48.2K",
      activeUsers: "71.4K",
      sessions: "198.4K",
      purchases: "3,214",
      cvr: "1.62%",
      revenue: "$238.1K",
    });
  });
});

describe("opportunities", () => {
  it("emits the design's three kind words and nothing outside them", () => {
    const cards = buildOpportunities({
      overview: {
        newVsReturning: {
          new: { sessions: 100, purchaseCvr: 0.01 },
          returning: { sessions: 50, purchaseCvr: 0.03 },
        },
      },
      landingPages: [
        { path: "/summer", sessions: 900, engagementRate: 0.2, purchases: 4, purchaseCvr: 0.004 },
        { path: "/tote", sessions: 500, engagementRate: 0.7, purchases: 40, purchaseCvr: 0.08 },
      ],
      products: [
        {
          name: "Strap Set",
          views: 9_950,
          addToCarts: 388,
          checkouts: 141,
          atcRate: 0.02,
          checkoutRate: 0.1,
        },
      ],
      audience: {
        channels: [
          {
            sourceMedium: "pinterest / social",
            sessions: 6_180,
            engagementRate: 0.2,
            purchaseCvr: 0,
          },
        ],
      },
    });
    expect(cards.map((card) => card.kind)).toEqual([
      "Opportunity",
      "Warning",
      "Strong",
      "Warning",
      "Warning",
      "Warning",
    ]);
    expect(cards[0]?.tone).toBe("info");
    expect(cards[2]?.tone).toBe("positive");
  });

  it("flags nothing when nothing crossed a threshold", () => {
    expect(buildOpportunities({})).toEqual([]);
  });
});
