import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/meta/ads-action-log", () => ({
  DECISION_ORIGIN_PENDING_RECONCILIATION_CODE:
    "decision_origin_pending_reconciliation_required",
  DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE:
    "provider_verification_persistence_failed",
  META_AD_STATUS_RECONCILIATION_REQUIRED_CODE:
    "meta_ad_status_reconciliation_required",
  resolveExactMetaAdActionTarget: vi.fn(),
  resolveMetaAdActionTarget: vi.fn(),
  hasRecentPendingMetaAdsAction: vi.fn(),
  createMetaAdsActionLog: vi.fn(),
  completeMetaAdsActionLog: vi.fn(),
  completeDecisionOriginMetaAdsActionLog: vi.fn(),
  createDecisionOriginMetaAdsActionLog: vi.fn(),
  markDecisionOriginActionReconciliationRequired: vi.fn(),
  decisionOriginIdempotencyReceiptFromLog: vi.fn(),
  findUnresolvedDecisionOriginPendingAction: vi.fn(),
  findRecentDuplicateActionResult: vi.fn(),
  listRecentMetaAdsActionLogs: vi.fn(),
}));

vi.mock("@/lib/meta/ads-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/ads-write")>();
  return {
    ...actual,
    readMetaAdExecutionState: vi.fn(),
    readMetaEntityExecutionState: vi.fn(),
  };
});

const access = await import("@/lib/access");
const integrations = await import("@/lib/integrations");
const actionLog = await import("@/lib/meta/ads-action-log");
const adsWrite = await import("@/lib/meta/ads-write");
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "272d0ab8-495b-4679-a4c6-ffa404c389d3";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  const body =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as { id?: unknown }).id === "string"
      ? {
          account_id: "123",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          ...payload,
        }
      : payload;
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/meta/ads/ad_1/duplicate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function duplicateBody(overrides: Record<string, unknown> = {}) {
  return {
    actionOrigin: "manual_operator_v1",
    manualConfirmation: "explicit_operator_confirmation",
    businessId: BUSINESS_ID,
    providerAccountId: "act_123",
    adId: "ad_1",
    creativeId: "creative_1",
    targetAdsetId: "adset_2",
    ...overrides,
  };
}

function params(adId = "ad_1") {
  return { params: Promise.resolve({ adId }) };
}

function mockAuthError(status: 401 | 403) {
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    error: NextResponse.json(
      {
        error: status === 401 ? "auth_error" : "forbidden",
        message:
          status === 401
            ? "Authentication required."
            : "Insufficient role permissions for this action.",
      },
      { status },
    ),
  } as never);
}

describe("POST /api/meta/ads/[adId]/duplicate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: USER_ID } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(actionLog.resolveExactMetaAdActionTarget).mockResolvedValue({
      ok: true,
      target: {
        businessId: BUSINESS_ID,
        adId: "ad_1",
        creativeId: "creative_1",
        providerAccountId: "act_123",
      },
    } as never);
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "ad_1",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-18T14:00:00.000Z",
    });
    vi.mocked(adsWrite.readMetaEntityExecutionState).mockResolvedValue({
      ok: true,
      scopeType: "adset",
      entityId: "adset_2",
      providerAccountId: "act_123",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      campaignId: "campaign_2",
      campaignProviderAccountId: "act_123",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      observedAt: "2026-07-18T14:00:00.000Z",
    });
    vi.mocked(actionLog.hasRecentPendingMetaAdsAction).mockResolvedValue(false);
    vi.mocked(
      actionLog.findUnresolvedDecisionOriginPendingAction,
    ).mockResolvedValue(null);
    vi.mocked(actionLog.findRecentDuplicateActionResult).mockResolvedValue(null);
    vi.mocked(actionLog.createMetaAdsActionLog).mockResolvedValue({
      id: "log_1",
    } as never);
    vi.mocked(actionLog.completeMetaAdsActionLog).mockResolvedValue({
      id: "log_1",
    } as never);
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      provider_account_id: "act_123",
      access_token: "secret-token",
    } as never);
  });

  it("rejects duplicate requests without an explicit manual origin", async () => {
    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        targetAdsetId: "adset_2",
      }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("action_origin_required");
    expect(actionLog.resolveMetaAdActionTarget).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not expose durable reconciliation query internals", async () => {
    vi.mocked(
      actionLog.findUnresolvedDecisionOriginPendingAction,
    ).mockRejectedValueOnce(
      new Error(
        'relation "meta_ads_action_log" is unavailable at postgres://internal',
      ),
    );

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      error: {
        code: "reconciliation_state_unavailable",
        message:
          "The durable Ad-action reconciliation state is temporarily unavailable.",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("meta_ads_action_log");
    expect(JSON.stringify(payload)).not.toContain("postgres://internal");
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 401 when no auth session exists", async () => {
    mockAuthError(401);

    const response = await POST(request(duplicateBody()), params());

    expect(response.status).toBe(401);
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 403 when role is insufficient", async () => {
    mockAuthError(403);

    const response = await POST(request(duplicateBody()), params());

    expect(response.status).toBe(403);
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 400 when targetAdsetId is missing", async () => {
    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("missing_target_adset_id");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("returns 400 when businessId is missing", async () => {
    const response = await POST(
      request({ targetAdsetId: "adset_2" }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("missing_business_id");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("rejects legacy ACTIVE-create requests before logging or calling Meta", async () => {
    const response = await POST(
      request(duplicateBody({ activateAfterCreate: true })),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("active_create_not_supported");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(actionLog.resolveMetaAdActionTarget).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 404 when the ad is not found locally", async () => {
    vi.mocked(actionLog.resolveExactMetaAdActionTarget).mockResolvedValue({
      ok: false,
      reason: "ad_not_found",
    } as never);

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe("ad_not_found");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 409 when a recent duplicate already produced an ad for the same target", async () => {
    vi.mocked(actionLog.findRecentDuplicateActionResult).mockResolvedValue({
      resultingAdId: "ad_copy_1",
    } as never);

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("duplicate_already_attempted");
    expect(payload.error.existingAdId).toBe("ad_copy_1");
    expect(actionLog.findRecentDuplicateActionResult).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      adId: "ad_1",
      targetAdsetId: "adset_2",
      sinceMinutes: 10,
    });
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks duplicate when the live source creative identity drifts", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValueOnce({
      ok: true,
      adId: "ad_1",
      providerAccountId: "act_123",
      creativeId: "creative_other",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-18T14:00:00.000Z",
    });

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("ad_identity_mismatch");
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks duplicate when the target ad set or campaign is not fully active", async () => {
    vi.mocked(adsWrite.readMetaEntityExecutionState).mockResolvedValueOnce({
      ok: true,
      scopeType: "adset",
      entityId: "adset_2",
      providerAccountId: "act_123",
      configuredStatus: "PAUSED",
      effectiveStatus: "PAUSED",
      campaignId: "campaign_2",
      campaignProviderAccountId: "act_123",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      observedAt: "2026-07-18T14:00:00.000Z",
    });

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe(
      "current_hierarchy_state_incompatible",
    );
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns retryable failure when target hierarchy GET cannot be proven", async () => {
    vi.mocked(adsWrite.readMetaEntityExecutionState).mockResolvedValueOnce({
      ok: false,
      scopeType: "adset",
      entityId: "adset_2",
      error: {
        code: "network_error",
        message: "connection reset",
      },
      httpStatus: null,
    });

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe(
      "current_hierarchy_state_unverified",
    );
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks duplicate when Meta resolves the target in another account", async () => {
    vi.mocked(adsWrite.readMetaEntityExecutionState).mockResolvedValueOnce({
      ok: false,
      scopeType: "adset",
      entityId: "adset_2",
      error: {
        code: "provider_account_mismatch",
        message: "different account",
      },
      httpStatus: 200,
    });

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("provider_account_mismatch");
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes audit success when Meta manual rebuild and verification succeed", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "ad_copy_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_copy_1",
          status: "PAUSED",
          effective_status: "PAUSED",
          adset_id: "adset_2",
          creative: { id: "creative_1" },
        }),
      );

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      action: "duplicate",
      newAdId: "ad_copy_1",
      status: "PAUSED",
      adsManagerUrl:
        "https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=123&selected_ad_ids=ad_copy_1",
    });
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        adId: "ad_1",
        creativeId: "creative_1",
        action: "duplicate",
        source: "manual_operator_v1",
        payloadRequest: expect.objectContaining({
          endpoint: "/act_123/ads",
          action_origin: "manual_operator_v1",
          manual_confirmation: "explicit_operator_confirmation",
          body: expect.objectContaining({
            adset_id: "adset_2",
            target_adset_id: "adset_2",
            status_option: "PAUSED",
          }),
        }),
      }),
    );
    const createLogInput = vi.mocked(actionLog.createMetaAdsActionLog).mock
      .calls[0]?.[0] as
      | { payloadRequest?: { body?: Record<string, unknown> } }
      | undefined;
    expect(createLogInput?.payloadRequest?.body).not.toHaveProperty(
      "daily_budget_minor",
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "success",
        resultingAdId: "ad_copy_1",
        verificationPayload: {
          sourceIdentity: expect.objectContaining({
            adId: "ad_1",
            providerAccountId: "act_123",
            creativeId: "creative_1",
          }),
          targetVerification: expect.objectContaining({
            id: "ad_copy_1",
            adset_id: "adset_2",
            creative: { id: "creative_1" },
          }),
        },
      }),
    );
  });

  it("keeps duplicate dry-run responses non-actionable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: "ad_1",
        name: "Source Ad",
        adset_id: "adset_1",
        creative: { id: "creative_1" },
      }),
    );

    const response = await POST(
      request(duplicateBody({ activateAfterCreate: false, dryRun: true })),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      action: "duplicate",
      newAdId: null,
      dryRun: true,
      adsManagerUrl: null,
      wouldHaveWritten: {
        method: "POST",
        path: "act_123/ads",
        body: expect.objectContaining({ status: "PAUSED" }),
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        resultingAdId: null,
      }),
    );
  });

  it("logs silent_failure when Meta creates the ad but verification fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "ad_copy_1" }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 100, message: "Unsupported get request." } },
          { status: 404 },
        ),
      );

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe("silent_failure");
    expect(payload.resultingAdId).toBe("ad_copy_1");
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "silent_failure",
        resultingAdId: "ad_copy_1",
        verificationPayload: {
          sourceIdentity: expect.objectContaining({
            adId: "ad_1",
            providerAccountId: "act_123",
            creativeId: "creative_1",
          }),
          targetVerification: expect.anything(),
        },
      }),
    );
  });

  it("logs failure when Meta returns an HTTP error", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 190, message: "Invalid OAuth access token." } },
          { status: 400 },
        ),
      );

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe("190");
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failure",
        errorCode: "190",
        verificationPayload: {
          sourceIdentity: expect.objectContaining({
            adId: "ad_1",
            providerAccountId: "act_123",
            creativeId: "creative_1",
          }),
          targetVerification: null,
        },
      }),
    );
  });

  it("fails closed after one duplicate POST when Meta rate limits the write", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 17, message: "(#17) User request limit reached" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "ad_copy_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_copy_1",
          status: "PAUSED",
          effective_status: "PAUSED",
          adset_id: "adset_2",
          creative: { id: "creative_1" },
        }),
      );

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("rate_limited");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failure",
        errorCode: "rate_limited",
      }),
    );
  });

  it("returns 409 when a pending row exists for the same ad", async () => {
    vi.mocked(actionLog.hasRecentPendingMetaAdsAction).mockResolvedValue(true);

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("action_in_flight");
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
