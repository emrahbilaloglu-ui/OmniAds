import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { normalizeMetaLaunchPayload } from "@/lib/launchpad/meta";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/ads-action-log", () => ({
  completeMetaAdsActionLog: vi.fn(),
  createMetaAdsActionLog: vi.fn(),
  hasRecentPendingMetaLaunchAction: vi.fn(),
}));

vi.mock("@/lib/meta/launch-write", () => ({
  createCampaign: vi.fn(),
  createAdSet: vi.fn(),
  createAd: vi.fn(),
}));

vi.mock("@/lib/meta/automation-write-guard", () => ({
  rejectIfMetaWritesBlocked: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-validation", () => ({
  metaLaunchAccountBlockerHttpStatus: vi.fn((code: string) =>
    code === "provider_account_not_assigned" ? 403 : 400,
  ),
  resolveAssignedMetaLaunchAccount: vi.fn(),
  resolveMetaLaunchWriteContext: vi.fn(),
  validateMetaLaunchRequest: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-launch-intent-service", () => ({
  prepareMetaLaunchIntentForExecution: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-launch-intent-capability", () => ({
  getMetaLaunchIntentCapability: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  markMetaLaunchIntentExecuting: vi.fn(),
  recordMetaLaunchIntentOutcome: vi.fn(),
  recordMetaLaunchIntentPreExecutionFailure: vi.fn(),
  recordMetaLaunchIntentValidation: vi.fn(),
  recordMetaLaunchIntentWriteBlocked: vi.fn(),
}));

const access = await import("@/lib/access");
const actionLog = await import("@/lib/meta/ads-action-log");
const writeGuard = await import("@/lib/meta/automation-write-guard");
const launchWrite = await import("@/lib/meta/launch-write");
const validation = await import("@/lib/launchpad/meta-validation");
const intentService = await import("@/lib/launchpad/meta-launch-intent-service");
const intentCapability = await import("@/lib/launchpad/meta-launch-intent-capability");
const intentStore = await import("@/lib/launchpad/meta-launch-intent-store");
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "272d0ab8-495b-4679-a4c6-ffa404c389d3";

function payload() {
  return {
    campaign: {
      name: "Launchpad test",
      objective: "OUTCOME_SALES",
      specialAdCategories: [],
    },
    budget: {
      mode: "CBO",
      schedule: "daily",
      amountMinor: 5000,
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    },
    creatives: [
      { creativeId: "creative_1", name: "Creative 1" },
      { creativeId: "creative_2", name: "Creative 2" },
    ],
    adSets: [
      {
        clientId: "adset-1",
        name: "Ad set 1",
        optimizationGoal: "OFFSITE_CONVERSIONS",
        pixelId: "pixel_1",
        customEventType: "PURCHASE",
        targeting: {
          countries: ["US"],
          ageMin: 18,
          ageMax: 65,
          advantageAudience: true,
          advantagePlacements: true,
        },
        attributionSpec: [{ eventType: "CLICK_THROUGH", windowDays: 7 }],
      },
    ],
  };
}

function request(body: unknown) {
  const scopedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? { providerAccountId: "act_123", ...body }
      : body;
  return new NextRequest("http://localhost/api/launchpad/meta/launch", {
    method: "POST",
    body: JSON.stringify(scopedBody),
    headers: { "Content-Type": "application/json" },
  });
}

function mockValidPayload() {
  vi.mocked(validation.validateMetaLaunchRequest).mockResolvedValue({
    ok: true,
    payload: normalizeMetaLaunchPayload(payload()),
    blockers: [],
    warnings: [],
    pixels: [],
  });
}

describe("POST /api/launchpad/meta/launch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(intentCapability.getMetaLaunchIntentCapability).mockResolvedValue({
      status: "ready",
      canRead: true,
      canWrite: true,
      missingTables: [],
      checkedAt: "2026-07-11T00:00:00.000Z",
    });
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: USER_ID } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(actionLog.hasRecentPendingMetaLaunchAction).mockResolvedValue(false);
    vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValue(null);
    vi.mocked(actionLog.createMetaAdsActionLog).mockImplementation(async () => ({
      id: `log_${vi.mocked(actionLog.createMetaAdsActionLog).mock.calls.length}`,
    }) as never);
    vi.mocked(actionLog.completeMetaAdsActionLog).mockResolvedValue({
      id: "log",
    } as never);
    vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
      ok: true,
      providerAccountId: "act_123",
    });
    vi.mocked(intentService.prepareMetaLaunchIntentForExecution).mockResolvedValue({
      ok: true,
      created: true,
      intent: { id: "intent_1", status: "prepared" },
    } as never);
    vi.mocked(intentStore.recordMetaLaunchIntentValidation).mockResolvedValue({
      id: "intent_1",
      status: "ready",
    } as never);
    vi.mocked(intentStore.markMetaLaunchIntentExecuting).mockResolvedValue({
      id: "intent_1",
      status: "executing",
    } as never);
    vi.mocked(intentStore.recordMetaLaunchIntentOutcome).mockImplementation(
      async (input) => ({ id: "intent_1", status: input.status }) as never,
    );
    vi.mocked(intentStore.recordMetaLaunchIntentPreExecutionFailure).mockResolvedValue({
      id: "intent_1",
      status: "failed",
    } as never);
    vi.mocked(intentStore.recordMetaLaunchIntentWriteBlocked).mockResolvedValue({
      id: "intent_1",
      status: "write_blocked",
    } as never);
    vi.mocked(validation.resolveMetaLaunchWriteContext).mockResolvedValue({
      ok: true,
      ctx: {
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        accessToken: "secret-token",
      },
    } as never);
    mockValidPayload();
    vi.mocked(launchWrite.createCampaign).mockResolvedValue({
      ok: true,
      campaignId: "cmp_1",
      verifiedStatus: "PAUSED",
      responsePayload: { id: "cmp_1" },
      verificationPayload: {
        id: "cmp_1",
        status: "PAUSED",
        objective: "OUTCOME_SALES",
      },
    } as never);
    vi.mocked(launchWrite.createAdSet).mockResolvedValue({
      ok: true,
      adsetId: "adset_1",
      verifiedStatus: "PAUSED",
      responsePayload: { id: "adset_1" },
      verificationPayload: { id: "adset_1", status: "PAUSED" },
    } as never);
    vi.mocked(launchWrite.createAd)
      .mockResolvedValueOnce({
        ok: true,
        adId: "ad_1",
        verifiedStatus: "PAUSED",
        responsePayload: { id: "ad_1" },
        verificationPayload: { id: "ad_1", status: "PAUSED" },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        adId: "ad_2",
        verifiedStatus: "PAUSED",
        responsePayload: { id: "ad_2" },
        verificationPayload: { id: "ad_2", status: "PAUSED" },
      } as never);
  });

  it("orchestrates campaign, ad set, and ads with audit logs", async () => {
    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        payload: payload(),
        idempotencyKey: "idem_1",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      campaignId: "cmp_1",
      adsetIds: ["adset_1"],
      adIds: ["ad_1", "ad_2"],
      launchIntentId: "intent_1",
      launchIntentStatus: "succeeded",
    });
    expect(body.steps).toHaveLength(4);
    expect(launchWrite.createCampaign).toHaveBeenCalledOnce();
    expect(launchWrite.createAdSet).toHaveBeenCalledOnce();
    expect(launchWrite.createAd).toHaveBeenCalledTimes(2);
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "launch_campaign",
        payloadRequest: expect.objectContaining({ launch_intent_id: "intent_1" }),
      }),
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "launch_adset" }),
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "launch_ad",
        creativeId: "creative_1",
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        resultingAdId: "cmp_1",
      }),
    );
    expect(validation.validateMetaLaunchRequest).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      payload: normalizeMetaLaunchPayload(payload()),
    });
    expect(intentStore.recordMetaLaunchIntentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "intent_1",
        status: "succeeded",
      }),
    );
  });

  it("returns partial state when campaign succeeds but ad set fails", async () => {
    vi.mocked(launchWrite.createAdSet).mockResolvedValueOnce({
      ok: false,
      httpStatus: 400,
      error: { code: "100", message: "Invalid targeting." },
      responsePayload: { error: { code: 100 } },
    } as never);

    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        payload: payload(),
        idempotencyKey: "idem_2",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      ok: false,
      campaignId: "cmp_1",
      adsetIds: [],
      adIds: [],
      failedAt: "adset:1",
      error: { code: "100" },
    });
    expect(launchWrite.createAd).not.toHaveBeenCalled();
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failure",
        errorCode: "100",
      }),
    );
  });

  it("returns 409 when the idempotency key is already pending", async () => {
    vi.mocked(actionLog.hasRecentPendingMetaLaunchAction).mockResolvedValue(true);

    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        payload: payload(),
        idempotencyKey: "idem_3",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("launch_in_flight");
    expect(validation.validateMetaLaunchRequest).not.toHaveBeenCalled();
    expect(launchWrite.createCampaign).not.toHaveBeenCalled();
  });

  it("blocks launch before validation when the Meta write kill switch is engaged", async () => {
    vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValueOnce(
      NextResponse.json(
        { ok: false, error: { code: "kill_switch_engaged" } },
        { status: 503 },
      ),
    );

    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        payload: payload(),
        idempotencyKey: "idem_kill",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("kill_switch_engaged");
    expect(body.launchIntentId).toBe("intent_1");
    expect(intentStore.recordMetaLaunchIntentWriteBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ id: "intent_1" }),
    );
    expect(validation.validateMetaLaunchRequest).not.toHaveBeenCalled();
    expect(launchWrite.createCampaign).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("rejects reviewer read-only launch attempts before kill-switch or validation", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "reviewer_1", email: "shopify-review@adsecute.com" } },
      membership: { businessId: BUSINESS_ID },
    } as never);

    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        payload: payload(),
        idempotencyKey: "idem_reviewer",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("reviewer_read_only");
    expect(body.error.action).toBe("launchpad_launch");
    expect(writeGuard.rejectIfMetaWritesBlocked).not.toHaveBeenCalled();
    expect(validation.validateMetaLaunchRequest).not.toHaveBeenCalled();
    expect(launchWrite.createCampaign).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("blocks launch when validation returns blockers", async () => {
    vi.mocked(validation.validateMetaLaunchRequest).mockResolvedValue({
      ok: false,
      payload: normalizeMetaLaunchPayload(payload()),
      blockers: [{ code: "pixel_not_active", message: "Pixel inactive." }],
      warnings: [],
      pixels: [],
    });

    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        payload: payload(),
        idempotencyKey: "idem_4",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("validation_blocked");
    expect(launchWrite.createCampaign).not.toHaveBeenCalled();
  });

  it("persists a terminal receipt when validation infrastructure fails", async () => {
    vi.mocked(validation.validateMetaLaunchRequest).mockRejectedValueOnce(
      new Error("warehouse unavailable"),
    );

    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        payload: payload(),
        idempotencyKey: "idem_validation_error",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("launch_validation_failed");
    expect(body.launchIntentId).toBe("intent_1");
    expect(intentStore.recordMetaLaunchIntentPreExecutionFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "intent_1",
        receipt: expect.objectContaining({ code: "launch_validation_failed" }),
      }),
    );
    expect(launchWrite.createCampaign).not.toHaveBeenCalled();
  });

  it("blocks before intent preparation or provider writes when the intent migration is missing", async () => {
    vi.mocked(intentCapability.getMetaLaunchIntentCapability).mockResolvedValue({
      status: "migration_required",
      canRead: false,
      canWrite: false,
      missingTables: ["meta_launch_intents"],
      checkedAt: "2026-07-11T00:00:00.000Z",
    });

    const response = await POST(
      request({ businessId: BUSINESS_ID, payload: payload(), idempotencyKey: "idem_missing" }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "launch_intent_migration_required" },
    });
    expect(intentService.prepareMetaLaunchIntentForExecution).not.toHaveBeenCalled();
    expect(launchWrite.createCampaign).not.toHaveBeenCalled();
  });
});
