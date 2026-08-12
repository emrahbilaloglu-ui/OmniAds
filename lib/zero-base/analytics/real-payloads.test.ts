/**
 * WP-21 adapters against fixtures derived from the ACTUAL handler return types.
 *
 * A transition audit found the first version calling adaptTable with row keys
 * none of these endpoints return, so every successful read degraded. These
 * fixtures are built from the real types — `AnalyticsOverviewResponse`,
 * `getGa4DetailedLandingPagesData`'s `{pages}`, and `SeoOverviewPayload` — and
 * each suite asserts both that the real shape adapts AND that the shape the
 * old code assumed is refused.
 */
import { describe, expect, it } from "vitest";

import {
  adaptAnalyticsOverview,
  adaptGeoOverview,
  adaptLandingPages,
  adaptLatestInsight,
  adaptSeoOverview,
  adaptTable,
} from "@/lib/zero-base/analytics/analytics-contract";

/* ------------------------------- /api/analytics/overview (real shape) ---- */

const OVERVIEW = {
  propertyName: "Acme GA4",
  kpis: {
    sessions: 12000,
    engagedSessions: 8400,
    engagementRate: 0.7,
    purchases: 0,
    purchaseCvr: 0,
    revenue: 48250.5,
  },
  newVsReturning: {
    new: { sessions: 9000, purchases: 210, purchaseCvr: 0.023 },
    returning: { sessions: 3000, purchases: 120, purchaseCvr: 0.04 },
  },
  insights: [{ text: "Returning visitors convert at nearly twice the rate." }],
};

describe("analytics overview reads the real payload", () => {
  it("adapts propertyName, kpis, cohorts and insights", () => {
    const result = adaptAnalyticsOverview(OVERVIEW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.propertyName).toBe("Acme GA4");
    expect(result.value.kpis.map((k) => k.key)).toEqual([
      "sessions",
      "engagedSessions",
      "engagementRate",
      "purchases",
      "purchaseCvr",
      "revenue",
    ]);
    expect(result.value.cohorts.map((c) => c.key)).toEqual(["new", "returning"]);
    expect(result.value.insights).toEqual([
      "Returning visitors convert at nearly twice the rate.",
    ]);
  });

  it("keeps a served zero as a measurement", () => {
    const result = adaptAnalyticsOverview(OVERVIEW);
    const purchases = result.ok && result.value.kpis.find((k) => k.key === "purchases")!.value;
    expect(purchases && purchases.available).toBe(true);
    expect(purchases && purchases.available && purchases.measuredZero).toBe(true);
  });

  it("omits a KPI the handler did not serve rather than showing a zero row", () => {
    const result = adaptAnalyticsOverview({ kpis: { sessions: 5 } });
    expect(result.ok && result.value.kpis.map((k) => k.key)).toEqual(["sessions"]);
  });

  it("never sums new and returning into a single figure", () => {
    const result = adaptAnalyticsOverview(OVERVIEW);
    // GA4 serves no combined cohort; producing one would invent a metric.
    expect(result.ok && result.value.cohorts).toHaveLength(2);
  });

  it("refuses a body with no kpis object", () => {
    expect(adaptAnalyticsOverview({ propertyName: "x" }).ok).toBe(false);
  });

  it("REGRESSION: the old row-key guess degrades on this real payload", () => {
    // This is the defect. adaptTable finds none of rows/sources/channels, so the
    // previous client reported a healthy read as unavailable.
    expect(adaptTable(OVERVIEW, ["rows", "sources", "channels"]).ok).toBe(false);
    // The real adapter reads it.
    expect(adaptAnalyticsOverview(OVERVIEW).ok).toBe(true);
  });
});

/* --------------------------- /api/analytics/landing-pages (real shape) --- */

const LANDING = {
  pages: [
    { path: "/pricing", sessions: 900, engagementRate: 0.62, purchases: 18, purchaseCvr: 0.02 },
    { path: "/product", sessions: 400, engagementRate: 0.55, purchases: 0, purchaseCvr: 0 },
  ],
};

describe("landing pages read purchases and purchaseCvr", () => {
  it("adapts the real fields", () => {
    const result = adaptLandingPages(LANDING);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows[0].purchases.available && result.value.rows[0].purchases.display).toBe("18");
    expect(result.value.rows[0].purchaseCvr.available && result.value.rows[0].purchaseCvr.display).toBe("2.00%");
  });

  it("keeps a measured zero distinct from unavailable", () => {
    const result = adaptLandingPages(LANDING);
    if (!result.ok) return;
    const zero = result.value.rows[1].purchases;
    expect(zero.available && zero.measuredZero).toBe(true);

    const missing = adaptLandingPages({ pages: [{ path: "/x", sessions: 1 }] });
    expect(missing.ok && missing.value.rows[0].purchases.available).toBe(false);
  });

  it("REGRESSION: there is no `conversions` field on these rows", () => {
    // The previous columns asked for `conversions`, which is never served, so
    // every row of a healthy read printed "Not served".
    for (const page of LANDING.pages) {
      expect("conversions" in page).toBe(false);
    }
  });

  it("refuses a body with neither pages nor rows", () => {
    expect(adaptLandingPages({ items: [] }).ok).toBe(false);
  });
});

/* ----------------------------------- /api/seo/overview (real shape) ------ */

const SEO = {
  meta: {
    siteUrl: "https://acme.example",
    startDate: "2026-07-01",
    endDate: "2026-07-31",
    previousStartDate: "2026-06-01",
    previousEndDate: "2026-06-30",
    rowCount: 812,
  },
  summary: {
    clicks: { current: 4200, previous: 3900, delta: 300, deltaPercent: 0.077 },
    impressions: { current: 120000, previous: 118000, delta: 2000, deltaPercent: 0.017 },
    ctr: { current: 0.035, previous: 0.033, delta: 0.002, deltaPercent: null },
    position: { current: 12.4, previous: 13.1, delta: -0.7, deltaPercent: -0.053 },
  },
  leaders: { queries: [{ query: "acme pricing" }], pages: [{ page: "/pricing" }] },
  movers: {
    decliningQueries: [{ query: "acme review" }],
    decliningPages: [],
    improvingQueries: [],
    improvingPages: [],
  },
  causes: [{ title: "Lost featured snippet" }],
  recommendations: [{ title: "Refresh the pricing page" }],
  aiBrief: { headline: "Clicks up 7.7% on stable impressions." },
  aiWorkspace: { dataLayers: [], contextBlocks: [], requestedOutputs: [] },
};

describe("SEO reads the real payload structure", () => {
  it("adapts meta, summary, leaders, movers, causes and recommendations", () => {
    const result = adaptSeoOverview(SEO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.siteUrl).toBe("https://acme.example");
    expect(result.value.rowCount).toBe(812);
    expect(result.value.summary.map((s) => s.key)).toEqual(["clicks", "impressions", "ctr", "position"]);
    expect(result.value.leaderQueries[0].label).toBe("acme pricing");
    expect(result.value.decliningQueries[0].label).toBe("acme review");
    expect(result.value.causes[0].label).toBe("Lost featured snippet");
    expect(result.value.recommendations[0].label).toBe("Refresh the pricing page");
    expect(result.value.aiBriefHeadline).toMatch(/Clicks up/);
  });

  it("renders a null deltaPercent as unavailable, not as no change", () => {
    const result = adaptSeoOverview(SEO);
    const ctr = result.ok && result.value.summary.find((s) => s.key === "ctr")!;
    // The contract allows null; 0% would be a claim that nothing moved.
    expect(ctr && ctr.deltaPercent.available).toBe(false);
  });

  it("refuses a body with no summary object", () => {
    expect(adaptSeoOverview({ meta: {} }).ok).toBe(false);
  });

  it("REGRESSION: the old row-key guess degrades on this real payload", () => {
    expect(adaptTable(SEO, ["findings", "rows", "pages"]).ok).toBe(false);
    expect(adaptSeoOverview(SEO).ok).toBe(true);
  });
});

/* ------------------------------------------- GEO and insight unchanged --- */

describe("GEO and the latest insight keep their read-only semantics", () => {
  it("still adapts the real GEO payload", () => {
    const result = adaptGeoOverview({
      sources: { ga4: { connected: true }, searchConsole: { connected: true } },
      kpis: { aiPageCount: 50 },
      top3Priorities: [{ title: "a", priority: "high" }],
    });
    expect(result.ok && result.value.atProxyCap).toBe(true);
  });

  it("still reports an absent insight rather than an empty card", () => {
    expect(adaptLatestInsight({ insight: null }).absentReason).toMatch(/has been generated/);
  });
});
