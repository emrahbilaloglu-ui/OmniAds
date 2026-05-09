import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { metaRec } from "@/components/meta/redesign/test-fixtures";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
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

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const snapshot = await import("@/lib/meta/snapshot");
const campaigns = await import("@/lib/meta/campaigns-source");
const adsets = await import("@/lib/meta/adsets-source");
const { GET } = await import("@/app/api/meta/lane-classify/route");

describe("GET /api/meta/lane-classify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(db.getDb).mockReturnValue(vi.fn(async () => [{ rec_id: "rec_deferred" }]) as never);
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
    expect(payload.counts.archive).toBe(0);
    expect(payload.statusFilter).toBe("active");
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
        { id: "cmp_1", name: "Active ASC", status: "ACTIVE", spend: 100, purchases: 3, roas: 2.5, cpa: 33 },
        { id: "cmp_paused", name: "Paused ASC", status: "PAUSED", spend: 700, purchases: 7, roas: 1.4, cpa: 100 },
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
});
