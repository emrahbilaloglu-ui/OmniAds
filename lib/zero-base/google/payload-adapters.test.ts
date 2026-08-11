/**
 * The adapters, against the shapes the ACTUAL endpoints return.
 *
 * The fixtures below are the real payload keys: `/api/google-ads/overview`
 * serves `{kpis, kpiDeltas, topCampaigns, insights, summary, meta}`, and the
 * advisor serves `GoogleRecommendation` objects with `doBucket`, `rankScore`,
 * `executionTarget*` and `deepLinkUrl`. The first version of these clients was
 * typed against `{accounts, rows}` and an invented recommendation, which is why
 * the surface rendered nothing while calling the read "serving".
 */
import { describe, expect, it } from "vitest";

import {
  adaptCollection,
  adaptOverview,
  adaptRecommendations,
  adaptReportMeta,
  adaptScopeAccounts,
  sourceStateFromMeta,
} from "@/lib/zero-base/google/payload-adapters";

/** Exactly the keys app/api/google-ads/overview/route.ts returns. */
const OVERVIEW_PAYLOAD = {
  kpis: { cost: 1234.5, conversions: 42 },
  kpiDeltas: { cost: 0.12, conversions: null },
  topCampaigns: [
    { id: "c-1", name: "Brand", cost: 500, conversions: 20, badges: [] },
    { campaignId: "c-2", campaignName: "Generic", cost: 734.5, conversions: 22, badges: [] },
  ],
  insights: [],
  summary: {},
  meta: { partial: false, warnings: [], failed_queries: [] },
};

describe("overview adapter reads the real payload", () => {
  it("maps kpis, deltas and campaigns", () => {
    const result = adaptOverview(OVERVIEW_PAYLOAD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kpis).toEqual([
      { key: "cost", value: 1234.5, delta: 0.12 },
      { key: "conversions", value: 42, delta: null },
    ]);
    expect(result.value.campaigns.map((c) => c.id)).toEqual(["c-1", "c-2"]);
    expect(result.value.campaigns[1].name).toBe("Generic");
  });

  it("refuses the shape the first version assumed", () => {
    // `{accounts, rows}` is what the client used to expect; the endpoint never
    // returned it, and treating it as an empty success is the defect.
    const result = adaptOverview({ accounts: [], rows: [] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/did not carry the expected kpis and topCampaigns/);
  });

  it("refuses a non-object body", () => {
    expect(adaptOverview(null).ok).toBe(false);
    expect(adaptOverview("nope").ok).toBe(false);
  });
});

describe("report meta drives the source state", () => {
  it("reports serving on a clean read", () => {
    expect(sourceStateFromMeta(adaptReportMeta(OVERVIEW_PAYLOAD.meta)).kind).toBe("serving");
  });

  it("reports partial when a query failed", () => {
    const state = sourceStateFromMeta(
      adaptReportMeta({ partial: true, warnings: ["campaign_core_basic degraded"], failed_queries: [{}] }),
    );
    expect(state.kind).toBe("partial");
    expect(state.kind === "partial" && state.reason).toMatch(/1 query\/queries failed/);
  });

  it("reports unavailable when provider truth was never obtained", () => {
    // A projection is not a measurement; calling it "serving with warnings"
    // would present one as the other.
    const state = sourceStateFromMeta(
      adaptReportMeta({ partial: false, warnings: [], failed_queries: [], readSource: "provider_truth_unavailable" }),
    );
    expect(state.kind).toBe("unavailable");
  });

  it("treats degraded as partial", () => {
    expect(
      sourceStateFromMeta(adaptReportMeta({ degraded: true, warnings: [], failed_queries: [] })).kind,
    ).toBe("partial");
  });
});

describe("advisor adapter reads real GoogleRecommendation fields", () => {
  const payload = {
    recommendations: [
      {
        id: "r1",
        title: "Raise budget",
        summary: "Impression share lost to budget.",
        why: "why",
        doBucket: "do_now",
        rankScore: 91.2,
        level: "campaign",
        entityId: "c-1",
        entityName: "Brand",
        executionTargetType: "campaign",
        executionTargetId: "c-1",
        deepLinkUrl: "https://ads.google.com/aw/campaigns?id=c-1",
        rollbackGuidance: "Revert within 24h.",
      },
      { id: "r2", title: "Later thing", doBucket: "do_later", rankScore: 10 },
    ],
  };

  it("maps every field this programme reads", () => {
    const result = adaptRecommendations(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      id: "r1",
      doBucket: "do_now",
      rankScore: 91.2,
      executionTargetType: "campaign",
      deepLinkUrl: "https://ads.google.com/aw/campaigns?id=c-1",
    });
  });

  it("defaults an unknown bucket to do_later rather than promoting it", () => {
    const result = adaptRecommendations({ recommendations: [{ id: "x", title: "t", doBucket: "urgent" }] });
    expect(result.ok && result.value[0].doBucket).toBe("do_later");
  });

  it("drops an item with no id rather than keying it by index", () => {
    const result = adaptRecommendations({ recommendations: [{ title: "no id" }] });
    expect(result.ok && result.value).toHaveLength(0);
  });

  it("refuses a payload with no recommendations array", () => {
    const result = adaptRecommendations({ items: [] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/did not carry a recommendations array/);
  });

  it("carries no accountId, because the served recommendation has none", () => {
    const result = adaptRecommendations(payload);
    expect(result.ok && Object.keys(result.value[0])).not.toContain("accountId");
  });
});

describe("scope adapter", () => {
  it("maps served accounts and their nullable profile", () => {
    const result = adaptScopeAccounts({
      accounts: [{ id: "123", name: "Main", currency: "USD", timezone: "UTC" }, { id: "456" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[1]).toEqual({ id: "456", name: null, currency: null, timezone: null });
  });

  it("refuses rather than inventing an account", () => {
    expect(adaptScopeAccounts({}).ok).toBe(false);
    expect(adaptScopeAccounts({ accounts: [] }).ok).toBe(false);
    expect(adaptScopeAccounts({ accounts: [{ name: "no id" }] }).ok).toBe(false);
  });
});

describe("collection adapter", () => {
  it("finds the rows under whichever real key the endpoint used", () => {
    for (const key of ["rows", "products", "assets"]) {
      const result = adaptCollection({ [key]: [{ id: "1", title: "x", clicks: 3 }] }, ["rows", "products", "assets"]);
      expect(result.ok, key).toBe(true);
      expect(result.ok && result.value.rows[0].clicks).toBe(3);
    }
  });

  it("refuses when none of the expected collections is present", () => {
    const result = adaptCollection({ somethingElse: [] }, ["rows", "products"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/none of the expected collections/);
  });

  it("carries the row cap only when served", () => {
    expect(adaptCollection({ rows: [], rowCap: 500 }, ["rows"]).ok).toBe(true);
    const noCap = adaptCollection({ rows: [] }, ["rows"]);
    expect(noCap.ok && noCap.value.rowCap).toBeNull();
  });
});
