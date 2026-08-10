import { describe, expect, it } from "vitest";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import {
  buildCurrentWinnerEvidence,
  buildHistoricalWinnerEraState,
  findCreativeStudioCard,
  flattenCreativeStudioBriefingCards,
  groupServerFatigueEvidence,
  indexCreativeStudioBriefingCards,
  qualifyCurrentWinner,
  resolveCreativeStudioSharePolicy,
  resolveServerDecisionBadge,
  scopeCreativeInboxCards,
} from "./studio-truth";

type ServedCreativeDecision = NonNullable<
  BriefingCreativeCard["decisionCenterRow"]
>;

function decisionRow(
  overrides: Partial<ServedCreativeDecision> = {},
): ServedCreativeDecision {
  return {
    scope: "creative",
    creativeId: "creative_1",
    identityGrain: "creative",
    engine: {
      contractVersion: "creative-decision-os.v2.1",
      engineVersion: "v3-test",
      primaryDecision: "Scale",
      actionability: "review_only",
      problemClass: "performance",
      confidence: 80,
      maturity: "mature",
      priority: "high",
      reasonTags: ["strong_relative_winner"],
      evidenceSummary: "Server evidence",
      blockerReasons: [],
      missingData: [],
      queueEligible: false,
      applyEligible: false,
    },
    buyerAction: "scale",
    buyerLabel: "Scale budget",
    uiBucket: "scale",
    confidenceBand: "high",
    priority: "high",
    oneLine: "Server-qualified action",
    reasons: ["Server evidence"],
    nextStep: "Open in Decisions",
    missingData: [],
    ...overrides,
  };
}

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "row_1",
    creativeId: "creative_1",
    creativeName: "Creative one",
    providerAccountId: "act_1",
    truthSource: "commercial_truth",
    thresholdQuality: "ready",
    engineVersion: "v3-test",
    sourceAsOf: "2026-07-10",
    sourceDataSource: "warehouse",
    decisionCenterRow: decisionRow(),
    ...overrides,
  };
}

function exactAdCard(adId: string): BriefingCreativeCard {
  return card({
    id: adId,
    adId,
    realAdId: adId,
    creativeId: "creative_shared",
    decisionCenterRow: decisionRow({
      rowId: adId,
      creativeId: "creative_shared",
      identityGrain: "ad",
    }),
    canonicalDecision: {
      identityGrain: "ad",
      adId,
      sourceAuthority: {
        actionEligible: true,
        authorizedAction: "scale",
      },
    } as never,
  });
}

describe("Creative Studio truth projection", () => {
  it("uses action-lane cards first and de-duplicates briefing rows", () => {
    const actionCard = card({ creativeName: "Action version" });
    const duplicate = card({ creativeName: "Healthy duplicate" });
    const cards = flattenCreativeStudioBriefingCards({
      actionNow: [
        {
          id: "rollup_1",
          primaryRec: actionCard,
          placementList: [],
        },
      ],
      watching: [],
      healthy: [duplicate],
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]?.creativeName).toBe("Action version");
  });

  it("preserves exact native ads that share one creative across Studio and Inbox", () => {
    const first = exactAdCard("ad_1");
    const second = exactAdCard("ad_2");
    const cards = flattenCreativeStudioBriefingCards({
      actionNow: [first, second],
      watching: [],
      healthy: [],
    });
    const index = indexCreativeStudioBriefingCards(cards);

    expect(cards.map((item) => item.id)).toEqual(["ad_1", "ad_2"]);
    expect(
      findCreativeStudioCard(
        { id: "ad_1", creativeId: "creative_shared" },
        index,
      )?.realAdId,
    ).toBe("ad_1");
    expect(
      findCreativeStudioCard(
        { id: "ad_2", creativeId: "creative_shared" },
        index,
      )?.realAdId,
    ).toBe("ad_2");
    expect(
      findCreativeStudioCard(
        { id: "creative_shared", creativeId: "creative_shared" },
        index,
      ),
    ).toBeNull();
  });

  it("renders decision badges only from the server decision row", () => {
    expect(resolveServerDecisionBadge(card())).toEqual({
      label: "Scale budget",
      servedAction: "scale",
      confidenceBand: "high",
      source: "decision_center",
    });
    expect(
      resolveServerDecisionBadge(
        card({ decisionCenterRow: null, label: "scale", primary: { label: "Scale" } }),
      ),
    ).toBeNull();
  });

  it("does not match a reused grouped row id to a different creative version", () => {
    const index = indexCreativeStudioBriefingCards([
      card({ id: "creative_shared", creativeId: "old_creative" }),
    ]);

    expect(
      findCreativeStudioCard(
        { id: "creative_shared", creativeId: "new_creative" },
        index,
      ),
    ).toBeNull();
    expect(
      findCreativeStudioCard(
        { id: "creative_shared", creativeId: "old_creative" },
        index,
      )?.creativeId,
    ).toBe("old_creative");
  });

  it("withholds winner language under global, thin, stale, or incomplete truth", () => {
    expect(qualifyCurrentWinner(card()).qualified).toBe(true);
    expect(
      qualifyCurrentWinner(card({ truthSource: "global_default" })),
    ).toMatchObject({ qualified: false, reason: "global_default_truth" });
    expect(
      qualifyCurrentWinner(card({ truthSource: "account_baseline_thin" })),
    ).toMatchObject({ qualified: false, reason: "thin_account_truth" });
    expect(
      qualifyCurrentWinner(card({ truthSource: "commercial_truth_stale" })),
    ).toMatchObject({ qualified: false, reason: "stale_commercial_truth" });
    expect(
      qualifyCurrentWinner(card({ engineVersion: null })),
    ).toMatchObject({ qualified: false, reason: "engine_provenance_missing" });
    expect(
      buildCurrentWinnerEvidence([
        card(),
        card({ id: "row_2", creativeId: "creative_2", truthSource: "global_default" }),
      ]),
    ).toMatchObject({ qualified: [{ creativeId: "creative_1" }], withheld: [{ card: { creativeId: "creative_2" } }] });
  });

  it("uses persisted exact-Ad action authority instead of a removed legacy threshold field", () => {
    const exact = exactAdCard("ad_1");
    exact.thresholdQuality = undefined;

    expect(qualifyCurrentWinner(exact)).toMatchObject({
      candidate: true,
      qualified: true,
      reason: "qualified",
    });

    exact.canonicalDecision!.sourceAuthority.actionEligible = false;
    expect(qualifyCurrentWinner(exact)).toMatchObject({
      candidate: true,
      qualified: false,
      reason: "threshold_not_ready",
    });
  });

  it("does not call historical scale events winners without per-event era provenance", () => {
    const state = buildHistoricalWinnerEraState([
      card({
        decisionHistory: [
          {
            date: "2026-07-01",
            previousLabel: "keep",
            currentLabel: "scale",
            realizedOutcome7d: "positive",
          },
        ],
      }),
    ]);

    expect(state.status).toBe("provenance_incomplete");
    expect(state.eras).toEqual([]);
    expect(state.transitions).toHaveLength(1);
  });

  it("keeps historical eras blocked when ordinary transitions also omit engine version", () => {
    const state = buildHistoricalWinnerEraState([
      card({
        decisionHistory: [
          {
            date: "2026-07-02",
            previousLabel: "test_more",
            currentLabel: "diagnose",
          },
        ],
      }),
    ]);

    expect(state.status).toBe("provenance_incomplete");
    expect(state.eras).toEqual([]);
  });

  it("groups only explicit server fatigue signals", () => {
    const groups = groupServerFatigueEvidence([
      card({ id: "one", creativeId: "one", fatigue: true, campaignName: "Prospecting" }),
      card({ id: "two", creativeId: "two", fatigue: false, campaignName: "Prospecting" }),
      card({ id: "three", creativeId: "three", fatigue: true, campaignName: "Retargeting" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.campaignLabel === "Prospecting")?.cards).toHaveLength(1);
  });

  it("scopes Inbox cards to one business and one provider account", () => {
    const scoped = scopeCreativeInboxCards(
      [
        { ...card(), businessId: "biz_1" },
        { ...card({ id: "row_2", creativeId: "creative_2", providerAccountId: "act_2" }), businessId: "biz_1" },
        { ...card({ id: "row_3", creativeId: "creative_3", providerAccountId: null }), businessId: "biz_1" },
        { ...card({ id: "row_4", creativeId: "creative_4" }), businessId: "biz_2" },
      ],
      { businessId: "biz_1", providerAccountId: "act_1" },
    );

    expect(scoped.cards.map((item) => item.creativeId)).toEqual(["creative_1"]);
    expect(scoped.excludedAccountCount).toBe(1);
    expect(scoped.missingAccountCount).toBe(1);
    expect(scoped.excludedBusinessCount).toBe(1);
  });

  it("locks creator and external shares to the closed Tier-0 metric set", () => {
    const external = resolveCreativeStudioSharePolicy({
      audience: "external",
      selectedMetricIds: ["spend", "roas", "thumbstop"],
      buyerDecisionLanguage: true,
      allowCsv: true,
      anonymizeCampaignNames: false,
    });

    expect(external.creatorTier0).toBe(true);
    expect(external.metrics).toEqual([
      "thumbstop",
      "ctrAll",
      "linkCtr",
      "video25",
      "video50",
      "video75",
      "video100",
    ]);
    expect(external.metrics).not.toContain("spend");
    expect(external.metrics).not.toContain("roas");
    expect(external.includeDecisionLanguage).toBe(false);
    expect(external.includeCampaignNames).toBe(false);
    expect(external.allowCsv).toBe(false);
  });
});
