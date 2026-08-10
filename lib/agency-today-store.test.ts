import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.hoisted(() => vi.fn());
const getDbSchemaReadiness = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));
vi.mock("@/lib/db-schema-readiness", () => ({ getDbSchemaReadiness }));

import { readAgencyTodayTotals, resolveClientFreshness } from "@/lib/agency-today-store";

describe("readAgencyTodayTotals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbSchemaReadiness.mockResolvedValue({ ready: true });
  });

  it("reads every client in one grouped query rather than one per client", async () => {
    query.mockResolvedValue([]);
    await readAgencyTodayTotals({
      businessIds: ["a", "b", "c", "d"],
      startDate: "2026-08-01",
      endDate: "2026-08-07",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("GROUP BY business_id");
    expect(query.mock.calls[0][1][0]).toEqual(["a", "b", "c", "d"]);
  });

  it("returns numeric totals keyed by business", async () => {
    query.mockResolvedValue([
      {
        business_id: "a",
        spend: "1200.50",
        revenue: "3000",
        purchases: "42",
        last_source_updated_at: "2026-08-07T10:00:00.000Z",
      },
    ]);
    const totals = await readAgencyTodayTotals({
      businessIds: ["a"],
      startDate: "2026-08-01",
      endDate: "2026-08-07",
    });
    expect(totals.get("a")).toEqual({
      businessId: "a",
      spend: 1200.5,
      revenue: 3000,
      purchases: 42,
      lastSourceUpdatedAt: "2026-08-07T10:00:00.000Z",
    });
  });

  it("does not query at all for an empty client list", async () => {
    const totals = await readAgencyTodayTotals({
      businessIds: [],
      startDate: "2026-08-01",
      endDate: "2026-08-07",
    });
    expect(query).not.toHaveBeenCalled();
    expect(totals.size).toBe(0);
  });

  it("returns nothing when the summary tables are absent", async () => {
    getDbSchemaReadiness.mockResolvedValue({ ready: false });
    const totals = await readAgencyTodayTotals({
      businessIds: ["a"],
      startDate: "2026-08-01",
      endDate: "2026-08-07",
    });
    expect(query).not.toHaveBeenCalled();
    expect(totals.size).toBe(0);
  });

  it("lets a genuine query failure surface instead of looking like no data", async () => {
    query.mockRejectedValue(new Error("connection reset"));
    await expect(
      readAgencyTodayTotals({
        businessIds: ["a"],
        startDate: "2026-08-01",
        endDate: "2026-08-07",
      }),
    ).rejects.toThrow("connection reset");
  });

  it("keeps a null total null rather than coercing it to zero", async () => {
    query.mockResolvedValue([
      { business_id: "a", spend: null, revenue: null, purchases: null, last_source_updated_at: null },
    ]);
    const totals = await readAgencyTodayTotals({
      businessIds: ["a"],
      startDate: "2026-08-01",
      endDate: "2026-08-07",
    });
    expect(totals.get("a")?.spend).toBeNull();
    expect(totals.get("a")?.revenue).toBeNull();
  });
});

describe("resolveClientFreshness", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");

  it("calls recent data fresh", () => {
    expect(resolveClientFreshness("2026-08-08T06:00:00.000Z", now)).toBe("fresh");
  });

  it("calls data past the stale window stale", () => {
    expect(resolveClientFreshness("2026-08-06T00:00:00.000Z", now)).toBe("stale");
  });

  it("never claims freshness it cannot evidence", () => {
    expect(resolveClientFreshness(null, now)).toBe("unknown");
    expect(resolveClientFreshness(undefined, now)).toBe("unknown");
    expect(resolveClientFreshness("not-a-date", now)).toBe("unknown");
  });
});
