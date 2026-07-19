import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  duplicateAd,
  META_ADS_PROVIDER_FETCH_TIMEOUT_MS,
  pauseAd,
  readMetaAdExecutionState,
  readMetaEntityExecutionState,
  resumeAd,
  resumeAdset,
  resumeCampaign,
  updateAdsetBidAmount,
  type MetaAdsWriteContext,
} from "@/lib/meta/ads-write";

vi.mock("@/lib/meta/automation-control-plane", () => ({
  getMetaWriteBlockState: vi.fn(),
}));

const controlPlane = await import("@/lib/meta/automation-control-plane");

const ctx: MetaAdsWriteContext = {
  businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  providerAccountId: "act_123",
  accessToken: "secret-token",
};

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

function exactAdExecutionResponse(
  overrides: {
    adId?: string;
    accountId?: string;
    creativeId?: string;
    campaignId?: string;
    adsetId?: string;
    status?: string;
    effectiveStatus?: string;
    campaignStatus?: string;
    campaignEffectiveStatus?: string;
    adsetStatus?: string;
    adsetEffectiveStatus?: string;
  } = {},
) {
  const status = overrides.status ?? "ACTIVE";
  return jsonResponse({
    id: overrides.adId ?? "ad_1",
    account_id: overrides.accountId ?? "123",
    creative: { id: overrides.creativeId ?? "creative_1" },
    status,
    effective_status: overrides.effectiveStatus ?? status,
    campaign: {
      id: overrides.campaignId ?? "campaign_1",
      status: overrides.campaignStatus ?? "ACTIVE",
      effective_status: overrides.campaignEffectiveStatus ?? "ACTIVE",
    },
    adset: {
      id: overrides.adsetId ?? "adset_1",
      status: overrides.adsetStatus ?? "ACTIVE",
      effective_status: overrides.adsetEffectiveStatus ?? "ACTIVE",
    },
  });
}

describe("Meta ads write client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({
      blocked: false,
      reason: null,
      message: null,
    });
  });

  it("pauseAd returns verified live success with its exact POST attempt receipt", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        exactAdExecutionResponse({ status: "PAUSED" }),
      );

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: true,
      verifiedStatus: "PAUSED",
      providerHttpStatus: 200,
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        path: "ad_1",
        providerResponseReceived: true,
        providerResponseSuccessful: true,
        httpStatus: 200,
        outcome: "provider_response_received",
        automaticRetryAttempted: false,
        transportError: null,
      },
    });
    if (!result.ok) throw new Error("Expected exact verified status success.");
    expect(result.verificationPayload).toEqual({
      contractVersion: "meta-ad-status-write-verification.v1",
      adId: "ad_1",
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
      providerGetEvidence: {
        id: "ad_1",
        account_id: "123",
        creative: { id: "creative_1" },
        status: "PAUSED",
        effective_status: "PAUSED",
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
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v22.0/ad_1?");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("access_token=secret-token");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "GET" });
  });

  it("runs the durable-attempt hook with the exact frozen hierarchy immediately before the POST", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        exactAdExecutionResponse({ status: "PAUSED" }),
      );
    const beforeMutationAttempt = vi.fn(async () => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    });

    const result = await pauseAd(ctx, "ad_1", {
      beforeMutationAttempt,
    });

    expect(result).toMatchObject({ ok: true, verifiedStatus: "PAUSED" });
    expect(beforeMutationAttempt).toHaveBeenCalledTimes(1);
    expect(beforeMutationAttempt).toHaveBeenCalledWith({
      businessId: ctx.businessId,
      providerAccountId: ctx.providerAccountId,
      adId: "ad_1",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      adsetId: "adset_1",
    });
    expect(beforeMutationAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[1]!,
    );
  });

  it("does not run the durable-attempt hook when the immediate status precondition blocks the POST", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      exactAdExecutionResponse({ status: "PAUSED" }),
    );
    const beforeMutationAttempt = vi.fn(async () => undefined);

    const result = await pauseAd(ctx, "ad_1", {
      beforeMutationAttempt,
    });

    expect(result).toMatchObject({
      ok: false,
      providerMutationAttempted: false,
      error: { code: "ad_status_already_requested" },
    });
    expect(beforeMutationAttempt).not.toHaveBeenCalled();
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("does not run the durable-attempt hook when the final control-plane check blocks the POST", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(exactAdExecutionResponse());
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({
      blocked: true,
      reason: "business_kill_switch",
      message: "Writes are blocked.",
    });
    const beforeMutationAttempt = vi.fn(async () => undefined);

    const result = await pauseAd(ctx, "ad_1", {
      beforeMutationAttempt,
    });

    expect(result).toMatchObject({
      ok: false,
      providerMutationAttempted: false,
      error: { code: "kill_switch_engaged" },
    });
    expect(beforeMutationAttempt).not.toHaveBeenCalled();
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("fails before the provider POST when durable-attempt persistence rejects", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(exactAdExecutionResponse());
    const beforeMutationAttempt = vi
      .fn()
      .mockRejectedValue(new Error("attempt journal unavailable"));

    const result = await pauseAd(ctx, "ad_1", {
      beforeMutationAttempt,
    });

    expect(result).toMatchObject({
      ok: false,
      providerMutationAttempted: false,
      error: {
        code: "before_mutation_attempt_failed",
        message: "attempt journal unavailable",
      },
    });
    expect(result).not.toHaveProperty("mutationAttempt");
    expect(beforeMutationAttempt).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("reads current ad execution state with its exact parsed provider evidence", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "ad_1",
        creative: { id: "creative_1" },
        status: "ACTIVE",
        effective_status: "ACTIVE",
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

    const result = await readMetaAdExecutionState(ctx, "ad_1");

    expect(result).toMatchObject({
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
      providerGetEvidence: {
        id: "ad_1",
        account_id: "123",
        creative: { id: "creative_1" },
        status: "ACTIVE",
        effective_status: "ACTIVE",
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
      },
    });
    if (!result.ok) throw new Error("Expected exact provider state evidence.");
    const providerGet = result.providerGetEvidence as {
      id: string;
      account_id: string;
      status: string;
      effective_status: string;
      creative: { id: string };
      campaign: { id: string };
      adset: { id: string };
    };
    expect(result.adId).toBe(providerGet.id);
    expect(result.providerAccountId).toBe(`act_${providerGet.account_id}`);
    expect(result.configuredStatus).toBe(providerGet.status);
    expect(result.effectiveStatus).toBe(providerGet.effective_status);
    expect(result.creativeId).toBe(providerGet.creative.id);
    expect(result.campaignId).toBe(providerGet.campaign.id);
    expect(result.adsetId).toBe(providerGet.adset.id);
    expect(JSON.stringify(result.providerGetEvidence)).not.toContain(
      "secret-token",
    );
    expect(JSON.stringify(result.providerGetEvidence)).not.toContain(
      "graph.facebook.com",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("marks provider policy states ineligible for exact execution", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: "ad_1",
        status: "ACTIVE",
        effective_status: "DISAPPROVED",
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

    await expect(readMetaAdExecutionState(ctx, "ad_1")).resolves.toMatchObject({
      ok: true,
      policyEligible: false,
      reviewStatus: "DISAPPROVED",
    });
  });

  it("classifies transient provider reads as retryable preflight evidence", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(
      new Error(
        "connection reset access_token=secret-token Bearer provider-secret",
      ),
    );

    const result = await readMetaAdExecutionState(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      adId: "ad_1",
      httpStatus: null,
      preflightBlocker: "current_ad_state_unverified",
      error: {
        code: "network_error",
        message:
          "connection reset access_token=[redacted] Bearer [redacted]",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("bounds current-state GETs and fails closed when the provider times out", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    vi.mocked(fetch).mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const resultPromise = readMetaAdExecutionState(ctx, "ad_1");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      adId: "ad_1",
      httpStatus: null,
      preflightBlocker: "current_ad_state_unverified",
      error: {
        code: "network_error",
        message: `Meta provider GET timed out after ${META_ADS_PROVIDER_FETCH_TIMEOUT_MS}ms.`,
      },
    });
    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(
      META_ADS_PROVIDER_FETCH_TIMEOUT_MS,
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBe(
      controller.signal,
    );
  });

  it.each([
    {
      name: "deleted object",
      response: jsonResponse(
        { error: { code: 100, message: "Unsupported get request." } },
        { status: 404 },
      ),
      blocker: "ad_not_found",
    },
    {
      name: "expired token",
      response: jsonResponse(
        { error: { code: 190, message: "Invalid OAuth access token." } },
        { status: 400 },
      ),
      blocker: "meta_account_unresolved",
    },
    {
      name: "other permanent request rejection",
      response: jsonResponse(
        { error: { code: 10, message: "Application does not have permission." } },
        { status: 400 },
      ),
      blocker: "current_ad_state_rejected",
    },
  ])("preserves $name as a non-retryable preflight blocker", async ({ response, blocker }) => {
    vi.mocked(fetch).mockResolvedValueOnce(response);

    await expect(readMetaAdExecutionState(ctx, "ad_1")).resolves.toMatchObject({
      ok: false,
      adId: "ad_1",
      preflightBlocker: blocker,
    });
  });

  it("preserves provider identity mismatches as a hard preflight blocker", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ id: "ad_other", status: "ACTIVE", effective_status: "ACTIVE" }),
    );

    await expect(readMetaAdExecutionState(ctx, "ad_1")).resolves.toMatchObject({
      ok: false,
      adId: "ad_other",
      httpStatus: 200,
      preflightBlocker: "ad_identity_mismatch",
    });
  });

  it.each([
    {
      accountId: "",
      blocker: "meta_account_unresolved",
      code: "meta_account_unresolved",
    },
    {
      accountId: "999",
      blocker: "provider_account_mismatch",
      code: "provider_account_mismatch",
    },
  ])(
    "fails closed when the live ad account identity is '$accountId'",
    async ({ accountId, blocker, code }) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          account_id: accountId,
          status: "ACTIVE",
          effective_status: "ACTIVE",
          creative: { id: "creative_1" },
        }),
      );

      await expect(readMetaAdExecutionState(ctx, "ad_1")).resolves.toMatchObject({
        ok: false,
        preflightBlocker: blocker,
        error: { code },
      });
    },
  );

  it("reads an ad set with exact provider and active campaign hierarchy", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "adset_1",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          campaign: { id: "campaign_1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "campaign_1",
          status: "ACTIVE",
          effective_status: "ACTIVE",
        }),
      );

    await expect(
      readMetaEntityExecutionState(ctx, "adset", "adset_1"),
    ).resolves.toMatchObject({
      ok: true,
      entityId: "adset_1",
      providerAccountId: "act_123",
      campaignId: "campaign_1",
      campaignProviderAccountId: "act_123",
    });
  });

  it("resumeAd returns success only with exact ACTIVE ad and hierarchy proof", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        exactAdExecutionResponse({ status: "PAUSED" }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(exactAdExecutionResponse());

    await expect(resumeAd(ctx, "ad_1")).resolves.toMatchObject({
      ok: true,
      verifiedStatus: "ACTIVE",
      verificationPayload: {
        contractVersion: "meta-ad-status-write-verification.v1",
        adId: "ad_1",
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
        providerGetEvidence: expect.any(Object),
      },
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it.each([
    {
      name: "pause",
      currentStatus: "PAUSED",
      run: () => pauseAd(ctx, "ad_1"),
    },
    {
      name: "resume",
      currentStatus: "ACTIVE",
      run: () => resumeAd(ctx, "ad_1"),
    },
  ])(
    "blocks an already-requested $name state before any provider POST",
    async ({ currentStatus, run }) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        exactAdExecutionResponse({ status: currentStatus }),
      );

      const result = await run();

      expect(result).toMatchObject({
        ok: false,
        httpStatus: 409,
        error: { code: "ad_status_already_requested" },
        responsePayload: null,
        verificationPayload: {
          verificationFailureReason: "already_requested_state",
          observedExecutionState: {
            configuredStatus: currentStatus,
            effectiveStatus: currentStatus,
            providerGetEvidence: expect.any(Object),
          },
        },
      });
      expect(result).not.toHaveProperty("mutationAttempt");
      expect(result).not.toHaveProperty("providerHttpStatus");
      expect(
        vi.mocked(fetch).mock.calls.filter(
          ([, init]) => init?.method === "POST",
        ),
      ).toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "configured",
      before: { status: "PAUSED", effectiveStatus: "ACTIVE" },
      reason: "configured_status_precondition_failed",
    },
    {
      name: "effective",
      before: { status: "ACTIVE", effectiveStatus: "PAUSED" },
      reason: "effective_status_precondition_failed",
    },
  ])(
    "blocks a $name/effective transition mismatch before any provider POST",
    async ({ before, reason }) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        exactAdExecutionResponse(before),
      );

      const result = await pauseAd(ctx, "ad_1");

      expect(result).toMatchObject({
        ok: false,
        httpStatus: 409,
        error: { code: "ad_status_precondition_failed" },
        verificationPayload: {
          verificationFailureReason: reason,
        },
      });
      expect(result).not.toHaveProperty("mutationAttempt");
      expect(
        vi.mocked(fetch).mock.calls.filter(
          ([, init]) => init?.method === "POST",
        ),
      ).toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "campaign configured",
      before: { campaignStatus: "PAUSED" },
      code: "campaign_status_precondition_failed",
      reason: "campaign_configured_status_not_active",
    },
    {
      name: "campaign effective",
      before: { campaignEffectiveStatus: "PAUSED" },
      code: "campaign_status_precondition_failed",
      reason: "campaign_effective_status_not_active",
    },
    {
      name: "ad set configured",
      before: { adsetStatus: "PAUSED" },
      code: "adset_status_precondition_failed",
      reason: "adset_configured_status_not_active",
    },
    {
      name: "ad set effective",
      before: { adsetEffectiveStatus: "PAUSED" },
      code: "adset_status_precondition_failed",
      reason: "adset_effective_status_not_active",
    },
  ])(
    "blocks a paused $name before any provider POST",
    async ({ before, code, reason }) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        exactAdExecutionResponse(before),
      );

      const result = await pauseAd(ctx, "ad_1");

      expect(result).toMatchObject({
        ok: false,
        httpStatus: 409,
        error: { code },
        verificationPayload: {
          verificationFailureReason: reason,
        },
      });
      expect(result).not.toHaveProperty("mutationAttempt");
      expect(
        vi.mocked(fetch).mock.calls.filter(
          ([, init]) => init?.method === "POST",
        ),
      ).toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("blocks policy and review ineligibility before any provider POST", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      exactAdExecutionResponse({
        status: "ACTIVE",
        effectiveStatus: "DISAPPROVED",
      }),
    );

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      error: { code: "ad_policy_precondition_failed" },
      verificationPayload: {
        verificationFailureReason: "policy_not_eligible",
        observedExecutionState: {
          policyEligible: false,
          reviewStatus: "DISAPPROVED",
        },
      },
    });
    expect(result).not.toHaveProperty("mutationAttempt");
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "campaign effective status",
      after: { status: "PAUSED", campaignEffectiveStatus: "PAUSED" },
      reason: "campaign_effective_status_not_active",
    },
    {
      name: "ad set effective status",
      after: { status: "PAUSED", adsetEffectiveStatus: "PAUSED" },
      reason: "adset_effective_status_not_active",
    },
  ])(
    "rejects provider success when $name drifts",
    async ({ after, reason }) => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(exactAdExecutionResponse())
        .mockResolvedValueOnce(jsonResponse({ success: true }))
        .mockResolvedValueOnce(exactAdExecutionResponse(after));

      const result = await pauseAd(ctx, "ad_1");

      expect(result).toMatchObject({
        ok: false,
        providerOutcome: "definite_failure",
        error: { code: "silent_failure" },
        mutationAttempt: { providerResponseSuccessful: true },
        verificationPayload: {
          verificationFailureReason: reason,
          observedExecutionState: {
            configuredStatus: "PAUSED",
            policyEligible: true,
            reviewStatus: null,
            providerGetEvidence: expect.any(Object),
          },
        },
      });
      expect(
        vi.mocked(fetch).mock.calls.filter(
          ([, init]) => init?.method === "POST",
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    {
      name: "creative",
      after: { status: "PAUSED", creativeId: "creative_drifted" },
      reason: "creativeId_drift",
    },
    {
      name: "campaign",
      after: { status: "PAUSED", campaignId: "campaign_drifted" },
      reason: "campaignId_drift",
    },
    {
      name: "ad set",
      after: { status: "PAUSED", adsetId: "adset_drifted" },
      reason: "adsetId_drift",
    },
  ])(
    "rejects provider success when the $name identity changes across the POST",
    async ({ after, reason }) => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(exactAdExecutionResponse())
        .mockResolvedValueOnce(jsonResponse({ success: true }))
        .mockResolvedValueOnce(exactAdExecutionResponse(after));

      await expect(pauseAd(ctx, "ad_1")).resolves.toMatchObject({
        ok: false,
        providerOutcome: "definite_failure",
        error: { code: "silent_failure" },
        mutationAttempt: { providerResponseSuccessful: true },
        verificationPayload: {
          verificationFailureReason: reason,
          observedExecutionState: {
            providerGetEvidence: expect.any(Object),
          },
        },
      });
      expect(
        vi.mocked(fetch).mock.calls.filter(
          ([, init]) => init?.method === "POST",
        ),
      ).toHaveLength(1);
    },
  );

  it("rejects provider success when configured and effective ad status diverge", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        exactAdExecutionResponse({
          status: "PAUSED",
          effectiveStatus: "ACTIVE",
        }),
      );

    await expect(pauseAd(ctx, "ad_1")).resolves.toMatchObject({
      ok: false,
      providerOutcome: "definite_failure",
      error: { code: "silent_failure" },
      verificationPayload: {
        verificationFailureReason: "effective_status_mismatch",
      },
    });
  });

  it("rejects provider success when policy or review state is not eligible", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        exactAdExecutionResponse({
          status: "PAUSED",
          effectiveStatus: "DISAPPROVED",
        }),
      );

    await expect(pauseAd(ctx, "ad_1")).resolves.toMatchObject({
      ok: false,
      providerOutcome: "definite_failure",
      error: { code: "silent_failure" },
      verificationPayload: {
        observedExecutionState: {
          policyEligible: false,
          reviewStatus: "DISAPPROVED",
        },
      },
    });
  });

  it("rejects provider success when a required post-write GET field is missing", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          creative: { id: "creative_1" },
          status: "PAUSED",
          effective_status: "PAUSED",
          campaign: {
            id: "campaign_1",
            status: "ACTIVE",
          },
          adset: {
            id: "adset_1",
            status: "ACTIVE",
            effective_status: "ACTIVE",
          },
        }),
      );

    await expect(pauseAd(ctx, "ad_1")).resolves.toMatchObject({
      ok: false,
      providerOutcome: "definite_failure",
      error: { code: "verification_failed" },
      verificationPayload: {
        verificationFailureReason: "missing_campaignEffectiveStatus",
        observedExecutionState: {
          providerGetEvidence: {
            campaign: {
              id: "campaign_1",
              status: "ACTIVE",
            },
          },
        },
      },
    });
  });

  it("bounds the post-write verification GET and never retries the POST", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("missing abort signal"));
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      );

    const resultPromise = pauseAd(ctx, "ad_1");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    controller.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      providerOutcome: "definite_failure",
      error: {
        code: "network_error",
        message: `Meta provider GET timed out after ${META_ADS_PROVIDER_FETCH_TIMEOUT_MS}ms.`,
      },
      mutationAttempt: {
        providerResponseSuccessful: true,
        automaticRetryAttempted: false,
      },
      verificationPayload: {
        verificationFailureReason: "current_ad_state_unverified",
      },
    });
    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("pauseAd returns silent_failure when verification shows unchanged status", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(exactAdExecutionResponse());

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      error: { code: "silent_failure" },
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        providerResponseReceived: true,
        providerResponseSuccessful: true,
        httpStatus: 200,
      },
    });
  });

  it("retains the successful status POST receipt when verification GET fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockRejectedValueOnce(new Error("verification connection reset"));

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      providerOutcome: "definite_failure",
      error: {
        code: "network_error",
        message: "verification connection reset",
      },
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        path: "ad_1",
        providerResponseReceived: true,
        providerResponseSuccessful: true,
        httpStatus: 200,
        outcome: "provider_response_received",
        automaticRetryAttempted: false,
        transportError: null,
      },
      responsePayload: { success: true },
      verificationPayload: {
        verificationFailureReason: "current_ad_state_unverified",
      },
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("treats a status POST timeout as one ambiguous mutation attempt without retry", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("missing abort signal"));
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      );

    const resultPromise = pauseAd(ctx, "ad_1");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const result = await resultPromise;

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      providerOutcome: "outcome_ambiguous",
      error: {
        code: "provider_outcome_ambiguous",
      },
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        path: "ad_1",
        providerResponseReceived: false,
        httpStatus: null,
        outcome: "outcome_ambiguous",
        automaticRetryAttempted: false,
        transportError: {
          code: "network_error",
          message: `Meta provider POST timed out after ${META_ADS_PROVIDER_FETCH_TIMEOUT_MS}ms.`,
        },
      },
      responsePayload: {
        provider_outcome: "outcome_ambiguous",
        reconciliation_required: true,
        retry_disposition:
          "do_not_retry_before_exact_provider_reconciliation",
      },
    });
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenNthCalledWith(
      1,
      META_ADS_PROVIDER_FETCH_TIMEOUT_MS,
    );
    expect(timeoutSpy).toHaveBeenNthCalledWith(
      2,
      META_ADS_PROVIDER_FETCH_TIMEOUT_MS,
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses provider redirects so one logical mutation cannot become two POSTs", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockRejectedValueOnce(
        new TypeError("fetch failed because redirect mode is set to error"),
      );

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      providerOutcome: "outcome_ambiguous",
      error: { code: "provider_outcome_ambiguous" },
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        outcome: "outcome_ambiguous",
        automaticRetryAttempted: false,
      },
    });
    const postCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "POST");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("rejects a successful status response verified in another account", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        exactAdExecutionResponse({
          accountId: "999",
          status: "PAUSED",
        }),
      );

    await expect(pauseAd(ctx, "ad_1")).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_account_mismatch" },
      mutationAttempt: {
        providerResponseSuccessful: true,
      },
    });
  });

  it("pauseAd returns Meta HTTP errors without post-write verification", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 190, message: "Invalid OAuth access token." } },
          { status: 400 },
        ),
      );

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 400,
      error: { code: "190", message: "Invalid OAuth access token." },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
    });
  });

  it("pauseAd dry-run verifies current state without issuing a POST", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "ad_1", status: "ACTIVE", effective_status: "ACTIVE" }),
    );

    const result = await pauseAd(ctx, "ad_1", { dryRun: true });

    expect(result).toMatchObject({
      ok: true,
      verifiedStatus: "PAUSED",
      dryRun: true,
      responsePayload: {
        dryRun: true,
        wouldHaveWritten: {
          method: "POST",
          path: "ad_1",
          body: { status: "PAUSED" },
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("kill switch blocks pauseAd without issuing HTTP", async () => {
    vi.stubEnv("META_ADS_WRITE_KILL_SWITCH", "1");

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 503,
      error: { code: "kill_switch_engaged" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry a status POST after Meta reports a request limit", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 17, message: "(#17) User request limit reached" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 429,
      error: { code: "rate_limited" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
    });
  });

  it("does not start a second POST attempt after a rate limit", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(exactAdExecutionResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 17, message: "(#17) User request limit reached" } },
          { status: 429 },
        ),
      );

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 429,
      error: {
        code: "rate_limited",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("resumeCampaign writes ACTIVE and verifies the campaign status", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "cmp_1", status: "ACTIVE", effective_status: "ACTIVE" }),
      );

    const result = await resumeCampaign(ctx, "cmp_1");

    expect(result).toMatchObject({ ok: true, verifiedStatus: "ACTIVE" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v22.0/cmp_1?");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect((fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams).get("status")).toBe("ACTIVE");
  });

  it("resumeCampaign returns silent_failure when verification does not reach ACTIVE", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "cmp_1", status: "PAUSED", effective_status: "PAUSED" }),
      );

    const result = await resumeCampaign(ctx, "cmp_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      error: { code: "silent_failure" },
    });
  });

  it("resumeAdset writes ACTIVE and verifies the ad set status", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "adset_1", status: "ACTIVE", effective_status: "ACTIVE" }),
      );

    const result = await resumeAdset(ctx, "adset_1");

    expect(result).toMatchObject({ ok: true, verifiedStatus: "ACTIVE" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v22.0/adset_1?");
    expect((fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams).get("status")).toBe("ACTIVE");
  });

  it("resumeAdset returns silent_failure when verification does not reach ACTIVE", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "adset_1", status: "PAUSED", effective_status: "PAUSED" }),
      );

    const result = await resumeAdset(ctx, "adset_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      error: { code: "silent_failure" },
    });
  });

  it("updateAdsetBidAmount dry-run verifies current bid without issuing a POST", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "adset_1",
        name: "Adset",
        bid_amount: 1800,
        bid_strategy: "COST_CAP",
        status: "ACTIVE",
        effective_status: "ACTIVE",
      }),
    );

    const result = await updateAdsetBidAmount(ctx, {
      adsetId: "adset_1",
      bidAmountMinor: 2200,
      dryRun: true,
    });

    expect(result).toMatchObject({
      ok: true,
      verifiedBidAmount: 2200,
      dryRun: true,
      responsePayload: {
        dryRun: true,
        wouldHaveWritten: {
          method: "POST",
          path: "adset_1",
          body: { bid_amount: 2200 },
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("duplicateAd dry-run returns a non-actionable preview without creating an ad", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "ad_1",
        name: "Source Ad",
        adset_id: "adset_1",
        creative: { id: "creative_1" },
      }),
    );

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
      dryRun: true,
    });

    expect(result).toMatchObject({
      ok: true,
      newAdId: null,
      dryRun: true,
      wouldHaveWritten: {
        method: "POST",
        path: "act_123/ads",
      },
      responsePayload: {
        dryRun: true,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("duplicateAd manually rebuilds the ad and verifies status, ad set, and creative", async () => {
    const trackingSpecs = [
      { "action.type": ["offsite_conversion"], fb_pixel: ["pixel_1"] },
    ];
    const conversionSpecs = [
      { "action.type": ["offsite_conversion"], fb_pixel: ["pixel_1"] },
    ];
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
          tracking_specs: trackingSpecs,
          conversion_specs: conversionSpecs,
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
          tracking_specs: trackingSpecs,
          conversion_specs: conversionSpecs,
        }),
      );

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
    });

    expect(result).toMatchObject({
      ok: true,
      newAdId: "ad_copy_1",
      verifiedStatus: "PAUSED",
    });
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "/v22.0/ad_1?",
    );
    const sourceUrl = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(sourceUrl.searchParams.get("fields")).not.toContain("tracking_specs");
    expect(sourceUrl.searchParams.get("fields")).not.toContain("conversion_specs");
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain(
      "/v22.0/act_123/ads?",
    );
    const body = vi.mocked(fetch).mock.calls[1]?.[1]?.body as URLSearchParams;
    expect(body.get("name")).toBe("Source Ad (copy)");
    expect(body.get("adset_id")).toBe("adset_2");
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("creative")).toBe(JSON.stringify({ creative_id: "creative_1" }));
    expect(body.get("tracking_specs")).toBeNull();
    expect(body.get("conversion_specs")).toBeNull();
  });

  it("retains the duplicate-ad POST receipt when Meta omits the new ad id", async () => {
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

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "silent_failure" },
      sourceIdentity: {
        adId: "ad_1",
        providerAccountId: "act_123",
        creativeId: "creative_1",
      },
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        path: "act_123/ads",
        providerResponseSuccessful: true,
        httpStatus: 200,
      },
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("duplicateAd can recreate the creative in the target account before creating the ad", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: {
            id: "creative_1",
            name: "Source Creative",
            object_story_spec: {
              page_id: "page_1",
              link_data: {
                link: "https://example.com/products/a",
                message: "Primary text",
                name: "Headline",
                description: "Description",
                picture: "https://cdn.example.com/image.jpg",
                call_to_action: {
                  type: "SHOP_NOW",
                  value: { link: "https://example.com/products/a" },
                },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          images: {
            "https://cdn.example.com/image.jpg": { hash: "target_hash_1" },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "creative_copy_1" }))
      .mockResolvedValueOnce(jsonResponse({ id: "ad_copy_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_copy_1",
          status: "PAUSED",
          effective_status: "PAUSED",
          adset_id: "adset_2",
          creative: { id: "creative_copy_1" },
        }),
      );

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
      name: "Source Ad added",
      copyMode: "rebuild_creative",
    });

    expect(result).toMatchObject({
      ok: true,
      newAdId: "ad_copy_1",
      newCreativeId: "creative_copy_1",
      verifiedStatus: "PAUSED",
    });
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain(
      "/v22.0/act_123/adimages?",
    );
    expect(String(vi.mocked(fetch).mock.calls[2]?.[0])).toContain(
      "/v22.0/act_123/adcreatives?",
    );
    const creativeBody = vi.mocked(fetch).mock.calls[2]?.[1]?.body as URLSearchParams;
    expect(creativeBody.get("name")).toBe("Source Ad added creative");
    expect(JSON.parse(creativeBody.get("object_story_spec") ?? "{}")).toMatchObject({
      page_id: "page_1",
      link_data: {
        link: "https://example.com/products/a",
        message: "Primary text",
        name: "Headline",
        description: "Description",
        image_hash: "target_hash_1",
        call_to_action: {
          type: "SHOP_NOW",
          value: { link: "https://example.com/products/a" },
        },
      },
    });
    const adBody = vi.mocked(fetch).mock.calls[3]?.[1]?.body as URLSearchParams;
    expect(adBody.get("creative")).toBe(JSON.stringify({ creative_id: "creative_copy_1" }));
  });

  it("retains the creative POST receipt when Meta omits the recreated creative id", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: {
            id: "creative_1",
            object_story_id: "page_1_post_1",
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
      copyMode: "rebuild_creative",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "silent_failure" },
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        path: "act_123/adcreatives",
        providerResponseSuccessful: true,
        httpStatus: 200,
      },
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain(
      "/v22.0/act_123/adcreatives?",
    );
  });

  it("duplicateAd reports source_ad_fetch_failed when the source ad read fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 100, message: "Unsupported get request." } },
        { status: 404 },
      ),
    );

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 404,
      error: { code: "source_ad_fetch_failed" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("duplicateAd reports silent_failure when verification shows a different ad set", async () => {
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
          adset_id: "adset_other",
          creative: { id: "creative_1" },
        }),
      );

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      error: { code: "silent_failure" },
      resultingAdId: "ad_copy_1",
      mutationAttempt: {
        providerResponseSuccessful: true,
      },
    });
  });

  it("duplicateAd allows Meta to inherit or normalize tracking from the target ad set", async () => {
    const trackingSpecs = [
      { "action.type": ["offsite_conversion"], fb_pixel: ["pixel_1"] },
    ];
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
          tracking_specs: trackingSpecs,
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
          tracking_specs: [
            { "action.type": ["offsite_conversion"], fb_pixel: ["pixel_2"] },
          ],
        }),
      );

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
    });

    expect(result).toMatchObject({
      ok: true,
      newAdId: "ad_copy_1",
      verifiedStatus: "PAUSED",
    });
  });

  it("duplicateAd issues exactly one create POST after Meta rate limiting", async () => {
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
              code: 17,
              error_subcode: 2446079,
              message: "(#17) User request limit reached",
            },
          },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "must_not_be_created" }));

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
      expectedSourceCreativeId: "creative_1",
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 429,
      error: { code: "rate_limited" },
      sourceIdentity: {
        adId: "ad_1",
        providerAccountId: "act_123",
        creativeId: "creative_1",
      },
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("duplicateAd issues exactly one create POST after an ambiguous network failure", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          name: "Source Ad",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      )
      .mockRejectedValueOnce(new Error("connection closed after request upload"))
      .mockResolvedValueOnce(jsonResponse({ id: "must_not_be_created" }));

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
      expectedSourceCreativeId: "creative_1",
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      providerOutcome: "outcome_ambiguous",
      error: { code: "provider_outcome_ambiguous" },
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        providerResponseReceived: false,
        outcome: "outcome_ambiguous",
        automaticRetryAttempted: false,
        transportError: {
          code: "network_error",
          message: "connection closed after request upload",
        },
      },
      responsePayload: {
        provider_outcome: "outcome_ambiguous",
        reconciliation_required: true,
        retry_disposition:
          "do_not_retry_before_exact_provider_reconciliation",
      },
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("duplicateAd binds observed source drift and blocks before the create POST", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: "ad_1",
        name: "Source Ad",
        adset_id: "adset_1",
        creative: { id: "creative_drifted" },
      }),
    );

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
      expectedSourceCreativeId: "creative_1",
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      error: { code: "creative_identity_mismatch" },
      sourceIdentity: {
        adId: "ad_1",
        providerAccountId: "act_123",
        creativeId: "creative_drifted",
      },
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("duplicateAd hardcodes PAUSED for custom-name creates", async () => {
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

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
      name: "Custom copy",
    });

    expect(result).toMatchObject({
      ok: true,
      newAdId: "ad_copy_1",
      verifiedStatus: "PAUSED",
    });
    const body = vi.mocked(fetch).mock.calls[1]?.[1]?.body as URLSearchParams;
    expect(body.get("name")).toBe("Custom copy");
    expect(body.get("status")).toBe("PAUSED");
  });
});
