import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createDecisionOriginAdActionIdempotencyKey } from "@/lib/creative-decision-engine/execution-safety";

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
  MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION:
    "meta-manual-ad-status-mutation-attempt.v1",
  META_AD_STATUS_RECONCILIATION_REQUIRED_CODE:
    "meta_ad_status_reconciliation_required",
  appendManualMetaAdStatusMutationAttemptCompleted: vi.fn(),
  appendManualMetaAdStatusMutationAttemptStarted: vi.fn(),
  resolveExactMetaAdActionTarget: vi.fn(),
  resolveMetaAdActionTarget: vi.fn(),
  hasRecentPendingMetaAdsAction: vi.fn(),
  createMetaAdsActionLog: vi.fn(),
  createDecisionOriginMetaAdsActionLog: vi.fn(),
  completeMetaAdsActionLog: vi.fn(),
  completeDecisionOriginMetaAdsActionLog: vi.fn(),
  markDecisionOriginActionReconciliationRequired: vi.fn(),
  decisionOriginIdempotencyReceiptFromLog: vi.fn(),
  findUnresolvedDecisionOriginPendingAction: vi.fn(),
  findRecentDuplicateActionResult: vi.fn(),
  listRecentMetaAdsActionLogs: vi.fn(),
}));

vi.mock("@/lib/meta/decision-origin-action-preflight", () => ({
  runServerDecisionOriginAdActionPreflight: vi.fn(),
}));

vi.mock("@/lib/meta/manual-ad-status-reconciliation", () => ({
  reconcileManualMetaAdStatusBlocker: vi.fn(),
}));

vi.mock("@/lib/meta/ads-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/ads-write")>();
  return { ...actual, readMetaAdExecutionState: vi.fn() };
});

const access = await import("@/lib/access");
const integrations = await import("@/lib/integrations");
const actionLog = await import("@/lib/meta/ads-action-log");
const adsWrite = await import("@/lib/meta/ads-write");
const decisionPreflight = await import(
  "@/lib/meta/decision-origin-action-preflight"
);
const manualReconciliation = await import(
  "@/lib/meta/manual-ad-status-reconciliation"
);
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "272d0ab8-495b-4679-a4c6-ffa404c389d3";

function decisionOriginResumeBody() {
  const base = {
    contractVersion: "meta-decision-origin-ad-execution.v1" as const,
    businessId: BUSINESS_ID,
    providerAccountId: "act_123",
    adId: "100000000000001",
    snapshotId: "00000000-0000-4000-8000-000000000011",
    evaluationId: "00000000-0000-4000-8000-000000000012",
    engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
    decisionHash: "d".repeat(64),
    action: "resume" as const,
    creativeId: "creative_1",
  };
  return {
    ...base,
    idempotencyKey: createDecisionOriginAdActionIdempotencyKey(base),
  };
}

function jsonResponse(payload: unknown, init?: ResponseInit) {
  const body =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as { id?: unknown }).id === "string"
      ? { account_id: "123", ...payload }
      : payload;
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function exactProviderAdState(status: "ACTIVE" | "PAUSED") {
  return {
    id: "100000000000001",
    account_id: "123",
    status,
    effective_status: status,
    creative: { id: "creative_1" },
    campaign: {
      id: "campaign_1",
      status: "ACTIVE",
      effective_status: "ACTIVE",
    },
    adset: {
      id: "adset_1",
      status: "ACTIVE",
      effective_status: "ACTIVE",
    },
  };
}

function rawRequest(body: unknown) {
  return new NextRequest(
    "http://localhost/api/meta/ads/100000000000001/resume",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  );
}

function request(body: unknown) {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const native = Boolean(record.contractVersion);
  return rawRequest({
    actionOrigin: native ? "native_decision_v1" : "manual_operator_v1",
    ...(!native
      ? {
          manualConfirmation: "explicit_operator_confirmation",
          providerAccountId: "act_123",
          adId: "100000000000001",
          creativeId: "creative_1",
        }
      : {}),
    ...record,
  });
}

function params(adId = "100000000000001") {
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

describe("POST /api/meta/ads/[adId]/resume", () => {
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
        adId: "100000000000001",
        creativeId: "creative_1",
        providerAccountId: "act_123",
      },
    } as never);
    vi.mocked(actionLog.hasRecentPendingMetaAdsAction).mockResolvedValue(false);
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: true,
      disposition: "proceed",
      shouldMutate: true,
      blockers: [],
      errorCode: null,
      duplicateReceipt: null,
      decisionAgeHours: 1,
      currentAdStateAgeMinutes: 0,
    });
    vi.mocked(actionLog.createMetaAdsActionLog).mockResolvedValue({
      id: "log_1",
    } as never);
    vi.mocked(actionLog.createDecisionOriginMetaAdsActionLog).mockResolvedValue({
      id: "log_decision_1",
    } as never);
    vi.mocked(actionLog.completeMetaAdsActionLog).mockResolvedValue({
      id: "log_1",
    } as never);
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).mockResolvedValue({
      id: "attempt_started_event_1",
      attemptId: "attempt_1",
      eventKind: "attempt_started",
    } as never);
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).mockResolvedValue({
      id: "attempt_completed_event_1",
      attemptId: "attempt_1",
      eventKind: "attempt_completed",
    } as never);
    vi.mocked(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).mockResolvedValue({ id: "log_decision_1" } as never);
    vi.mocked(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).mockResolvedValue({ id: "log_decision_1", status: "pending" } as never);
    vi.mocked(
      actionLog.findUnresolvedDecisionOriginPendingAction,
    ).mockResolvedValue(null);
    vi.mocked(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).mockResolvedValue({
      disposition: "not_needed",
      candidate: {
        blockerReason: "no_unresolved_manual_source",
      },
    } as never);
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      provider_account_id: "act_123",
      access_token: "secret-token",
    } as never);
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "100000000000001",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: "PAUSED",
      effectiveStatus: "PAUSED",
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-18T13:00:00.000Z",
    });
  });

  it("rejects a stripped action origin instead of falling through to manual execution", async () => {
    const response = await POST(
      rawRequest({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("action_origin_required");
    expect(actionLog.resolveMetaAdActionTarget).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks manual resume when the live parent hierarchy is not ACTIVE", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "100000000000001",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "PAUSED",
      adsetEffectiveStatus: "PAUSED",
      configuredStatus: "PAUSED",
      effectiveStatus: "PAUSED",
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-18T13:00:00.000Z",
    });

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe(
      "current_hierarchy_state_incompatible",
    );
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a resume no-op when reconciling an old pause finds the Ad already ACTIVE", async () => {
    vi.mocked(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).mockResolvedValueOnce({
      disposition: "reconciled",
      candidate: {
        sourceActionLogId: "old_pause_log",
        action: "pause",
      },
      event: { id: "reconciliation_event_1" },
      resolution: "current_state_matches_precondition",
      state: {
        ok: true,
        adId: "100000000000001",
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
        observedAt: "2026-07-18T13:00:00.000Z",
        providerGetEvidence: {
          id: "100000000000001",
          account_id: "123",
          status: "ACTIVE",
          effective_status: "ACTIVE",
        },
      },
    } as never);

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      action: "resume",
      status: "ACTIVE",
      reconciled: true,
      noOp: true,
      providerWriteAttempted: false,
    });
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 401 when no auth session exists", async () => {
    mockAuthError(401);

    const response = await POST(request({ businessId: BUSINESS_ID }), params());

    expect(response.status).toBe(401);
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 403 when role is insufficient", async () => {
    mockAuthError(403);

    const response = await POST(request({ businessId: BUSINESS_ID }), params());

    expect(response.status).toBe(403);
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 400 when businessId is missing", async () => {
    const response = await POST(request({}), params());
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("missing_business_id");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("returns 404 when the ad is not found locally", async () => {
    vi.mocked(actionLog.resolveExactMetaAdActionTarget).mockResolvedValue({
      ok: false,
      reason: "ad_not_found",
    } as never);

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe("ad_not_found");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes audit success when Meta resume and verification succeed", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")));

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, action: "resume", status: "ACTIVE" });
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        adId: "100000000000001",
        creativeId: "creative_1",
        action: "resume",
        source: "manual_operator_v1",
        payloadRequest: expect.objectContaining({
          endpoint: "/100000000000001",
          body: { status: "ACTIVE" },
          action_origin: "manual_operator_v1",
          manual_confirmation: "explicit_operator_confirmation",
        }),
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "log_1", status: "success" }),
    );
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceActionLogId: "log_1",
        attemptId: "attempt_1",
        completionOutcome: "provider_response_verified_success",
        providerResponse: { success: true },
        verification: expect.objectContaining({
          contractVersion: "meta-ad-status-write-verification.v1",
          adId: "100000000000001",
          providerAccountId: "act_123",
          creativeId: "creative_1",
          campaignId: "campaign_1",
          adsetId: "adset_1",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          campaignConfiguredStatus: "ACTIVE",
          campaignEffectiveStatus: "ACTIVE",
          adsetConfiguredStatus: "ACTIVE",
          adsetEffectiveStatus: "ACTIVE",
          policyEligible: true,
          reviewStatus: null,
          observedAt: expect.any(String),
          providerGetEvidence: exactProviderAdState("ACTIVE"),
        }),
      }),
    );
  });

  it("uses the exact typed and atomic path for a decision-origin resume", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")));

    const response = await POST(
      request(decisionOriginResumeBody()),
      params(),
    );

    expect(response.status).toBe(200);
    expect(actionLog.resolveExactMetaAdActionTarget).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId: "100000000000001",
    });
    expect(actionLog.createDecisionOriginMetaAdsActionLog).toHaveBeenCalled();
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_decision_1",
        status: "success",
        providerCompletedAt: expect.any(String),
        verificationPayload: expect.objectContaining({
          contractVersion: "meta-ad-status-write-verification.v1",
          adId: "100000000000001",
          providerAccountId: "act_123",
          creativeId: "creative_1",
          campaignId: "campaign_1",
          adsetId: "adset_1",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          campaignConfiguredStatus: "ACTIVE",
          campaignEffectiveStatus: "ACTIVE",
          adsetConfiguredStatus: "ACTIVE",
          adsetEffectiveStatus: "ACTIVE",
          policyEligible: true,
          reviewStatus: null,
          observedAt: expect.any(String),
          providerGetEvidence: exactProviderAdState("ACTIVE"),
        }),
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("logs silent_failure when Meta success verifies unchanged", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")));

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe("silent_failure");
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "silent_failure" }),
    );
  });

  it("logs failure when Meta returns an HTTP error", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 190, message: "Invalid OAuth access token." } },
          { status: 400 },
        ),
      );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe("190");
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failure", errorCode: "190" }),
    );
  });

  it("fails closed after one status POST when Meta rate limits the write", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 17, message: "(#17) User request limit reached" } },
          { status: 429 },
        ),
      );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("rate_limited");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
    });
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failure",
        errorCode: "rate_limited",
      }),
    );
  });

  it("returns the shared typed conflict when a manual pending row exists for the same ad", async () => {
    vi.mocked(actionLog.createMetaAdsActionLog).mockRejectedValueOnce(
      Object.assign(new Error("action_in_flight"), {
        code: "action_in_flight",
        blockingActionLogId: "blocking_manual_log",
        blockingOrigin: "manual_operator_v1",
        reconciliationRequired: false,
        reconciliationReceipt: null,
      }),
    );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      error: { code: "action_in_flight" },
      blockingActionLogId: "blocking_manual_log",
      blockingOrigin: "manual_operator_v1",
      retryAllowed: false,
    });
    expect(payload).not.toHaveProperty("reconciliationRequired");
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
