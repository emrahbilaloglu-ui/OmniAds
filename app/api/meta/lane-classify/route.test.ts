import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { metaRec } from "@/components/meta/redesign/test-fixtures";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/api/meta", () => ({
  resolveMetaCredentials: vi.fn(),
}));

vi.mock("@/lib/meta/snapshot", () => ({
  readMetaDecisionSnapshotForRange: vi.fn(),
}));

vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/adsets-source", () => ({
  getMetaAdSetsForRange: vi.fn(),
}));

vi.mock("@/lib/creative-decision-engine/campaign-context/source", async (
  importOriginal,
) => {
  const actual = await importOriginal<
    typeof import("@/lib/creative-decision-engine/campaign-context/source")
  >();
  return { ...actual, readCampaignContextMap: vi.fn(async () => new Map()) };
});
vi.mock("@/lib/meta/request-model-store", () => ({
  readPreviousDifferentMetaAdSetConfigHistoryDiffs: vi.fn(async () => new Map()),
  readPreviousDifferentMetaCampaignConfigHistoryDiffs: vi.fn(async () => new Map()),
}));

const access = await import("@/lib/access");
const apiMeta = await import("@/lib/api/meta");
const db = await import("@/lib/db");
const snapshot = await import("@/lib/meta/snapshot");
const campaigns = await import("@/lib/meta/campaigns-source");
const adsets = await import("@/lib/meta/adsets-source");
const { GET } = await import("@/app/api/meta/lane-classify/route");
const contextSource = await import(
  "@/lib/creative-decision-engine/campaign-context/source"
);
const { CAMPAIGN_CONTEXT_RESOLVER_VERSION } = await import(
  "@/lib/creative-decision-engine/campaign-context/resolver"
);
const { buildMetaOsDecisionsPresentation } = await import(
  "@/lib/meta/decisions-os-presentation"
);

function mockSql(rows: Array<Record<string, unknown>> = []) {
  vi.mocked(db.getDb).mockReturnValue(
    vi.fn(async (strings: TemplateStringsArray) => {
      const query = Array.from(strings).join(" ");
      if (query.includes("meta_decision_responses") || query.includes("meta_ads_action_log")) {
        return rows;
      }
      return [];
    }) as never,
  );
}

/*
  ── ROUND 6 AUDIT ITEM 6: THE CHAIN ENDS AT THE ROUTE ───────────────────────
  `campaign-kind-runtime-chain.test.ts` proves a stale persisted `campaignKind`
  is dropped by the snapshot read and cannot reach the presentation shape. What
  it does NOT drive is THIS route, which is the second authority boundary:
  `attachCampaignKindToRecommendation` used to read
  `input.rec.campaignKind ?? campaignKindForRecommendation(...)`, so a kind the
  snapshot payload carried won without the trusted role map being consulted at
  all.

  These cases drive the real exported GET. The snapshot payload carries a stale
  kind, `readCampaignContextMap` answers with each refused context state in
  turn, and the served row must carry no `campaignKind` and no structure-review
  action label. The trusted control at the end returns it.
*/
describe("GET /api/meta/lane-classify — a stale campaignKind cannot survive the route", () => {
  const CAMPAIGN = "cmp_1";

  const contextRow = (over: Record<string, unknown> = {}) =>
    new Map([
      [
        CAMPAIGN,
        {
          kind: "main",
          contextTrust: "high",
          confidenceClass: "high",
          inferenceConfidenceClass: "high",
          resolverAuthorityValidated: true,
          source: "system_inferred",
          resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
          provenance: {
            mode: "automatic",
            source: "system_inferred",
            campaignId: CAMPAIGN,
            kind: "main",
            contextTrust: "high",
          },
          ...over,
        },
      ],
    ]) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue(null);
    mockSql([]);
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [],
      evidenceSource: "live",
    } as never);
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: CAMPAIGN,
          name: "ASC Prospecting",
          status: "ACTIVE",
          spend: 800,
          purchases: 9,
          roas: 2.8,
          cpa: 31,
          optimizationGoal: "Purchase",
          dailyBudget: 100,
          lifetimeBudget: null,
        },
      ],
      evidenceSource: "live",
    } as never);
  });

  /**
   * The row the route actually serves, plus the structure-inventory entry for
   * the same campaign — both are authority-bearing and both are built from the
   * role map, so a stale kind that survived either one would reach an operator.
   */
  const serve = async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d",
      ),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      actionNow?: Array<Record<string, unknown>>;
      watching?: Array<Record<string, unknown>>;
      structureInventory?: Array<Record<string, unknown>>;
    };
    const rec = [...(payload.actionNow ?? []), ...(payload.watching ?? [])].find(
      (row) => row.campaignId === CAMPAIGN,
    );
    const inventory = (payload.structureInventory ?? []).find(
      (row) => row.id === CAMPAIGN && row.level === "campaign",
    );
    return { rec, inventory };
  };

  /**
   * The label an operator actually reads, produced by the same presentation
   * builder the decisions workspace calls — fed with the ROUTE'S OWN output.
   *
   * This is what extends the chain past the snapshot proof: it is no longer a
   * hand-built recommendation being presented, it is the object this GET
   * serialized. A stale `mixed` that survived the route would render here as
   * "Review Structure", telling an operator to restructure a campaign whose
   * role the resolver refused to state.
   */
  const servedActionLabel = (rec: unknown): string | null => {
    const served = buildMetaOsDecisionsPresentation({
      actionNow: [rec],
      watching: [],
      nonSales: [],
      decisionReadModel: {
        source: { snapshotAsOf: null, engineVersion: null },
        queue: { sections: {} },
        structure: { entities: [] },
      },
      currency: "USD",
      generatedAt: "2026-09-03T00:00:00.000Z",
    } as never);
    const node = served.structure?.groups?.[0]?.campaign ?? null;
    return (node?.action?.label as string | undefined) ?? null;
  };

  const staleSnapshot = (staleKind: string) => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      snapshotDate: "2026-05-06",
      snapshotCreatedAt: "2026-05-06T03:10:00.000Z",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_stale_kind",
          campaignId: CAMPAIGN,
          decisionState: "act",
          /*
            `scale_for_volume`, not the fixture's default
            `rebuild_with_constraints`: the rebuild shape wins the action label
            outright, which would make the label assertions below vacuous. On a
            scale row the structure-review shape is genuinely reachable, so the
            label is decided by `campaignKind` and nothing else.
          */
          type: "scale_for_volume",
          lens: "volume",
          // THE STALE VALUE, as a persisted payload carries it.
          campaignKind: staleKind as never,
        }),
      ],
    } as never);
  };

  /*
    The five ways `isContextTrustedForAction` refuses, plus the absent row.
    Each override targets the exact field the predicate reads — the route takes
    `source` from `entry.provenance`, not from the entry itself, so overriding
    the entry's own `source` would leave the entry trusted and the case would
    prove nothing.
  */
  const REFUSED: Array<[string, Record<string, unknown> | null]> = [
    ["no context row at all", null],
    ["medium inference confidence", { inferenceConfidenceClass: "medium" }],
    ["an unvalidated resolver identity", { resolverAuthorityValidated: false }],
    [
      "a resolver that reported no identity",
      { resolverAuthorityValidated: undefined },
    ],
    ["medium context trust", { contextTrust: "medium" }],
    [
      "an operator override as the provenance",
      {
        provenance: {
          mode: "manual",
          source: "user_override",
          campaignId: CAMPAIGN,
          kind: "main",
          contextTrust: "high",
        },
      },
    ],
  ];

  for (const staleKind of ["mixed", "test", "main"]) {
    it.each(REFUSED)(
      `serves no campaignKind for a stale "${staleKind}" under %s`,
      async (_name, over) => {
        staleSnapshot(staleKind);
        vi.mocked(contextSource.readCampaignContextMap).mockResolvedValue(
          over === null ? (new Map() as never) : contextRow(over),
        );

        const { rec, inventory } = await serve();
        expect(rec, "the row itself must still be served").toBeTruthy();
        expect(rec?.campaignKind).toBeUndefined();
        // The inventory entry is built from the same map and must agree.
        expect(inventory, "the inventory entry must still be served").toBeTruthy();
        expect(inventory?.campaignKind ?? null).toBeNull();
        /*
          And the label an operator reads is not the structure-review one. The
          `toBeTruthy` guard first: a builder that produced no node at all would
          satisfy `not.toBe` while proving nothing.
        */
        expect(servedActionLabel(rec)).toBeTruthy();
        expect(servedActionLabel(rec)).not.toBe("Review Structure");
      },
    );
  }

  it("returns a TRUSTED canonical mixed, which is what makes the refusals discriminating", async () => {
    staleSnapshot("main");
    vi.mocked(contextSource.readCampaignContextMap).mockResolvedValue(
      contextRow({
        kind: "mixed",
        provenance: {
          mode: "automatic",
          source: "system_inferred",
          campaignId: CAMPAIGN,
          kind: "mixed",
          contextTrust: "high",
        },
      }),
    );

    const { rec, inventory } = await serve();
    // The trusted map result wins over the stale stored "main"...
    expect(rec?.campaignKind).toBe("mixed");
    expect(inventory?.campaignKind).toBe("mixed");
    // ...and only then does the structure-review label appear.
    expect(servedActionLabel(rec)).toBe("Review Structure");
  });
});

describe("GET /api/meta/lane-classify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue(null);
    mockSql([{ rec_id: "rec_deferred", action: "deferred", action_subtype: "let_cook_24h", occurred_at: "2026-05-07T00:00:00.000Z" }]);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      snapshotDate: "2026-05-06",
      snapshotCreatedAt: "2026-05-06T03:10:00.000Z",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 3,
      },
      recommendations: [
        metaRec({ id: "rec_action", confidenceScore: 0.82, decisionState: "act" }),
        metaRec({ id: "rec_deferred", confidenceScore: 0.84, decisionState: "act" }),
        metaRec({ id: "rec_watch", confidenceScore: 0.42, decisionState: "watch" }),
      ],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_1",
          name: "ASC Prospecting",
          status: "ACTIVE",
          spend: 800,
          purchases: 9,
          roas: 2.8,
          cpa: 31,
          optimizationGoal: "Purchase",
          bidStrategyType: "cost_cap",
          bidStrategyLabel: "Cost Cap",
          bidValue: 1500,
          bidValueFormat: "currency",
          previousBidValue: 1200,
          previousBidValueFormat: "currency",
          previousBidValueCapturedAt: "2026-05-01T00:00:00.000Z",
          dailyBudget: 100,
          lifetimeBudget: null,
        },
        {
          id: "cmp_healthy",
          name: "Healthy ASC",
          status: "ACTIVE",
          spend: 500,
          purchases: 12,
          roas: 3,
          cpa: 25,
          optimizationGoal: "Purchase",
          bidStrategyType: "cost_cap",
          bidStrategyLabel: "Cost Cap",
          manualBidAmount: 1200,
          previousManualBidAmount: 1000,
          bidValue: 1200,
          bidValueFormat: "currency",
          previousBidValue: 1000,
          previousBidValueFormat: "currency",
          previousBidValueCapturedAt: "2026-03-31T00:00:00.000Z",
          isOptimizationGoalMixed: false,
          isBidStrategyMixed: false,
          isBidValueMixed: false,
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [{
        id: "adset_healthy",
        name: "Healthy Broad",
        campaignId: "cmp_healthy",
        status: "ACTIVE",
        spend: 120,
        purchases: 4,
        roas: 2.4,
        cpa: 30,
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 900,
        previousManualBidAmount: 700,
        bidValue: 900,
        bidValueFormat: "currency",
        previousBidValue: 700,
        previousBidValueFormat: "currency",
        previousBidValueCapturedAt: "2026-04-01T00:00:00.000Z",
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
      }] as never,
      evidenceSource: "live",
    });
  });

  it("classifies action, watching, deferred, and healthy lanes", async () => {
    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.actionNow.map((rec: { id: string }) => rec.id)).toEqual(["rec_action"]);
    expect(payload.actionNow[0].entityConfiguration).toMatchObject({
      bidStrategyType: "cost_cap",
      bidStrategyLabel: "Cost Cap",
      bidValue: 1500,
      previousBidValue: 1200,
      previousBidValueCapturedAt: "2026-05-01T00:00:00.000Z",
      dailyBudget: 100,
      budgetUtilization: expect.any(Number),
    });
    expect(payload.watching.map((rec: { id: string }) => rec.id)).toEqual(["rec_deferred", "rec_watch"]);
    expect(payload.healthy[0].name).toBe("Healthy ASC");
    expect(payload.healthy[0]).toMatchObject({
      optimizationGoal: "Purchase",
      bidStrategyLabel: "Cost Cap",
      bidValue: 1200,
      previousBidValue: 1000,
      previousBidValueCapturedAt: "2026-03-31T00:00:00.000Z",
    });
    expect(payload.healthy[1]).toMatchObject({
      id: "adset_healthy",
      campaignId: "cmp_healthy",
      campaignName: "Healthy ASC",
      optimizationGoal: "Purchase",
      bidStrategyLabel: "Bid Cap",
      bidValue: 900,
      previousBidValue: 700,
      previousBidValueCapturedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(payload.deferredIds).toEqual(["rec_deferred"]);
    expect(payload.watching[0]).toMatchObject({ id: "rec_deferred", operatorResponseState: "deferred" });
    expect(payload.watchingSegments).toEqual([
      expect.objectContaining({ key: "deferred", count: 1 }),
      expect.objectContaining({ key: "insufficient_signal", count: 1 }),
    ]);
    expect(payload.counts.nonSales).toBe(0);
    expect(payload.counts.archive).toBe(0);
    expect(payload.statusFilter).toBe("active");
    expect(payload.structureInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cmp_1",
          level: "campaign",
          status: "ACTIVE",
          metrics: expect.objectContaining({ spend: 800, roas: 2.8 }),
        }),
        expect.objectContaining({
          id: "adset_healthy",
          level: "adset",
          campaignId: "cmp_healthy",
        }),
      ]),
    );
    expect(campaigns.getMetaCampaignsForRange).toHaveBeenCalledWith(
      expect.objectContaining({ includePrev: true, includePrevBudget: true }),
    );
    expect(adsets.getMetaAdSetsForRange).toHaveBeenCalledWith(
      expect.objectContaining({ includePrev: true, includePrevBudget: true }),
    );
  });

  it("keeps complete Structure inventory but removes previous-history work from the compact OS path", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d&status_filter=all&decision_workspace=1&workspace_surface=os",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.statusFilter).toBe("all");
    expect(payload.structureInventory).toHaveLength(3);
    expect(payload.healthy).toEqual([]);
    expect(campaigns.getMetaCampaignsForRange).toHaveBeenCalledWith(
      expect.objectContaining({ includePrev: false, includePrevBudget: false }),
    );
    expect(adsets.getMetaAdSetsForRange).toHaveBeenCalledWith(
      expect.objectContaining({ includePrev: false, includePrevBudget: false }),
    );
  });

  it("rechecks compact workspace recommendations before filtering stale warehouse status", async () => {
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      accessToken: "token",
      accountIds: ["act_1"],
      accountProfiles: {},
    } as never);
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.searchParams.get("ids")).toContain("cmp_reactivated");
      return new Response(
        JSON.stringify({
          cmp_reactivated: {
            id: "cmp_reactivated",
            status: "ACTIVE",
            effective_status: "ACTIVE",
            updated_time: "2026-07-13T10:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-07-06",
      endDate: "2026-07-12",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_reactivated",
          campaignId: "cmp_reactivated",
          campaignName: "Reactivated after warehouse snapshot",
          confidenceScore: 0.9,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_reactivated",
          name: "Reactivated after warehouse snapshot",
          status: "PAUSED",
          spend: 500,
          purchases: 5,
          roas: 2,
          cpa: 100,
          optimizationGoal: "PURCHASE",
        },
      ] as never,
      evidenceSource: "snapshot",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "snapshot",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/lane-classify?businessId=biz_1&window=7d&status_filter=all&decision_workspace=1&workspace_surface=os",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payload.actionNow).toEqual([
      expect.objectContaining({
        id: "rec_reactivated",
        campaignId: "cmp_reactivated",
      }),
    ]);
    expect(payload.structureInventory).toEqual([
      expect.objectContaining({ id: "cmp_reactivated", status: "ACTIVE" }),
    ]);
  });

  it("serves the true snapshot as-of, not the requested range end", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    // The mocked snapshot read returns endDate 2026-05-07 but the served
    // rows' snapshot_date is 2026-05-06 - the payload must expose the
    // latter (echoing endDate overstated freshness and mis-scoped defers).
    expect(payload.snapshotDate).toBe("2026-05-06");
    expect(payload.snapshotCreatedAt).toBe("2026-05-06T03:10:00.000Z");
  });

  it("clears stale pause acted state when the current ad set is active again", async () => {
    mockSql([{ rec_id: "rec_acted", action: "acted", action_subtype: "paused", occurred_at: "2026-05-17T07:39:24.000Z" }]);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_acted",
          level: "adset",
          adsetId: "adset_acted",
          adsetName: "Paused Adset",
          type: "adset_cut_spend",
          confidenceScore: 0.95,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [{
        id: "adset_acted",
        name: "Paused Adset",
        campaignId: "cmp_1",
        status: "ACTIVE",
        statusUpdatedAt: "2026-05-17T08:00:00.000Z",
        spend: 900,
        purchases: 1,
        roas: 0.17,
        cpa: null,
      }] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.actionNow[0]).toMatchObject({ id: "rec_acted" });
    expect(payload.actionNow[0]).not.toHaveProperty("operatorResponseState");
    expect(payload.actionNow[0]).not.toHaveProperty("operatorResponseSubtype");
  });

  it("keeps a verified pause action when the active status snapshot is older than the action", async () => {
    mockSql([{ rec_id: "rec_acted", action: "acted", action_subtype: "pause", occurred_at: "2026-05-17T08:52:43.585Z" }]);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_acted",
          level: "adset",
          adsetId: "adset_acted",
          adsetName: "Paused Adset",
          type: "adset_cut_spend",
          confidenceScore: 0.95,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [{
        id: "adset_acted",
        name: "Paused Adset",
        campaignId: "cmp_1",
        status: "ACTIVE",
        statusUpdatedAt: "2026-05-17T08:52:14.234Z",
        spend: 900,
        purchases: 1,
        roas: 0.17,
        cpa: null,
      }] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d&status_filter=all"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.actionNow[0]).toMatchObject({
      id: "rec_acted",
      operatorResponseState: "acted",
      operatorResponseSubtype: "pause",
      operatorResponseAt: "2026-05-17T08:52:43.585Z",
    });
  });

  it("clears acted pause state when live Meta status shows the ad set was reactivated externally", async () => {
    mockSql([{ rec_id: "rec_acted", action: "acted", action_subtype: "pause", occurred_at: "2026-05-17T08:52:43.585Z" }]);
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      accessToken: "token",
      accountIds: ["act_1"],
      accountProfiles: {},
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            adset_acted: {
              id: "adset_acted",
              effective_status: "ACTIVE",
              status: "ACTIVE",
              updated_time: "2026-05-17T09:10:00+0000",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_acted",
          level: "adset",
          adsetId: "adset_acted",
          adsetName: "Externally Reactivated Adset",
          type: "adset_cut_spend",
          confidenceScore: 0.95,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [{
        id: "adset_acted",
        name: "Externally Reactivated Adset",
        campaignId: "cmp_1",
        status: "PAUSED",
        statusUpdatedAt: "2026-05-17T08:52:14.234Z",
        spend: 900,
        purchases: 1,
        roas: 0.17,
        cpa: null,
      }] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.actionNow[0]).toMatchObject({ id: "rec_acted" });
    expect(payload.actionNow[0]).not.toHaveProperty("operatorResponseState");
    expect(payload.actionNow[0]).not.toHaveProperty("operatorResponseSubtype");
    expect(payload.archive.map((row: { id: string }) => row.id)).not.toContain("adset_acted");
  });

  it("keeps acted pause state when live Meta active status is older than the successful action", async () => {
    mockSql([{ rec_id: "rec_acted", action: "acted", action_subtype: "pause", occurred_at: "2026-05-17T08:52:43.585Z" }]);
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      accessToken: "token",
      accountIds: ["act_1"],
      accountProfiles: {},
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            adset_acted: {
              id: "adset_acted",
              effective_status: "ACTIVE",
              status: "ACTIVE",
              updated_time: "2026-05-17T08:52:14+0000",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_acted",
          level: "adset",
          adsetId: "adset_acted",
          adsetName: "Newly Paused Adset",
          type: "adset_cut_spend",
          confidenceScore: 0.95,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [{
        id: "adset_acted",
        name: "Newly Paused Adset",
        campaignId: "cmp_1",
        status: "ACTIVE",
        statusUpdatedAt: "2026-05-17T08:52:14.234Z",
        spend: 900,
        purchases: 1,
        roas: 0.17,
        cpa: null,
      }] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d&status_filter=all"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.actionNow[0]).toMatchObject({
      id: "rec_acted",
      operatorResponseState: "acted",
      operatorResponseSubtype: "pause",
      operatorResponseAt: "2026-05-17T08:52:43.585Z",
    });
  });

  it("falls back to warehouse timestamp reconciliation when live Meta status probing fails", async () => {
    mockSql([{ rec_id: "rec_acted", action: "acted", action_subtype: "pause", occurred_at: "2026-05-17T08:52:43.585Z" }]);
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      accessToken: "token",
      accountIds: ["act_1"],
      accountProfiles: {},
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("graph unavailable");
      }),
    );
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_acted",
          level: "adset",
          adsetId: "adset_acted",
          adsetName: "Warehouse Reactivated Adset",
          type: "adset_cut_spend",
          confidenceScore: 0.95,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [{
        id: "adset_acted",
        name: "Warehouse Reactivated Adset",
        campaignId: "cmp_1",
        status: "ACTIVE",
        statusUpdatedAt: "2026-05-17T09:10:00.000Z",
        spend: 900,
        purchases: 1,
        roas: 0.17,
        cpa: null,
      }] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.actionNow[0]).toMatchObject({ id: "rec_acted" });
    expect(payload.actionNow[0]).not.toHaveProperty("operatorResponseState");
    expect(payload.actionNow[0]).not.toHaveProperty("operatorResponseSubtype");
    expect(console.warn).toHaveBeenCalledWith(
      "[meta-lane-classify] live status probe request failed",
      expect.objectContaining({
        businessId: "biz_1",
        entityCount: 2,
        error: "graph unavailable",
      }),
    );
  });

  it("persists acted pause state from successful Meta action logs while the ad set is paused", async () => {
    mockSql([{ rec_id: "rec_acted", action: "acted", action_subtype: "pause", occurred_at: "2026-05-17T07:39:24.000Z" }]);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_acted",
          level: "adset",
          adsetId: "adset_acted",
          adsetName: "Paused Adset",
          type: "adset_cut_spend",
          confidenceScore: 0.95,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [{
        id: "adset_acted",
        name: "Paused Adset",
        campaignId: "cmp_1",
        status: "PAUSED",
        spend: 900,
        purchases: 1,
        roas: 0.17,
        cpa: null,
      }] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d&status_filter=all"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.actionNow[0]).toMatchObject({
      id: "rec_acted",
      operatorResponseState: "acted",
      operatorResponseSubtype: "pause",
    });
  });

  it("reconciles acted resume state against the current ad set status", async () => {
    mockSql([
      { rec_id: "rec_resume_active", action: "acted", action_subtype: "resume", occurred_at: "2026-05-17T07:39:24.000Z" },
      { rec_id: "rec_resume_paused", action: "acted", action_subtype: "resumed", occurred_at: "2026-05-17T07:39:24.000Z" },
    ]);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 2,
      },
      recommendations: [
        metaRec({
          id: "rec_resume_active",
          level: "adset",
          adsetId: "adset_resume_active",
          adsetName: "Resumed Active Adset",
          type: "adset_cut_spend",
          confidenceScore: 0.95,
          decisionState: "act",
        }),
        metaRec({
          id: "rec_resume_paused",
          level: "adset",
          adsetId: "adset_resume_paused",
          adsetName: "Paused Again Adset",
          type: "adset_cut_spend",
          confidenceScore: 0.95,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "adset_resume_active",
          name: "Resumed Active Adset",
          campaignId: "cmp_1",
          status: "ACTIVE",
          spend: 900,
          purchases: 1,
          roas: 0.17,
          cpa: null,
        },
        {
          id: "adset_resume_paused",
          name: "Paused Again Adset",
          campaignId: "cmp_1",
          status: "PAUSED",
          statusUpdatedAt: "2026-05-17T08:00:00.000Z",
          spend: 900,
          purchases: 1,
          roas: 0.17,
          cpa: null,
        },
      ] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d&status_filter=all"));
    const payload = await response.json();
    const recs = new Map(payload.actionNow.map((rec: { id: string }) => [rec.id, rec]));

    expect(response.status).toBe(200);
    expect(recs.get("rec_resume_active")).toMatchObject({
      operatorResponseState: "acted",
      operatorResponseSubtype: "resume",
    });
    expect(recs.get("rec_resume_paused")).not.toHaveProperty("operatorResponseState");
    expect(recs.get("rec_resume_paused")).not.toHaveProperty("operatorResponseSubtype");
  });

  it("uses campaign status timestamps for campaign-level pause reconciliation", async () => {
    mockSql([
      { rec_id: "rec_campaign_stale", action: "acted", action_subtype: "pause", occurred_at: "2026-05-17T07:39:24.000Z" },
      { rec_id: "rec_campaign_recent", action: "acted", action_subtype: "pause", occurred_at: "2026-05-17T08:52:43.585Z" },
    ]);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 2,
      },
      recommendations: [
        metaRec({
          id: "rec_campaign_stale",
          level: "campaign",
          campaignId: "cmp_stale",
          campaignName: "Stale Campaign",
          confidenceScore: 0.95,
          decisionState: "act",
        }),
        metaRec({
          id: "rec_campaign_recent",
          level: "campaign",
          campaignId: "cmp_recent",
          campaignName: "Recent Campaign",
          confidenceScore: 0.95,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_stale",
          name: "Stale Campaign",
          status: "ACTIVE",
          statusUpdatedAt: "2026-05-17T08:00:00.000Z",
          spend: 900,
          purchases: 1,
          roas: 0.17,
          cpa: null,
        },
        {
          id: "cmp_recent",
          name: "Recent Campaign",
          status: "ACTIVE",
          statusUpdatedAt: "2026-05-17T08:52:14.234Z",
          spend: 900,
          purchases: 1,
          roas: 0.17,
          cpa: null,
        },
      ] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d&status_filter=all"));
    const payload = await response.json();
    const recs = new Map(payload.actionNow.map((rec: { id: string }) => [rec.id, rec]));

    expect(response.status).toBe(200);
    expect(recs.get("rec_campaign_stale")).not.toHaveProperty("operatorResponseState");
    expect(recs.get("rec_campaign_stale")).not.toHaveProperty("operatorResponseSubtype");
    expect(recs.get("rec_campaign_recent")).toMatchObject({
      operatorResponseState: "acted",
      operatorResponseSubtype: "pause",
    });
  });

  it("routes non-purchase recommendations into nonSales only", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_upper",
          campaignId: "cmp_upper",
          campaignName: "Video Views",
          cohort: "upper_funnel",
          confidenceScore: 0.91,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_upper",
          name: "Video Views",
          status: "ACTIVE",
          spend: 500,
          purchases: 0,
          roas: 0,
          cpa: null,
          optimizationGoal: "THRUPLAY",
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.actionNow.map((rec: { id: string }) => rec.id)).not.toContain("rec_upper");
    expect(payload.watching.map((rec: { id: string }) => rec.id)).not.toContain("rec_upper");
    expect(payload.nonSales.map((rec: { id: string }) => rec.id)).toEqual(["rec_upper"]);
    expect(payload.counts.nonSales).toBe(payload.nonSales.length);
  });

  it("keeps purchase, null-cohort, and unknown-cohort recommendations in the existing purchase lanes", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 2,
      },
      recommendations: [
        metaRec({
          id: "rec_purchase",
          campaignId: "cmp_purchase",
          campaignName: "Purchase Campaign",
          cohort: "purchase",
          confidenceScore: 0.88,
          decisionState: "act",
        }),
        metaRec({
          id: "rec_null",
          campaignId: "cmp_null",
          campaignName: "Null Cohort Campaign",
          cohort: null,
          confidenceScore: 0.41,
          decisionState: "watch",
        }),
        metaRec({
          id: "rec_unknown",
          campaignId: "cmp_unknown",
          campaignName: "Unknown Cohort Campaign",
          cohort: "unknown",
          confidenceScore: 0.89,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_purchase",
          name: "Purchase Campaign",
          status: "ACTIVE",
          spend: 500,
          purchases: 8,
          roas: 2.8,
          cpa: 30,
          optimizationGoal: "PURCHASE",
        },
        {
          id: "cmp_null",
          name: "Null Cohort Campaign",
          status: "ACTIVE",
          spend: 200,
          purchases: 3,
          roas: 1.4,
          cpa: 67,
          optimizationGoal: "PURCHASE",
        },
        {
          id: "cmp_unknown",
          name: "Unknown Cohort Campaign",
          status: "ACTIVE",
          spend: 450,
          purchases: 5,
          roas: 2.1,
          cpa: 90,
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.actionNow.map((rec: { id: string }) => rec.id)).toEqual(["rec_purchase", "rec_unknown"]);
    expect(payload.watching.map((rec: { id: string }) => rec.id)).toEqual(["rec_null"]);
    expect(payload.nonSales).toHaveLength(0);
  });

  it("keeps unknown-cohort purchase rows out of nonSales when sync fields are missing", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 0,
      },
      recommendations: [],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_missing_goal",
          name: "Missing Goal Purchase Activity",
          status: "ACTIVE",
          spend: 600,
          purchases: 6,
          roas: 2.4,
          cpa: 100,
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.healthy.map((row: { id: string }) => row.id)).toEqual(["cmp_missing_goal"]);
    expect(payload.nonSales).toHaveLength(0);
  });

  it("routes healthy non-purchase campaign rows into nonSales instead of healthy", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 0,
      },
      recommendations: [],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_thruplay",
          name: "Video Views",
          status: "ACTIVE",
          spend: 700,
          purchases: 0,
          roas: 0,
          cpa: null,
          optimizationGoal: "THRUPLAY",
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.healthy.map((row: { id: string }) => row.id)).not.toContain("cmp_thruplay");
    expect(payload.nonSales[0]).toMatchObject({
      campaignId: "cmp_thruplay",
      campaignName: "Video Views",
      cohort: "upper_funnel",
      decision: "non_sales_eligible",
    });
    expect(payload.counts.nonSales).toBe(payload.nonSales.length);
  });

  it("includes upper-funnel brand metrics on nonSales state rows", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = String(strings[0] ?? "");
        if (query.includes("meta_decision_calibration_daily")) {
          return [{ p50: "1.5", sample_size: "8" }];
        }
        return [];
      }) as never,
    );
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 0,
      },
      recommendations: [],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_upper",
          name: "Video Views",
          status: "ACTIVE",
          spend: 700,
          purchases: 0,
          roas: 0,
          cpa: null,
          optimizationGoal: "THRUPLAY",
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "adset_upper",
          name: "ThruPlay Broad",
          campaignId: "cmp_upper",
          status: "ACTIVE",
          spend: 84,
          purchases: 0,
          roas: 0,
          cpa: null,
          cpm: 12,
          impressions: 1000,
          reach: 600,
          frequency: 1.7,
          optimizationGoal: "THRUPLAY",
          thruplayActions: 42,
          videoViews3s: 100,
        },
      ] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    const adsetRow = payload.nonSales.find((rec: { adsetId?: string }) => rec.adsetId === "adset_upper");

    expect(adsetRow).toMatchObject({
      adsetId: "adset_upper",
      adsetName: "ThruPlay Broad",
      cohort: "upper_funnel",
      targetValue: {
        spend: 84,
        impressions: 1000,
        reach: 600,
        frequency: 1.7,
        cpm: 12,
        thruplayActions: 42,
        videoViews3s: 100,
        costPerThruplayP50: 1.5,
      },
    });
  });

  it("keeps healthy purchase campaign rows in healthy", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 0,
      },
      recommendations: [],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_purchase_healthy",
          name: "Purchase Healthy",
          status: "ACTIVE",
          spend: 700,
          purchases: 8,
          roas: 2.7,
          cpa: 32,
          optimizationGoal: "OFFSITE_CONVERSIONS",
          customEventType: "",
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.healthy.map((row: { id: string }) => row.id)).toEqual(["cmp_purchase_healthy"]);
    expect(payload.nonSales).toHaveLength(0);
  });

  it("keeps paused non-purchase campaigns out of Structure and exposes them in archive", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 0,
      },
      recommendations: [],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_archived_video",
          name: "Archived Video Views",
          status: "PAUSED",
          spend: 250,
          purchases: 0,
          roas: 0,
          cpa: null,
          optimizationGoal: "THRUPLAY",
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.nonSales).toHaveLength(0);
    expect(payload.archive).toEqual([
      expect.objectContaining({
        id: "cmp_archived_video",
        name: "Archived Video Views",
        status: "PAUSED",
      }),
    ]);
    expect(payload.counts.archive).toBe(payload.archive.length);
  });

  it("keeps active non-sales ad sets out of Structure when their parent campaign is paused", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 0,
      },
      recommendations: [],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_paused_upper",
          name: "Paused Video Views",
          status: "PAUSED",
          spend: 250,
          purchases: 0,
          roas: 0,
          cpa: null,
          optimizationGoal: "THRUPLAY",
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "adset_active_child",
          name: "Configured Active Child",
          campaignId: "cmp_paused_upper",
          status: "ACTIVE",
          spend: 100,
          purchases: 0,
          roas: 0,
          cpa: null,
          optimizationGoal: "THRUPLAY",
        },
      ] as never,
      evidenceSource: "live",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d",
      ),
    );
    const payload = await response.json();

    expect(payload.nonSales).toHaveLength(0);
    expect(payload.archive).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cmp_paused_upper", status: "PAUSED" }),
        expect.objectContaining({
          id: "adset_active_child",
          status: "CAMPAIGN_PAUSED",
        }),
      ]),
    );
  });

  it("filters closed-entity recommendations by default and exposes them in archive", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 2,
      },
      recommendations: [
        metaRec({ id: "rec_active", campaignId: "cmp_1", confidenceScore: 0.82, decisionState: "act" }),
        metaRec({ id: "rec_closed", campaignId: "cmp_paused", confidenceScore: 0.9, decisionState: "act" }),
      ],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_1",
          name: "Active ASC",
          status: "ACTIVE",
          spend: 100,
          purchases: 3,
          roas: 2.5,
          cpa: 33,
          optimizationGoal: "PURCHASE",
        },
        {
          id: "cmp_paused",
          name: "Paused ASC",
          status: "PAUSED",
          spend: 700,
          purchases: 7,
          roas: 1.4,
          cpa: 100,
          optimizationGoal: "PURCHASE",
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.actionNow.map((rec: { id: string }) => rec.id)).toEqual(["rec_active"]);
    expect(payload.archive).toHaveLength(1);
    expect(payload.archive[0]).toMatchObject({
      id: "cmp_paused",
      status: "PAUSED",
      name: "Paused ASC",
      advisory: {
        primaryActionLabel: expect.any(String),
        why: expect.any(String),
        confidence: "high",
      },
    });
  });

  it("reconciles a historical ACTIVE row with the current provider status before serving Structure", async () => {
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      accessToken: "token",
      accountIds: ["act_1"],
      accountProfiles: {},
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const requestUrl = new URL(String(url));
        expect(requestUrl.searchParams.get("ids")).toContain("cmp_now_paused");
        return new Response(
          JSON.stringify({
            cmp_now_paused: {
              id: "cmp_now_paused",
              status: "PAUSED",
              effective_status: "PAUSED",
              updated_time: "2026-07-13T07:00:00.000Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-07-06",
      endDate: "2026-07-12",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_now_paused",
          campaignId: "cmp_now_paused",
          campaignName: "Paused after snapshot",
          confidenceScore: 0.9,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_now_paused",
          name: "Paused after snapshot",
          status: "ACTIVE",
          spend: 500,
          purchases: 5,
          roas: 2,
          cpa: 100,
          optimizationGoal: "PURCHASE",
        },
      ] as never,
      evidenceSource: "snapshot",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "snapshot",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/lane-classify?businessId=biz_1&window=7d&startDate=2026-07-06&endDate=2026-07-12",
      ),
    );
    const payload = await response.json();

    expect(payload.actionNow).toHaveLength(0);
    expect(payload.watching).toHaveLength(0);
    expect(payload.archive).toEqual([
      expect.objectContaining({
        id: "cmp_now_paused",
        status: "PAUSED",
        advisory: expect.objectContaining({ confidence: "high" }),
      }),
    ]);
  });

  it("fails closed when a historical Structure candidate cannot be reconciled to current provider status", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-07-06",
      endDate: "2026-07-12",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_status_unverified",
          campaignId: "cmp_status_unverified",
          campaignName: "Status cannot be verified",
          confidenceScore: 0.9,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_status_unverified",
          name: "Status cannot be verified",
          status: "ACTIVE",
          spend: 500,
          purchases: 5,
          roas: 2,
          cpa: 100,
          optimizationGoal: "PURCHASE",
        },
      ] as never,
      evidenceSource: "snapshot",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "snapshot",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/lane-classify?businessId=biz_1&window=7d&startDate=2026-07-06&endDate=2026-07-12",
      ),
    );
    const payload = await response.json();

    expect(payload.actionNow).toHaveLength(0);
    expect(payload.watching).toHaveLength(0);
    expect(payload.archive).toEqual([
      expect.objectContaining({
        id: "cmp_status_unverified",
        status: "UNKNOWN",
        diagnosticNote: expect.stringContaining("Status truth is incomplete"),
      }),
    ]);
  });

  it("withholds an active ad set when its parent campaign is paused", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({
          id: "rec_child",
          level: "adset",
          campaignId: undefined,
          campaignName: "Paused parent",
          adsetId: "adset_child_active",
          adsetName: "Configured active child",
          confidenceScore: 0.9,
          decisionState: "act",
        }),
      ],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_parent_paused",
          name: "Paused parent",
          status: "PAUSED",
          spend: 400,
          purchases: 4,
          roas: 1.8,
          cpa: 100,
          optimizationGoal: "PURCHASE",
        },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "adset_child_active",
          name: "Configured active child",
          campaignId: "cmp_parent_paused",
          status: "ACTIVE",
          spend: 200,
          purchases: 2,
          roas: 1.7,
          cpa: 100,
          optimizationGoal: "PURCHASE",
        },
      ] as never,
      evidenceSource: "live",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d",
      ),
    );
    const payload = await response.json();

    expect(payload.actionNow).toHaveLength(0);
    expect(payload.archive).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "adset_child_active",
          status: "CAMPAIGN_PAUSED",
          statusLabel: "Campaign paused",
          advisory: expect.objectContaining({ confidence: "high" }),
        }),
      ]),
    );
  });

  it("keeps WITH_ISSUES recommendations out of Structure and exposes them in archive", async () => {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({ id: "rec_issue", campaignId: "cmp_issue", confidenceScore: 0.95, decisionState: "act" }),
      ],
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        { id: "cmp_issue", name: "Delivery Issue", status: "WITH_ISSUES", spend: 250, purchases: 2, roas: 1.2, cpa: 125 },
      ] as never,
      evidenceSource: "live",
    });
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.actionNow).toHaveLength(0);
    expect(payload.watching).toHaveLength(0);
    expect(payload.archive).toEqual([
      expect.objectContaining({
        id: "cmp_issue",
        status: "WITH_ISSUES",
        advisory: expect.objectContaining({ confidence: "high" }),
      }),
    ]);
  });

  it("routes the [0.55, 0.7) act-state confidence band into Watching as mid_confidence instead of dropping it", async () => {
    mockSql([]);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 1,
      },
      recommendations: [
        metaRec({ id: "rec_mid", confidenceScore: 0.62, decisionState: "act" }),
      ],
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.actionNow).toHaveLength(0);
    expect(payload.watching.map((rec: { id: string }) => rec.id)).toEqual(["rec_mid"]);
    expect(payload.watching[0]).toMatchObject({ id: "rec_mid", watchSegment: "mid_confidence" });
    expect(payload.watchingSegments).toEqual([
      expect.objectContaining({ key: "mid_confidence", count: 1, label: "Mid confidence" }),
    ]);
    expect(payload.counts.watching).toBe(payload.watching.length);
  });

  it("keeps the 0.7 Action Now bar and the existing sub-0.55 insufficient-signal path unchanged", async () => {
    mockSql([]);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 3,
      },
      recommendations: [
        metaRec({ id: "rec_at_bar", confidenceScore: 0.7, decisionState: "act" }),
        metaRec({ id: "rec_below_band", confidenceScore: 0.54, decisionState: "act" }),
        // decisionState "watch" wins over the score band: mid-band watch-state
        // recs stay on the existing insufficient_signal path.
        metaRec({ id: "rec_watch_state", confidenceScore: 0.62, decisionState: "watch" }),
        metaRec({ id: "rec_watch_high", confidenceScore: 0.95, decisionState: "watch" }),
      ],
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();
    const watching = new Map(payload.watching.map((rec: { id: string }) => [rec.id, rec]));

    expect(response.status).toBe(200);
    expect(payload.actionNow.map((rec: { id: string }) => rec.id)).toEqual(["rec_at_bar"]);
    expect(watching.get("rec_below_band")).toMatchObject({ watchSegment: "insufficient_signal" });
    expect(watching.get("rec_watch_state")).toMatchObject({ watchSegment: "insufficient_signal" });
    expect(watching.get("rec_watch_high")).toMatchObject({ watchSegment: "insufficient_signal" });
    expect(payload.watchingSegments).toEqual([
      expect.objectContaining({ key: "insufficient_signal", count: 3 }),
    ]);
  });

  it("partitions every recommendation into exactly one lane across the confidence sweep (no-gap contract)", async () => {
    mockSql([]);
    const sweep = [
      metaRec({ id: "rec_c040", confidenceScore: 0.4, decisionState: "watch" }),
      metaRec({ id: "rec_c055", confidenceScore: 0.55, decisionState: "act" }),
      metaRec({ id: "rec_c062", confidenceScore: 0.62, decisionState: "test" }),
      metaRec({ id: "rec_c069", confidenceScore: 0.69, decisionState: "act" }),
      metaRec({ id: "rec_c070", confidenceScore: 0.7, decisionState: "act" }),
      metaRec({ id: "rec_c090", confidenceScore: 0.9, decisionState: "act" }),
    ];
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: sweep.length,
      },
      recommendations: sweep,
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();
    const laneMemberships = [
      ...payload.actionNow.map((rec: { id: string }) => rec.id),
      ...payload.watching.map((rec: { id: string }) => rec.id),
      ...payload.nonSales.map((rec: { id: string }) => rec.id),
      ...payload.archive.map((row: { id: string }) => row.id),
    ].filter((id: string) => id.startsWith("rec_c"));

    expect(response.status).toBe(200);
    // Every rec lands in exactly one lane: total memberships === rec count, no dupes.
    expect(laneMemberships).toHaveLength(sweep.length);
    expect(new Set(laneMemberships).size).toBe(sweep.length);
    expect([...laneMemberships].sort()).toEqual(sweep.map((rec) => rec.id).sort());
    expect(payload.actionNow.map((rec: { id: string }) => rec.id).sort()).toEqual(["rec_c070", "rec_c090"]);
    expect(payload.counts.actionNow).toBe(payload.actionNow.length);
    expect(payload.counts.watching).toBe(payload.watching.length);
  });

  it("returns expired deferrals to their natural lane while future and legacy deferrals stay deferred", async () => {
    const pastReappearAt = new Date(Date.now() - 60_000).toISOString();
    const futureReappearAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    mockSql([
      { rec_id: "rec_defer_expired", action: "deferred", action_subtype: "defer_24h", occurred_at: "2026-05-01T00:00:00.000Z", reappear_at: pastReappearAt },
      { rec_id: "rec_defer_future", action: "deferred", action_subtype: "defer_24h", occurred_at: "2026-05-01T00:00:00.000Z", reappear_at: futureReappearAt },
      // Legacy rows have no reappear_at: indefinite deferral semantics are preserved.
      { rec_id: "rec_defer_legacy", action: "deferred", action_subtype: "let_cook_24h", occurred_at: "2026-05-01T00:00:00.000Z", reappear_at: null },
    ]);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: 3,
      },
      recommendations: [
        metaRec({ id: "rec_defer_expired", confidenceScore: 0.84, decisionState: "act" }),
        metaRec({ id: "rec_defer_future", confidenceScore: 0.84, decisionState: "act" }),
        metaRec({ id: "rec_defer_legacy", confidenceScore: 0.84, decisionState: "act" }),
      ],
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();
    const watching = new Map(payload.watching.map((rec: { id: string }) => [rec.id, rec]));

    expect(response.status).toBe(200);
    // Expired deferral returns to its naturally classified lane (Action Now here).
    expect(payload.actionNow.map((rec: { id: string }) => rec.id)).toEqual(["rec_defer_expired"]);
    expect(payload.actionNow[0]).not.toHaveProperty("operatorResponseState");
    expect([...payload.deferredIds].sort()).toEqual(["rec_defer_future", "rec_defer_legacy"]);
    expect(watching.get("rec_defer_future")).toMatchObject({
      watchSegment: "deferred",
      operatorResponseState: "deferred",
    });
    expect(watching.get("rec_defer_legacy")).toMatchObject({
      watchSegment: "deferred",
      operatorResponseState: "deferred",
    });
    expect(payload.watchingSegments).toEqual([
      expect.objectContaining({ key: "deferred", count: 2 }),
    ]);
  });
});

describe("the live status probe caches the big accounts too", () => {
  const source = readFileSync("app/api/meta/lane-classify/route.ts", "utf8");

  /**
   * The probe that costs the most must not be the one that is never cached.
   *
   * `readLiveMetaEntityStatuses` is a Meta Graph round trip in 50-id batches,
   * and it runs on the strictly serial stage between base evidence and label
   * kinds. Its 45-second cache used to be skipped whenever the id set exceeded
   * 200 — so a small account paid the provider once every 45 seconds while an
   * account of 214 ids (73 campaigns + 141 ad sets, a real one) paid it in
   * full on every request. Size is a reason to cache, not a reason to stop.
   *
   * The cache stays honest only while its key still names the exact scope:
   * the business AND the exact set of ids. A digest is fine; dropping either
   * one would let a probe answer for ids it never asked about.
   */
  it("keys the cache on the whole id set and never disables it by size", () => {
    const reader = source.slice(
      source.indexOf("async function readLiveMetaEntityStatuses"),
      source.indexOf("function applyLiveStatusesToRows"),
    );
    expect(reader).not.toBe("");
    expect(
      reader,
      "an id-count threshold must not bypass the cache",
    ).not.toMatch(/uniqueIds\.length\s*>\s*\d+/);
    expect(reader).toContain("createHash(\"sha256\")");
    expect(reader).toContain(".update(uniqueIds.join(\",\"), \"utf8\")");
    expect(
      reader,
      "the cache key must still name the business and the exact id set",
    ).toContain("${businessId}:${uniqueIds.length}:${scopeDigest}");
  });
});

/*
  CODEX C21 — lane placement must not be decided by buyer copy.

  `isInLearning` ended with
  `/learning|cook|thin|insufficient/i.test(`${rec.title} ${rec.summary}`)`, so a
  row's lane depended on the wording of its own prose. This module already emits
  Turkish copy, and no Turkish sentence matches those English stems — so the same
  decision landed in a different lane depending on the language it was rendered
  in, and rewording a summary silently re-routed it.

  Segments carry `key` and `count`, not the rows themselves, so these assert on
  the segment KEY a row produces. An earlier draft asserted on a non-existent
  `items` array and passed vacuously.
*/
describe("learning routing is invariant under copy", () => {
  async function segmentKeysFor(recs: unknown[]) {
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz_1",
      startDate: "2026-04-10",
      endDate: "2026-05-07",
      snapshotDate: "2026-05-06",
      snapshotCreatedAt: "2026-05-06T03:10:00.000Z",
      sourceModel: "snapshot_persistent",
      summary: {
        title: "Snapshot",
        summary: "Snapshot",
        primaryLens: "structure",
        confidence: "high",
        recommendationCount: recs.length,
      },
      recommendations: recs,
    } as never);
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d",
      ),
    );
    const payload = await response.json();
    return (payload.watchingSegments ?? []).map(
      (segment: { key: string; count: number }) => `${segment.key}:${segment.count}`,
    );
  }

  const PROSE = {
    title: "Still learning: thin data while the ad cooks",
    summary: "Insufficient signal so far.",
  };
  const NEUTRAL_TURKISH = {
    title: "Butce en guclu scale adaylarina kaydirilabilir",
    summary: "Veri toplaniyor.",
  };

  it("does not route a row into learning because its COPY says so", async () => {
    const keys = await segmentKeysFor([
      metaRec({
        id: "rec_prose",
        confidenceScore: 0.42,
        decisionState: "watch",
        ...PROSE,
      }),
    ]);
    // Every stem the old regex matched is in the copy, and no typed learning
    // signal is on the row: it must land somewhere else.
    expect(keys).not.toContain("learning:1");
    expect(keys).toContain("insufficient_signal:1");
  });

  it("routes a row into learning from the TYPED signal, whatever the copy says", async () => {
    const keys = await segmentKeysFor([
      metaRec({
        id: "rec_typed",
        confidenceScore: 0.42,
        decisionState: "watch",
        ...NEUTRAL_TURKISH,
        confidenceReason: "thin_data_watching",
      }),
    ]);
    expect(keys).toContain("learning:1");
  });

  it("places the same typed row identically whatever its copy is", async () => {
    const withEnglish = await segmentKeysFor([
      metaRec({
        id: "rec_same",
        confidenceScore: 0.42,
        decisionState: "watch",
        ...PROSE,
        confidenceReason: "thin_data_watching",
      }),
    ]);
    const withTurkish = await segmentKeysFor([
      metaRec({
        id: "rec_same",
        confidenceScore: 0.42,
        decisionState: "watch",
        ...NEUTRAL_TURKISH,
        confidenceReason: "thin_data_watching",
      }),
    ]);
    expect(withTurkish).toEqual(withEnglish);
    // And not vacuously: the row really did land in a segment.
    expect(withEnglish).toContain("learning:1");
  });
});
