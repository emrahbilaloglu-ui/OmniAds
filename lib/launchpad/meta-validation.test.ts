import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateMetaAddToExistingLiveProviderPreflight,
  validateMetaBulkResumePreflight,
  type MetaBulkResumePreflightTarget,
} from "@/lib/launchpad/meta-validation";
import { normalizeMetaAddToExistingPayload } from "@/lib/launchpad/meta";
import {
  META_ADS_PROVIDER_FETCH_TIMEOUT_MS,
  type MetaAdsWriteContext,
} from "@/lib/meta/ads-write";

const ctx: MetaAdsWriteContext = {
  businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  providerAccountId: "act_123",
  accessToken: "secret-token",
  connectionGeneration: "1:connected",
};

const target: MetaBulkResumePreflightTarget = {
  adId: "ad_1",
  creativeId: "creative_1",
  providerAccountId: "act_123",
};

const addToExistingPayload = normalizeMetaAddToExistingPayload({
  mode: "add_to_existing",
  copyMode: "reuse_creative",
  targets: [
    {
      targetCampaignId: "campaign_1",
      targetAdsetId: "adset_1",
    },
  ],
  creativeIds: ["creative_1"],
  creatives: [
    {
      creativeId: "creative_1",
      sourceAdId: "source_ad_1",
    },
  ],
});

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("validateMetaBulkResumePreflight", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("accepts a Launchpad ad only when billing, pixel, creative, and parent are live", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ account_status: 1 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "pixel_1", is_unavailable: false }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          account_id: "123",
          status: "PAUSED",
          effective_status: "PAUSED",
          creative: { id: "creative_1" },
          adset_id: "adset_1",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "adset_1",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          campaign_id: "campaign_1",
          promoted_object: { pixel_id: "pixel_1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "campaign_1",
          status: "ACTIVE",
          effective_status: "ACTIVE",
        }),
      );

    const result = await validateMetaBulkResumePreflight({
      ctx,
      targets: [target],
    });

    expect(result).toEqual({ ok: true, blockers: [] });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(
      vi.mocked(fetch).mock.calls.every(([, init]) => init?.signal instanceof AbortSignal),
    ).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledTimes(5);
    expect(timeoutSpy).toHaveBeenCalledWith(META_ADS_PROVIDER_FETCH_TIMEOUT_MS);
  });

  it("fails closed when an account preflight GET exceeds the provider deadline", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.mocked(fetch).mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Timed out", "TimeoutError")),
            { once: true },
          );
        }),
    );

    const pending = validateMetaBulkResumePreflight({
      ctx,
      targets: [target],
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "account_preflight_failed",
      "target_account_unresolved",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      signal: controller.signal,
    });
  });

  it("fails closed on billing, creative, parent, and pixel drift", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ account_status: 2 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "pixel_old", is_unavailable: false }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          account_id: "123",
          status: "PAUSED",
          effective_status: "WITH_ISSUES",
          creative: { id: "creative_changed" },
          adset_id: "adset_1",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "adset_1",
          status: "PAUSED",
          effective_status: "CAMPAIGN_PAUSED",
          campaign_id: "campaign_1",
          promoted_object: { pixel_id: "pixel_1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "campaign_1",
          status: "PAUSED",
          effective_status: "PAUSED",
        }),
      );

    const result = await validateMetaBulkResumePreflight({
      ctx,
      targets: [target],
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "billing_not_ok",
        "creative_not_resumable",
        "creative_identity_mismatch",
        "parent_adset_not_active",
        "parent_campaign_not_active",
        "pixel_not_active",
      ]),
    );
  });
});

describe("validateMetaAddToExistingLiveProviderPreflight", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("proves exact source ad/creative and target account hierarchy with GET only", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "source_ad_1",
          account_id: "123",
          status: "PAUSED",
          effective_status: "CAMPAIGN_PAUSED",
          creative: { id: "creative_1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "creative_1", account_id: "123" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "adset_1",
          account_id: "123",
          campaign_id: "campaign_1",
          status: "ACTIVE",
          effective_status: "ACTIVE",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "campaign_1",
          account_id: "123",
          status: "ACTIVE",
          effective_status: "ACTIVE",
        }),
      );

    const result = await validateMetaAddToExistingLiveProviderPreflight({
      ctx,
      payload: addToExistingPayload,
    });

    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.checks.map((check) => check.kind)).toEqual([
      "source_ad",
      "source_creative",
      "target_adset",
      "target_campaign",
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(
      vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });

  it("fails closed on source identity/policy and target hierarchy drift", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: "source_ad_other",
          account_id: "999",
          status: "PAUSED",
          effective_status: "DISAPPROVED",
          creative: { id: "creative_other" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "creative_other", account_id: "999" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "adset_other",
          account_id: "999",
          campaign_id: "campaign_other",
          status: "PAUSED",
          effective_status: "CAMPAIGN_PAUSED",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "campaign_other",
          account_id: "999",
          status: "PAUSED",
          effective_status: "PAUSED",
        }),
      );

    const result = await validateMetaAddToExistingLiveProviderPreflight({
      ctx,
      payload: addToExistingPayload,
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "source_ad_identity_mismatch",
        "source_ad_account_mismatch",
        "source_creative_identity_mismatch",
        "source_ad_policy_ineligible",
        "source_creative_account_mismatch",
        "target_adset_identity_mismatch",
        "target_adset_account_mismatch",
        "target_campaign_identity_mismatch",
        "target_adset_not_active",
        "target_campaign_account_mismatch",
        "target_campaign_not_active",
      ]),
    );
  });

  it("treats any provider read failure as a blocker", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: "Temporary read failure" } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "adset_1",
          account_id: "123",
          campaign_id: "campaign_1",
          status: "ACTIVE",
          effective_status: "ACTIVE",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "campaign_1",
          account_id: "123",
          status: "ACTIVE",
          effective_status: "ACTIVE",
        }),
      );

    const result = await validateMetaAddToExistingLiveProviderPreflight({
      ctx,
      payload: addToExistingPayload,
    });

    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "source_ad_state_unverified" }),
      ]),
    );
  });
});
