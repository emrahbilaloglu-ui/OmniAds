import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/meta/ads-action-log", () => ({
  createMetaAdsActionLog: vi.fn(),
  completeMetaAdsActionLog: vi.fn(),
  hasRecentPendingMetaAdsAction: vi.fn(),
}));

vi.mock("@/lib/meta/ads-write", () => ({
  pauseCampaign: vi.fn(),
  pauseAdset: vi.fn(),
  updateAdsetBidAmount: vi.fn(),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const integrations = await import("@/lib/integrations");
const logs = await import("@/lib/meta/ads-action-log");
const writes = await import("@/lib/meta/ads-write");
const campaignPause = await import("@/app/api/meta/campaigns/[campaignId]/pause/route");
const adsetPause = await import("@/app/api/meta/adsets/[adsetId]/pause/route");
const applyBid = await import("@/app/api/meta/adsets/[adsetId]/apply-bid/route");

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/meta/entity", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("Meta entity write routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } } as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(db.getDb).mockReturnValue(vi.fn(async () => [{ provider_account_id: "act_1", label: "Entity" }]) as never);
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      provider_account_id: "act_1",
      access_token: "token",
    } as never);
    vi.mocked(logs.hasRecentPendingMetaAdsAction).mockResolvedValue(false);
    vi.mocked(logs.createMetaAdsActionLog).mockResolvedValue({ id: "log_1" } as never);
    vi.mocked(logs.completeMetaAdsActionLog).mockResolvedValue({ id: "log_1" } as never);
    vi.mocked(writes.pauseCampaign).mockResolvedValue({
      ok: true,
      verifiedStatus: "PAUSED",
      responsePayload: { success: true },
      verificationPayload: { status: "PAUSED" },
    });
    vi.mocked(writes.pauseAdset).mockResolvedValue({
      ok: true,
      verifiedStatus: "PAUSED",
      responsePayload: { success: true },
      verificationPayload: { status: "PAUSED" },
    });
    vi.mocked(writes.updateAdsetBidAmount).mockResolvedValue({
      ok: true,
      verifiedBidAmount: 2200,
      responsePayload: { success: true },
      verificationPayload: { bid_amount: 2200 },
    });
  });

  it("pauses campaigns with rec audit linkage", async () => {
    const response = await campaignPause.POST(
      request({ businessId: "biz_1", recId: "rec_1" }),
      { params: Promise.resolve({ campaignId: "cmp_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("PAUSED");
    expect(writes.pauseCampaign).toHaveBeenCalledWith(
      { businessId: "biz_1", providerAccountId: "act_1", accessToken: "token" },
      "cmp_1",
    );
    expect(logs.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pause", recIdOrigin: "rec_1", adId: "cmp_1" }),
    );
  });

  it("pauses adsets with verify-after-write infrastructure", async () => {
    const response = await adsetPause.POST(
      request({ businessId: "biz_1", recIdOrigin: "rec_2" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );

    expect(response.status).toBe(200);
    expect(writes.pauseAdset).toHaveBeenCalledWith(
      { businessId: "biz_1", providerAccountId: "act_1", accessToken: "token" },
      "adset_1",
    );
    expect(logs.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pause", recIdOrigin: "rec_2", adId: "adset_1" }),
    );
  });

  it("applies adset bid caps and persists rec_id_origin", async () => {
    const response = await applyBid.POST(
      request({ businessId: "biz_1", bidValue: 22, recId: "rec_bid" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.bidAmountMinor).toBe(2200);
    expect(writes.updateAdsetBidAmount).toHaveBeenCalledWith(
      { businessId: "biz_1", providerAccountId: "act_1", accessToken: "token" },
      { adsetId: "adset_1", bidAmountMinor: 2200 },
    );
    expect(logs.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "launch_adset", recIdOrigin: "rec_bid" }),
    );
  });
});
