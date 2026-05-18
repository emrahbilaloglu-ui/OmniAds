import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const db = await import("@/lib/db");
const { createMetaAdsActionLog, resolveMetaAdActionTarget } = await import("./ads-action-log");

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
    expect(resolveSql).toContain("::text AS business_id_text");
    expect(resolveSql).toContain("::uuid AS business_id_uuid");
    expect(resolveSql).toContain("NULL::text AS creative_id");
    expect(resolveSql).toContain("meta_creative_daily");
    expect(resolveSql).toContain("creative_daily_by_creative");
  });

  it("persists rec_id_origin when provided", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      {
        id: "log_1",
        business_id: "business_1",
        ad_id: "ad_1",
        creative_id: "creative_1",
        action: "pause",
        source: "ui_manual",
        requested_by: "user_1",
        requested_at: "2026-05-06T10:00:00.000Z",
        payload_request: { body: { status: "PAUSED" } },
        payload_response: null,
        status: "pending",
        error_code: null,
        error_message: null,
        resulting_ad_id: null,
        duration_ms: null,
        verified_at: null,
        verification_payload: null,
        rec_id_origin: "rec_1",
        created_at: "2026-05-06T10:00:00.000Z",
        updated_at: "2026-05-06T10:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const row = await createMetaAdsActionLog({
      businessId: "business_1",
      adId: "ad_1",
      creativeId: "creative_1",
      action: "pause",
      requestedBy: "user_1",
      payloadRequest: { body: { status: "PAUSED" } },
      recIdOrigin: "rec_1",
    });

    expect(row.recIdOrigin).toBe("rec_1");
    const insertSql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(insertSql).toContain("rec_id_origin");
  });
});
