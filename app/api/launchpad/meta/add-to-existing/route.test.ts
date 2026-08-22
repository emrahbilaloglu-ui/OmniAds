import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { normalizeMetaAddToExistingPayload } from "@/lib/launchpad/meta";
import { META_LAUNCHPAD_EXECUTION_LIMITS } from "@/lib/launchpad/meta-execution-bounds";
import { META_LAUNCHPAD_MANUAL_AUTHORITY } from "@/lib/launchpad/meta-manual-authority";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

// The demo refusal is a SERVER rule (rejectIfLaunchpadDemoWrite reads
// businesses.is_demo_business). Mocked here so these cases exercise the rest
// of the route; the refusal itself is asserted in demo-write-authority.test.ts
// and in the per-route demo case below.
vi.mock("../demo-write-authority", () => ({
  rejectIfLaunchpadDemoWrite: vi.fn(async () => null),
}));

vi.mock("@/lib/meta/ads-action-log", () => ({
  completeMetaAdsActionLog: vi.fn(),
  createMetaAdsActionLog: vi.fn(),
  hasRecentPendingMetaAddToExistingAction: vi.fn(),
}));

vi.mock("@/lib/meta/ads-write", () => ({
  duplicateAd: vi.fn(),
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
  validateMetaAddToExistingLiveProviderPreflight: vi.fn(),
  validateMetaAddToExistingRequest: vi.fn(),
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
const adsWrite = await import("@/lib/meta/ads-write");
const writeGuard = await import("@/lib/meta/automation-write-guard");
const validation = await import("@/lib/launchpad/meta-validation");
const intentService = await import("@/lib/launchpad/meta-launch-intent-service");
const intentCapability = await import("@/lib/launchpad/meta-launch-intent-capability");
const intentStore = await import("@/lib/launchpad/meta-launch-intent-store");
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
    ...META_LAUNCHPAD_MANUAL_AUTHORITY,
    businessId: BUSINESS_ID,
    providerAccountId: "act_123",
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
    copyMode: "reuse_creative" as const,
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
      copyMode: "reuse_creative",
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
      { creativeId: "creative_1", creativeName: "Creative 1", effectiveStatus: "ACTIVE", sourceAdId: "source_ad_1", providerAccountId: "act_123" },
      { creativeId: "creative_2", creativeName: "Creative 2", effectiveStatus: "ACTIVE", sourceAdId: "source_ad_2", providerAccountId: "act_123" },
    ],
  });
}

describe("POST /api/launchpad/meta/add-to-existing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Same reason as the launch suite: this file is about what the create path
    // does, so it opens the gate. The closed-gate refusal is covered by the
    // case at the bottom of this file and by
    // `app/api/launchpad/meta/execution-gate.test.ts`.
    process.env.META_LAUNCHPAD_EXECUTION = "true";
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
    vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValue(null);
    vi.mocked(actionLog.hasRecentPendingMetaAddToExistingAction).mockResolvedValue(false);
    vi.mocked(actionLog.createMetaAdsActionLog).mockImplementation(async () => ({
      id: `log_${vi.mocked(actionLog.createMetaAdsActionLog).mock.calls.length}`,
    }) as never);
    vi.mocked(actionLog.completeMetaAdsActionLog).mockResolvedValue({ id: "log" } as never);
    vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
      ok: true,
      providerAccountId: "act_123",
    });
    vi.mocked(intentService.prepareMetaLaunchIntentForExecution).mockResolvedValue({
      ok: true,
      created: true,
      intent: {
        id: "intent_1",
        status: "prepared",
        requestFingerprint: "fingerprint_1",
      },
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
    vi.mocked(
      validation.validateMetaAddToExistingLiveProviderPreflight,
    ).mockResolvedValue({
      ok: true,
      blockers: [],
      checks: [
        { kind: "source_ad", requestedAdId: "source_ad_1" },
        { kind: "target_adset", requestedAdsetId: "adset_1" },
      ],
    });
    mockValid();
    vi.mocked(adsWrite.duplicateAd)
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        newAdId: "ad_1",
        sourceIdentity: {
          adId: "source_ad_1",
          providerAccountId: "act_123",
          creativeId: "creative_1",
          observedAt: "2026-07-18T10:00:00.000Z",
        },
        verifiedStatus: "PAUSED",
        responsePayload: { id: "ad_1" },
        verificationPayload: { id: "ad_1", status: "PAUSED" },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        newAdId: "ad_2",
        sourceIdentity: {
          adId: "source_ad_2",
          providerAccountId: "act_123",
          creativeId: "creative_2",
          observedAt: "2026-07-18T10:00:01.000Z",
        },
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
      launchIntentId: "intent_1",
      launchIntentStatus: "succeeded",
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
        expectedSourceCreativeId: "creative_1",
      }),
    );
    const duplicateInput = vi.mocked(adsWrite.duplicateAd).mock.calls[0]?.[1];
    expect(duplicateInput).not.toHaveProperty("activateAfterCreate");
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "launch_ad",
        source: "launchpad_manual",
        adId: "source_ad_1",
        creativeId: "creative_1",
      }),
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadRequest: expect.objectContaining({
          action_origin: "launchpad_manual_v1",
          manual_confirmation: "explicit_operator_confirmation",
          launch_intent_request_fingerprint: "fingerprint_1",
          launch_intent_id: "intent_1",
          provider_preflight: expect.arrayContaining([
            expect.objectContaining({ kind: "source_ad" }),
          ]),
          target_campaign_name: "Campaign",
          target_adset_name: "Ad set",
          source_name: "Creative 1",
          body: expect.objectContaining({
            copy_mode: "reuse_creative",
            source_name: "Creative 1",
            status_option: "PAUSED",
            name: "Creative 1 added",
          }),
        }),
      }),
    );
    expect(validation.validateMetaAddToExistingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
      }),
    );
    expect(
      intentService.prepareMetaLaunchIntentForExecution,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: expect.objectContaining({
          executionAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
        }),
      }),
    );
    expect(
      validation.validateMetaAddToExistingLiveProviderPreflight,
    ).toHaveBeenCalledWith({
      ctx: expect.objectContaining({ providerAccountId: "act_123" }),
      payload: expect.objectContaining({ mode: "add_to_existing" }),
    });
    expect(intentStore.recordMetaLaunchIntentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        resultReceipt: expect.objectContaining({
          executionAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
          requestFingerprint: "fingerprint_1",
          steps: expect.arrayContaining([
            expect.objectContaining({
              sourceIdentity: expect.objectContaining({
                adId: "source_ad_1",
                creativeId: "creative_1",
              }),
            }),
          ]),
        }),
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadResponse: expect.objectContaining({
          source_identity: expect.objectContaining({
            adId: "source_ad_1",
            creativeId: "creative_1",
          }),
        }),
        verificationPayload: expect.objectContaining({
          source_identity: expect.objectContaining({
            adId: "source_ad_1",
            creativeId: "creative_1",
          }),
        }),
      }),
    );
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "launch_campaign" }),
    );
  });

  it.each([
    [
      {
        actionOrigin: undefined,
        manualConfirmation: undefined,
      },
      "action_origin_required",
    ],
    [
      {
        actionOrigin: "manual_operator_v1",
        manualConfirmation: "explicit_operator_confirmation",
      },
      "action_origin_required",
    ],
    [
      {
        actionOrigin: "launchpad_manual_v1",
        manualConfirmation: undefined,
      },
      "manual_confirmation_required",
    ],
    [
      {
        ...META_LAUNCHPAD_MANUAL_AUTHORITY,
        sourceDecisionId: null,
      },
      "mixed_action_origin_contract",
    ],
  ])(
    "rejects invalid or mixed authority before intent and provider work",
    async (authority, code) => {
      const response = await POST(request({ ...body(), ...authority }));
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe(code);
      expect(
        intentService.prepareMetaLaunchIntentForExecution,
      ).not.toHaveBeenCalled();
      expect(
        validation.validateMetaAddToExistingLiveProviderPreflight,
      ).not.toHaveBeenCalled();
      expect(adsWrite.duplicateAd).not.toHaveBeenCalled();
      expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    },
  );

  it("keeps rebuild_creative review-only before intent or provider work", async () => {
    const response = await POST(
      request({
        ...body(),
        copyMode: "rebuild_creative",
        idempotencyKey: "idem_rebuild_review",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe(
      "rebuild_creative_receipt_contract_required",
    );
    expect(
      intentService.prepareMetaLaunchIntentForExecution,
    ).not.toHaveBeenCalled();
    expect(adsWrite.duplicateAd).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("rejects over-limit fan-out before account, intent, validation, or provider work", async () => {
    const creatives = Array.from(
      { length: META_LAUNCHPAD_EXECUTION_LIMITS.maxCreatives + 1 },
      (_, index) => ({
        creativeId: `creative_${index + 1}`,
        sourceAdId: `source_ad_${index + 1}`,
      }),
    );
    const response = await POST(
      request({
        ...body(),
        creativeIds: creatives.map((creative) => creative.creativeId),
        creatives,
        idempotencyKey: "idem_over_limit",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload.error.code).toBe("launchpad_creative_limit_exceeded");
    expect(payload.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "launchpad_creative_limit_exceeded",
        }),
      ]),
    );
    expect(validation.resolveAssignedMetaLaunchAccount).not.toHaveBeenCalled();
    expect(
      intentService.prepareMetaLaunchIntentForExecution,
    ).not.toHaveBeenCalled();
    expect(validation.validateMetaAddToExistingRequest).not.toHaveBeenCalled();
    expect(
      validation.validateMetaAddToExistingLiveProviderPreflight,
    ).not.toHaveBeenCalled();
    expect(adsWrite.duplicateAd).not.toHaveBeenCalled();
  });

  it("records the observed source identity when it drifts between preflight and write", async () => {
    const observedIdentity = {
      adId: "source_ad_1",
      providerAccountId: "act_123",
      creativeId: "creative_drifted",
      observedAt: "2026-07-18T10:01:00.000Z",
    };
    vi.mocked(adsWrite.duplicateAd)
      .mockReset()
      .mockResolvedValueOnce({
        ok: false,
        httpStatus: 409,
        error: {
          code: "creative_identity_mismatch",
          message: "Meta source ad no longer references the expected creative.",
        },
        sourceIdentity: observedIdentity,
        responsePayload: { id: "source_ad_1" },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        newAdId: "ad_2",
        sourceIdentity: {
          adId: "source_ad_2",
          providerAccountId: "act_123",
          creativeId: "creative_2",
          observedAt: "2026-07-18T10:01:01.000Z",
        },
        verifiedStatus: "PAUSED",
      } as never);

    const response = await POST(
      request({ ...body(), idempotencyKey: "idem_source_drift" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(false);
    expect(payload.results[0]).toMatchObject({
      ok: false,
      sourceIdentity: observedIdentity,
      error: { code: "creative_identity_mismatch" },
    });
    expect(adsWrite.duplicateAd).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        adId: "source_ad_1",
        expectedSourceCreativeId: "creative_1",
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadResponse: expect.objectContaining({
          source_identity: observedIdentity,
        }),
      }),
    );
    expect(intentStore.recordMetaLaunchIntentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        errorReceipt: expect.objectContaining({
          partialResult: expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                creativeId: "creative_1",
                sourceIdentity: observedIdentity,
                error: expect.objectContaining({
                  code: "creative_identity_mismatch",
                }),
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("blocks on fresh provider source or hierarchy proof before any mutation", async () => {
    vi.mocked(
      validation.validateMetaAddToExistingLiveProviderPreflight,
    ).mockResolvedValue({
      ok: false,
      blockers: [
        {
          code: "target_campaign_not_active",
          message: "Target campaign must be fully ACTIVE.",
        },
      ],
      checks: [
        {
          kind: "target_campaign",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
        },
      ],
    });

    const response = await POST(
      request({ ...body(), idempotencyKey: "idem_provider_drift" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("provider_preflight_blocked");
    expect(payload.blockers).toEqual([
      expect.objectContaining({ code: "target_campaign_not_active" }),
    ]);
    expect(adsWrite.duplicateAd).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(intentStore.recordMetaLaunchIntentValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: expect.objectContaining({
          ok: false,
          checks: expect.arrayContaining([
            expect.objectContaining({ kind: "target_campaign" }),
          ]),
          executionAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
          requestFingerprint: "fingerprint_1",
        }),
      }),
    );
  });

  it("halts after the first definite provider failure and omits later creates", async () => {
    const mutationAttempt = {
      attemptCount: 1 as const,
      method: "POST" as const,
      path: "act_123/ads",
      attemptedAt: "2026-07-18T15:00:00.000Z",
      completedAt: "2026-07-18T15:00:01.000Z",
      providerResponseReceived: true,
      httpStatus: 400,
      outcome: "provider_response_received" as const,
      automaticRetryAttempted: false as const,
      transportError: null,
    };
    vi.mocked(adsWrite.duplicateAd)
      .mockReset()
      .mockResolvedValueOnce({
        ok: false,
        httpStatus: 400,
        providerOutcome: "definite_failure",
        mutationAttempt,
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

    expect(response.status).toBe(502);
    expect(payload.ok).toBe(false);
    expect(payload.failedCount).toBe(1);
    expect(payload.successCount).toBe(0);
    expect(payload.halted).toBe(true);
    expect(payload.haltedReason).toEqual({
      code: "100",
      message: "Invalid creative.",
    });
    expect(payload.omittedCount).toBe(1);
    expect(payload.results).toEqual([
      {
        creativeId: "creative_1",
        targetCampaignId: "cmp_1",
        targetAdsetId: "adset_1",
        ok: false,
        providerOutcome: "definite_failure",
        mutationAttempt,
        error: { code: "100", message: "Invalid creative." },
      },
    ]);
    expect(payload.steps[0]).toMatchObject({
      status: "failure",
      id: "ad_partial_1",
      adsManagerUrl:
        "https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=123&selected_ad_ids=ad_partial_1",
    });
    expect(adsWrite.duplicateAd).toHaveBeenCalledTimes(1);
  });

  it("halts on an ambiguous ad POST and preserves the LaunchIntent attempt receipt", async () => {
    const mutationAttempt = {
      attemptCount: 1 as const,
      method: "POST" as const,
      path: "act_123/ads",
      attemptedAt: "2026-07-18T15:00:00.000Z",
      completedAt: "2026-07-18T15:00:01.000Z",
      providerResponseReceived: false,
      httpStatus: null,
      outcome: "outcome_ambiguous" as const,
      automaticRetryAttempted: false as const,
      transportError: {
        code: "network_error",
        message: "connection closed after request upload",
      },
    };
    vi.mocked(adsWrite.duplicateAd)
      .mockReset()
      .mockResolvedValueOnce({
        ok: false,
        httpStatus: 502,
        providerOutcome: "outcome_ambiguous",
        error: {
          code: "provider_outcome_ambiguous",
          message:
            "The provider outcome is unknown; reconcile before another write.",
        },
        mutationAttempt,
        sourceIdentity: {
          adId: "source_ad_1",
          providerAccountId: "act_123",
          creativeId: "creative_1",
          observedAt: "2026-07-18T15:00:00.000Z",
        },
        responsePayload: {
          provider_outcome: "outcome_ambiguous",
          mutation_attempt: mutationAttempt,
          reconciliation_required: true,
          retry_disposition:
            "do_not_retry_before_exact_provider_reconciliation",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        newAdId: "must_not_be_created",
        sourceIdentity: {
          adId: "source_ad_2",
          providerAccountId: "act_123",
          creativeId: "creative_2",
          observedAt: "2026-07-18T15:00:00.000Z",
        },
        verifiedStatus: "PAUSED",
      } as never);

    const response = await POST(
      request({ ...body(), idempotencyKey: "idem_ambiguous" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      launchIntentStatus: "silent_failure",
      haltedReason: { code: "provider_outcome_ambiguous" },
      results: [
        {
          creativeId: "creative_1",
          ok: false,
          providerOutcome: "outcome_ambiguous",
          mutationAttempt,
          retryAllowed: false,
          error: { code: "provider_outcome_ambiguous" },
        },
      ],
      steps: [
        {
          kind: "ad",
          status: "silent_failure",
          providerOutcome: "outcome_ambiguous",
          mutationAttempt,
          retryAllowed: false,
        },
      ],
    });
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "silent_failure",
        errorCode: "provider_outcome_ambiguous",
        payloadResponse: expect.objectContaining({
          provider_payload: expect.objectContaining({
            provider_outcome: "outcome_ambiguous",
          }),
        }),
      }),
    );
    expect(intentStore.recordMetaLaunchIntentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "silent_failure",
        errorReceipt: expect.objectContaining({
          code: "provider_outcome_ambiguous",
          recovery: {
            rollbackSupported: false,
            retrySupported: false,
          },
          partialResult: expect.objectContaining({
            steps: [
              expect.objectContaining({
                providerOutcome: "outcome_ambiguous",
                mutationAttempt,
                retryAllowed: false,
              }),
            ],
          }),
        }),
      }),
    );
    expect(adsWrite.duplicateAd).toHaveBeenCalledTimes(1);
  });

  it("passes duplicate copy mode through to Meta write helper", async () => {
    const response = await POST(request({ ...body(), idempotencyKey: "idem_reuse", copyMode: "reuse_creative" }));

    expect(response.status).toBe(200);
    expect(adsWrite.duplicateAd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ copyMode: "reuse_creative" }),
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadRequest: expect.objectContaining({
          body: expect.objectContaining({ copy_mode: "reuse_creative" }),
        }),
      }),
    );
  });

  it("creates ads across multiple selected targets in one provider account", async () => {
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
          providerAccountId: "act_123",
        },
      ],
      creatives: [
        { creativeId: "creative_1", creativeName: "Creative 1", effectiveStatus: "ACTIVE", sourceAdId: "source_ad_1", providerAccountId: "act_123" },
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
      expect.objectContaining({ targetAdsetId: "adset_1", copyMode: "reuse_creative" }),
    );
    expect(adsWrite.duplicateAd).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerAccountId: "act_123" }),
      expect.objectContaining({ targetAdsetId: "adset_2", copyMode: "reuse_creative" }),
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

  it("halts remaining provider writes when the kill switch engages mid-launch", async () => {
    vi.mocked(adsWrite.duplicateAd)
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        newAdId: "ad_1",
        verifiedStatus: "PAUSED",
      } as never)
      .mockResolvedValueOnce({
        ok: false,
        httpStatus: 503,
        error: {
          code: "kill_switch_engaged",
          message: "Owner stopped Meta writes.",
        },
      } as never);

    const response = await POST(
      request({ ...body(), idempotencyKey: "idem_mid_kill" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      haltedReason: { code: "kill_switch_engaged" },
      launchIntentStatus: "partially_succeeded",
    });
    expect(adsWrite.duplicateAd).toHaveBeenCalledTimes(2);
    expect(intentStore.recordMetaLaunchIntentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "partially_succeeded",
        errorReceipt: expect.objectContaining({ code: "kill_switch_engaged" }),
      }),
    );
  });

  it("blocks add-to-existing writes before pending checks, validation, or Meta writes", async () => {
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
    expect(actionLog.hasRecentPendingMetaAddToExistingAction).not.toHaveBeenCalled();
    expect(validation.validateMetaAddToExistingRequest).not.toHaveBeenCalled();
    expect(validation.resolveMetaLaunchWriteContext).not.toHaveBeenCalled();
    expect(adsWrite.duplicateAd).not.toHaveBeenCalled();
  });

  it("blocks before intent preparation or provider writes when the intent migration is missing", async () => {
    vi.mocked(intentCapability.getMetaLaunchIntentCapability).mockResolvedValue({
      status: "migration_required",
      canRead: false,
      canWrite: false,
      missingTables: ["meta_launch_intents"],
      checkedAt: "2026-07-11T00:00:00.000Z",
    });

    const response = await POST(request({ ...body(), idempotencyKey: "idem_missing" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "launch_intent_migration_required" },
    });
    expect(intentService.prepareMetaLaunchIntentForExecution).not.toHaveBeenCalled();
    expect(adsWrite.duplicateAd).not.toHaveBeenCalled();
  });
});
