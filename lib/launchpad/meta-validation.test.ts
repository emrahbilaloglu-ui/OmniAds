import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateMetaBulkResumePreflight,
  type MetaBulkResumePreflightTarget,
} from "@/lib/launchpad/meta-validation";
import type { MetaAdsWriteContext } from "@/lib/meta/ads-write";

const ctx: MetaAdsWriteContext = {
  businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  providerAccountId: "act_123",
  accessToken: "secret-token",
};

const target: MetaBulkResumePreflightTarget = {
  adId: "ad_1",
  creativeId: "creative_1",
  providerAccountId: "act_123",
};

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
          promoted_object: { pixel_id: "pixel_1" },
        }),
      );

    const result = await validateMetaBulkResumePreflight({
      ctx,
      targets: [target],
    });

    expect(result).toEqual({ ok: true, blockers: [] });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
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
          promoted_object: { pixel_id: "pixel_1" },
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
        "pixel_not_active",
      ]),
    );
  });
});
