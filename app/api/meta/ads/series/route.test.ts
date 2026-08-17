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
});
