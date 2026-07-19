import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/meta/automation-write-guard", () => ({
  rejectIfMetaWritesBlocked: vi.fn(),
}));

vi.mock("@/lib/meta/account-context", () => ({
  getMetaAccountContext: vi.fn(),
  normalizeMetaCurrencyCode: vi.fn((value: unknown) =>
    typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null,
  ),
}));

vi.mock("@/lib/meta/ads-action-log", () => ({
  createMetaAdsActionLog: vi.fn(),
  completeMetaAdsActionLog: vi.fn(),
  hasRecentPendingMetaAdsAction: vi.fn(),
}));

vi.mock("@/lib/meta/ads-write", () => ({
  hasSuccessfulMetaProviderMutationAttempt: vi.fn(
    (result: {
      mutationAttempt?: { providerResponseSuccessful?: boolean } | null;
    }) => result.mutationAttempt?.providerResponseSuccessful === true,
  ),
  pauseCampaign: vi.fn(),
  readMetaEntityExecutionState: vi.fn(),
  resumeCampaign: vi.fn(),
  pauseAdset: vi.fn(),
  resumeAdset: vi.fn(),
  updateAdsetBidAmount: vi.fn(),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const integrations = await import("@/lib/integrations");
const writeGuard = await import("@/lib/meta/automation-write-guard");
const accountContext = await import("@/lib/meta/account-context");
const logs = await import("@/lib/meta/ads-action-log");
const writes = await import("@/lib/meta/ads-write");
const campaignPause = await import("@/app/api/meta/campaigns/[campaignId]/pause/route");
const campaignResume = await import("@/app/api/meta/campaigns/[campaignId]/resume/route");
const adsetPause = await import("@/app/api/meta/adsets/[adsetId]/pause/route");
const adsetResume = await import("@/app/api/meta/adsets/[adsetId]/resume/route");
const applyBid = await import("@/app/api/meta/adsets/[adsetId]/apply-bid/route");

function request(
  body: Record<string, unknown>,
  options: { injectManualOrigin?: boolean } = {},
) {
  const injectManualOrigin = options.injectManualOrigin !== false;
  return new NextRequest("http://localhost/api/meta/entity", {
    method: "POST",
    body: JSON.stringify({
      ...(injectManualOrigin
        ? {
            actionOrigin: "manual_operator_v1",
            manualConfirmation: "explicit_operator_confirmation",
            providerAccountId: "act_1",
          }
        : {}),
      ...body,
    }),
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
    vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValue(null);
    vi.mocked(accountContext.getMetaAccountContext).mockResolvedValue({
      accountProfiles: {
        act_1: { currency: "USD", timezone: null, name: "Account" },
      },
    } as never);
    vi.mocked(logs.hasRecentPendingMetaAdsAction).mockResolvedValue(false);
    vi.mocked(logs.createMetaAdsActionLog).mockResolvedValue({ id: "log_1" } as never);
    vi.mocked(logs.completeMetaAdsActionLog).mockResolvedValue({ id: "log_1" } as never);
    vi.mocked(writes.readMetaEntityExecutionState).mockImplementation(
      async (_ctx, scopeType, entityId) => ({
        ok: true,
        scopeType,
        entityId,
        providerAccountId: "act_1",
        configuredStatus: "ACTIVE",
        effectiveStatus: "ACTIVE",
        campaignId: scopeType === "campaign" ? entityId : "cmp_1",
        campaignProviderAccountId: "act_1",
        campaignConfiguredStatus: "ACTIVE",
        campaignEffectiveStatus: "ACTIVE",
        observedAt: "2026-07-18T14:00:00.000Z",
      }),
    );
    vi.mocked(writes.pauseCampaign).mockResolvedValue({
      ok: true,
      verifiedStatus: "PAUSED",
      responsePayload: { success: true },
      verificationPayload: { status: "PAUSED" },
    });
    vi.mocked(writes.resumeCampaign).mockResolvedValue({
      ok: true,
      verifiedStatus: "ACTIVE",
      responsePayload: { success: true },
      verificationPayload: { status: "ACTIVE" },
    });
    vi.mocked(writes.pauseAdset).mockResolvedValue({
      ok: true,
      verifiedStatus: "PAUSED",
      responsePayload: { success: true },
      verificationPayload: { status: "PAUSED" },
    });
    vi.mocked(writes.resumeAdset).mockResolvedValue({
      ok: true,
      verifiedStatus: "ACTIVE",
      responsePayload: { success: true },
      verificationPayload: { status: "ACTIVE" },
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
      expect.objectContaining({
        action: "pause",
        source: "manual_operator_v1",
        recIdOrigin: "rec_1",
        adId: "cmp_1",
        payloadRequest: expect.objectContaining({
          action_origin: "manual_operator_v1",
          manual_confirmation: "explicit_operator_confirmation",
        }),
      }),
    );
  });

  it("rejects campaign and ad set writes without an explicit action origin", async () => {
    const response = await campaignPause.POST(
      request(
        {
          businessId: "biz_1",
          manualConfirmation: "explicit_operator_confirmation",
        },
        { injectManualOrigin: false },
      ),
      { params: Promise.resolve({ campaignId: "cmp_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("action_origin_required");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(db.getDb).not.toHaveBeenCalled();
    expect(logs.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(writes.pauseCampaign).not.toHaveBeenCalled();
  });

  it("rejects manual campaign and ad set writes without explicit confirmation", async () => {
    const response = await adsetPause.POST(
      request({ businessId: "biz_1", manualConfirmation: undefined }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("manual_confirmation_required");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(db.getDb).not.toHaveBeenCalled();
    expect(logs.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(writes.pauseAdset).not.toHaveBeenCalled();
  });

  it.each([
    ["contractVersion", null],
    ["snapshot_id", ""],
    ["evaluationId", null],
    ["engine_version", ""],
    ["decisionHash", null],
    ["decision_action", ""],
  ])(
    "rejects explicit native lineage field %s=%j on manual entity writes",
    async (field, value) => {
      const response = await campaignPause.POST(
        request({ businessId: "biz_1", [field]: value }),
        { params: Promise.resolve({ campaignId: "cmp_1" }) },
      );
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe("mixed_action_origin_contract");
      expect(access.requireBusinessAccess).not.toHaveBeenCalled();
      expect(writes.pauseCampaign).not.toHaveBeenCalled();
    },
  );

  it("rejects a conflicting entity action-origin alias", async () => {
    const response = await campaignPause.POST(
      request({
        businessId: "biz_1",
        action_origin: "native_decision_v1",
      }),
      { params: Promise.resolve({ campaignId: "cmp_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("mixed_action_origin_contract");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(writes.pauseCampaign).not.toHaveBeenCalled();
  });

  it("rejects malformed dryRun before creating a log or provider write", async () => {
    const response = await campaignPause.POST(
      request({ businessId: "biz_1", dryRun: "true" }),
      { params: Promise.resolve({ campaignId: "cmp_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_dry_run");
    expect(logs.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(writes.pauseCampaign).not.toHaveBeenCalled();
  });

  it("rejects reviewer read-only provider writes before kill-switch or Meta calls", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "reviewer_1", email: "shopify-review@adsecute.com" } } as never,
      membership: { businessId: "biz_1" } as never,
    });

    const response = await adsetPause.POST(
      request({ businessId: "biz_1", recIdOrigin: "rec_2" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("reviewer_read_only");
    expect(payload.error.action).toBe("adset_pause");
    expect(writeGuard.rejectIfMetaWritesBlocked).not.toHaveBeenCalled();
    expect(writes.pauseAdset).not.toHaveBeenCalled();
    expect(logs.createMetaAdsActionLog).not.toHaveBeenCalled();
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
      expect.objectContaining({
        action: "pause",
        source: "manual_operator_v1",
        recIdOrigin: "rec_2",
        adId: "adset_1",
        payloadRequest: expect.objectContaining({
          action_origin: "manual_operator_v1",
          manual_confirmation: "explicit_operator_confirmation",
        }),
      }),
    );
  });

  it("blocks entity writes when the server-presented account no longer matches", async () => {
    const response = await adsetPause.POST(
      request({
        businessId: "biz_1",
        providerAccountId: "act_other",
      }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("provider_account_mismatch");
    expect(writes.readMetaEntityExecutionState).not.toHaveBeenCalled();
    expect(writes.pauseAdset).not.toHaveBeenCalled();
  });

  it("blocks ad set writes when the live parent campaign is missing", async () => {
    vi.mocked(writes.readMetaEntityExecutionState).mockResolvedValueOnce({
      ok: true,
      scopeType: "adset",
      entityId: "adset_1",
      providerAccountId: "act_1",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      campaignId: null,
      campaignProviderAccountId: null,
      campaignConfiguredStatus: null,
      campaignEffectiveStatus: null,
      observedAt: "2026-07-18T14:00:00.000Z",
    });

    const response = await adsetPause.POST(
      request({ businessId: "biz_1" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe(
      "current_hierarchy_identity_mismatch",
    );
    expect(writes.pauseAdset).not.toHaveBeenCalled();
  });

  it("fails retryably when live entity state cannot be read", async () => {
    vi.mocked(writes.readMetaEntityExecutionState).mockResolvedValueOnce({
      ok: false,
      scopeType: "campaign",
      entityId: "cmp_1",
      error: { code: "network_error", message: "connection reset" },
      httpStatus: null,
    });

    const response = await campaignPause.POST(
      request({ businessId: "biz_1" }),
      { params: Promise.resolve({ campaignId: "cmp_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("network_error");
    expect(writes.pauseCampaign).not.toHaveBeenCalled();
    expect(logs.createMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("resumes campaigns with verify-after-write infrastructure", async () => {
    vi.mocked(writes.readMetaEntityExecutionState).mockResolvedValueOnce({
      ok: true,
      scopeType: "campaign",
      entityId: "cmp_1",
      providerAccountId: "act_1",
      configuredStatus: "PAUSED",
      effectiveStatus: "PAUSED",
      campaignId: "cmp_1",
      campaignProviderAccountId: "act_1",
      campaignConfiguredStatus: "PAUSED",
      campaignEffectiveStatus: "PAUSED",
      observedAt: "2026-07-18T14:00:00.000Z",
    });
    const response = await campaignResume.POST(
      request({ businessId: "biz_1" }),
      { params: Promise.resolve({ campaignId: "cmp_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, action: "resume", scopeType: "campaign", status: "ACTIVE" });
    expect(writes.resumeCampaign).toHaveBeenCalledWith(
      { businessId: "biz_1", providerAccountId: "act_1", accessToken: "token" },
      "cmp_1",
    );
    expect(logs.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "resume",
        source: "manual_operator_v1",
        recIdOrigin: null,
        adId: "cmp_1",
        payloadRequest: expect.objectContaining({ body: { status: "ACTIVE" } }),
      }),
    );
  });

  it("resumes adsets with verify-after-write infrastructure", async () => {
    vi.mocked(writes.readMetaEntityExecutionState).mockResolvedValueOnce({
      ok: true,
      scopeType: "adset",
      entityId: "adset_1",
      providerAccountId: "act_1",
      configuredStatus: "PAUSED",
      effectiveStatus: "PAUSED",
      campaignId: "cmp_1",
      campaignProviderAccountId: "act_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      observedAt: "2026-07-18T14:00:00.000Z",
    });
    const response = await adsetResume.POST(
      request({ businessId: "biz_1" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, action: "resume", scopeType: "adset", status: "ACTIVE" });
    expect(writes.resumeAdset).toHaveBeenCalledWith(
      { businessId: "biz_1", providerAccountId: "act_1", accessToken: "token" },
      "adset_1",
    );
    expect(logs.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "resume",
        source: "manual_operator_v1",
        recIdOrigin: null,
        adId: "adset_1",
        payloadRequest: expect.objectContaining({ body: { status: "ACTIVE" } }),
      }),
    );
  });

  it("surfaces resume silent_failure without marking the route successful", async () => {
    vi.mocked(writes.readMetaEntityExecutionState).mockResolvedValueOnce({
      ok: true,
      scopeType: "adset",
      entityId: "adset_1",
      providerAccountId: "act_1",
      configuredStatus: "PAUSED",
      effectiveStatus: "PAUSED",
      campaignId: "cmp_1",
      campaignProviderAccountId: "act_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      observedAt: "2026-07-18T14:00:00.000Z",
    });
    vi.mocked(writes.resumeAdset).mockResolvedValueOnce({
      ok: false,
      httpStatus: 502,
      error: {
        code: "silent_failure",
        message: "Meta returned success but ad set status verified as PAUSED instead of ACTIVE.",
      },
      responsePayload: { success: true },
      verificationPayload: { status: "PAUSED" },
    } as never);

    const response = await adsetResume.POST(
      request({ businessId: "biz_1" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "silent_failure",
      },
    });
    expect(logs.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "silent_failure",
        errorCode: "silent_failure",
      }),
    );
  });

  it("records a successful entity POST with failed verification as non-retryable silent_failure", async () => {
    const mutationAttempt = {
      attemptCount: 1 as const,
      method: "POST" as const,
      path: "adset_1",
      attemptedAt: "2026-07-18T15:00:00.000Z",
      completedAt: "2026-07-18T15:00:01.000Z",
      providerResponseReceived: true,
      providerResponseSuccessful: true,
      httpStatus: 200,
      outcome: "provider_response_received" as const,
      automaticRetryAttempted: false as const,
      transportError: null,
    };
    vi.mocked(writes.readMetaEntityExecutionState).mockResolvedValueOnce({
      ok: true,
      scopeType: "adset",
      entityId: "adset_1",
      providerAccountId: "act_1",
      configuredStatus: "PAUSED",
      effectiveStatus: "PAUSED",
      campaignId: "cmp_1",
      campaignProviderAccountId: "act_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      observedAt: "2026-07-18T14:00:00.000Z",
    });
    vi.mocked(writes.resumeAdset).mockResolvedValueOnce({
      ok: false,
      httpStatus: 502,
      providerOutcome: "definite_failure",
      mutationAttempt,
      error: {
        code: "network_error",
        message: "verification connection reset",
      },
      responsePayload: { success: true },
      verificationPayload: null,
    } as never);

    const response = await adsetResume.POST(
      request({ businessId: "biz_1" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      providerOutcome: "definite_failure",
      mutationAttempt,
      retryAllowed: false,
      error: { code: "network_error" },
    });
    expect(logs.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "silent_failure",
        errorCode: "network_error",
      }),
    );
  });

  it("applies adset bid caps and persists rec_id_origin", async () => {
    const response = await applyBid.POST(
      request({ businessId: "biz_1", bidAmountMinor: 2200, recId: "rec_bid" }),
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
      expect.objectContaining({
        action: "launch_adset",
        source: "manual_operator_v1",
        recIdOrigin: "rec_bid",
        payloadRequest: expect.objectContaining({
          action_origin: "manual_operator_v1",
          manual_confirmation: "explicit_operator_confirmation",
        }),
      }),
    );
  });

  it("rejects legacy major-unit bidValue for adset bid caps", async () => {
    const response = await applyBid.POST(
      request({ businessId: "biz_1", bidValue: 22, recId: "rec_bid" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_bid_unit");
    expect(writes.updateAdsetBidAmount).not.toHaveBeenCalled();
    expect(logs.createMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("rejects executable bid writes when account currency is unavailable", async () => {
    vi.mocked(accountContext.getMetaAccountContext).mockResolvedValue({
      accountProfiles: {
        act_1: { currency: null, timezone: null, name: "Account" },
      },
    } as never);

    const response = await applyBid.POST(
      request({ businessId: "biz_1", bidAmountMinor: 2200, recId: "rec_bid" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("currency_unavailable");
    expect(logs.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(writes.updateAdsetBidAmount).not.toHaveBeenCalled();
  });

  it("passes dry-run bid writes through the entity action route", async () => {
    vi.mocked(writes.updateAdsetBidAmount).mockResolvedValueOnce({
      ok: true,
      verifiedBidAmount: 2200,
      dryRun: true,
      wouldHaveWritten: {
        method: "POST",
        path: "adset_1",
        body: { bid_amount: 2200 },
      },
      responsePayload: {
        dryRun: true,
        wouldHaveWritten: {
          method: "POST",
          path: "adset_1",
          body: { bid_amount: 2200 },
        },
      },
      verificationPayload: { bid_amount: 1800 },
    });

    const response = await applyBid.POST(
      request({ businessId: "biz_1", bidAmountMinor: 2200, dryRun: true, recId: "rec_bid" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, dryRun: true, bidAmountMinor: 2200 });
    expect(writes.updateAdsetBidAmount).toHaveBeenCalledWith(
      { businessId: "biz_1", providerAccountId: "act_1", accessToken: "token" },
      { adsetId: "adset_1", bidAmountMinor: 2200, dryRun: true },
    );
  });

  it("surfaces write kill switch failures with 503", async () => {
    vi.mocked(writes.updateAdsetBidAmount).mockResolvedValueOnce({
      ok: false,
      httpStatus: 503,
      error: {
        code: "kill_switch_engaged",
        message: "Meta writes are disabled by kill switch.",
      },
      responsePayload: null,
      verificationPayload: null,
    } as never);

    const response = await applyBid.POST(
      request({ businessId: "biz_1", bidAmountMinor: 2200, recId: "rec_bid" }),
      { params: Promise.resolve({ adsetId: "adset_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("kill_switch_engaged");
    expect(logs.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "failure",
        errorCode: "kill_switch_engaged",
      }),
    );
  });

  it("blocks entity writes before target lookup and action logging when the business kill switch is engaged", async () => {
    vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValueOnce(
      NextResponse.json(
        { ok: false, error: { code: "kill_switch_engaged" } },
        { status: 503 },
      ),
    );

    const response = await campaignPause.POST(
      request({ businessId: "biz_1", recId: "rec_1" }),
      { params: Promise.resolve({ campaignId: "cmp_1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("kill_switch_engaged");
    expect(db.getDb).not.toHaveBeenCalled();
    expect(logs.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(writes.pauseCampaign).not.toHaveBeenCalled();
  });
});
