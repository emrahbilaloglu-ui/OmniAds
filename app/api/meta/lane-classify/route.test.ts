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
      rows: [{
        id: "cmp_healthy",
        name: "Healthy ASC",
        status: "ACTIVE",
        spend: 500,
        purchases: 12,
        roas: 3,
        cpa: 25,
      }] as never,
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
    expect(payload.healthy[1]).toMatchObject({
      id: "adset_healthy",
      campaignId: "cmp_healthy",
      campaignName: "Healthy ASC",
    });
    expect(payload.deferredIds).toEqual(["rec_deferred"]);
  });
});
