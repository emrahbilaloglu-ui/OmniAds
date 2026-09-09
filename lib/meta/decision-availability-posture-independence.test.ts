/**
 * The availability matrix's headline invariant, as a fast unit guard.
 *
 * `docs/qa/decision-availability-matrix.md` measures it end to end: 24 operating
 * postures over one byte-identical set of warehouse facts, driven through the
 * real producer, the retained snapshot, the served route and the shipped
 * dispatch. That run takes a Postgres cluster and several minutes, and its
 * result was a single fingerprint — the recommendation, its evidence and its
 * sizing did not move with posture; only the queue and the dispatch did.
 *
 * This file guards the structural reason that was true, so a regression is
 * caught in milliseconds rather than only by the matrix. The three presentation
 * functions the Decision Center's card is built from are PURE over the
 * recommendation: they read no control plane, no decision mode, no STOP, no
 * `dryRunOnly` guardrail and no release gate. Posture therefore cannot reach
 * the recommendation, and dispatch stays the only thing it can move.
 *
 * The target value below is the forward-compatible shape
 * `projectBidIntents` persists (`lib/meta/bid-intent-projection.ts`): a cost
 * cap of 1200 minor USD raised 10% to 1320 on ad set 9000000000201. B1 is the
 * only recommendation vocabulary that authorises that bid-amount direction;
 * its current production emitter is campaign-grain, so this ad-set row pins
 * the presentation contract rather than claiming present-day production
 * reachability.
 */
import { describe, expect, it } from "vitest";

import { META_BID_INTENT_CONTRACT_VERSION } from "@/lib/meta/bid-intent-contract";
import { proposedActionForRecommendation } from "@/lib/meta/recommendations";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import {
  serverActionKindForRec,
  serverOperatorApplyForRec,
  serverPrimaryActionLabelForRec,
} from "@/lib/meta/rec-presentation";

const PERSISTED_BID_INTENT = {
  contractVersion: META_BID_INTENT_CONTRACT_VERSION,
  kind: "bid_intent",
  authorityStatus: "authorised",
  blockerCodes: [] as string[],
  proposedMinorUnits: 1320,
  bidAmountMinor: 1320,
  currentMinorUnits: 1200,
  currency: "USD",
  currencyExponent: 2,
  direction: "increase",
  percent: 10,
  bidStrategyType: "cost_cap",
  sizingPolicyVersion: "meta.bid-sizing.v1",
  intentKey: "harness-intent-key",
} as const;

function cappedAdsetRecommendation(): MetaRecommendation {
  return {
    id: "scenario_b1_capped_winner_bid_raise-9000000000201",
    type: "scenario_b1_capped_winner_bid_raise",
    kind: "recommendation",
    level: "adset",
    campaignId: "9000000000101",
    adsetId: "9000000000201",
    decisionState: "test",
    decisionLabel: "refresh",
    title: "Broad prospecting: frequency fatigue",
    evidence: [],
    targetValue: { ...PERSISTED_BID_INTENT },
  } as unknown as MetaRecommendation;
}

/**
 * Every posture the matrix varies, expressed the only way it could possibly
 * reach these functions: through the environment. A control-plane row cannot
 * reach them at all — they take no business id and open no connection — so an
 * environment sweep is the strongest statement this level can make, and the
 * matrix covers the database half.
 */
const POSTURE_ENVIRONMENTS = [
  { META_AUTOMATION_LIVE_WRITES: "true" },
  { META_AUTOMATION_LIVE_WRITES: "false" },
  { META_AUTOMATION_LIVE_WRITES: undefined },
  { META_ADS_WRITE_KILL_SWITCH: "1" },
  { META_LAUNCHPAD_EXECUTION: "true" },
] as const;

describe("decision availability: posture cannot move the recommendation", () => {
  it("serves the same concrete 1320 apply under every release posture", () => {
    const rec = cappedAdsetRecommendation();
    const observed = POSTURE_ENVIRONMENTS.map((posture) => {
      const previous: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(posture)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        return JSON.stringify({
          operatorApply: serverOperatorApplyForRec(rec),
          actionKind: serverActionKindForRec(rec),
          primaryActionLabel: serverPrimaryActionLabelForRec(rec),
          proposedAction: proposedActionForRecommendation(rec),
        });
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    expect(new Set(observed).size).toBe(1);
    expect(JSON.parse(observed[0]!).operatorApply).toEqual({
      action: "bid",
      grain: "adset",
      entityId: "9000000000201",
      bidAmountMinor: 1320,
    });
  });

  it("keeps the operator's capability and the engine's authority separate", () => {
    /*
      Two different questions, deliberately answered by two functions, and the
      matrix measured both: the ENGINE withholds its own authority from an
      ad-set row (`review_drill`), while the OPERATOR is offered the typed verb
      and the exact amount. A future change that made `operatorApply` follow
      `actionKind` would silently remove the only in-product way to apply this
      decision, which is the failure `serverOperatorApplyForRec` exists to
      prevent — so the divergence is pinned rather than left implicit.

      `docs/qa/decision-availability-matrix.md` Finding 1 is about the OTHER
      side of this: `queue.actionStates` counts `actionKind` only, so it reports
      this row as review-only while the card applies 1320. That is a defect in
      the census, not in either function here.
    */
    const rec = cappedAdsetRecommendation();
    expect(serverActionKindForRec(rec)).toBe("review_drill");
    expect(serverOperatorApplyForRec(rec)).not.toBeNull();
  });

  it("withholds the apply when the persisted intent is not authorised", () => {
    const withheld = {
      ...cappedAdsetRecommendation(),
      targetValue: {
        ...PERSISTED_BID_INTENT,
        authorityStatus: "blocked",
        blockerCodes: ["policy_spend_ceiling_currency_mismatch"],
      },
    } as unknown as MetaRecommendation;
    expect(serverOperatorApplyForRec(withheld)).toBeNull();
    expect(proposedActionForRecommendation(withheld)).toBeUndefined();
  });
});
