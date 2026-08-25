import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

const db = await import("@/lib/db");
const { buildBuyerClientActions } = await import("./client-action-feed");

describe("buildBuyerClientActions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("filters the real write ledger to one provider account", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      {
        id: "action_1",
        action: "pause",
        status: "success",
        creative_id: "creative_1",
        requested_at: "2026-07-10T10:00:00.000Z",
        payload_request: {},
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const actions = await buildBuyerClientActions({
      businessId: "business_1",
      providerAccountId: "act_1",
    });

    expect(actions).toHaveLength(1);
    const query = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    expect(query).toContain("meta_ad_dimensions");
    expect(query).toContain("meta_campaign_dimensions");
    expect(query).toContain("meta_adset_dimensions");
    expect(query).toContain("meta_launch_intents");
    expect(query).toContain("launch_intent_id");
    expect(sql.mock.calls[0]).toContain("act_1");
  });

  it("withholds the feed when account scope is missing", async () => {
    const sql = vi.fn();
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      buildBuyerClientActions({
        businessId: "business_1",
        providerAccountId: "",
      }),
    ).resolves.toEqual([]);
    expect(sql).not.toHaveBeenCalled();
  });
});

/**
 * The driver hands back a `Date` for a `timestamptz`, and every existing case
 * in this file passed a string — so the row shape the tests exercised was not
 * the row shape production sees. It cost a 500 on every buyer share for a
 * business with a qualifying action row: the store called `date.trim()` and
 * threw, and the mint answered "a server error interrupted the freeze".
 */
describe("the timestamp arrives as a Date, not a string", () => {
  beforeEach(() => vi.clearAllMocks());

  const rowWith = (requestedAt: unknown) => ({
    id: "action_1",
    action: "pause",
    status: "success",
    creative_id: "creative_1",
    requested_at: requestedAt,
    payload_request: {},
  });

  it("returns a trimmable ISO string for a Date", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([rowWith(new Date("2026-07-10T10:00:00.000Z"))]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const [action] = await buildBuyerClientActions({
      businessId: "business_1",
      providerAccountId: "act_1",
    });

    expect(typeof action.date).toBe("string");
    // The exact call the store makes, which is what used to throw.
    expect(() => action.date.trim()).not.toThrow();
    expect(action.date).toBe("2026-07-10T10:00:00.000Z");
  });

  it("still orders newest first when every date is a Date", async () => {
    // Ordering survived the raw-Date era — `Date.parse` coerces its argument to
    // a string first — so this pins that the conversion did not break it.
    const sql = vi.fn().mockResolvedValueOnce([
      { ...rowWith(new Date("2026-07-01T00:00:00.000Z")), id: "older" },
      { ...rowWith(new Date("2026-07-20T00:00:00.000Z")), id: "newer" },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const actions = await buildBuyerClientActions({
      businessId: "business_1",
      providerAccountId: "act_1",
    });

    expect(actions.map((action) => action.id)).toEqual(["newer", "older"]);
  });

  it("leaves an already-ISO string exactly as it was", async () => {
    const sql = vi.fn().mockResolvedValueOnce([rowWith("2026-07-10T10:00:00.000Z")]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const [action] = await buildBuyerClientActions({
      businessId: "business_1",
      providerAccountId: "act_1",
    });
    expect(action.date).toBe("2026-07-10T10:00:00.000Z");
  });
});
