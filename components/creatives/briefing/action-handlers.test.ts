import { describe, expect, it, vi } from "vitest";
import {
  buildCutSuccessToast,
  buildLaunchpadOpenToast,
  buildMetaAdsManagerUrlForBriefingCard,
  getBriefingAdActionInputId,
  getCreativeScopeId,
  isCutPrimaryAction,
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
    expect(isCutPrimaryAction(card())).toBe(true);
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
        body: JSON.stringify({ businessId: "biz_1" }),
      }),
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

  it("can build the optional Launchpad-open toast copy", () => {
    expect(buildLaunchpadOpenToast("fresh_test")).toEqual({
      type: "info",
      message: "Launchpad bridge opened · fresh test",
    });
  });
});
