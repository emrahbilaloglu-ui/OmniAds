import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/ads/series/route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", () => ({
  getMetaAdDailySeries: vi.fn(),
}));

const access = await import("@/lib/access");
const fetchers = await import("@/lib/meta/creatives-fetchers");
const warehouse = await import("@/lib/meta/warehouse");

function url(query: string) {
  return new NextRequest(`http://localhost/api/meta/ads/series?${query}`);
}

const BASE = "businessId=biz_1&adIds=ad_1&start=2026-07-20&end=2026-08-16";

describe("GET /api/meta/ads/series", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(fetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(warehouse.getMetaAdDailySeries).mockResolvedValue([]);
  });

  it("rejects a request with no ad ids before it reads anything", async () => {
    const response = await GET(url("businessId=biz_1&start=2026-07-20&end=2026-08-16"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "missing_ad_ids" });
    expect(warehouse.getMetaAdDailySeries).not.toHaveBeenCalled();
  });

  it("rejects a request with no date range", async () => {
    const response = await GET(url("businessId=biz_1&adIds=ad_1"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "missing_date_range" });
  });

  it("returns the access error without reading the warehouse", async () => {
    const denied = new Response("no", { status: 403 });
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: denied,
    } as never);
    const response = await GET(url(BASE));
    expect(response.status).toBe(403);
    expect(warehouse.getMetaAdDailySeries).not.toHaveBeenCalled();
  });

  it("narrows the warehouse read to the business's assigned accounts", async () => {
    vi.mocked(fetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1", "act_2"]);
    await GET(url("businessId=biz_1&adIds=ad_1,%20ad_2,ad_1&start=2026-07-20&end=2026-08-16"));
    expect(warehouse.getMetaAdDailySeries).toHaveBeenCalledWith({
      businessId: "biz_1",
      adIds: ["ad_1", "ad_2"],
      startDate: "2026-07-20",
      endDate: "2026-08-16",
      providerAccountIds: ["act_1", "act_2"],
    });
  });

  it("serves an empty series when no Meta account is assigned", async () => {
    vi.mocked(fetchers.fetchAssignedAccountIds).mockResolvedValue([]);
    const response = await GET(url(BASE));
    await expect(response.json()).resolves.toEqual({ adCount: 0, points: [] });
    expect(warehouse.getMetaAdDailySeries).not.toHaveBeenCalled();
  });

  it("serves one point per day with link CTR as a percent", async () => {
    vi.mocked(warehouse.getMetaAdDailySeries).mockResolvedValue([
      {
        adId: "ad_1",
        date: "2026-08-02",
        impressions: 2000,
        clicks: 40,
        linkClicks: 30,
        reach: 1000,
        frequency: 2,
        ctr: 2,
      },
      {
        adId: "ad_1",
        date: "2026-08-01",
        impressions: 1000,
        clicks: 20,
        linkClicks: 10,
        reach: 500,
        frequency: 2,
        ctr: 2,
      },
    ]);
    const response = await GET(url(BASE));
    const payload = (await response.json()) as {
      adCount: number;
      points: Array<{ date: string; linkCtr: number | null; frequency: number | null }>;
    };
    expect(payload.adCount).toBe(1);
    expect(payload.points.map((point) => point.date)).toEqual(["2026-08-01", "2026-08-02"]);
    expect(payload.points[0].linkCtr).toBeCloseTo(1, 6);
    expect(payload.points[1].linkCtr).toBeCloseTo(1.5, 6);
    expect(payload.points[0].frequency).toBeCloseTo(2, 6);
  });

  it("weights a multi-ad day's frequency by impressions and never sums it", async () => {
    vi.mocked(warehouse.getMetaAdDailySeries).mockResolvedValue([
      {
        adId: "ad_1",
        date: "2026-08-01",
        impressions: 3000,
        clicks: 0,
        linkClicks: 30,
        reach: 1000,
        frequency: 3,
        ctr: null,
      },
      {
        adId: "ad_2",
        date: "2026-08-01",
        impressions: 1000,
        clicks: 0,
        linkClicks: 10,
        reach: 1000,
        frequency: 1,
        ctr: null,
      },
    ]);
    const response = await GET(url("businessId=biz_1&adIds=ad_1,ad_2&start=2026-07-20&end=2026-08-16"));
    const payload = (await response.json()) as {
      adCount: number;
      points: Array<{ frequency: number | null; linkCtr: number | null }>;
    };
    expect(payload.adCount).toBe(2);
    // (3×3000 + 1×1000) / 4000 = 2.5 — bounded by the reported values, not 4.
    expect(payload.points[0].frequency).toBeCloseTo(2.5, 6);
    expect(payload.points[0].linkCtr).toBeCloseTo(1, 6);
  });

  it("leaves link CTR null when no ad reported link clicks that day", async () => {
    vi.mocked(warehouse.getMetaAdDailySeries).mockResolvedValue([
      {
        adId: "ad_1",
        date: "2026-08-01",
        impressions: 1000,
        clicks: 20,
        linkClicks: null,
        reach: 500,
        frequency: null,
        ctr: 2,
      },
    ]);
    const response = await GET(url(BASE));
    const payload = (await response.json()) as {
      points: Array<{ linkCtr: number | null; frequency: number | null }>;
    };
    expect(payload.points[0].linkCtr).toBeNull();
    expect(payload.points[0].frequency).toBeNull();
  });

  it("does not publish a partial multi-ad link-click sum as a measured total", async () => {
    vi.mocked(warehouse.getMetaAdDailySeries).mockResolvedValue([
      {
        adId: "ad_1", date: "2026-08-01", impressions: 1000, clicks: 20,
        linkClicks: 10, reach: 500, frequency: 2, ctr: 2,
      },
      {
        adId: "ad_2", date: "2026-08-01", impressions: 1000, clicks: 20,
        linkClicks: null, reach: 500, frequency: null, ctr: null,
      },
    ]);
    const response = await GET(url("businessId=biz_1&adIds=ad_1,ad_2&start=2026-07-20&end=2026-08-16&groupBy=ad"));
    const payload = (await response.json()) as {
      points: Array<{
        linkClicks: number | null; linkCtr: number | null;
        frequency: number | null; ctr: number | null;
      }>;
      series: Array<{ adId: string; points: Array<{ linkClicks: number | null }> }>;
    };
    expect(payload.points[0]).toMatchObject({
      linkClicks: null, linkCtr: null, frequency: null, ctr: null,
    });
    expect(payload.series.find((item) => item.adId === "ad_1")?.points[0]?.linkClicks).toBe(10);
    expect(payload.series.find((item) => item.adId === "ad_2")?.points[0]?.linkClicks).toBeNull();
  });

  it("reads a full creative queue once at exact account/date scope and separates observed, zero, missing and incomplete CTR", async () => {
    const adIds = Array.from({ length: 60 }, (_, index) => `ad_${index + 1}`);
    vi.mocked(warehouse.getMetaAdDailySeries).mockResolvedValue([
      { adId: "ad_1", date: "2026-08-01", impressions: 100, clicks: 2,
        linkClicks: 1, reach: 100, frequency: 1, ctr: 2,
        sourceUpdatedAt: "2026-08-17T09:00:00Z" },
      { adId: "ad_1", date: "2026-08-02", impressions: 300, clicks: 15,
        linkClicks: 8, reach: 200, frequency: 1.5, ctr: 5,
        sourceUpdatedAt: "2026-08-18T10:00:00Z" },
      { adId: "ad_2", date: "2026-08-02", impressions: 1000, clicks: 0,
        linkClicks: 0, reach: 800, frequency: 1.25, ctr: 0 },
      { adId: "ad_3", date: "2026-08-01", impressions: 200, clicks: 2,
        linkClicks: 2, reach: 180, frequency: 1.1, ctr: 1 },
      { adId: "ad_3", date: "2026-08-02", impressions: 300, clicks: 0,
        linkClicks: null, reach: 260, frequency: 1.2, ctr: null },
    ]);
    const response = await GET(url(
      `businessId=biz_1&providerAccountId=act_1&adIds=${adIds.join(",")}` +
      "&start=2026-07-20&end=2026-08-16&ctrEvidence=1",
    ));
    expect(response.status).toBe(200);
    expect(warehouse.getMetaAdDailySeries).toHaveBeenCalledTimes(1);
    expect(warehouse.getMetaAdDailySeries).toHaveBeenCalledWith({
      businessId: "biz_1", providerAccountIds: ["act_1"], adIds,
      startDate: "2026-07-20", endDate: "2026-08-16", finalizedOnly: true,
    });
    const payload = (await response.json()) as {
      ctrEvidence: Array<{
        adId: string; state: string; ctrPercent: number | null;
        measuredDays: number; lastWarehouseUpdateAt: string | null;
      }>;
    };
    expect(payload.ctrEvidence).toHaveLength(60);
    expect(payload.ctrEvidence[0]).toMatchObject({
      adId: "ad_1", state: "observed", measuredDays: 2,
      lastWarehouseUpdateAt: "2026-08-18T10:00:00Z",
    });
    expect(payload.ctrEvidence[0]?.ctrPercent).toBeCloseTo(4.25);
    expect(payload.ctrEvidence[1]).toMatchObject({
      adId: "ad_2", state: "observed", ctrPercent: 0, measuredDays: 1,
    });
    expect(payload.ctrEvidence[2]).toMatchObject({
      adId: "ad_3", state: "incomplete", ctrPercent: null, measuredDays: 2,
    });
    expect(payload.ctrEvidence[59]).toMatchObject({
      adId: "ad_60", state: "missing", ctrPercent: null, measuredDays: 0,
    });
  });

  it("refuses a CTR evidence read for an unassigned account", async () => {
    const response = await GET(url(`${BASE}&ctrEvidence=1&providerAccountId=act_other`));
    expect(response.status).toBe(403);
    expect(warehouse.getMetaAdDailySeries).not.toHaveBeenCalled();
  });

  it("rejects invalid report dates before the CTR evidence warehouse read", async () => {
    const response = await GET(url(
      "businessId=biz_1&providerAccountId=act_1&adIds=ad_1" +
      "&start=2026-02-30&end=2026-03-01&ctrEvidence=1",
    ));
    expect(response.status).toBe(400);
    expect(warehouse.getMetaAdDailySeries).not.toHaveBeenCalled();
  });
});
