import { describe, expect, it } from "vitest";

import { META_BID_INTENT_CONTRACT_VERSION } from "@/lib/meta/bid-intent-contract";
import { serverOperatorApplyForRec } from "@/lib/meta/rec-presentation";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

function authorisedBidTarget(bidAmountMinor: number) {
  return {
    contractVersion: META_BID_INTENT_CONTRACT_VERSION,
    kind: "bid_intent",
    authorityStatus: "authorised",
    blockerCodes: [],
    proposedMinorUnits: bidAmountMinor,
    bidAmountMinor,
    currentMinorUnits: 1200,
    currency: "USD",
    currencyExponent: 2,
    direction: "increase",
    percent: 10,
    bidStrategyType: "cost_cap",
    sizingPolicyVersion: "meta.bid-sizing.v1",
  } as unknown as MetaRecommendation["targetValue"];
}

function rec(overrides: Partial<MetaRecommendation>): MetaRecommendation {
  return {
    id: "rec-1",
    level: "adset",
    campaignId: "camp-1",
    adsetId: "adset-1",
    ...overrides,
  } as MetaRecommendation;
}

/**
 * The engine's authority and the operator's capability answer different
 * questions, and this file holds them apart. `serverActionKindForRec` stays
 * review-only for campaign and ad-set rows; this offers the concrete verb the
 * engine already named, to be executed under the operator's own origin.
 */
describe("what the operator may apply from a structure row", () => {
  it("offers the ad-set pause the engine proposed", () => {
    expect(
      serverOperatorApplyForRec(rec({ proposedAction: { kind: "pause" } })),
    ).toEqual({ action: "pause", grain: "adset", entityId: "adset-1" });
  });

  it("offers a campaign resume against the campaign id", () => {
    expect(
      serverOperatorApplyForRec(
        rec({ level: "campaign", proposedAction: { kind: "resume" } }),
      ),
    ).toEqual({ action: "resume", grain: "campaign", entityId: "camp-1" });
  });

  it("carries the exact bid amount, in minor units", () => {
    expect(
      serverOperatorApplyForRec(
        rec({
          type: "scenario_b1_capped_winner_bid_raise",
          targetValue: authorisedBidTarget(1320),
          proposedAction: { kind: "apply_bid", bidAmountMinor: 1320 },
        }),
      ),
    ).toEqual({
      action: "bid",
      grain: "adset",
      entityId: "adset-1",
      bidAmountMinor: 1320,
    });
  });

  it("refuses a bid at campaign grain, which has no endpoint", () => {
    expect(
      serverOperatorApplyForRec(
        rec({
          level: "campaign",
          type: "scenario_b1_capped_winner_bid_raise",
          targetValue: authorisedBidTarget(1320),
          proposedAction: { kind: "apply_bid", bidAmountMinor: 1320 },
        }),
      ),
    ).toBeNull();
  });

  it("refuses a bid amount that is not a positive whole number", () => {
    for (const bidAmountMinor of [0, -5, 12.5, Number.NaN]) {
      expect(
        serverOperatorApplyForRec(
          rec({
            type: "scenario_b1_capped_winner_bid_raise",
            targetValue: authorisedBidTarget(bidAmountMinor),
            proposedAction: { kind: "apply_bid", bidAmountMinor },
          }),
        ),
        `bid ${bidAmountMinor}`,
      ).toBeNull();
    }
  });

  it("refuses a bid amount attached to unrelated recommendation semantics", () => {
    expect(
      serverOperatorApplyForRec(
        rec({
          type: "scenario_e1_frequency_fatigue",
          targetValue: authorisedBidTarget(1320),
          proposedAction: { kind: "apply_bid", bidAmountMinor: 1320 },
        }),
      ),
    ).toBeNull();
  });

  it("offers nothing without a proven entity id", () => {
    expect(
      serverOperatorApplyForRec(
        rec({ adsetId: undefined, proposedAction: { kind: "pause" } }),
      ),
    ).toBeNull();
    expect(
      serverOperatorApplyForRec(
        rec({ adsetId: "   ", proposedAction: { kind: "pause" } }),
      ),
    ).toBeNull();
  });

  it("offers nothing for an anomaly or a state row", () => {
    // These describe a condition; there is no change named to make.
    for (const kind of ["anomaly", "state"] as const) {
      expect(
        serverOperatorApplyForRec(rec({ kind, proposedAction: { kind: "pause" } })),
      ).toBeNull();
    }
  });

  it("offers nothing when the engine named no concrete verb", () => {
    expect(serverOperatorApplyForRec(rec({}))).toBeNull();
  });
});
