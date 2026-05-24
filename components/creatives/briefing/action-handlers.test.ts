import { describe, expect, it, vi } from "vitest";
import {
  buildCutSuccessToast,
  buildLaunchpadOpenToast,
  buildMetaAdsManagerUrlForBriefingCard,
  getBriefingAdActionCandidateIds,
  getBriefingAdActionInputId,
  getCreativeScopeId,
  isCutPrimaryAction,
  metaAdActionFailureMessage,
  pauseBriefingCard,
} from "@/components/creatives/briefing/action-handlers";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "creative_synth_1",
    creativeId: "creative_1",
    name: "Cut Candidate",
    accountId: "act_123",
    label: "cut",
    primary: { kind: "cut", label: "Cut" },
    ...overrides,
  };
}

describe("briefing action handlers", () => {
  it("resolves creative scope and pause route input ids without assuming creative id equals ad id", () => {
    expect(getCreativeScopeId(card())).toBe("creative_1");
    expect(getBriefingAdActionInputId(card())).toBe("creative_1");
    expect(getBriefingAdActionInputId(card({ realAdId: "1200" }))).toBe("1200");
    expect(
      getBriefingAdActionCandidateIds(
        card({
          realAdId: "1200",
          metaAdId: "1200",
          effectiveAdId: "1201",
          adId: "row_ad",
        }),
      ),
    ).toEqual(["1200", "1201", "row_ad", "creative_1", "creative_synth_1"]);
    expect(isCutPrimaryAction(card())).toBe(true);
    expect(isCutPrimaryAction(card({ primary: { kind: "pause_ad", label: "Pause ad" } }))).toBe(true);
    expect(isCutPrimaryAction(card({ label: "scale", primary: { kind: "review", label: "Pause ad" } }))).toBe(true);
    expect(isCutPrimaryAction(card({ primary: { kind: "demote", label: "Demote to test" } }))).toBe(false);
    expect(isCutPrimaryAction(card({ label: "scale", primary: { kind: "promote", label: "Promote" } }))).toBe(false);
  });

  it("posts cut actions through the existing pause endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, adId: "1200", status: "PAUSED" }),
    })) as unknown as typeof fetch;

    const result = await pauseBriefingCard({
      businessId: "biz_1",
      card: card({ realAdId: "1200" }),
      fetchImpl,
    });

    expect(result.adId).toBe("1200");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/meta/ads/1200/pause",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ businessId: "biz_1", recIdOrigin: "creative_1" }),
      }),
    );
  });

  it("tries the next action id when the first Briefing id is not resolvable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({
          ok: false,
          error: { code: "ad_not_found", message: "Ad not found for this business." },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, adId: "real_ad_1", status: "PAUSED" }),
      }) as unknown as typeof fetch;

    const result = await pauseBriefingCard({
      businessId: "biz_1",
      card: card({ realAdId: "stale_ad_1", metaAdId: "real_ad_1" }),
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: true,
      adId: "real_ad_1",
      attemptedIds: ["stale_ad_1", "real_ad_1"],
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/meta/ads/stale_ad_1/pause",
      expect.any(Object),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/meta/ads/real_ad_1/pause",
      expect.any(Object),
    );
  });

  it("builds the existing Meta Ads Manager link for cut toasts", () => {
    expect(buildMetaAdsManagerUrlForBriefingCard(card(), "1200")).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=123&selected_ad_ids=1200",
    );
    expect(buildCutSuccessToast(card(), { ok: true, adId: "1200" })).toEqual({
      type: "success",
      message: "Cut applied · Cut Candidate",
      link: {
        href: "https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=123&selected_ad_ids=1200",
        label: "Open in Meta",
      },
    });
  });

  it("does not present cut dry-runs as applied writes", () => {
    expect(buildCutSuccessToast(card(), { ok: true, adId: "1200", dryRun: true })).toEqual({
      type: "info",
      message: "Dry run completed · Cut Candidate",
      link: null,
    });
  });

  it("surfaces kill-switch failures with operator-specific copy", () => {
    expect(
      metaAdActionFailureMessage(
        {
          error: {
            code: "kill_switch_engaged",
            message: "Meta writes are disabled by kill switch.",
          },
        },
        503,
      ),
    ).toBe("Meta writes are temporarily disabled (kill switch). Try again later.");
  });

  it("can build the optional Launchpad-open toast copy", () => {
    expect(buildLaunchpadOpenToast("fresh_test")).toEqual({
      type: "info",
      message: "Launchpad bridge opened · fresh test",
    });
  });
});
