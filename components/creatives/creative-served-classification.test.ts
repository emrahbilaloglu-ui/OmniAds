import { describe, expect, it } from "vitest";

import {
  buildServedCreativeClassifications,
  creativeDecisionStatusFallback,
  decisionEvidenceLines,
  servedClassificationForRow,
} from "@/components/creatives/creative-served-classification";
import type { CreativesBriefingResponse } from "@/components/creatives/briefing/types";

function responseWithCanonical(input: {
  sourceLabel: string;
  buyerLabel: string | null;
  buyerAction: string | null;
  heldAction: string | null;
}) {
  return {
    actionNow: [
      {
        id: "card_1",
        creativeId: "creative_1",
        canonicalDecision: {
          adId: "ad_1",
          creativeId: "creative_1",
          decisionId: "decision_1",
          sourceDecision: { label: input.sourceLabel },
          classification: {
            decisionState: input.heldAction ? "blocked" : "act",
            buyerLabel: input.buyerLabel,
            buyerAction: input.buyerAction,
            heldAction: input.heldAction,
          },
        },
      },
    ],
    watching: [],
    healthy: [],
  } as unknown as CreativesBriefingResponse;
}

describe("served creative classification copy", () => {
  it("maps canonical actions to buyer language without exposing engine fields", () => {
    const result = buildServedCreativeClassifications(
      responseWithCanonical({
        sourceLabel: "scale",
        buyerLabel: "Increase budget",
        buyerAction: "scale",
        heldAction: null,
      }),
    ).get("creative_1");

    expect(result).toMatchObject({
      label: "Increase budget",
      segment: "Act",
      detail: "Recommended action: Scale",
    });
    expect(result?.detail).not.toContain("Engine:");
    expect(result?.detail).not.toContain("Action:");
  });

  it("describes a held action without exposing its raw enum", () => {
    const result = buildServedCreativeClassifications(
      responseWithCanonical({
        sourceLabel: "cut",
        buyerLabel: null,
        buyerAction: null,
        heldAction: "fix_delivery",
      }),
    ).get("creative_1");

    expect(result).toMatchObject({
      label: "Cut",
      segment: "Blocked",
      detail: "Fix delivery recommendation awaits review",
    });
    expect(result?.detail).not.toContain("fix_delivery");
    expect(result?.detail).not.toContain("Held:");
  });

  it("describes missing recommendations without endpoint or serving jargon", () => {
    const states = ["loading", "unavailable", "available"] as const;
    const details = states.map(
      (state) => creativeDecisionStatusFallback(state).detail,
    );

    expect(details).toEqual([
      "Recommendation is loading.",
      "Recommendation is temporarily unavailable.",
      "No recommendation is available for this creative.",
    ]);
    expect(details.join(" ")).not.toMatch(/endpoint|served decision|context/i);
  });

  it("does not expose an unknown legacy engine enum", () => {
    const response = {
      actionNow: [
        {
          id: "card_2",
          creativeId: "creative_2",
          label: "internal_future_action",
        },
      ],
      watching: [],
      healthy: [],
    } as unknown as CreativesBriefingResponse;

    const result =
      buildServedCreativeClassifications(response).get("creative_2");

    expect(result?.label).toBe("Recommendation available");
    expect(result?.label).not.toContain("internal_future_action");
  });

  it("does not treat a malformed Ad-grain card as a creative-grain decision", () => {
    const response = responseWithCanonical({
      sourceLabel: "cut",
      buyerLabel: "Stop",
      buyerAction: "cut",
      heldAction: null,
    });
    delete (response.actionNow[0] as unknown as { canonicalDecision: { adId?: string } }).canonicalDecision.adId;

    expect(buildServedCreativeClassifications(response).get("creative_1")).toBeUndefined();
  });

  it("does not assign a collapsed creative-only map to an Ad-grain row", () => {
    const collapsed = new Map([
      [
        "shared_creative",
        {
          label: "Cut",
          tone: "negative" as const,
          segment: "Act",
          detail: null,
          decisionCount: 1,
          source: "canonical_decision" as const,
          adDecisions: [],
          variesByAd: false,
        },
      ],
    ]);
    expect(
      servedClassificationForRow(collapsed, {
        creativeId: "shared_creative",
        sourceAdIds: ["different_ad"],
        sourceAdIdsComplete: false,
      }),
    ).toBeNull();
  });
});

/** One served exact-Ad card, as the briefing projection puts it on the wire. */
function adCard(input: {
  adId: string;
  creativeId: string;
  name: string;
  adsetName?: string;
  campaignName: string;
  decisionState: string;
  buyerLabel: string;
  buyerAction?: string | null;
  heldAction?: string | null;
  decisionEvidence?: unknown;
}) {
  return {
    id: `card_${input.adId}`,
    creativeId: input.creativeId,
    name: input.name,
    ...(input.adsetName ? { adsetName: input.adsetName } : {}),
    campaignName: input.campaignName,
    canonicalDecision: {
      adId: input.adId,
      creativeId: input.creativeId,
      decisionId: `decision_${input.adId}`,
      sourceDecision: { label: "keep" },
      classification: {
        decisionState: input.decisionState,
        buyerLabel: input.buyerLabel,
        buyerAction: input.buyerAction ?? null,
        heldAction: input.heldAction ?? null,
      },
      ...(input.decisionEvidence !== undefined
        ? { decisionEvidence: input.decisionEvidence }
        : {}),
    },
  };
}

describe("a creative-grain row holding several exact-Ad verdicts", () => {
  /*
    Grandmix, 2026-09-18..24: the Studio row "Cat-Sale" is two same-named Ads
    in one campaign and two ad sets. The server held a Cut on one and served
    Protect on the other. The row used to print
    "Blocked / Monitor · Cut · Held / Protect".
  */
  const response = {
    actionNow: [
      adCard({
        adId: "ad_cut",
        creativeId: "creative_a",
        name: "Cat-Sale",
        adsetName: "LAL3-WallArtPurchase180Catalog/Klaviyo",
        campaignName: "Claude-WallArt-LAL3-CostCap-v1",
        decisionState: "blocked",
        buyerLabel: "Cut · Held",
        heldAction: "cut",
      }),
    ],
    watching: [
      adCard({
        adId: "ad_keep",
        creativeId: "creative_b",
        name: "Cat-Sale",
        adsetName: "LAL3-Purchase730",
        campaignName: "Claude-WallArt-LAL3-CostCap-v1",
        decisionState: "monitor",
        buyerLabel: "Protect",
        buyerAction: "protect",
      }),
    ],
    healthy: [],
  } as unknown as CreativesBriefingResponse;
  const index = buildServedCreativeClassifications(response);

  it("pairs each verdict with its own Ad instead of joining states and labels apart", () => {
    const result = servedClassificationForRow(index, {
      creativeId: "creative_a",
      sourceAdIds: ["ad_cut", "ad_keep"],
      sourceAdIdsComplete: true,
    });

    expect(result).toMatchObject({
      label: "2 Ads · different recommendations",
      segment: null,
      tone: "neutral",
      decisionCount: 2,
      variesByAd: true,
    });
    expect(
      result?.adDecisions.map((entry) => [
        entry.adId,
        entry.adsetName,
        entry.segment,
        entry.label,
      ]),
    ).toEqual([
      ["ad_cut", "LAL3-WallArtPurchase180Catalog/Klaviyo", "Blocked", "Cut · Held"],
      ["ad_keep", "LAL3-Purchase730", "Monitor", "Protect"],
    ]);
    expect(result?.label).not.toContain("/");
    expect(result?.detail?.split("\n")).toEqual([
      "Cat-Sale (LAL3-WallArtPurchase180Catalog/Klaviyo · Claude-WallArt-LAL3-CostCap-v1): Blocked · Cut · Held — Pause ad recommendation awaits review",
      "Cat-Sale (LAL3-Purchase730 · Claude-WallArt-LAL3-CostCap-v1): Monitor · Protect — Recommended action: Protect performance",
    ]);
  });

  it("keeps one verdict as the server's own state and label when every Ad shares it", () => {
    const same = {
      actionNow: [],
      watching: [
        adCard({
          adId: "ad_1",
          creativeId: "creative_x",
          name: "MAF-Hero",
          campaignName: "Test",
          decisionState: "monitor",
          buyerLabel: "Test more",
        }),
        adCard({
          adId: "ad_2",
          creativeId: "creative_y",
          name: "MAF-Hero",
          campaignName: "Main",
          decisionState: "monitor",
          buyerLabel: "Test more",
        }),
      ],
      healthy: [],
    } as unknown as CreativesBriefingResponse;
    const result = servedClassificationForRow(
      buildServedCreativeClassifications(same),
      { creativeId: "creative_x", sourceAdIds: ["ad_1", "ad_2"], sourceAdIdsComplete: true },
    );

    expect(result).toMatchObject({
      label: "Test more",
      segment: "Monitor",
      decisionCount: 2,
      variesByAd: false,
    });
    expect(result?.detail).toContain("Same recommendation for 2 Ads.");
  });
});

describe("what a verdict rests on", () => {
  it("names the admitted period, its recorded figures and its recent band", () => {
    // BathroomMeta-Bestseller, Grandmix, generation as of 2026-09-25.
    expect(
      decisionEvidenceLines({
        period: {
          startDate: "2026-09-09",
          endDate: "2026-09-24",
          calendarDaySpan: 16,
          economicDayCount: 16,
        },
        spend: 536.56,
        purchases: 10,
        roas: 5.17,
        currency: "USD",
        recent: { startDate: "2026-09-19", endDate: "2026-09-24", roas: 0 },
      }),
    ).toEqual({
      period: "Decided on 2026-09-09–09-24 · 16/16 economic days",
      figures: "ROAS 5.17 · 10 purchases · $537 spend",
      recent: "Recent 2026-09-19–09-24: ROAS 0.00",
    });
  });

  it("leaves an unmeasured figure out instead of printing zero", () => {
    const lines = decisionEvidenceLines({
      period: {
        startDate: "2026-09-10",
        endDate: "2026-09-24",
        calendarDaySpan: 15,
        economicDayCount: 12,
      },
      spend: 130.03,
      purchases: null,
      roas: null,
      currency: "USD",
      recent: { startDate: "2026-09-19", endDate: "2026-09-24", roas: null },
    });
    expect(lines).toEqual({
      period: "Decided on 2026-09-10–09-24 · 12/15 economic days",
      figures: "$130 spend",
      recent: "Recent 2026-09-19–09-24: ROAS unavailable",
    });
    expect(JSON.stringify(lines)).not.toMatch(/ROAS 0|0 purchases/);
  });

  it("says the period is unknown, and prints no figures without one", () => {
    expect(
      decisionEvidenceLines({
        period: null,
        spend: 10,
        purchases: 1,
        roas: 3,
        currency: "USD",
        recent: null,
      }),
    ).toEqual({ period: "Decision period unavailable", figures: null, recent: null });
    // A payload serialized before the field existed says nothing at all.
    expect(decisionEvidenceLines(undefined)).toBeNull();
  });
});
