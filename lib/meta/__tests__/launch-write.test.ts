import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaAdsWriteContext } from "@/lib/meta/ads-write";
import {
  createAd,
  createAdSet,
  createCampaign,
  preflightMetaLaunchCreatives,
  type MetaLaunchAdInput,
  type MetaLaunchAdSetInput,
  type MetaLaunchCampaignInput,
} from "@/lib/meta/launch-write";

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

// The generation compare-and-set is now unconditional. These launch tests were
// green while it self-disabled on a context with no connectionGeneration —
// which is exactly the state every real Launchpad write was in. Default-admit;
// refusals are proven in lib/meta/write-authority-toctou.test.ts.
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
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({ blocked: false, reason: null, message: null, rehearsal: false });
  });

  it("createCampaign creates a paused OUTCOME_SALES campaign and verifies it", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ id: "cmp_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "cmp_1",
          account_id: "123",
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
          account_id: "123",
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
      providerOutcome: "definite_failure",
      error: { code: "190", message: "Invalid OAuth access token." },
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        providerResponseReceived: true,
        httpStatus: 400,
        outcome: "provider_response_received",
        automaticRetryAttempted: false,
        transportError: null,
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous campaign POST after Meta rate limiting", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 17, message: "(#17) User request limit reached" } },
        { status: 429 },
      ),
    );

    const result = await createCampaign(ctx, campaignInput());

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 429,
      error: { code: "rate_limited" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks the kill switch once and does not enter a campaign POST retry path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 17, message: "(#17) User request limit reached" } },
        { status: 429 },
      ),
    );

    const result = await createCampaign(ctx, campaignInput());

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 429,
      error: {
        code: "rate_limited",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(controlPlane.getMetaWriteBlockState).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["campaign", () => createCampaign(ctx, campaignInput()), "act_123/campaigns"],
    ["ad set", () => createAdSet(ctx, adSetInput()), "cmp_1/adsets"],
    ["ad", () => createAd(ctx, adInput()), "adset_1/ads"],
  ])(
    "records one ambiguous %s POST attempt without retrying the mutation",
    async (_label, run, expectedPath) => {
      vi.mocked(fetch)
        .mockRejectedValueOnce(
          new Error("connection closed after request upload"),
        )
        .mockResolvedValueOnce(jsonResponse({ id: "must_not_be_created" }));

      const result = await run();

      expect(result).toMatchObject({
        ok: false,
        httpStatus: 502,
        providerOutcome: "outcome_ambiguous",
        error: { code: "provider_outcome_ambiguous" },
        mutationAttempt: {
          attemptCount: 1,
          method: "POST",
          path: expectedPath,
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
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
      });
    },
  );

  it("createAdSet creates a paused conversion ad set and verifies it", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ id: "adset_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "adset_1",
          account_id: "123",
          campaign_id: "cmp_1",
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
          account_id: "123",
          campaign_id: "cmp_1",
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

  it("does not retry an ambiguous ad-set POST after Meta rate limiting", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 17, message: "(#17) User request limit reached" } },
        { status: 429 },
      ),
    );

    const result = await createAdSet(ctx, adSetInput());

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 429,
      error: { code: "rate_limited" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("createAd creates a paused ad and verifies it", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ id: "ad_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          account_id: "123",
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
          account_id: "123",
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

  it("does not retry an ambiguous ad POST after Meta rate limiting", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 17, message: "(#17) User request limit reached" } },
        { status: 429 },
      ),
    );

    const result = await createAd(ctx, adInput());

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 429,
      error: { code: "rate_limited" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads every selected creative and proves exact id plus account before launch", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ id: "creative_1", account_id: "123" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "creative_2", account_id: "123" }),
      );

    const result = await preflightMetaLaunchCreatives(ctx, [
      "creative_1",
      "creative_2",
    ]);

    expect(result).toMatchObject({
      ok: true,
      providerAccountId: "act_123",
      checks: [
        {
          requestedCreativeId: "creative_1",
          returnedCreativeId: "creative_1",
          returnedProviderAccountId: "act_123",
          ok: true,
        },
        {
          requestedCreativeId: "creative_2",
          returnedCreativeId: "creative_2",
          returnedProviderAccountId: "act_123",
          ok: true,
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(fetch).mock.calls) {
      expect(call[1]?.method).toBe("GET");
      expect(String(call[0])).toContain("fields=id%2Caccount_id");
    }
  });

  it.each([
    [
      { id: "wrong_creative", account_id: "123" },
      "creative_id_mismatch",
    ],
    [
      { id: "creative_1", account_id: "999" },
      "creative_account_mismatch",
    ],
    [
      { id: "creative_1" },
      "creative_account_mismatch",
    ],
  ])(
    "fails creative preflight closed for wrong or missing provider identity",
    async (providerPayload, errorCode) => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(providerPayload));

      const result = await preflightMetaLaunchCreatives(ctx, ["creative_1"]);

      expect(result.ok).toBe(false);
      expect(result.checks[0]).toMatchObject({
        ok: false,
        error: { code: errorCode },
      });
    },
  );

  it("retries a GET-only creative preflight after code 17", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 17, message: "(#17) User request limit reached" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "creative_1", account_id: "123" }),
      );

    const result = await preflightMetaLaunchCreatives(ctx, ["creative_1"]);

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "campaign",
      async () => createCampaign(ctx, campaignInput()),
      [
        { id: "cmp_1" },
        {
          id: "wrong_campaign",
          account_id: "123",
          status: "PAUSED",
          objective: "OUTCOME_SALES",
        },
      ],
    ],
    [
      "ad set",
      async () => createAdSet(ctx, adSetInput()),
      [
        { id: "adset_1" },
        {
          id: "adset_1",
          account_id: "123",
          campaign_id: "wrong_campaign",
          status: "PAUSED",
          optimization_goal: "OFFSITE_CONVERSIONS",
          promoted_object: {
            pixel_id: "pixel_1",
            custom_event_type: "PURCHASE",
          },
        },
      ],
    ],
    [
      "ad",
      async () => createAd(ctx, adInput()),
      [
        { id: "ad_1" },
        {
          id: "ad_1",
          account_id: "999",
          status: "PAUSED",
          adset_id: "adset_1",
          creative: { id: "creative_1" },
        },
      ],
    ],
  ])(
    "fails %s post-write verification closed on wrong id, account, or parent",
    async (_label, run, responses) => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse(responses[0]))
        .mockResolvedValueOnce(jsonResponse(responses[1]));

      const result = await run();

      expect(result).toMatchObject({
        ok: false,
        error: { code: "silent_failure" },
      });
    },
  );

  it("fails ad post-write verification closed when the exact creative id mismatches", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ id: "ad_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_1",
          account_id: "123",
          status: "PAUSED",
          adset_id: "adset_1",
          creative: { id: "wrong_creative" },
        }),
      );

    const result = await createAd(ctx, adInput());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "silent_failure" },
      resultingAdId: "ad_1",
    });
  });

  it.each([
    [
      "campaign account",
      async () => createCampaign(ctx, campaignInput()),
      {
        id: "cmp_1",
        status: "PAUSED",
        objective: "OUTCOME_SALES",
      },
    ],
    [
      "ad-set id",
      async () => createAdSet(ctx, adSetInput()),
      {
        account_id: "123",
        campaign_id: "cmp_1",
        status: "PAUSED",
        optimization_goal: "OFFSITE_CONVERSIONS",
        promoted_object: {
          pixel_id: "pixel_1",
          custom_event_type: "PURCHASE",
        },
      },
    ],
    [
      "ad creative",
      async () => createAd(ctx, adInput()),
      {
        id: "ad_1",
        account_id: "123",
        status: "PAUSED",
        adset_id: "adset_1",
      },
    ],
  ])(
    "fails %s post-write verification closed when an exact field is missing",
    async (_label, run, verificationPayload) => {
      const createdId = _label.startsWith("campaign")
        ? "cmp_1"
        : _label.startsWith("ad-set")
          ? "adset_1"
          : "ad_1";
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ id: createdId }))
        .mockResolvedValueOnce(jsonResponse(verificationPayload));

      const result = await run();

      expect(result).toMatchObject({
        ok: false,
        error: { code: "silent_failure" },
        resultingAdId: createdId,
      });
    },
  );
});
