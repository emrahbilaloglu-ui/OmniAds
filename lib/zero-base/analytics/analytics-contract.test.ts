/**
 * The adapters, against the shapes the ACTUAL endpoints return.
 *
 * The GEO fixture mirrors `app/api/geo/overview/route.ts`: a `sources` object
 * with `ga4`/`searchConsole`, a `kpis` object whose `aiPageCount` is
 * `Math.min(rowCount, 50)`, and `top3Priorities` already sliced server-side.
 */
import { describe, expect, it } from "vitest";

import {
  AI_GENERATE_ENDPOINT,
  BACKEND_CAP_NOT_SUPPLIED,
  GEO_PAGE_COUNT_PROXY_CAP,
  GEO_PROXY_DISCLOSURE,
  GEO_TOP_THREE_DISCLOSURE,
  adaptGeoOverview,
  adaptLatestInsight,
  adaptSources,
  adaptTable,
  analyticsValue,
  dualSourceState,
  seoRoleState,
} from "@/lib/zero-base/analytics/analytics-contract";

const GEO_PAYLOAD = {
  sources: { ga4: { connected: true }, searchConsole: { connected: true } },
  kpis: {
    aiSessions: 120,
    aiEngagementRate: 0,
    aiPageCount: 50,
    geoScore: 61,
    topAiSource: "chatgpt",
  },
  insights: [],
  top3Priorities: [
    { title: "Publish comparison pages", priority: "high", detail: "AI cites competitors." },
    { title: "Add FAQ schema", priority: "medium", detail: null },
    { title: "Refresh pricing page", priority: "low", detail: null },
  ],
};

describe("measured zero is not unavailable", () => {
  it("marks a served zero as a measurement", () => {
    const value = analyticsValue(0, String);
    expect(value.available).toBe(true);
    expect(value.available && value.measuredZero).toBe(true);
  });

  it("reports an absent value with a reason", () => {
    for (const absent of [null, undefined, "12", Number.NaN]) {
      expect(analyticsValue(absent, String).available).toBe(false);
    }
  });
});

describe("dual-source panels", () => {
  it("reports both connected", () => {
    const panels = adaptSources(GEO_PAYLOAD);
    expect(panels.map((p) => p.connected)).toEqual([true, true]);
    expect(dualSourceState(panels).kind).toBe("serving");
  });

  it("degrades to partial when one source is down, keeping the other", () => {
    const panels = adaptSources({
      sources: { ga4: { connected: true }, searchConsole: { connected: false, error: "Token expired." } },
    });
    const state = dualSourceState(panels);
    // Blanking the page would discard measurements we actually have.
    expect(state.kind).toBe("partial");
    expect(state.reason).toMatch(/Search Console/);
    expect(state.reason).toMatch(/missing rather than zero/);
  });

  it("carries the provider's verbatim error", () => {
    const panels = adaptSources({
      sources: { ga4: { connected: false, error: "GA4 property not selected." }, searchConsole: { connected: true } },
    });
    expect(panels[0].error).toBe("GA4 property not selected.");
  });

  it("reports unavailable only when both are down", () => {
    const panels = adaptSources({ sources: { ga4: { connected: false }, searchConsole: { connected: false } } });
    expect(dualSourceState(panels).kind).toBe("unavailable");
  });

  it("treats an unreported source as not connected rather than assuming it", () => {
    expect(adaptSources({})[0].connected).toBe(false);
  });
});

describe("GEO proxy and top-three disclosures", () => {
  it("adapts the real payload", () => {
    const result = adaptGeoOverview(GEO_PAYLOAD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.priorities).toHaveLength(3);
    expect(result.value.aiPageCount.available && result.value.aiPageCount.raw).toBe(50);
  });

  it("flags the 50 ceiling as a proxy, not a measurement", () => {
    const result = adaptGeoOverview(GEO_PAYLOAD);
    expect(result.ok && result.value.atProxyCap).toBe(true);
    expect(GEO_PROXY_DISCLOSURE).toMatch(/capped at 50/);
    expect(GEO_PROXY_DISCLOSURE).toMatch(/at least 50/);
    expect(GEO_PAGE_COUNT_PROXY_CAP).toBe(50);
  });

  it("does not flag a count below the ceiling", () => {
    const result = adaptGeoOverview({ ...GEO_PAYLOAD, kpis: { ...GEO_PAYLOAD.kpis, aiPageCount: 12 } });
    expect(result.ok && result.value.atProxyCap).toBe(false);
  });

  it("shows exactly the three the server sliced, and says more may exist", () => {
    const result = adaptGeoOverview({
      ...GEO_PAYLOAD,
      // Even if a future server sent more, the surface shows what it received
      // and never pads or re-slices to manufacture a ranking.
      top3Priorities: GEO_PAYLOAD.top3Priorities,
    });
    expect(result.ok && result.value.priorities).toHaveLength(3);
    expect(GEO_TOP_THREE_DISCLOSURE).toMatch(/Others may exist/);
  });

  it("refuses a payload with no kpis object", () => {
    const result = adaptGeoOverview({ sources: {} });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/did not carry the expected kpis/);
  });
});

describe("served caps only", () => {
  it("states the cap the backend supplied", () => {
    const result = adaptTable({ rows: [{ id: 1 }, { id: 2 }], rowLimit: 300 }, ["rows", "pages"]);
    expect(result.ok && result.value.capText).toMatch(/Showing 2 of up to 300/);
  });

  it("says the backend supplied none rather than printing a spec number", () => {
    const result = adaptTable({ pages: [{ id: 1 }] }, ["rows", "pages"]);
    expect(result.ok && result.value.servedCap).toBeNull();
    expect(result.ok && result.value.capText).toBe(BACKEND_CAP_NOT_SUPPLIED);
  });

  it("says more may exist when the page fills the cap", () => {
    const result = adaptTable({ rows: [{ id: 1 }, { id: 2 }], rowLimit: 2 }, ["rows"]);
    expect(result.ok && result.value.capText).toMatch(/More may exist/);
  });

  it("refuses when no expected collection is present", () => {
    expect(adaptTable({ somethingElse: [] }, ["rows", "pages"]).ok).toBe(false);
  });
});

describe("AI insight is read only", () => {
  it("adapts a served insight", () => {
    const result = adaptLatestInsight({ insight: { content: "Traffic shifted to AI sources.", createdAt: "2026-08-01" } });
    expect(result.text).toBe("Traffic shifted to AI sources.");
    expect(result.absentReason).toBeNull();
  });

  it("says none exists rather than rendering an empty card", () => {
    // The real endpoint returns { insight: null }.
    expect(adaptLatestInsight({ insight: null }).absentReason).toMatch(/has been generated/);
  });

  it("names the generate endpoint only so tests can assert it is never called", () => {
    expect(AI_GENERATE_ENDPOINT).toBe("/api/ai/insights/generate");
  });
});

describe("SEO role gate", () => {
  it("allows collaborators and admins", () => {
    expect(seoRoleState("collaborator").allowed).toBe(true);
    expect(seoRoleState("admin").allowed).toBe(true);
  });

  it("blocks a guest with a stated reason rather than hiding silently", () => {
    const state = seoRoleState("guest");
    expect(state.allowed).toBe(false);
    expect(!state.allowed && state.reason).toMatch(/cannot change them/);
  });

  it("blocks an unknown role", () => {
    expect(seoRoleState(null).allowed).toBe(false);
  });
});
