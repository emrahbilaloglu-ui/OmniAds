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
  claimMetaAdDuplicateAction: vi.fn(),
  createMetaAdsActionLog: vi.fn(),
  completeMetaAdsActionLog: vi.fn(),
  completeDecisionOriginMetaAdsActionLog: vi.fn(),
  createDecisionOriginMetaAdsActionLog: vi.fn(),
  markDecisionOriginActionReconciliationRequired: vi.fn(),
  decisionOriginIdempotencyReceiptFromLog: vi.fn(),
  findUnresolvedDecisionOriginPendingAction: vi.fn(),
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

vi.mock(
  "@/lib/meta/duplicate-ad-reconciliation-store",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/meta/duplicate-ad-reconciliation-store")
      >();
    return {
      ...actual,
      createMetaAdDuplicateMarker: vi.fn(
        () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
      appendMetaAdDuplicateAttemptStarted: vi.fn(),
      finalizeMetaAdDuplicateAttempt: vi.fn(),
      finalizeMetaAdDuplicatePreProviderFailure: vi.fn(),
    };
  },
);

const access = await import("@/lib/access");
const integrations = await import("@/lib/integrations");
const actionLog = await import("@/lib/meta/ads-action-log");
const adsWrite = await import("@/lib/meta/ads-write");
const duplicateStore = await import(
  "@/lib/meta/duplicate-ad-reconciliation-store"
);
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "272d0ab8-495b-4679-a4c6-ffa404c389d3";
const CANONICAL_DUPLICATE_NAME =
  "Adsecute duplicate [ADSECUTE_DUP:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]";

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


// Restored from current main during the native integration: the native branch
// predates these guards, so its route fixtures exercised the write path with
// the reconnect and selection checks switched off.
vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/account-context")>();
  return {
    ...actual,
    // Default-authorised. The deselection refusal has its own suite; these
    // cases are about what the action does once the account is selected.
    resolveMetaAccountAuthority: vi.fn(async () => ({
      state: "authorized" as const,
      errorMessage: null,
    })),
  };
});
vi.mock("@/lib/provider-account-snapshots", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readProviderConnectionGenerationToken: vi
      .fn()
      .mockResolvedValue("1:connected"),
  };
});
vi.mock("@/lib/provider-write-authority", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertProviderWriteAuthorityUnchanged: vi
      .fn()
      .mockResolvedValue({ ok: true }),
  };
});

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
    vi.mocked(actionLog.claimMetaAdDuplicateAction).mockResolvedValue({
      claimed: true,
      log: { id: "log_1" },
    } as never);
    vi.mocked(actionLog.createMetaAdsActionLog).mockResolvedValue({
      id: "log_1",
    } as never);
    vi.mocked(actionLog.completeMetaAdsActionLog).mockResolvedValue({
      id: "log_1",
    } as never);
    vi.mocked(
      duplicateStore.appendMetaAdDuplicateAttemptStarted,
    ).mockResolvedValue({} as never);
    vi.mocked(
      duplicateStore.finalizeMetaAdDuplicateAttempt,
    ).mockResolvedValue();
    vi.mocked(
      duplicateStore.finalizeMetaAdDuplicatePreProviderFailure,
    ).mockResolvedValue();
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
    vi.mocked(actionLog.claimMetaAdDuplicateAction).mockResolvedValue({
      claimed: false,
      existing: { resultingAdId: "ad_copy_1" },
    } as never);

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("duplicate_already_attempted");
    expect(payload.error.existingAdId).toBe("ad_copy_1");
    expect(actionLog.claimMetaAdDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId: "ad_1",
      targetAdsetId: "adset_2",
      sinceMinutes: 10,
      }),
    );
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous duplicate without a resulting ad reconciliation-blocking", async () => {
    vi.mocked(actionLog.claimMetaAdDuplicateAction).mockResolvedValue({
      claimed: false,
      existing: {
        status: "silent_failure",
        errorCode: "provider_outcome_ambiguous",
        resultingAdId: null,
        dryRun: false,
      },
    } as never);

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toEqual({
      code: "duplicate_reconciliation_required",
      message:
        "A prior duplicate attempt has unresolved durable or provider state. Reconcile it before retrying.",
      reconciliationRequired: true,
      retryAllowed: false,
    });
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing physical provider-account ref",
      existing: {
        providerAccountRefId: null,
        providerAccountId: "act_123",
        payloadRequest: {
          duplicate_attempt_contract_version:
            "meta-manual-ad-duplicate-attempt.v1",
          duplicate_attempt_required: true,
          dry_run: false,
          body: { target_adset_id: "adset_2", dry_run: false },
        },
      },
    },
    {
      label: "missing provider account id",
      existing: {
        providerAccountRefId: "372d0ab8-495b-4679-a4c6-ffa404c389d3",
        providerAccountId: null,
        payloadRequest: {
          duplicate_attempt_contract_version:
            "meta-manual-ad-duplicate-attempt.v1",
          duplicate_attempt_required: true,
          dry_run: false,
          body: { target_adset_id: "adset_2", dry_run: false },
        },
      },
    },
    {
      label: "a non-current duplicate-attempt required marker",
      existing: {
        providerAccountRefId: "372d0ab8-495b-4679-a4c6-ffa404c389d3",
        providerAccountId: "act_123",
        payloadRequest: {
          duplicate_attempt_contract_version:
            "meta-manual-ad-duplicate-attempt.v1",
          duplicate_attempt_required: false,
          dry_run: false,
          body: { target_adset_id: "adset_2", dry_run: false },
        },
      },
    },
  ])(
    "keeps a non-dry legacy failure reconciliation-blocking when it has $label",
    async ({ existing }) => {
      vi.mocked(actionLog.claimMetaAdDuplicateAction).mockResolvedValue({
        claimed: false,
        existing: {
          id: "legacy_failure_log",
          businessId: BUSINESS_ID,
          adId: "ad_1",
          creativeId: "creative_1",
          action: "duplicate",
          source: "manual_operator_v1",
          status: "failure",
          dryRun: false,
          errorCode: "190",
          resultingAdId: null,
          ...existing,
        },
      } as never);

      const response = await POST(request(duplicateBody()), params());
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error).toEqual({
        code: "duplicate_reconciliation_required",
        message:
          "A prior duplicate attempt has unresolved durable or provider state. Reconcile it before retrying.",
        reconciliationRequired: true,
        retryAllowed: false,
      });
      expect(actionLog.claimMetaAdDuplicateAction).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          providerAccountId: "act_123",
          adId: "ad_1",
          targetAdsetId: "adset_2",
          dryRun: false,
        }),
      );
      expect(
        duplicateStore.appendMetaAdDuplicateAttemptStarted,
      ).not.toHaveBeenCalled();
      expect(
        duplicateStore.finalizeMetaAdDuplicateAttempt,
      ).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("fails closed before provider execution when the atomic duplicate claim is unavailable", async () => {
    vi.mocked(actionLog.claimMetaAdDuplicateAction).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error).toMatchObject({
      code: "duplicate_claim_state_unavailable",
      reconciliationRequired: true,
      retryAllowed: false,
    });
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
          name: CANONICAL_DUPLICATE_NAME,
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
    expect(actionLog.claimMetaAdDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "ad_1",
        creativeId: "creative_1",
        targetAdsetId: "adset_2",
        dryRun: false,
        payloadRequest: expect.objectContaining({
          endpoint: "/act_123/ads",
          action_origin: "manual_operator_v1",
          manual_confirmation: "explicit_operator_confirmation",
          dry_run: false,
          body: expect.objectContaining({
            adset_id: "adset_2",
            target_adset_id: "adset_2",
            status_option: "PAUSED",
          }),
        }),
      }),
    );
    const createLogInput = vi.mocked(actionLog.claimMetaAdDuplicateAction).mock
      .calls[0]?.[0] as
      | { payloadRequest?: { body?: Record<string, unknown> } }
      | undefined;
    expect(createLogInput?.payloadRequest?.body).not.toHaveProperty(
      "daily_budget_minor",
    );
    expect(
      duplicateStore.finalizeMetaAdDuplicateAttempt,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceActionLogId: "log_1",
        successful: true,
        resultingAdId: "ad_copy_1",
        verification: expect.objectContaining({
          id: "ad_copy_1",
          name: CANONICAL_DUPLICATE_NAME,
          adset_id: "adset_2",
          creative: { id: "creative_1" },
        }),
      }),
    );
  });

  it("keeps duplicate dry-run responses non-actionable", async () => {
    vi.mocked(actionLog.hasRecentPendingMetaAdsAction).mockResolvedValue(true);
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
    expect(actionLog.hasRecentPendingMetaAdsAction).not.toHaveBeenCalled();
    expect(
      actionLog.findUnresolvedDecisionOriginPendingAction,
    ).not.toHaveBeenCalled();
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
    expect(
      duplicateStore.finalizeMetaAdDuplicateAttempt,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        successful: false,
        resultingAdId: "ad_copy_1",
        errorCode: "silent_failure",
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
          {
            error: {
              code: 190,
              message: "Invalid OAuth access token.",
              is_transient: false,
            },
          },
          { status: 400 },
        ),
      );

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe("190");
    expect(payload.providerOutcome).toBe("definite_failure");
    expect(payload.retryAllowed).toBeNull();
    expect(
      duplicateStore.finalizeMetaAdDuplicateAttempt,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        successful: false,
        errorCode: "190",
        verification: null,
        verificationObservedAt: null,
        mutationReceipt: expect.objectContaining({
          attemptCount: 1,
          method: "POST",
          path: "act_123/ads",
          providerResponseReceived: true,
          providerResponseSuccessful: false,
          httpStatus: 400,
          outcome: "provider_response_received",
          automaticRetryAttempted: false,
          transportError: null,
        }),
      }),
    );
  });

  it("allows a new claim and provider POST after an exact current-contract definite 4xx failure", async () => {
    vi.mocked(actionLog.claimMetaAdDuplicateAction)
      .mockResolvedValueOnce({
        claimed: true,
        log: { id: "definite_failure_log" },
      } as never)
      .mockResolvedValueOnce({
        claimed: true,
        log: { id: "retry_log" },
      } as never);
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
          {
            error: {
              code: 190,
              message: "Invalid OAuth access token.",
              is_transient: false,
            },
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "ad_copy_2" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_copy_2",
          name: CANONICAL_DUPLICATE_NAME,
          status: "PAUSED",
          effective_status: "PAUSED",
          adset_id: "adset_2",
          creative: { id: "creative_1" },
        }),
      );

    const firstResponse = await POST(request(duplicateBody()), params());
    const firstPayload = await firstResponse.json();

    expect(firstResponse.status).toBe(502);
    expect(firstPayload).toMatchObject({
      ok: false,
      error: { code: "190" },
      providerOutcome: "definite_failure",
      retryAllowed: null,
    });
    expect(
      duplicateStore.finalizeMetaAdDuplicateAttempt,
    ).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sourceActionLogId: "definite_failure_log",
        successful: false,
        resultingAdId: null,
        errorCode: "190",
        mutationReceipt: expect.objectContaining({
          providerResponseReceived: true,
          providerResponseSuccessful: false,
          httpStatus: 400,
          outcome: "provider_response_received",
        }),
      }),
    );

    const retryResponse = await POST(request(duplicateBody()), params());
    const retryPayload = await retryResponse.json();

    expect(retryResponse.status, JSON.stringify(retryPayload)).toBe(200);
    expect(retryPayload).toMatchObject({
      ok: true,
      action: "duplicate",
      adId: "ad_1",
      newAdId: "ad_copy_2",
      status: "PAUSED",
    });
    expect(actionLog.claimMetaAdDuplicateAction).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(2);
    expect(
      duplicateStore.appendMetaAdDuplicateAttemptStarted,
    ).toHaveBeenCalledTimes(2);
    expect(
      duplicateStore.finalizeMetaAdDuplicateAttempt,
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sourceActionLogId: "retry_log",
        successful: true,
        resultingAdId: "ad_copy_2",
        errorCode: null,
      }),
    );
  });

  it("preserves the pending claim when an ambiguous provider outcome cannot be terminalized", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      )
      .mockRejectedValueOnce(new Error("connection reset after write"));
    vi.mocked(duplicateStore.finalizeMetaAdDuplicateAttempt)
      .mockRejectedValueOnce(new Error("terminal write unavailable"))
      .mockRejectedValueOnce(new Error("terminal write unavailable"));

    const response = await POST(request(duplicateBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "duplicate_terminal_persistence_failed" },
      reconciliationRequired: true,
      retryAllowed: false,
    });
    expect(
      duplicateStore.finalizeMetaAdDuplicateAttempt,
    ).toHaveBeenCalledTimes(2);
    for (const [completion] of vi.mocked(
      duplicateStore.finalizeMetaAdDuplicateAttempt,
    ).mock.calls) {
      expect(completion).toMatchObject({
        sourceActionLogId: "log_1",
        successful: false,
        errorCode: "provider_outcome_ambiguous",
      });
    }
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it.each([
    {
      label: "HTTP 408",
      status: 408,
      providerPayload: {
        error: {
          code: 2,
          message: "Request timeout after provider admission.",
          is_transient: true,
        },
      },
    },
    {
      label: "HTTP 425",
      status: 425,
      providerPayload: {
        error: {
          code: 2,
          message: "Provider is not ready to confirm finality.",
          is_transient: true,
        },
      },
    },
    {
      label: "HTTP 429",
      status: 429,
      providerPayload: {
        error: {
          code: 17,
          message: "(#17) User request limit reached",
        },
      },
    },
    {
      label: "HTTP 500",
      status: 500,
      providerPayload: {
        error: {
          code: 1,
          message: "Unknown provider failure after request receipt.",
          is_transient: true,
        },
      },
    },
    {
      label: "transient HTTP 400",
      status: 400,
      providerPayload: {
        error: {
          code: 2,
          message: "Temporary provider processing failure.",
          is_transient: true,
        },
      },
    },
    {
      label: "HTTP 400 with missing is_transient proof",
      status: 400,
      providerPayload: {
        error: {
          code: 190,
          message: "Invalid OAuth access token.",
        },
      },
    },
    {
      label: "HTTP 400 with null is_transient proof",
      status: 400,
      providerPayload: {
        error: {
          code: 190,
          message: "Invalid OAuth access token.",
          is_transient: null,
        },
      },
    },
    {
      label: "HTTP 400 with string is_transient proof",
      status: 400,
      providerPayload: {
        error: {
          code: 190,
          message: "Invalid OAuth access token.",
          is_transient: "false",
        },
      },
    },
  ])(
    "fails closed after one duplicate POST for $label",
    async ({ status, providerPayload }) => {
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
          jsonResponse(providerPayload, { status }),
        )
        .mockResolvedValueOnce(jsonResponse({ id: "must_not_be_created" }));

      const response = await POST(request(duplicateBody()), params());
      const payload = await response.json();

      expect(response.status).toBe(502);
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe("provider_outcome_ambiguous");
      expect(payload.providerOutcome).toBe("outcome_ambiguous");
      expect(payload.retryAllowed).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(
        vi.mocked(fetch).mock.calls.filter(
          ([, init]) => init?.method === "POST",
        ),
      ).toHaveLength(1);
      expect(
        duplicateStore.finalizeMetaAdDuplicateAttempt,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          successful: false,
          errorCode: "provider_outcome_ambiguous",
          verificationObservedAt: null,
          resultingAdId: null,
          mutationReceipt: expect.objectContaining({
            attemptCount: 1,
            method: "POST",
            path: "act_123/ads",
            providerResponseReceived: true,
            providerResponseSuccessful: false,
            httpStatus: status,
            outcome: "outcome_ambiguous",
            automaticRetryAttempted: false,
            transportError: null,
          }),
        }),
      );

      vi.mocked(actionLog.claimMetaAdDuplicateAction).mockResolvedValueOnce({
        claimed: false,
        existing: {
          id: "log_1",
          businessId: BUSINESS_ID,
          providerAccountId: "act_123",
          adId: "ad_1",
          creativeId: "creative_1",
          action: "duplicate",
          source: "manual_operator_v1",
          status: "silent_failure",
          dryRun: false,
          errorCode: "provider_outcome_ambiguous",
          resultingAdId: null,
        },
      } as never);
      const fetchCountAfterAmbiguousResult = vi.mocked(fetch).mock.calls.length;

      const retryResponse = await POST(request(duplicateBody()), params());
      const retryPayload = await retryResponse.json();

      expect(retryResponse.status).toBe(409);
      expect(retryPayload.error).toMatchObject({
        code: "duplicate_reconciliation_required",
        reconciliationRequired: true,
        retryAllowed: false,
      });
      expect(fetch).toHaveBeenCalledTimes(fetchCountAfterAmbiguousResult);
      expect(
        vi.mocked(fetch).mock.calls.filter(
          ([, init]) => init?.method === "POST",
        ),
      ).toHaveLength(1);
      expect(
        duplicateStore.appendMetaAdDuplicateAttemptStarted,
      ).toHaveBeenCalledTimes(1);
      expect(
        duplicateStore.finalizeMetaAdDuplicateAttempt,
      ).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a 2xx missing-id result open and blocks the same request before another POST", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    const firstResponse = await POST(request(duplicateBody()), params());
    const firstPayload = await firstResponse.json();

    expect(firstResponse.status).toBe(502);
    expect(firstPayload).toMatchObject({
      ok: false,
      error: { code: "silent_failure" },
      resultingAdId: null,
      providerOutcome: "outcome_ambiguous",
      retryAllowed: false,
    });
    expect(
      duplicateStore.finalizeMetaAdDuplicateAttempt,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceActionLogId: "log_1",
        successful: false,
        resultingAdId: null,
        errorCode: "silent_failure",
        verification: null,
        verificationObservedAt: null,
        mutationReceipt: expect.objectContaining({
          attemptCount: 1,
          method: "POST",
          path: "act_123/ads",
          providerResponseReceived: true,
          providerResponseSuccessful: true,
          httpStatus: 200,
          outcome: "provider_response_received",
          automaticRetryAttempted: false,
          transportError: null,
        }),
      }),
    );

    vi.mocked(actionLog.claimMetaAdDuplicateAction).mockResolvedValueOnce({
      claimed: false,
      existing: {
        id: "log_1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "ad_1",
        creativeId: "creative_1",
        action: "duplicate",
        source: "manual_operator_v1",
        status: "silent_failure",
        dryRun: false,
        errorCode: "silent_failure",
        resultingAdId: null,
      },
    } as never);
    const fetchCountAfterFirstRequest = vi.mocked(fetch).mock.calls.length;

    const secondResponse = await POST(request(duplicateBody()), params());
    const secondPayload = await secondResponse.json();

    expect(secondResponse.status).toBe(409);
    expect(secondPayload.error).toMatchObject({
      code: "duplicate_reconciliation_required",
      reconciliationRequired: true,
      retryAllowed: false,
    });
    expect(fetch).toHaveBeenCalledTimes(fetchCountAfterFirstRequest);
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(
      duplicateStore.appendMetaAdDuplicateAttemptStarted,
    ).toHaveBeenCalledTimes(1);
    expect(
      duplicateStore.finalizeMetaAdDuplicateAttempt,
    ).toHaveBeenCalledTimes(1);
    expect(actionLog.claimMetaAdDuplicateAction).toHaveBeenCalledTimes(2);
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
