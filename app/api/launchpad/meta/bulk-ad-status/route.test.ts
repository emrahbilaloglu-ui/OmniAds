import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/ads-action-log", () => ({
  completeMetaAdsActionLog: vi.fn(),
  createMetaAdsActionLog: vi.fn(),
  hasRecentPendingMetaAdsAction: vi.fn(),
  resolveMetaAdActionTarget: vi.fn(),
}));

vi.mock("@/lib/meta/ads-write", () => ({
  pauseAd: vi.fn(),
  resumeAd: vi.fn(),
}));

vi.mock("@/lib/meta/automation-write-guard", () => ({
  rejectIfMetaWritesBlocked: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-validation", () => ({
  resolveMetaLaunchWriteContext: vi.fn(),
}));

const access = await import("@/lib/access");
const actionLog = await import("@/lib/meta/ads-action-log");
const adsWrite = await import("@/lib/meta/ads-write");
const writeGuard = await import("@/lib/meta/automation-write-guard");
const validation = await import("@/lib/launchpad/meta-validation");
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "272d0ab8-495b-4679-a4c6-ffa404c389d3";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/launchpad/meta/bulk-ad-status", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function body() {
  return {
    businessId: BUSINESS_ID,
    action: "pause",
    ads: [
      { adId: "ad_1", creativeId: "creative_1", name: "Creative 1" },
      { adId: "ad_2", creativeId: "creative_2", name: "Creative 2" },
    ],
    idempotencyKey: "bulk_1",
  };
}

describe("POST /api/launchpad/meta/bulk-ad-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: USER_ID } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(validation.resolveMetaLaunchWriteContext).mockResolvedValue({
      ok: true,
      ctx: {
        businessId: BUSINESS_ID,
        providerAccountId: "act_default",
        accessToken: "secret-token",
      },
    } as never);
    vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValue(null);
    vi.mocked(actionLog.hasRecentPendingMetaAdsAction).mockResolvedValue(false);
    vi.mocked(actionLog.createMetaAdsActionLog).mockImplementation(async () => ({
      id: `log_${vi.mocked(actionLog.createMetaAdsActionLog).mock.calls.length}`,
    }) as never);
    vi.mocked(actionLog.completeMetaAdsActionLog).mockResolvedValue({ id: "log" } as never);
    vi.mocked(actionLog.resolveMetaAdActionTarget).mockImplementation(async (input) => ({
      ok: true,
      target: {
        businessId: BUSINESS_ID,
        adId: input.adId,
        creativeId: input.adId === "ad_1" ? "creative_1" : "creative_2",
        providerAccountId: input.adId === "ad_1" ? "act_123" : "act_456",
      },
    }) as never);
    vi.mocked(adsWrite.pauseAd)
      .mockResolvedValueOnce({
        ok: true,
        verifiedStatus: "PAUSED",
        responsePayload: { success: true },
        verificationPayload: { id: "ad_1", status: "PAUSED" },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        verifiedStatus: "PAUSED",
        responsePayload: { success: true },
        verificationPayload: { id: "ad_2", status: "PAUSED" },
      } as never);
    vi.mocked(adsWrite.resumeAd).mockResolvedValue({
      ok: true,
      verifiedStatus: "ACTIVE",
      responsePayload: { success: true },
      verificationPayload: { status: "ACTIVE" },
    } as never);
  });

  it("pauses selected ads with each resolved provider account", async () => {
    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      action: "pause",
      status: "PAUSED",
      successCount: 2,
      failedCount: 0,
      adIds: ["ad_1", "ad_2"],
    });
    expect(adsWrite.pauseAd).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerAccountId: "act_123" }),
      "ad_1",
    );
    expect(adsWrite.pauseAd).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerAccountId: "act_456" }),
      "ad_2",
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pause", adId: "ad_1", creativeId: "creative_1" }),
    );
  });

  it("continues after a failed ad and returns partial results", async () => {
    vi.mocked(adsWrite.pauseAd)
      .mockReset()
      .mockResolvedValueOnce({
        ok: false,
        httpStatus: 400,
        error: { code: "100", message: "Cannot pause ad." },
        responsePayload: { error: { code: 100 } },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        verifiedStatus: "PAUSED",
        responsePayload: { success: true },
        verificationPayload: { id: "ad_2", status: "PAUSED" },
      } as never);

    const response = await POST(request({ ...body(), idempotencyKey: "bulk_2" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(false);
    expect(payload.failedCount).toBe(1);
    expect(payload.successCount).toBe(1);
    expect(payload.results).toEqual([
      {
        inputAdId: "ad_1",
        adId: "ad_1",
        creativeId: "creative_1",
        ok: false,
        attemptedIds: ["ad_1"],
        error: { code: "100", message: "Cannot pause ad." },
      },
      {
        inputAdId: "ad_2",
        adId: "ad_2",
        creativeId: "creative_2",
        ok: true,
        status: "PAUSED",
        attemptedIds: ["ad_2"],
      },
    ]);
  });

  it("resolves bulk pause through fallback candidate ids before mutating Meta", async () => {
    vi.mocked(actionLog.resolveMetaAdActionTarget).mockImplementation(async (input) => {
      if (input.adId === "stale_row_id") {
        return { ok: false, reason: "ad_not_found" } as never;
      }
      return {
        ok: true,
        target: {
          businessId: BUSINESS_ID,
          adId: "real_ad_1",
          creativeId: "creative_1",
          providerAccountId: "act_123",
        },
      } as never;
    });
    vi.mocked(adsWrite.pauseAd).mockReset().mockResolvedValueOnce({
      ok: true,
      verifiedStatus: "PAUSED",
      responsePayload: { success: true },
      verificationPayload: { id: "real_ad_1", status: "PAUSED" },
    } as never);

    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        action: "pause",
        ads: [
          {
            adId: "stale_row_id",
            candidateAdIds: ["stale_row_id", "real_ad_1", "creative_1"],
            creativeId: "creative_1",
            name: "Creative 1",
          },
        ],
        idempotencyKey: "bulk_fallback",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      results: [
        {
          inputAdId: "stale_row_id",
          adId: "real_ad_1",
          creativeId: "creative_1",
          ok: true,
          attemptedIds: ["stale_row_id", "real_ad_1"],
        },
      ],
    });
    expect(actionLog.resolveMetaAdActionTarget).toHaveBeenNthCalledWith(1, {
      businessId: BUSINESS_ID,
      adId: "stale_row_id",
    });
    expect(actionLog.resolveMetaAdActionTarget).toHaveBeenNthCalledWith(2, {
      businessId: BUSINESS_ID,
      adId: "real_ad_1",
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_123" }),
      "real_ad_1",
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        adId: "real_ad_1",
        payloadRequest: expect.objectContaining({
          input_ad_id: "stale_row_id",
          resolved_from_input_id: "real_ad_1",
          candidate_ad_ids: ["stale_row_id", "real_ad_1", "creative_1"],
        }),
      }),
    );
  });

  it("resumes selected ads", async () => {
    const response = await POST(
      request({ ...body(), action: "resume", idempotencyKey: "bulk_3" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("ACTIVE");
    expect(adsWrite.resumeAd).toHaveBeenCalledTimes(2);
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("blocks bulk status writes before provider context or target resolution", async () => {
    vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValueOnce(
      NextResponse.json(
        { ok: false, error: { code: "kill_switch_engaged" } },
        { status: 503 },
      ),
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("kill_switch_engaged");
    expect(validation.resolveMetaLaunchWriteContext).not.toHaveBeenCalled();
    expect(actionLog.resolveMetaAdActionTarget).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });
});
