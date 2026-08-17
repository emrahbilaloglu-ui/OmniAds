import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/google-ads/action-clusters", () => ({
  executeActionCluster: vi.fn(),
  rollbackActionCluster: vi.fn(),
}));

vi.mock("@/lib/google-ads/account-authority", () => ({
  assertGoogleAdsAccountAuthority: vi.fn(),
  isGoogleAdsAccountAuthorityError: (error: unknown) =>
    Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        "httpStatus" in error,
    ),
}));

vi.mock("@/lib/google-ads/advisor-memory", () => ({
  getAdvisorExecutionCalibration: vi.fn(),
  logAdvisorExecutionEvent: vi.fn(),
  recordAdvisorOutcome: vi.fn(),
  updateAdvisorCompletionState: vi.fn(),
  updateAdvisorExecutionState: vi.fn(),
  updateAdvisorMemoryAction: vi.fn(),
}));

vi.mock("@/lib/google-ads/advisor-mutate", () => ({
  executeAdvisorMutation: vi.fn(),
  preflightAdvisorMutation: vi.fn(),
  rollbackAdvisorMutation: vi.fn(),
}));

vi.mock("@/lib/google-ads/search-intelligence-storage", () => ({
  appendGoogleAdsDecisionActionOutcomeLog: vi.fn(async () => undefined),
}));

const access = await import("@/lib/access");
const businessMode = await import("@/lib/business-mode.server");
const accountAuthority = await import("@/lib/google-ads/account-authority");
const advisorMemory = await import("@/lib/google-ads/advisor-memory");
const advisorMutate = await import("@/lib/google-ads/advisor-mutate");
const { POST } = await import("@/app/api/google-ads/advisor-memory/route");

describe("POST /api/google-ads/advisor-memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOOGLE_ADS_DECISION_ENGINE_V2", "true");
    vi.stubEnv("GOOGLE_ADS_WRITEBACK_ENABLED", "false");
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      // The seat the write is authorized under. The route reads the actor from
      // here and never from the request body.
      session: { user: { id: "usr_1" } } as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(accountAuthority.assertGoogleAdsAccountAuthority).mockResolvedValue({
      state: "authorized",
    } as never);
    vi.mocked(advisorMemory.updateAdvisorMemoryAction).mockResolvedValue({
      matched: true,
      recommendationFingerprint: "fp_1",
      currentStatus: "suppressed",
      userAction: "dismissed",
      suppressUntil: "2026-08-24T00:00:00.000Z",
    });
  });

  it("blocks write-back execution when the explicit capability gate is disabled", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/google-ads/advisor-memory", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          accountId: "acc_1",
          recommendationFingerprint: "fp_1",
          executionAction: "apply_mutate",
          mutateActionType: "add_negative_keyword",
          mutatePayloadPreview: { adGroupId: "ag_1", text: "free" },
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toContain("write-back is disabled");
    expect(payload.capabilityGate).toMatchObject({
      enabled: false,
      mutateEnabled: false,
      rollbackEnabled: false,
      clusterExecutionEnabled: false,
    });
    expect(vi.mocked(advisorMutate.preflightAdvisorMutation)).not.toHaveBeenCalled();
    expect(vi.mocked(advisorMutate.executeAdvisorMutation)).not.toHaveBeenCalled();
  });

  it("stamps the authorized seat on every execution-log row a guarded write emits", async () => {
    vi.stubEnv("GOOGLE_ADS_WRITEBACK_ENABLED", "true");
    vi.mocked(advisorMutate.executeAdvisorMutation).mockResolvedValue({
      resourceNames: ["customers/1/adGroupCriteria/2~3"],
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/google-ads/advisor-memory", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          accountId: "acc_1",
          recommendationFingerprint: "fp_1",
          executionAction: "apply_mutate",
          mutateActionType: "add_negative_keyword",
          mutatePayloadPreview: { adGroupId: "ag_1", text: "free" },
          // The body cannot name the author; the session does.
          actorUserId: "usr_forged",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const logCalls = vi.mocked(advisorMemory.logAdvisorExecutionEvent).mock.calls;
    expect(logCalls.length).toBeGreaterThan(0);
    for (const [event] of logCalls) {
      expect(event).toMatchObject({ actorUserId: "usr_1" });
    }
  });

  it("records a manual outcome without requiring write-back capability", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/google-ads/advisor-memory", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          accountId: "all",
          recommendationFingerprint: "fp_2",
          executionAction: "record_outcome",
          outcomeVerdict: "improved",
          outcomeMetric: "manual_validation",
          outcomeDelta: -3,
          outcomeConfidence: "medium",
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true });
    expect(vi.mocked(advisorMemory.recordAdvisorOutcome)).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        accountId: "all",
        recommendationFingerprint: "fp_2",
        verdict: "improved",
        metric: "manual_validation",
        delta: -3,
      })
    );
  });

  it("authorizes the exact account and returns a verified dismissal receipt", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/google-ads/advisor-memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessId: "biz",
          accountId: "acc_1",
          recommendationFingerprint: "fp_1",
          action: "dismissed",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(accountAuthority.assertGoogleAdsAccountAuthority).toHaveBeenCalledWith({
      businessId: "biz",
      accountId: "acc_1",
    });
    expect(advisorMemory.updateAdvisorMemoryAction).toHaveBeenCalledWith({
      businessId: "biz",
      accountId: "acc_1",
      recommendationFingerprint: "fp_1",
      action: "dismissed",
      dismissReason: null,
      suppressUntil: null,
    });
    expect(payload).toEqual({
      ok: true,
      action: "dismissed",
      accountId: "acc_1",
      recommendationFingerprint: "fp_1",
      currentStatus: "suppressed",
      suppressUntil: "2026-08-24T00:00:00.000Z",
    });
  });

  it("refuses an account that is no longer selected before touching memory", async () => {
    vi.mocked(accountAuthority.assertGoogleAdsAccountAuthority).mockRejectedValueOnce(
      Object.assign(new Error("This account is not currently selected."), {
        code: "google_ads_account_not_selected",
        httpStatus: 409,
      }),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/google-ads/advisor-memory", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          accountId: "foreign_account",
          recommendationFingerprint: "fp_1",
          action: "dismissed",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "google_ads_account_not_selected",
    });
    expect(advisorMemory.updateAdvisorMemoryAction).not.toHaveBeenCalled();
  });

  it("fails closed when the fingerprint no longer matches an account row", async () => {
    vi.mocked(advisorMemory.updateAdvisorMemoryAction).mockResolvedValueOnce({
      matched: false,
      recommendationFingerprint: null,
      currentStatus: null,
      userAction: null,
      suppressUntil: null,
    });

    const response = await POST(
      new NextRequest("http://localhost/api/google-ads/advisor-memory", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          accountId: "acc_1",
          recommendationFingerprint: "stale_fp",
          action: "dismissed",
        }),
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "advisor_recommendation_not_found",
    });
  });

  it("does not report a no-op dismissal as successful for demo businesses", async () => {
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValueOnce(true);

    const response = await POST(
      new NextRequest("http://localhost/api/google-ads/advisor-memory", {
        method: "POST",
        body: JSON.stringify({
          businessId: "demo_business",
          accountId: "acc_1",
          recommendationFingerprint: "fp_1",
          action: "dismissed",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "demo_read_only" });
    expect(accountAuthority.assertGoogleAdsAccountAuthority).not.toHaveBeenCalled();
    expect(advisorMemory.updateAdvisorMemoryAction).not.toHaveBeenCalled();
  });
});
