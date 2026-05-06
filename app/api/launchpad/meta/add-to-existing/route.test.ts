import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { normalizeMetaAddToExistingPayload } from "@/lib/launchpad/meta";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/ads-action-log", () => ({
  completeMetaAdsActionLog: vi.fn(),
  createMetaAdsActionLog: vi.fn(),
  hasRecentPendingMetaAddToExistingAction: vi.fn(),
}));

vi.mock("@/lib/meta/ads-write", () => ({
  duplicateAd: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-validation", () => ({
  resolveMetaLaunchWriteContext: vi.fn(),
  validateMetaAddToExistingRequest: vi.fn(),
}));

const access = await import("@/lib/access");
const actionLog = await import("@/lib/meta/ads-action-log");
const adsWrite = await import("@/lib/meta/ads-write");
const validation = await import("@/lib/launchpad/meta-validation");
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "272d0ab8-495b-4679-a4c6-ffa404c389d3";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/launchpad/meta/add-to-existing", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function body() {
  return {
    businessId: BUSINESS_ID,
    targetCampaignId: "cmp_1",
    targetAdsetId: "adset_1",
    targets: [{ targetCampaignId: "cmp_1", targetAdsetId: "adset_1" }],
    creativeIds: ["creative_1", "creative_2"],
    creatives: [
      { creativeId: "creative_1", sourceAdId: "source_ad_1" },
      { creativeId: "creative_2", sourceAdId: "source_ad_2" },
    ],
    names: {
      creative_1: "Creative 1 added",
      creative_2: "Creative 2 added",
    },
    idempotencyKey: "idem_1",
  };
}

function mockValid() {
  vi.mocked(validation.validateMetaAddToExistingRequest).mockResolvedValue({
    ok: true,
    payload: normalizeMetaAddToExistingPayload({
      mode: "add_to_existing",
      targetCampaignId: "cmp_1",
      targetAdsetId: "adset_1",
      targets: [{ targetCampaignId: "cmp_1", targetAdsetId: "adset_1" }],
      creativeIds: ["creative_1", "creative_2"],
      creatives: [
        { creativeId: "creative_1", sourceAdId: "source_ad_1" },
        { creativeId: "creative_2", sourceAdId: "source_ad_2" },
      ],
      names: {
        creative_1: "Creative 1 added",
        creative_2: "Creative 2 added",
      },
    }),
    blockers: [],
    warnings: [],
    target: {
      campaignId: "cmp_1",
      adsetId: "adset_1",
      campaignName: "Campaign",
      adsetName: "Ad set",
      adsetStatus: "ACTIVE",
      providerAccountId: "act_123",
    },
    targets: [
      {
        campaignId: "cmp_1",
        adsetId: "adset_1",
        campaignName: "Campaign",
        adsetName: "Ad set",
        adsetStatus: "ACTIVE",
        providerAccountId: "act_123",
      },
    ],
    creatives: [
      { creativeId: "creative_1", creativeName: "Creative 1", effectiveStatus: "ACTIVE", sourceAdId: "source_ad_1" },
      { creativeId: "creative_2", creativeName: "Creative 2", effectiveStatus: "ACTIVE", sourceAdId: "source_ad_2" },
    ],
  });
}

describe("POST /api/launchpad/meta/add-to-existing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: USER_ID } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(actionLog.hasRecentPendingMetaAddToExistingAction).mockResolvedValue(false);
    vi.mocked(actionLog.createMetaAdsActionLog).mockImplementation(async () => ({
      id: `log_${vi.mocked(actionLog.createMetaAdsActionLog).mock.calls.length}`,
    }) as never);
    vi.mocked(actionLog.completeMetaAdsActionLog).mockResolvedValue({ id: "log" } as never);
    vi.mocked(validation.resolveMetaLaunchWriteContext).mockResolvedValue({
      ok: true,
      ctx: {
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        accessToken: "secret-token",
      },
    } as never);
    mockValid();
    vi.mocked(adsWrite.duplicateAd)
      .mockResolvedValueOnce({
        ok: true,
        newAdId: "ad_1",
        verifiedStatus: "PAUSED",
        responsePayload: { id: "ad_1" },
        verificationPayload: { id: "ad_1", status: "PAUSED" },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        newAdId: "ad_2",
        verifiedStatus: "PAUSED",
        responsePayload: { id: "ad_2" },
        verificationPayload: { id: "ad_2", status: "PAUSED" },
      } as never);
  });

  it("creates paused ads in the selected ad set and logs launch_ad only", async () => {
    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      targetCampaignId: "cmp_1",
      targetAdsetId: "adset_1",
      successCount: 2,
      failedCount: 0,
      adIds: ["ad_1", "ad_2"],
    });
    expect(payload.steps[0].adsManagerUrl).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=123&selected_ad_ids=ad_1",
    );
    expect(adsWrite.duplicateAd).toHaveBeenCalledTimes(2);
    expect(adsWrite.duplicateAd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adId: "source_ad_1",
        targetAdsetId: "adset_1",
        activateAfterCreate: false,
      }),
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "launch_ad", adId: "source_ad_1", creativeId: "creative_1" }),
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadRequest: expect.objectContaining({
          target_campaign_name: "Campaign",
          target_adset_name: "Ad set",
        }),
      }),
    );
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "launch_campaign" }),
    );
  });

  it("continues after a failed creative and returns ok false with partial results", async () => {
    vi.mocked(adsWrite.duplicateAd)
      .mockReset()
      .mockResolvedValueOnce({
        ok: false,
        httpStatus: 400,
        error: { code: "100", message: "Invalid creative." },
        responsePayload: { error: { code: 100 } },
        resultingAdId: "ad_partial_1",
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        newAdId: "ad_2",
        verifiedStatus: "PAUSED",
        responsePayload: { id: "ad_2" },
        verificationPayload: { id: "ad_2", status: "PAUSED" },
      } as never);

    const response = await POST(request({ ...body(), idempotencyKey: "idem_2" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(false);
    expect(payload.failedCount).toBe(1);
    expect(payload.successCount).toBe(1);
    expect(payload.results).toEqual([
      {
        creativeId: "creative_1",
        targetCampaignId: "cmp_1",
        targetAdsetId: "adset_1",
        ok: false,
        error: { code: "100", message: "Invalid creative." },
      },
      {
        creativeId: "creative_2",
        targetCampaignId: "cmp_1",
        targetAdsetId: "adset_1",
        ok: true,
        adId: "ad_2",
      },
    ]);
    expect(payload.steps[0]).toMatchObject({
      status: "failure",
      id: "ad_partial_1",
      adsManagerUrl:
        "https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=123&selected_ad_ids=ad_partial_1",
    });
    expect(adsWrite.duplicateAd).toHaveBeenCalledTimes(2);
  });

  it("creates ads across multiple selected campaign targets", async () => {
    vi.mocked(validation.validateMetaAddToExistingRequest).mockResolvedValue({
      ok: true,
      payload: normalizeMetaAddToExistingPayload({
        mode: "add_to_existing",
        targets: [
          { targetCampaignId: "cmp_1", targetAdsetId: "adset_1", targetAdsetName: "Ad set 1" },
          { targetCampaignId: "cmp_2", targetAdsetId: "adset_2", targetAdsetName: "Ad set 2" },
        ],
        creativeIds: ["creative_1"],
        creatives: [{ creativeId: "creative_1", sourceAdId: "source_ad_1" }],
        names: { creative_1: "Creative 1 added" },
      }),
      blockers: [],
      warnings: [],
      target: {
        campaignId: "cmp_1",
        adsetId: "adset_1",
        campaignName: "Campaign 1",
        adsetName: "Ad set 1",
        adsetStatus: "ACTIVE",
        providerAccountId: "act_123",
      },
      targets: [
        {
          campaignId: "cmp_1",
          adsetId: "adset_1",
          campaignName: "Campaign 1",
          adsetName: "Ad set 1",
          adsetStatus: "ACTIVE",
          providerAccountId: "act_123",
        },
        {
          campaignId: "cmp_2",
          adsetId: "adset_2",
          campaignName: "Campaign 2",
          adsetName: "Ad set 2",
          adsetStatus: "ACTIVE",
          providerAccountId: "act_456",
        },
      ],
      creatives: [
        { creativeId: "creative_1", creativeName: "Creative 1", effectiveStatus: "ACTIVE", sourceAdId: "source_ad_1" },
      ],
    });
    vi.mocked(adsWrite.duplicateAd)
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        newAdId: "ad_1",
        verifiedStatus: "PAUSED",
        responsePayload: { id: "ad_1" },
        verificationPayload: { id: "ad_1", status: "PAUSED" },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        newAdId: "ad_2",
        verifiedStatus: "PAUSED",
        responsePayload: { id: "ad_2" },
        verificationPayload: { id: "ad_2", status: "PAUSED" },
      } as never);

    const response = await POST(
      request({
        ...body(),
        idempotencyKey: "idem_multi",
        targets: [
          { targetCampaignId: "cmp_1", targetAdsetId: "adset_1" },
          { targetCampaignId: "cmp_2", targetAdsetId: "adset_2" },
        ],
        creativeIds: ["creative_1"],
        creatives: [{ creativeId: "creative_1", sourceAdId: "source_ad_1" }],
        names: { creative_1: "Creative 1 added" },
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      successCount: 2,
      failedCount: 0,
      adIds: ["ad_1", "ad_2"],
    });
    expect(actionLog.hasRecentPendingMetaAddToExistingAction).toHaveBeenCalledWith(
      expect.objectContaining({ targetAdsetId: "adset_1" }),
    );
    expect(actionLog.hasRecentPendingMetaAddToExistingAction).toHaveBeenCalledWith(
      expect.objectContaining({ targetAdsetId: "adset_2" }),
    );
    expect(adsWrite.duplicateAd).toHaveBeenCalledTimes(2);
    expect(adsWrite.duplicateAd).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerAccountId: "act_123" }),
      expect.objectContaining({ targetAdsetId: "adset_1" }),
    );
    expect(adsWrite.duplicateAd).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerAccountId: "act_456" }),
      expect.objectContaining({ targetAdsetId: "adset_2" }),
    );
  });

  it("blocks duplicate pending requests for the same idempotency key and ad set", async () => {
    vi.mocked(actionLog.hasRecentPendingMetaAddToExistingAction).mockResolvedValue(true);

    const response = await POST(request({ ...body(), idempotencyKey: "idem_3" }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("launch_in_flight");
    expect(validation.validateMetaAddToExistingRequest).not.toHaveBeenCalled();
    expect(adsWrite.duplicateAd).not.toHaveBeenCalled();
  });
});
