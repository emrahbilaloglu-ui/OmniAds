import { describe, expect, it, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { clearCreativeInboxBriefingCacheForTests } from "./route-state";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearCreativeInboxBriefingCacheForTests();
});

describe("GET /api/creatives/inbox", () => {
  it("aggregates existing briefing cards server-side and sorts by priority score", async () => {
    const fetchSpy = vi.fn(async (url: URL, _init?: RequestInit) => {
      const businessId = url.searchParams.get("businessId");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          actionNow: [
            {
              id: `${businessId}_action`,
              label: "cut",
              primary: { kind: "cut", label: "Cut" },
              priorityScore: { score: businessId === "biz_2" ? 50 : 150 },
              spend: businessId === "biz_2" ? 900 : 100,
            },
          ],
          watching: [
            {
              id: `${businessId}_watch`,
              label: "keep",
              priorityScore: { score: 10 },
              spend: 50,
            },
          ],
          healthy: [],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/inbox?businessIds=biz_1,biz_2&limit=3",
        {
          headers: { cookie: "sid=test" },
        },
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.cache).toMatchObject({
      hits: 0,
      misses: 2,
      ttlMs: 60_000,
      maxEntries: 200,
    });
    expect(payload.inbox.map((card: { id: string }) => card.id)).toEqual([
      "biz_1_action",
      "biz_2_action",
      "biz_1_watch",
    ]);
    expect(payload.inbox[0]).toMatchObject({
      businessId: "biz_1",
      primary: { kind: "cut", label: "Cut" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0].toString()).toContain(
      "/api/creatives/briefing",
    );
    expect(fetchSpy.mock.calls[0][0].origin).toBe("http://127.0.0.1:3000");
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({
      headers: expect.any(Headers),
      cache: "no-store",
    });
  });

  it("keeps missing priority scores below explicit zero scores", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          actionNow: [
            {
              id: "missing_priority",
              label: "cut",
              spend: 1_000,
            },
            {
              id: "zero_priority",
              label: "cut",
              priorityScore: { score: 0 },
              spend: 10,
            },
          ],
          watching: [],
          healthy: [],
        }),
      })),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/inbox?businessIds=biz_1",
      ),
    );
    const payload = await response.json();

    expect(payload.inbox.map((card: { id: string }) => card.id)).toEqual([
      "zero_priority",
      "missing_priority",
    ]);
  });

  it("reuses auth-scoped briefing payloads within a short inbox window", async () => {
    const fetchSpy = vi.fn(async (url: URL) => {
      const businessId = url.searchParams.get("businessId");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          actionNow: [
            {
              id: `${businessId}_action`,
              label: "cut",
              priorityScore: { score: 100 },
              spend: 100,
            },
          ],
          watching: [],
          healthy: [],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchSpy);
    const request = new NextRequest(
      "http://localhost/api/creatives/inbox?businessIds=biz_1,biz_2&asOf=2026-05-25",
      {
        headers: { cookie: "sid=test" },
      },
    );

    await GET(request);
    const cachedResponse = await GET(request);
    const cachedPayload = await cachedResponse.json();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(cachedPayload.cache).toMatchObject({
      hits: 2,
      misses: 0,
      entries: 2,
    });

    await GET(
      new NextRequest(
        "http://localhost/api/creatives/inbox?businessIds=biz_1,biz_2&asOf=2026-05-26",
        {
          headers: { cookie: "sid=test" },
        },
      ),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("uses the resolved default asOf date in briefing requests and cache keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T23:59:55.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      const businessId = url.searchParams.get("businessId");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          actionNow: [{ id: `${businessId}_action`, priorityScore: { score: 1 } }],
          watching: [],
          healthy: [],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchSpy);
    const request = new NextRequest(
      "http://localhost/api/creatives/inbox?businessIds=biz_1",
      { headers: { cookie: "sid=test" } },
    );

    await GET(request);
    await GET(request);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0].searchParams.get("asOf")).toBe("2026-05-25");

    vi.setSystemTime(new Date("2026-05-26T00:00:05.000Z"));
    await GET(
      new NextRequest("http://localhost/api/creatives/inbox?businessIds=biz_1", {
        headers: { cookie: "sid=test" },
      }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0].searchParams.get("asOf")).toBe("2026-05-26");
  });

  it("reports an unavailable briefing dependency without turning the inbox into HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/inbox?businessIds=biz_1"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.inbox).toEqual([]);
    expect(payload.businessesSucceeded).toBe(0);
    expect(payload.errors).toEqual([
      { businessId: "biz_1", status: 503, error: "briefing_unavailable" },
    ]);
  });

  it("requires explicit business ids", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/creatives/inbox"),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("missing_business_ids");
  });
});
