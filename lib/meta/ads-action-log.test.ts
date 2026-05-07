import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const db = await import("@/lib/db");
const { resolveMetaAdActionTarget } = await import("./ads-action-log");

describe("resolveMetaAdActionTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a just-created launch ad from action logs before warehouse sync", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: "business_1" }])
      .mockResolvedValueOnce([
        {
          provider_account_id: "act_123",
          resolved_ad_id: "new_ad_1",
          creative_id: "creative_1",
        },
      ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await resolveMetaAdActionTarget({
      businessId: "business_1",
      adId: "new_ad_1",
    });

    expect(result).toEqual({
      ok: true,
      target: {
        businessId: "business_1",
        adId: "new_ad_1",
        creativeId: "creative_1",
        providerAccountId: "act_123",
      },
    });
    const resolveSql = String(sql.mock.calls[1]?.[0]?.join(""));
    expect(resolveSql).toContain("meta_ads_action_log");
    expect(resolveSql).toContain("log.resulting_ad_id = target.input_id");
  });
});
