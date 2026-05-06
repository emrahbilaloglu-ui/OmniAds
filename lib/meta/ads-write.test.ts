import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  duplicateAd,
  pauseAd,
  type MetaAdsWriteContext,
} from "@/lib/meta/ads-write";

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

describe("Meta ads write client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
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

  it("duplicateAd returns the copied ad id after status and placement verification", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ copied_ad_id: "ad_copy_1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "ad_copy_1",
          name: "Copy",
          status: "PAUSED",
          effective_status: "PAUSED",
          adset_id: "adset_2",
          campaign_id: "cmp_2",
        }),
      );

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
      activateAfterCreate: false,
    });

    expect(result).toMatchObject({
      ok: true,
      newAdId: "ad_copy_1",
      verifiedStatus: "PAUSED",
    });
    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("adset_id")).toBe("adset_2");
    expect(body.get("status_option")).toBe("PAUSED");
  });

  it("duplicateAd reports silent_failure when the copied ad cannot be verified", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ copied_ad_id: "ad_copy_1" }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 100, message: "Unsupported get request." } },
          { status: 404 },
        ),
      );

    const result = await duplicateAd(ctx, {
      adId: "ad_1",
      targetAdsetId: "adset_2",
      activateAfterCreate: false,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 404,
      error: { code: "silent_failure" },
      resultingAdId: "ad_copy_1",
    });
  });
});
