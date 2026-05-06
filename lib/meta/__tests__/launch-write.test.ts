import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaAdsWriteContext } from "@/lib/meta/ads-write";
import {
  createAd,
  createAdSet,
  createCampaign,
  type MetaLaunchAdInput,
  type MetaLaunchAdSetInput,
  type MetaLaunchCampaignInput,
} from "@/lib/meta/launch-write";

const ctx: MetaAdsWriteContext = {
  businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  providerAccountId: "act_123",
  accessToken: "secret-token",
};

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function campaignInput(
  overrides: Partial<MetaLaunchCampaignInput> = {},
): MetaLaunchCampaignInput {
  return {
    name: "Launchpad campaign",
    objective: "OUTCOME_SALES",
    status: "PAUSED",
    specialAdCategories: [],
    isAdsetBudgetSharingEnabled: true,
    dailyBudgetMinor: 5000,
    buyingType: "AUCTION",
    ...overrides,
  };
}

function adSetInput(
  overrides: Partial<MetaLaunchAdSetInput> = {},
): MetaLaunchAdSetInput {
  return {
    campaignId: "cmp_1",
    name: "Launchpad ad set",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    status: "PAUSED",
    promotedObject: {
      pixelId: "pixel_1",
      customEventType: "PURCHASE",
    },
    targeting: {
      geoLocations: { countries: ["US"] },
      ageMin: 18,
      ageMax: 65,
      advantageAudience: 1,
    },
    attributionSpec: [{ eventType: "CLICK_THROUGH", windowDays: 7 }],
    dailyBudgetMinor: 2500,
    ...overrides,
  };
}

function adInput(overrides: Partial<MetaLaunchAdInput> = {}): MetaLaunchAdInput {
  return {
    adsetId: "adset_1",
    name: "Launchpad ad",
    creativeId: "creative_1",
    status: "PAUSED",
    ...overrides,
  };
}

describe("Meta launch write client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("createCampaign creates a paused OUTCOME_SALES campaign and verifies it", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ id: "cmp_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "cmp_1",
          status: "PAUSED",
          objective: "OUTCOME_SALES",
        }),
      );

    const result = await createCampaign(ctx, campaignInput());

    expect(result).toMatchObject({
      ok: true,
      campaignId: "cmp_1",
      verifiedStatus: "PAUSED",
    });
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "/v22.0/act_123/campaigns?",
    );
    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("objective")).toBe("OUTCOME_SALES");
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("daily_budget")).toBe("5000");
    expect(body.get("is_adset_budget_sharing_enabled")).toBe("true");
  });

  it("createCampaign returns silent_failure when verification mismatches", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ id: "cmp_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "cmp_1",
          status: "ACTIVE",
          objective: "OUTCOME_SALES",
        }),
      );

    const result = await createCampaign(ctx, campaignInput());

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      error: { code: "silent_failure" },
      resultingAdId: "cmp_1",
    });
  });

  it("createCampaign returns Meta HTTP errors without verification", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 190, message: "Invalid OAuth access token." } },
        { status: 400 },
      ),
    );

    const result = await createCampaign(ctx, campaignInput());

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 400,
      error: { code: "190", message: "Invalid OAuth access token." },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("createCampaign retries once after Meta rate limiting", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 17, message: "(#17) User request limit reached" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "cmp_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "cmp_1",
          status: "PAUSED",
          objective: "OUTCOME_SALES",
        }),
      );

    const result = await createCampaign(ctx, campaignInput());

    expect(result).toMatchObject({ ok: true, campaignId: "cmp_1" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("createAdSet creates a paused conversion ad set and verifies it", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ id: "adset_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "adset_1",
          status: "PAUSED",
          optimization_goal: "OFFSITE_CONVERSIONS",
          promoted_object: {
            pixel_id: "pixel_1",
            custom_event_type: "PURCHASE",
          },
        }),
      );

    const result = await createAdSet(ctx, adSetInput());

    expect(result).toMatchObject({
      ok: true,
      adsetId: "adset_1",
      verifiedStatus: "PAUSED",
    });
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "/v22.0/cmp_1/adsets?",
    );
    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("billing_event")).toBe("IMPRESSIONS");
    expect(body.get("promoted_object")).toBe(
      JSON.stringify({ pixel_id: "pixel_1", custom_event_type: "PURCHASE" }),
    );
    expect(body.get("targeting")).toContain("advantage_audience");
    expect(body.get("attribution_spec")).toBe(
      JSON.stringify([{ event_type: "CLICK_THROUGH", window_days: 7 }]),
    );
  });

  it("createAdSet returns silent_failure when verification mismatches", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ id: "adset_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "adset_1",
          status: "PAUSED",
          optimization_goal: "LANDING_PAGE_VIEWS",
          promoted_object: {
            pixel_id: "pixel_1",
            custom_event_type: "PURCHASE",
          },
        }),
      );

    const result = await createAdSet(ctx, adSetInput());

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      error: { code: "silent_failure" },
      resultingAdId: "adset_1",
    });
  });

  it("createAdSet returns Meta HTTP errors without verification", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 100, message: "Missing promoted object." } },
        { status: 400 },
      ),
    );

    const result = await createAdSet(ctx, adSetInput());

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 400,
      error: { code: "100", message: "Missing promoted object." },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("createAdSet retries once after Meta rate limiting", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 17, message: "(#17) User request limit reached" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "adset_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "adset_1",
          status: "PAUSED",
          optimization_goal: "OFFSITE_CONVERSIONS",
          promoted_object: {
            pixel_id: "pixel_1",
            custom_event_type: "PURCHASE",
          },
        }),
      );

    const result = await createAdSet(ctx, adSetInput());

    expect(result).toMatchObject({ ok: true, adsetId: "adset_1" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("createAd creates a paused ad and verifies it", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ id: "ad_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          status: "PAUSED",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      );

    const result = await createAd(ctx, adInput());

    expect(result).toMatchObject({
      ok: true,
      adId: "ad_1",
      verifiedStatus: "PAUSED",
    });
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "/v22.0/adset_1/ads?",
    );
    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("creative")).toBe(JSON.stringify({ creative_id: "creative_1" }));
    expect(body.get("status")).toBe("PAUSED");
  });

  it("createAd returns silent_failure when verification mismatches", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ id: "ad_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          status: "ACTIVE",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      );

    const result = await createAd(ctx, adInput());

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 502,
      error: { code: "silent_failure" },
      resultingAdId: "ad_1",
    });
  });

  it("createAd returns Meta HTTP errors without verification", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 100, message: "Invalid creative." } },
        { status: 400 },
      ),
    );

    const result = await createAd(ctx, adInput());

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 400,
      error: { code: "100", message: "Invalid creative." },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("createAd retries once after Meta rate limiting", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 17, message: "(#17) User request limit reached" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "ad_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          status: "PAUSED",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        }),
      );

    const result = await createAd(ctx, adInput());

    expect(result).toMatchObject({ ok: true, adId: "ad_1" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
