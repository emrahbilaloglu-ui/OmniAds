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
