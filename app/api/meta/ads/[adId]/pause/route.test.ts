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
  return {
    ...actual,
    pauseAd: vi.fn(actual.pauseAd),
    resumeAd: vi.fn(actual.resumeAd),
    readMetaAdExecutionState: vi.fn(),
  };
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

function decisionOriginPauseBody() {
  const base = {
    contractVersion: "meta-decision-origin-ad-execution.v1" as const,
    businessId: BUSINESS_ID,
    providerAccountId: "act_123",
    adId: "100000000000001",
    snapshotId: "00000000-0000-4000-8000-000000000011",
    evaluationId: "00000000-0000-4000-8000-000000000012",
    engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
    decisionHash: "d".repeat(64),
    action: "pause" as const,
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

function successfulMutationAttempt() {
  return {
    attemptCount: 1 as const,
    method: "POST" as const,
    path: "100000000000001",
    attemptedAt: "2026-07-18T13:00:01.000Z",
    completedAt: "2026-07-18T13:00:02.000Z",
    providerResponseReceived: true,
    providerResponseSuccessful: true,
    httpStatus: 200,
    outcome: "provider_response_received" as const,
    automaticRetryAttempted: false as const,
    transportError: null,
  };
}

function definiteRejectedMutationResult() {
  return {
    ok: false as const,
    error: { code: "provider_rejected", message: "Rejected by Meta." },
    httpStatus: 400,
    providerMutationAttempted: true,
    providerOutcome: "definite_failure" as const,
    mutationAttempt: {
      ...successfulMutationAttempt(),
      providerResponseSuccessful: false,
      httpStatus: 400,
    },
    responsePayload: { error: { message: "Rejected by Meta." } },
  };
}

function mockManualPauseResultAfterAttempt(result: unknown) {
  vi.mocked(adsWrite.pauseAd).mockImplementationOnce(
    async (_ctx, _adId, options) => {
      await options?.beforeMutationAttempt?.({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "100000000000001",
        creativeId: "creative_1",
        campaignId: "campaign_1",
        adsetId: "adset_1",
      });
      return result as never;
    },
  );
}

function reconciledManualStatus(
  configuredStatus: "ACTIVE" | "PAUSED",
  sourceAction: "pause" | "resume" = "pause",
) {
  return {
    disposition: "reconciled" as const,
    candidate: {
      sourceActionLogId: "unresolved_log_1",
      action: sourceAction,
    },
    event: { id: "reconciliation_event_1" },
    resolution:
      configuredStatus === (sourceAction === "pause" ? "PAUSED" : "ACTIVE")
        ? ("current_state_matches_requested" as const)
        : ("current_state_matches_precondition" as const),
    state: {
      ok: true as const,
      adId: "100000000000001",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus,
      effectiveStatus: configuredStatus,
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-18T13:00:00.000Z",
      providerGetEvidence: {
        id: "100000000000001",
        account_id: "123",
        status: configuredStatus,
        effective_status: configuredStatus,
      },
    },
  };
}

function rawRequest(body: unknown) {
  return new NextRequest(
    "http://localhost/api/meta/ads/100000000000001/pause",
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

describe("POST /api/meta/ads/[adId]/pause", () => {
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
      actionLog.decisionOriginIdempotencyReceiptFromLog,
    ).mockReturnValue({
      actionLogId: "log_decision_1",
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId: "100000000000001",
      creativeId: "creative_1",
      snapshotId: "00000000-0000-4000-8000-000000000011",
      evaluationId: "00000000-0000-4000-8000-000000000012",
      engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
      decisionHash: "d".repeat(64),
      action: "pause",
      idempotencyKey: decisionOriginPauseBody().idempotencyKey,
      status: "success",
      dryRun: false,
      providerVerified: true,
      treatmentEligible: true,
    });
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
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
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

  it("blocks manual pause when the live parent hierarchy is not ACTIVE", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "100000000000001",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "PAUSED",
      campaignEffectiveStatus: "PAUSED",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
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

  it("does not read or write Meta before an unresolved manual attempt reaches settlement", async () => {
    vi.mocked(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).mockResolvedValueOnce({
      disposition: "waiting",
      candidate: {
        settlementNotBefore: "2026-07-18T13:05:00.000Z",
        blockerReason: "settlement_not_elapsed",
      },
    } as never);

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      error: { code: "meta_ad_status_reconciliation_waiting" },
      reconciliationRequired: true,
      retryAllowed: false,
      settlementNotBefore: "2026-07-18T13:05:00.000Z",
    });
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a reconciled manual no-op when exact current state already matches pause", async () => {
    vi.mocked(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).mockResolvedValueOnce(reconciledManualStatus("PAUSED") as never);

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      action: "pause",
      status: "PAUSED",
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

  it("does not fabricate a native receipt when reconciliation finds the requested state", async () => {
    vi.mocked(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).mockResolvedValueOnce(reconciledManualStatus("PAUSED") as never);
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValueOnce({
      ok: false,
      disposition: "reject",
      shouldMutate: false,
      blockers: ["ad_status_incompatible"],
      errorCode: "ad_status_incompatible",
      duplicateReceipt: null,
      decisionAgeHours: 1,
      currentAdStateAgeMinutes: 0,
    });

    const response = await POST(
      request(decisionOriginPauseBody()),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "ad_status_incompatible" },
    });
    expect(payload).not.toHaveProperty("receipt");
    expect(payload).not.toHaveProperty("reconciled");
    expect(
      actionLog.createDecisionOriginMetaAdsActionLog,
    ).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when exact reconciliation evidence is inconclusive", async () => {
    vi.mocked(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).mockResolvedValueOnce({
      disposition: "blocked",
      candidate: {
        blockerReason: "attempt_journal_contradictory",
      },
      blocker: "provider_state_inconclusive",
    } as never);

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      error: { code: "meta_ad_status_reconciliation_required" },
      reconciliationRequired: true,
      retryAllowed: false,
      blocker: "provider_state_inconclusive",
    });
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires one exact server-presented ad, creative, and account for manual writes", async () => {
    const response = await POST(
      rawRequest({
        actionOrigin: "manual_operator_v1",
        manualConfirmation: "explicit_operator_confirmation",
        businessId: BUSINESS_ID,
      }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("exact_ad_authority_required");
    expect(actionLog.resolveExactMetaAdActionTarget).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["contractVersion", null],
    ["snapshotId", ""],
    ["evaluation_id", null],
    ["engine_version", ""],
    ["decisionHash", null],
    ["decision_action", ""],
  ])(
    "rejects manual/native mixed lineage when %s is explicitly %j",
    async (field, value) => {
      const response = await POST(
        rawRequest({
          actionOrigin: "manual_operator_v1",
          manualConfirmation: "explicit_operator_confirmation",
          businessId: BUSINESS_ID,
          providerAccountId: "act_123",
          adId: "100000000000001",
          creativeId: "creative_1",
          [field]: value,
        }),
        params(),
      );
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe("mixed_action_origin_contract");
      expect(access.requireBusinessAccess).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["manualConfirmation", null],
    ["manual_confirmation", ""],
    ["launchIntentId", null],
    ["launch_intent_request_fingerprint", ""],
  ])(
    "rejects native/manual mixed authority when %s is explicitly %j",
    async (field, value) => {
      const response = await POST(
        request({
          contractVersion: "meta-decision-origin-ad-execution.v1",
          businessId: BUSINESS_ID,
          providerAccountId: "act_123",
          adId: "100000000000001",
          snapshotId: "00000000-0000-4000-8000-000000000011",
          evaluationId: "00000000-0000-4000-8000-000000000012",
          engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
          decisionHash: "d".repeat(64),
          action: "pause",
          idempotencyKey: "decision-pause-mixed",
          [field]: value,
        }),
        params(),
      );
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe("mixed_action_origin_contract");
      expect(access.requireBusinessAccess).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a second action-origin alias", async () => {
    const response = await POST(
      rawRequest({
        actionOrigin: "manual_operator_v1",
        action_origin: "native_decision_v1",
        manualConfirmation: "explicit_operator_confirmation",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "100000000000001",
        creativeId: "creative_1",
      }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("mixed_action_origin_contract");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("rejects a manual ad id that differs from the route identity", async () => {
    const response = await POST(
      rawRequest({
        actionOrigin: "manual_operator_v1",
        manualConfirmation: "explicit_operator_confirmation",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "ad_other",
        creativeId: "creative_1",
      }),
      params("100000000000001"),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("ad_identity_mismatch");
    expect(actionLog.resolveExactMetaAdActionTarget).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a manual write when local or live creative identity drifts", async () => {
    vi.mocked(actionLog.resolveExactMetaAdActionTarget).mockResolvedValueOnce({
      ok: true,
      target: {
        businessId: BUSINESS_ID,
        adId: "100000000000001",
        creativeId: "creative_other",
        providerAccountId: "act_123",
      },
    } as never);

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("creative_identity_mismatch");
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a manual write when Meta reports a different provider account", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValueOnce({
      ok: true,
      adId: "100000000000001",
      providerAccountId: "act_999",
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
    });

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("provider_account_mismatch");
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
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

  it("writes audit success when Meta pause and verification succeed", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")));

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, action: "pause", status: "PAUSED" });
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "100000000000001",
        creativeId: "creative_1",
        action: "pause",
        source: "manual_operator_v1",
        payloadRequest: expect.objectContaining({
          endpoint: "/100000000000001",
          body: { status: "PAUSED" },
          action_origin: "manual_operator_v1",
          manual_confirmation: "explicit_operator_confirmation",
          mutation_journal_contract_version:
            "meta-manual-ad-status-mutation-attempt.v1",
          mutation_journal_required: true,
          manual_status_mutation_target: {
            businessId: BUSINESS_ID,
            providerAccountId: "act_123",
            adId: "100000000000001",
            creativeId: "creative_1",
            campaignId: "campaign_1",
            adsetId: "adset_1",
          },
        }),
      }),
    );
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).toHaveBeenCalledWith({
      sourceActionLogId: "log_1",
      target: {
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "100000000000001",
        creativeId: "creative_1",
        campaignId: "campaign_1",
        adsetId: "adset_1",
      },
      action: "pause",
      postPath: "100000000000001",
    });
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceActionLogId: "log_1",
        attemptId: "attempt_1",
        completionOutcome: "provider_response_verified_success",
        mutationAttempt: expect.objectContaining({
          method: "POST",
          path: "100000000000001",
          attemptCount: 1,
        }),
        providerResponse: { success: true },
        verification: expect.objectContaining({
          contractVersion: "meta-ad-status-write-verification.v1",
          adId: "100000000000001",
          providerAccountId: "act_123",
          creativeId: "creative_1",
          campaignId: "campaign_1",
          adsetId: "adset_1",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          campaignConfiguredStatus: "ACTIVE",
          campaignEffectiveStatus: "ACTIVE",
          adsetConfiguredStatus: "ACTIVE",
          adsetEffectiveStatus: "ACTIVE",
          policyEligible: true,
          reviewStatus: null,
          observedAt: expect.any(String),
          providerGetEvidence: exactProviderAdState("PAUSED"),
        }),
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "log_1", status: "success" }),
    );
    expect(
      vi.mocked(adsWrite.pauseAd).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(
        actionLog.appendManualMetaAdStatusMutationAttemptStarted,
      ).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(
        actionLog.appendManualMetaAdStatusMutationAttemptStarted,
      ).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(fetch).mock.invocationCallOrder[1]!);
    expect(
      vi.mocked(
        actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
      ).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(actionLog.completeMetaAdsActionLog).mock
        .invocationCallOrder[0]!,
    );
  });

  it("terminalizes an attempt-start persistence failure after the read but before any provider POST", async () => {
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).mockRejectedValueOnce(new Error("attempt journal unavailable"));
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(exactProviderAdState("ACTIVE")),
    );

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      error: {
        code: "manual_mutation_attempt_start_persistence_failed",
      },
      actionLogId: "log_1",
      providerWriteAttempted: false,
    });
    expect(payload).not.toHaveProperty("reconciliationRequired");
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "failure",
        errorCode: "manual_mutation_attempt_start_persistence_failed",
        payloadResponse: {
          mutation_attempt_journal: {
            started: false,
            provider_write_attempted: false,
          },
        },
      }),
    );
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
    });
  });

  it("keeps the exact no-attempt claim reconcilable when start and terminal persistence both fail", async () => {
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).mockRejectedValueOnce(new Error("attempt journal unavailable"));
    vi.mocked(actionLog.completeMetaAdsActionLog).mockRejectedValue(
      new Error("terminal persistence unavailable"),
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(exactProviderAdState("ACTIVE")),
    );

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      error: {
        code: "manual_mutation_attempt_start_persistence_failed",
      },
      actionLogId: "log_1",
      reconciliationRequired: true,
      retryAllowed: false,
      providerWriteAttempted: false,
    });
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledTimes(2);
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("terminalizes an immediate adapter target drift without starting the journal or POST", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        ...exactProviderAdState("ACTIVE"),
        creative: { id: "creative_drifted_before_post" },
      }),
    );

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      error: { code: "manual_mutation_target_drift" },
      mutationAttempt: null,
    });
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "failure",
        payloadResponse: {
          adapter_pre_provider_abort: {
            code: "manual_mutation_target_drift",
            provider_mutation_attempted: false,
          },
        },
        errorCode: "manual_mutation_target_drift",
        verificationPayload: null,
        verifiedAt: null,
      }),
    );
  });

  it("terminalizes an immediate adapter status blocker without starting the journal or POST", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(exactProviderAdState("PAUSED")),
    );

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      error: { code: "ad_status_already_requested" },
      mutationAttempt: null,
    });
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failure",
        payloadResponse: {
          adapter_pre_provider_abort: {
            code: "ad_status_already_requested",
            provider_mutation_attempted: false,
          },
        },
        errorCode: "ad_status_already_requested",
        verificationPayload: null,
        verifiedAt: null,
      }),
    );
  });

  it("never retries or terminalizes after a provider result whose attempt completion cannot persist", async () => {
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).mockRejectedValueOnce(new Error("attempt completion unavailable"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")));

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      error: {
        code: "manual_mutation_attempt_completion_persistence_failed",
      },
      actionLogId: "log_1",
      reconciliationRequired: true,
      retryAllowed: false,
      providerWriteAttempted: true,
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(actionLog.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("fails closed on a typed cross-origin claim conflict before a provider POST", async () => {
    vi.mocked(actionLog.createMetaAdsActionLog).mockRejectedValueOnce(
      Object.assign(new Error("action_in_flight"), {
        code: "action_in_flight",
        blockingActionLogId: "blocking_native_log",
        blockingOrigin: "native_decision_v1",
        reconciliationRequired: false,
        reconciliationReceipt: null,
      }),
    );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "action_in_flight" },
      blockingActionLogId: "blocking_native_log",
      blockingOrigin: "native_decision_v1",
      retryAllowed: false,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(actionLog.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("rechecks manual authority after claim and terminalizes a stale same-direction race without a provider POST", async () => {
    const state = {
      ok: true as const,
      adId: "100000000000001",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-18T13:00:00.000Z",
    };
    vi.mocked(adsWrite.readMetaAdExecutionState)
      .mockResolvedValueOnce({
        ...state,
        configuredStatus: "ACTIVE",
        effectiveStatus: "ACTIVE",
      })
      .mockResolvedValueOnce({
        ...state,
        configuredStatus: "PAUSED",
        effectiveStatus: "PAUSED",
      });

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("ad_status_incompatible");
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "failure",
        errorCode: "ad_status_incompatible",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the exact typed and atomic path for a decision-origin pause", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")));

    const response = await POST(
      request(decisionOriginPauseBody()),
      params(),
    );

    expect(response.status).toBe(200);
    expect(actionLog.resolveExactMetaAdActionTarget).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId: "100000000000001",
    });
    expect(actionLog.resolveMetaAdActionTarget).not.toHaveBeenCalled();
    expect(actionLog.createDecisionOriginMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          businessId: BUSINESS_ID,
          providerAccountId: "act_123",
          adId: "100000000000001",
          action: "pause",
        }),
      }),
    );
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: "log_decision_1", status: "success" }),
    );
    expect(actionLog.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("does not report native pause success when durable lineage completion fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")));
    vi.mocked(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).mockResolvedValueOnce({
      id: "log_decision_1",
      status: "silent_failure",
      errorCode: "verification_campaign_mismatch",
      errorMessage:
        "Provider verification did not preserve the exact native Ad lineage.",
    } as never);

    const response = await POST(request(decisionOriginPauseBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error).toMatchObject({
      code: "verification_campaign_mismatch",
    });
    expect(actionLog.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("marks reconciliation required after provider success when receipt finalization throws", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("PAUSED")));
    vi.mocked(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).mockRejectedValueOnce(new Error("receipt insert failed"));

    const response = await POST(request(decisionOriginPauseBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "provider_verification_persistence_failed" },
      reconciliationRequired: true,
      retryAllowed: false,
      providerMutationSucceeded: true,
      markerPersisted: true,
    });
    expect(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_decision_1",
        errorMessage: "receipt insert failed",
        verificationPayload: expect.objectContaining({
          contractVersion: "meta-ad-status-write-verification.v1",
          adId: "100000000000001",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          providerGetEvidence: exactProviderAdState("PAUSED"),
        }),
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects a caller-selected native tuple key at the route boundary", async () => {
    const response = await POST(
      request({
        ...decisionOriginPauseBody(),
        idempotencyKey: "alternate-attempt-key",
      }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.blockers).toContain(
      "idempotency_key_mismatch",
    );
    expect(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).not.toHaveBeenCalled();
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a stale exact decision before creating a log or writing to Meta", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: false,
      disposition: "reject",
      shouldMutate: false,
      blockers: ["decision_stale"],
      errorCode: "decision_stale",
      duplicateReceipt: null,
      decisionAgeHours: 13,
      currentAdStateAgeMinutes: 0,
    });

    const response = await POST(
      request(decisionOriginPauseBody()),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("decision_stale");
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed dryRun instead of falling through to execute", async () => {
    const response = await POST(
      request({ ...decisionOriginPauseBody(), dryRun: "true" }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_dry_run");
    expect(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).not.toHaveBeenCalled();
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks native authority after claim and blocks a stale race before a second POST", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    )
      .mockResolvedValueOnce({
        ok: true,
        disposition: "proceed",
        shouldMutate: true,
        blockers: [],
        errorCode: null,
        duplicateReceipt: null,
        decisionAgeHours: 1,
        currentAdStateAgeMinutes: 0,
      })
      .mockResolvedValueOnce({
        ok: false,
        disposition: "reject",
        shouldMutate: false,
        blockers: ["current_hierarchy_state_incompatible"],
        errorCode: "current_hierarchy_state_incompatible",
        duplicateReceipt: null,
        decisionAgeHours: 1,
        currentAdStateAgeMinutes: 0,
      });

    const response = await POST(
      request(decisionOriginPauseBody()),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("current_hierarchy_state_incompatible");
    expect(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ignorePendingReceiptActionLogId: "log_decision_1",
      }),
    );
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_decision_1",
        status: "failure",
        errorCode: "current_hierarchy_state_incompatible",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an existing exact receipt without another Meta write", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: true,
      disposition: "duplicate",
      shouldMutate: false,
      blockers: [],
      errorCode: null,
      duplicateReceipt: {
        actionLogId: "log_decision_1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "100000000000001",
        creativeId: "creative_1",
        snapshotId: "00000000-0000-4000-8000-000000000011",
        evaluationId: "00000000-0000-4000-8000-000000000012",
        engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: "d".repeat(64),
        action: "pause",
        idempotencyKey: decisionOriginPauseBody().idempotencyKey,
        status: "success",
        dryRun: false,
        providerVerified: true,
        treatmentEligible: true,
      },
      decisionAgeHours: null,
      currentAdStateAgeMinutes: null,
    });

    const response = await POST(
      request(decisionOriginPauseBody()),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, duplicate: true, status: "PAUSED" });
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns action_in_flight for an unmarked native same-key pending receipt", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: true,
      disposition: "duplicate",
      shouldMutate: false,
      blockers: [],
      errorCode: null,
      duplicateReceipt: {
        actionLogId: "log_decision_1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "100000000000001",
        creativeId: "creative_1",
        snapshotId: "00000000-0000-4000-8000-000000000011",
        evaluationId: "00000000-0000-4000-8000-000000000012",
        engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: "d".repeat(64),
        action: "pause",
        idempotencyKey: decisionOriginPauseBody().idempotencyKey,
        status: "pending",
        dryRun: false,
        providerVerified: false,
        treatmentEligible: false,
        errorCode: null,
        reconciliationRequired: false,
        retryAllowed: null,
      },
      decisionAgeHours: null,
      currentAdStateAgeMinutes: null,
    });

    const response = await POST(request(decisionOriginPauseBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      duplicate: true,
      error: { code: "action_in_flight" },
    });
    expect(payload).not.toHaveProperty("reconciliationRequired");
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an explicit non-retryable reconciliation receipt without another Meta write", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: true,
      disposition: "duplicate",
      shouldMutate: false,
      blockers: [],
      errorCode: null,
      duplicateReceipt: {
        actionLogId: "log_decision_1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "100000000000001",
        creativeId: "creative_1",
        snapshotId: "00000000-0000-4000-8000-000000000011",
        evaluationId: "00000000-0000-4000-8000-000000000012",
        engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: "d".repeat(64),
        action: "pause",
        idempotencyKey: decisionOriginPauseBody().idempotencyKey,
        status: "pending",
        dryRun: false,
        providerVerified: false,
        treatmentEligible: false,
        errorCode: "provider_verification_persistence_failed",
        reconciliationRequired: true,
        retryAllowed: false,
        reconciliationOutcome:
          "provider_write_verified_receipt_persistence_failed",
        providerMutationAttempted: true,
        providerMutationSucceeded: true,
        providerOutcomeAmbiguous: false,
      },
      decisionAgeHours: null,
      currentAdStateAgeMinutes: null,
    });

    const response = await POST(request(decisionOriginPauseBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      duplicate: true,
      error: { code: "provider_verification_persistence_failed" },
      reconciliationRequired: true,
      retryAllowed: false,
      providerMutationSucceeded: true,
    });
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves an ambiguous same-key reconciliation marker without claiming provider success", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: true,
      disposition: "duplicate",
      shouldMutate: false,
      blockers: [],
      errorCode: null,
      duplicateReceipt: {
        actionLogId: "log_decision_1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "100000000000001",
        creativeId: "creative_1",
        snapshotId: "00000000-0000-4000-8000-000000000011",
        evaluationId: "00000000-0000-4000-8000-000000000012",
        engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: "d".repeat(64),
        action: "pause",
        idempotencyKey: decisionOriginPauseBody().idempotencyKey,
        status: "pending",
        dryRun: false,
        providerVerified: false,
        treatmentEligible: false,
        errorCode: "provider_verification_persistence_failed",
        reconciliationRequired: true,
        retryAllowed: false,
        reconciliationOutcome: "provider_outcome_ambiguous",
        providerMutationAttempted: true,
        providerMutationSucceeded: false,
        providerOutcomeAmbiguous: true,
      },
      decisionAgeHours: null,
      currentAdStateAgeMinutes: null,
    });

    const response = await POST(request(decisionOriginPauseBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      duplicate: true,
      error: { code: "provider_verification_persistence_failed" },
      reconciliationRequired: true,
      retryAllowed: false,
      providerOutcomeAmbiguous: true,
    });
    expect(payload).not.toHaveProperty("providerMutationSucceeded");
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("quarantines an old unresolved decision-origin attempt across a different canonical key", async () => {
    vi.mocked(
      actionLog.createDecisionOriginMetaAdsActionLog,
    ).mockRejectedValueOnce(
      Object.assign(
        new Error("decision_origin_pending_reconciliation_required"),
        {
          code: "decision_origin_pending_reconciliation_required",
          blockingActionLogId: "old_pending_log",
          blockingOrigin: "native_decision_v1",
          reconciliationRequired: true,
          reconciliationReceipt: null,
        },
      ),
    );

    const response = await POST(request(decisionOriginPauseBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "decision_origin_pending_reconciliation_required",
      },
      reconciliationRequired: true,
      retryAllowed: false,
      blockingActionLogId: "old_pending_log",
      blockingOrigin: "native_decision_v1",
    });
    expect(payload.providerMutationSucceeded).toBeUndefined();
    expect(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).toHaveBeenCalledTimes(1);
    expect(actionLog.createDecisionOriginMetaAdsActionLog).toHaveBeenCalledTimes(
      1,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("halts a create-time idempotency race without inferring provider success from a sparse marker", async () => {
    vi.mocked(actionLog.createDecisionOriginMetaAdsActionLog).mockResolvedValue({
      id: "log_decision_1",
      status: "pending",
      idempotentReplay: true,
    } as never);
    vi.mocked(
      actionLog.decisionOriginIdempotencyReceiptFromLog,
    ).mockReturnValue({
      actionLogId: "log_decision_1",
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId: "100000000000001",
      creativeId: "creative_1",
      snapshotId: "00000000-0000-4000-8000-000000000011",
      evaluationId: "00000000-0000-4000-8000-000000000012",
      engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
      decisionHash: "d".repeat(64),
      action: "pause",
      idempotencyKey: decisionOriginPauseBody().idempotencyKey,
      status: "pending",
      dryRun: false,
      providerVerified: false,
      treatmentEligible: false,
      errorCode: "provider_verification_persistence_failed",
      reconciliationRequired: true,
      retryAllowed: false,
    });

    const response = await POST(request(decisionOriginPauseBody()), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      duplicate: true,
      error: { code: "provider_verification_persistence_failed" },
      reconciliationRequired: true,
      retryAllowed: false,
    });
    expect(payload).not.toHaveProperty("providerMutationSucceeded");
    expect(actionLog.completeDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps an atomic different-key claim loser to structured reconciliation without a POST", async () => {
    vi.mocked(
      actionLog.createDecisionOriginMetaAdsActionLog,
    ).mockRejectedValueOnce(
      Object.assign(
        new Error("decision_origin_pending_reconciliation_required"),
        {
          code: "decision_origin_pending_reconciliation_required",
          blockingActionLogId: "blocking_native_log",
          blockingOrigin: "native_decision_v1",
          reconciliationRequired: true,
          reconciliationReceipt: null,
        },
      ),
    );

    const response = await POST(
      request(decisionOriginPauseBody()),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "decision_origin_pending_reconciliation_required",
      },
      reconciliationRequired: true,
      retryAllowed: false,
      blockingActionLogId: "blocking_native_log",
      blockingOrigin: "native_decision_v1",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).not.toHaveBeenCalled();
  });

  it("returns a retryable error when current Meta state is unavailable", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: false,
      disposition: "reject",
      shouldMutate: false,
      blockers: ["current_ad_state_unverified"],
      errorCode: "current_ad_state_unverified",
      duplicateReceipt: null,
      decisionAgeHours: 1,
      currentAdStateAgeMinutes: null,
    });

    const response = await POST(
      request(decisionOriginPauseBody()),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("current_ad_state_unverified");
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs silent_failure when Meta success verifies unchanged", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")));

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      error: { code: "silent_failure" },
      reconciliationRequired: true,
      retryAllowed: false,
      providerMutationSucceeded: true,
    });
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "silent_failure" }),
    );
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceActionLogId: "log_1",
        completionOutcome:
          "provider_response_succeeded_verification_failed",
        providerResponse: { success: true },
        verification: {
          verificationFailureReason: "configured_status_mismatch",
          observedExecutionState: expect.objectContaining({
            adId: "100000000000001",
            providerAccountId: "act_123",
            creativeId: "creative_1",
            campaignId: "campaign_1",
            adsetId: "adset_1",
            configuredStatus: "ACTIVE",
            effectiveStatus: "ACTIVE",
            providerGetEvidence: exactProviderAdState("ACTIVE"),
          }),
        },
      }),
    );
  });

  it("retries dry-run terminal completion once and never claims a provider mutation", async () => {
    const {
      idempotencyKey: _liveKey,
      ...dryRunBaseWithoutKey
    } = decisionOriginPauseBody();
    const dryRunBase = {
      ...dryRunBaseWithoutKey,
      dryRun: true as const,
    };
    const dryRunRequest = {
      ...dryRunBase,
      idempotencyKey:
        createDecisionOriginAdActionIdempotencyKey(dryRunBase),
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: "100000000000001",
        status: "ACTIVE",
        effective_status: "ACTIVE",
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
      }),
    );
    vi.mocked(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).mockRejectedValue(new Error("dry-run receipt DB unavailable"));

    const response = await POST(request(dryRunRequest), params());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      reconciliationOutcome: "dry_run_terminal_persistence_failed",
      reconciliationRequired: true,
      retryAllowed: false,
      markerPersisted: true,
    });
    expect(payload).not.toHaveProperty("providerMutationSucceeded");
    expect(payload).not.toHaveProperty("providerOutcomeAmbiguous");
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledTimes(2);
    expect(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_decision_1",
        outcome: "dry_run_terminal_persistence_failed",
      }),
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("durably records a successful status POST as silent_failure when verification GET fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockRejectedValueOnce(new Error("verification connection reset"));

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "network_error",
        message: "verification connection reset",
      },
      providerOutcome: "definite_failure",
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        path: "100000000000001",
        providerResponseReceived: true,
        providerResponseSuccessful: true,
        httpStatus: 200,
        outcome: "provider_response_received",
      },
      reconciliationRequired: true,
      retryAllowed: false,
      providerMutationSucceeded: true,
    });
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "silent_failure",
        errorCode: "network_error",
        payloadResponse: { success: true },
        verificationPayload: {
          verificationFailureReason: "current_ad_state_unverified",
        },
      }),
    );
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceActionLogId: "log_1",
        completionOutcome:
          "provider_response_succeeded_verification_failed",
        providerResponse: { success: true },
        verification: {
          verificationFailureReason: "current_ad_state_unverified",
        },
      }),
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps native provider-success verification failure pending and blocks a different key without a second POST", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockRejectedValueOnce(new Error("verification connection reset"));

    const firstResponse = await POST(
      request(decisionOriginPauseBody()),
      params(),
    );
    const firstPayload = await firstResponse.json();

    expect(firstResponse.status).toBe(503);
    expect(firstPayload).toMatchObject({
      ok: false,
      error: { code: "provider_verification_persistence_failed" },
      reconciliationOutcome:
        "provider_response_succeeded_verification_failed",
      reconciliationRequired: true,
      retryAllowed: false,
      providerMutationSucceeded: true,
      markerPersisted: true,
      mutationAttempt: {
        providerResponseSuccessful: true,
      },
    });
    expect(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_decision_1",
        outcome:
          "provider_response_succeeded_verification_failed",
        providerErrorCode: "network_error",
        mutationAttempt: expect.objectContaining({
          providerResponseSuccessful: true,
        }),
      }),
    );
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).not.toHaveBeenCalled();

    const {
      idempotencyKey: _firstKey,
      ...secondBaseWithoutKey
    } = decisionOriginPauseBody();
    const secondBase = {
      ...secondBaseWithoutKey,
      snapshotId: "00000000-0000-4000-8000-000000000021",
      evaluationId: "00000000-0000-4000-8000-000000000022",
      decisionHash: "e".repeat(64),
    };
    const secondRequest = {
      ...secondBase,
      idempotencyKey:
        createDecisionOriginAdActionIdempotencyKey(secondBase),
    };
    vi.mocked(
      actionLog.createDecisionOriginMetaAdsActionLog,
    ).mockRejectedValueOnce(
      Object.assign(
        new Error("decision_origin_pending_reconciliation_required"),
        {
          code: "decision_origin_pending_reconciliation_required",
          blockingActionLogId: "log_decision_1",
          blockingOrigin: "native_decision_v1",
          reconciliationRequired: true,
          reconciliationReceipt: {
            actionLogId: "log_decision_1",
            businessId: BUSINESS_ID,
            providerAccountId: "act_123",
            adId: "100000000000001",
            creativeId: "creative_1",
            snapshotId: decisionOriginPauseBody().snapshotId,
            evaluationId: decisionOriginPauseBody().evaluationId,
            engineVersion: decisionOriginPauseBody().engineVersion,
            decisionHash: decisionOriginPauseBody().decisionHash,
            action: "pause",
            idempotencyKey: decisionOriginPauseBody().idempotencyKey,
            status: "pending",
            dryRun: false,
            providerVerified: false,
            treatmentEligible: false,
            errorCode: "provider_verification_persistence_failed",
            reconciliationRequired: true,
            retryAllowed: false,
            reconciliationOutcome:
              "provider_response_succeeded_verification_failed",
            providerMutationAttempted: true,
            providerMutationSucceeded: true,
            providerOutcomeAmbiguous: false,
          },
        },
      ),
    );

    const secondResponse = await POST(request(secondRequest), params());
    const secondPayload = await secondResponse.json();

    expect(secondResponse.status).toBe(409);
    expect(secondPayload).toMatchObject({
      ok: false,
      error: {
        code: "decision_origin_pending_reconciliation_required",
      },
      reconciliationRequired: true,
      retryAllowed: false,
      providerMutationSucceeded: true,
      blockingActionLogId: "log_decision_1",
      blockingOrigin: "native_decision_v1",
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(
      actionLog.createDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledTimes(2);
  });

  it("durably records an ambiguous single POST without retrying the mutation", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
      .mockRejectedValueOnce(
        new Error("connection closed after request upload"),
      );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "provider_outcome_ambiguous" },
      providerOutcome: "outcome_ambiguous",
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        path: "100000000000001",
        providerResponseReceived: false,
        outcome: "outcome_ambiguous",
        automaticRetryAttempted: false,
      },
      reconciliationRequired: true,
      providerOutcomeAmbiguous: true,
      retryAllowed: false,
    });
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "silent_failure",
        errorCode: "provider_outcome_ambiguous",
        payloadResponse: null,
      }),
    );
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceActionLogId: "log_1",
        attemptId: "attempt_1",
        completionOutcome: "provider_outcome_ambiguous",
        providerResponse: null,
        verification: null,
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("terminalizes a raw pre-hook manual adapter exception as a definite no-POST failure", async () => {
    vi.mocked(adsWrite.pauseAd).mockRejectedValueOnce(
      new Error("unexpected provider adapter throw"),
    );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "provider_write_unexpected_exception" },
      providerWriteAttempted: false,
      actionLogId: "log_1",
    });
    expect(payload).not.toHaveProperty("providerMutationSucceeded");
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).not.toHaveBeenCalled();
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "failure",
        errorCode: "provider_write_unexpected_exception",
        payloadResponse: {
          adapter_pre_provider_abort: {
            code: "provider_write_unexpected_exception",
            provider_mutation_attempted: false,
          },
        },
      }),
    );
  });

  it("blocks a second provider attempt behind manual reconciliation authority", async () => {
    vi.mocked(adsWrite.pauseAd).mockRejectedValueOnce(
      new Error("unexpected provider adapter throw"),
    );
    vi.mocked(actionLog.createMetaAdsActionLog)
      .mockResolvedValueOnce({ id: "log_1" } as never)
      .mockRejectedValueOnce({
        code: "meta_ad_status_reconciliation_required",
        blockingActionLogId: "log_1",
        blockingOrigin: "manual_operator_v1",
        reconciliationRequired: true,
        reconciliationReceipt: null,
      });

    const firstResponse = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    expect(firstResponse.status).toBe(502);

    const secondResponse = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const secondPayload = await secondResponse.json();

    expect(secondResponse.status).toBe(409);
    expect(secondPayload).toMatchObject({
      ok: false,
      error: { code: "meta_ad_status_reconciliation_required" },
      blockingActionLogId: "log_1",
      blockingOrigin: "manual_operator_v1",
      reconciliationRequired: true,
      retryAllowed: false,
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
  });

  it("treats a raw manual dry-run exception as a definite 502 failure", async () => {
    vi.mocked(adsWrite.pauseAd).mockRejectedValueOnce(
      new Error("unexpected dry-run adapter throw"),
    );

    const response = await POST(
      request({ businessId: BUSINESS_ID, dryRun: true }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "provider_write_unexpected_exception" },
      dryRun: true,
      actionLogId: "log_1",
    });
    expect(payload).not.toHaveProperty("providerOutcomeAmbiguous");
    expect(payload).not.toHaveProperty("providerMutationSucceeded");
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "failure",
        errorCode: "provider_write_unexpected_exception",
        payloadResponse: expect.objectContaining({
          provider_write_exception: expect.objectContaining({
            mutation_attempted: false,
            outcome: "definite_failure",
          }),
        }),
      }),
    );
  });

  it("does not leak persistence internals when raw-throw quarantine cannot be stored", async () => {
    vi.mocked(adsWrite.pauseAd).mockRejectedValueOnce(
      new Error("unexpected provider adapter throw"),
    );
    vi.mocked(actionLog.completeMetaAdsActionLog).mockRejectedValue(
      new Error(
        'duplicate key on table "meta_ads_action_log" at postgres://internal',
      ),
    );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "manual_failure_terminal_persistence_failed" },
      actionLogId: "log_1",
      providerWriteAttempted: false,
      reconciliationRequired: true,
      retryAllowed: false,
    });
    expect(payload).not.toHaveProperty("persistenceError");
    expect(JSON.stringify(payload)).not.toContain("meta_ads_action_log");
    expect(JSON.stringify(payload)).not.toContain("postgres://internal");
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledTimes(2);
  });

  it("retries an identical manual success completion without rewriting it as failure", async () => {
    mockManualPauseResultAfterAttempt({
      ok: true,
      verifiedStatus: "PAUSED",
      responsePayload: { success: true },
      verificationPayload: {
        id: "100000000000001",
        status: "PAUSED",
      },
      mutationAttempt: successfulMutationAttempt(),
      providerHttpStatus: 200,
    });
    vi.mocked(actionLog.completeMetaAdsActionLog).mockRejectedValueOnce(
      new Error("commit acknowledgement lost"),
    );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      action: "pause",
      adId: "100000000000001",
      status: "PAUSED",
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(actionLog.completeMetaAdsActionLog).mock.calls.every(
        ([completion]) => completion.status === "success",
      ),
    ).toBe(true);
  });

  it("returns typed non-retryable reconciliation when manual success persistence fails twice", async () => {
    mockManualPauseResultAfterAttempt({
      ok: true,
      verifiedStatus: "PAUSED",
      responsePayload: { success: true },
      verificationPayload: {
        id: "100000000000001",
        status: "PAUSED",
      },
      mutationAttempt: successfulMutationAttempt(),
      providerHttpStatus: 200,
    });
    vi.mocked(actionLog.completeMetaAdsActionLog).mockRejectedValue(
      new Error("terminal persistence unavailable"),
    );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "manual_success_terminal_persistence_failed" },
      actionLogId: "log_1",
      providerMutationSucceeded: true,
      reconciliationRequired: true,
      retryAllowed: false,
    });
    expect(payload).not.toHaveProperty("persistenceError");
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(actionLog.completeMetaAdsActionLog).mock.calls.every(
        ([completion]) => completion.status === "success",
      ),
    ).toBe(true);
  });

  it("does not retry a definite provider rejection when manual failure persistence fails", async () => {
    mockManualPauseResultAfterAttempt(definiteRejectedMutationResult());
    vi.mocked(actionLog.completeMetaAdsActionLog).mockRejectedValue(
      new Error("terminal persistence unavailable"),
    );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "manual_failure_terminal_persistence_failed" },
      actionLogId: "log_1",
      reconciliationRequired: true,
      retryAllowed: false,
      providerError: { code: "provider_rejected" },
    });
    expect(payload).not.toHaveProperty("persistenceError");
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceActionLogId: "log_1",
        attemptId: "attempt_1",
        completionOutcome: "provider_definite_failure",
        providerResponse: {
          error: { message: "Rejected by Meta." },
        },
        verification: null,
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(actionLog.completeMetaAdsActionLog).mock.calls.every(
        ([completion]) => completion.status === "failure",
      ),
    ).toBe(true);
  });

  it("replays an ACK-lost manual failure with byte-identical frozen terminal fields", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 17;
      return now;
    });
    mockManualPauseResultAfterAttempt(definiteRejectedMutationResult());
    vi.mocked(actionLog.completeMetaAdsActionLog)
      .mockRejectedValueOnce(new Error("commit acknowledgement lost"))
      .mockResolvedValueOnce({ id: "log_1", status: "failure" } as never);

    const response = await POST(
      request({ businessId: BUSINESS_ID }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "provider_rejected" },
    });
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledTimes(2);
    const firstCompletion =
      vi.mocked(actionLog.completeMetaAdsActionLog).mock.calls[0]?.[0];
    const secondCompletion =
      vi.mocked(actionLog.completeMetaAdsActionLog).mock.calls[1]?.[0];
    expect(secondCompletion).toEqual(firstCompletion);
    expect(firstCompletion).toMatchObject({
      status: "failure",
      errorCode: "provider_rejected",
      durationMs: expect.any(Number),
      verifiedAt: null,
      verificationPayload: null,
    });
  });

  it("keeps a native ambiguous POST pending for reconciliation", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
      .mockRejectedValueOnce(
        new Error("connection closed after request upload"),
      );

    const response = await POST(
      request(decisionOriginPauseBody()),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "provider_verification_persistence_failed" },
      reconciliationOutcome: "provider_outcome_ambiguous",
      reconciliationRequired: true,
      retryAllowed: false,
      providerOutcomeAmbiguous: true,
      markerPersisted: true,
    });
    expect(payload).not.toHaveProperty("providerMutationSucceeded");
    expect(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_decision_1",
        outcome: "provider_outcome_ambiguous",
        providerErrorCode: "provider_outcome_ambiguous",
      }),
    );
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("logs failure when Meta returns an HTTP error", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
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
      .mockResolvedValueOnce(jsonResponse(exactProviderAdState("ACTIVE")))
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

  it("keeps a marked native blocker as action_in_flight for a manual request", async () => {
    vi.mocked(actionLog.createMetaAdsActionLog).mockRejectedValueOnce(
      Object.assign(new Error("action_in_flight"), {
        code: "action_in_flight",
        blockingActionLogId: "blocking_native_log",
        blockingOrigin: "native_decision_v1",
        reconciliationRequired: true,
        reconciliationReceipt: {
          actionLogId: "blocking_native_log",
          businessId: BUSINESS_ID,
          providerAccountId: "act_123",
          adId: "100000000000001",
          creativeId: "creative_1",
          snapshotId: "00000000-0000-4000-8000-000000000011",
          evaluationId: "00000000-0000-4000-8000-000000000012",
          engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
          decisionHash: "d".repeat(64),
          action: "pause",
          idempotencyKey: decisionOriginPauseBody().idempotencyKey,
          status: "pending",
          dryRun: false,
          providerVerified: false,
          treatmentEligible: false,
          errorCode: "provider_verification_persistence_failed",
          reconciliationRequired: true,
          retryAllowed: false,
          reconciliationOutcome: "provider_outcome_ambiguous",
          providerMutationAttempted: true,
          providerMutationSucceeded: false,
          providerOutcomeAmbiguous: true,
        },
      }),
    );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      error: { code: "action_in_flight" },
      blockingActionLogId: "blocking_native_log",
      blockingOrigin: "native_decision_v1",
      reconciliationRequired: true,
      retryAllowed: false,
      providerOutcomeAmbiguous: true,
    });
    expect(payload).not.toHaveProperty("providerMutationSucceeded");
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
