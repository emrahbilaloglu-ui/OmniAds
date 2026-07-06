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
      expect.objectContaining({ businessId: "biz_1", entityCount: 1, error: "graph unavailable" }),
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
    vi.mocked(adsets.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
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

  it("routes archived non-purchase campaign rows into nonSales instead of archive", async () => {
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

    expect(payload.archive.map((row: { id: string }) => row.id)).not.toContain("cmp_archived_video");
    expect(payload.nonSales[0]).toMatchObject({
      campaignId: "cmp_archived_video",
      campaignName: "Archived Video Views",
      cohort: "upper_funnel",
    });
    expect(payload.counts.nonSales).toBe(payload.nonSales.length);
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

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.actionNow.map((rec: { id: string }) => rec.id)).toEqual(["rec_active"]);
    expect(payload.archive).toHaveLength(1);
    expect(payload.archive[0]).toMatchObject({ id: "cmp_paused", status: "PAUSED", name: "Paused ASC" });
  });

  it("keeps WITH_ISSUES recommendations visible in Watching instead of Action Now", async () => {
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

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.actionNow).toHaveLength(0);
    expect(payload.watching.map((rec: { id: string }) => rec.id)).toContain("rec_issue");
    expect(payload.archive).toHaveLength(0);
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
      ],
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/lane-classify?businessId=biz_1&window=28d"));
    const payload = await response.json();
    const watching = new Map(payload.watching.map((rec: { id: string }) => [rec.id, rec]));

    expect(response.status).toBe(200);
    expect(payload.actionNow.map((rec: { id: string }) => rec.id)).toEqual(["rec_at_bar"]);
    expect(watching.get("rec_below_band")).toMatchObject({ watchSegment: "insufficient_signal" });
    expect(watching.get("rec_watch_state")).toMatchObject({ watchSegment: "insufficient_signal" });
    expect(payload.watchingSegments).toEqual([
      expect.objectContaining({ key: "insufficient_signal", count: 2 }),
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
