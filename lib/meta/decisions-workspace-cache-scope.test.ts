import { describe, expect, it } from "vitest";
import {
  metaDecisionCampaignContextScopeKey,
  normalizeMetaDecisionCampaignContextIds,
} from "@/lib/meta/decisions-workspace-cache-scope";
import type { MetaCurrentAdStatusSourceRow } from "@/lib/meta/decisions-workspace-read-model";

function currentAd(
  campaignId: string | null,
): MetaCurrentAdStatusSourceRow {
  return {
    providerAccountId: "act_1",
    adId: `ad_${campaignId ?? "none"}`,
    adName: null,
    campaignId,
    adsetId: null,
    creativeId: null,
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    providerUpdatedAt: null,
    fetchedAt: "2026-07-14T00:00:00.000Z",
  };
}

describe("Meta Decisions campaign-context cache scope", () => {
  it("normalizes the exact union used by current Ads and Structure", () => {
    expect(
      normalizeMetaDecisionCampaignContextIds({
        currentAds: [currentAd(" cmp_b "), currentAd(null)],
        structureCampaignIds: ["cmp_a", "cmp_b", "", null],
      }),
    ).toEqual(["cmp_a", "cmp_b"]);
  });

  it("is stable for equivalent sets and changes with Structure scope", () => {
    const first = normalizeMetaDecisionCampaignContextIds({
      currentAds: [currentAd("cmp_b")],
      structureCampaignIds: ["cmp_a", "cmp_b"],
    });
    const reordered = normalizeMetaDecisionCampaignContextIds({
      currentAds: [currentAd("cmp_a")],
      structureCampaignIds: ["cmp_b", "cmp_a", "cmp_b"],
    });
    const different = normalizeMetaDecisionCampaignContextIds({
      currentAds: [currentAd("cmp_b")],
      structureCampaignIds: ["cmp_c"],
    });

    expect(metaDecisionCampaignContextScopeKey(first)).toBe(
      metaDecisionCampaignContextScopeKey(reordered),
    );
    expect(metaDecisionCampaignContextScopeKey(first)).not.toBe(
      metaDecisionCampaignContextScopeKey(different),
    );
  });
});
