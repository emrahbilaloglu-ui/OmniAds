import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  duplicateAd,
  pauseAd,
  readMetaAdExecutionState,
  resumeAdset,
  resumeCampaign,
  updateAdsetBidAmount,
  type MetaAdsWriteContext,
} from "@/lib/meta/ads-write";

vi.mock("@/lib/meta/automation-control-plane", () => ({
  getMetaWriteBlockState: vi.fn(),
}));

// Current-selection authority is re-read immediately before every provider
// POST, so these write-client tests must state which authority they run under.
// Default-admit here; the deselection and unknown-authority paths are proven in
// lib/meta/ads-action-selection.test.ts and
// lib/meta/write-authority-toctou.test.ts.
vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveMetaAccountAuthority: vi.fn(async () => ({
      state: "authorized",
      errorMessage: null,
    })),
  };
});

// The generation compare-and-set is now UNCONDITIONAL. It used to be skipped
// whenever a context omitted connectionGeneration, which is why these tests
// passed for so long without ever stating an authority: they were exercising
// the write path with the reconnect guard switched off. Default-admit here, as
// above; the refusal paths are proven in lib/meta/write-authority-toctou.test.ts.
vi.mock("@/lib/provider-write-authority", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertProviderWriteAuthorityUnchanged: vi.fn(async () => ({ ok: true })),
  };
});

const controlPlane = await import("@/lib/meta/automation-control-plane");

const ctx: MetaAdsWriteContext = {
  businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  providerAccountId: "act_123",
  accessToken: "secret-token",
  connectionGeneration: "1:connected",
};

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
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

  it("pauseAd writes status and verifies the ad status", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "ad_1", status: "PAUSED", effective_status: "PAUSED" }),
      );

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({ ok: true, verifiedStatus: "PAUSED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v22.0/ad_1?");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("access_token=secret-token");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("reads current ad execution state without issuing a provider write", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "ad_1",
        status: "ACTIVE",
        effective_status: "ACTIVE",
      }),
    );

    const result = await readMetaAdExecutionState(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: true,
      adId: "ad_1",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("marks provider policy states ineligible for exact execution", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: "ad_1",
        status: "ACTIVE",
        effective_status: "DISAPPROVED",
      }),
    );

    await expect(readMetaAdExecutionState(ctx, "ad_1")).resolves.toMatchObject({
      ok: true,
      policyEligible: false,
      reviewStatus: "DISAPPROVED",
    });
  });

  it("classifies transient provider reads as retryable preflight evidence", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("connection reset"));

    await expect(readMetaAdExecutionState(ctx, "ad_1")).resolves.toMatchObject({
      ok: false,
      adId: "ad_1",
      httpStatus: null,
      preflightBlocker: "current_ad_state_unverified",
      error: { code: "network_error" },
    });
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

  it("pauseAd returns silent_failure when verification shows unchanged status", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "ad_1", status: "ACTIVE", effective_status: "ACTIVE" }),
      );

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      error: { code: "silent_failure" },
    });
  });

  it("pauseAd returns Meta HTTP errors without verification", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
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
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("pauseAd retries once after Meta user request limit and then verifies", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 17, message: "(#17) User request limit reached" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "ad_1", status: "PAUSED", effective_status: "PAUSED" }),
      );

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({ ok: true, verifiedStatus: "PAUSED" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("halts a rate-limit retry when the business kill switch engages", async () => {
    vi.mocked(controlPlane.getMetaWriteBlockState)
      .mockResolvedValueOnce({ blocked: false, reason: null, message: null })
      .mockResolvedValueOnce({
        blocked: true,
        reason: "business_kill_switch",
        message: "Owner stopped Meta writes.",
      });
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 17, message: "(#17) User request limit reached" } },
        { status: 429 },
      ),
    );

    const result = await pauseAd(ctx, "ad_1");

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 503,
      error: {
        code: "kill_switch_engaged",
        message: "Owner stopped Meta writes.",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("duplicateAd retries once after Meta rate limiting and succeeds on the second create", async () => {
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
    });

    expect(result).toMatchObject({ ok: true, newAdId: "ad_copy_1" });
    expect(fetch).toHaveBeenCalledTimes(4);
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
