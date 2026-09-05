/**
 * Attaches a sized bid intent to the ad sets that earned one.
 *
 * The write primitive and the `apply-bid` route have existed for a long time,
 * and `proposedActionForRecommendation` already turns a `bidAmountMinor` in
 * `targetValue` into an executable operator action. Nothing ever wrote that
 * number, so the whole path was dark: an ad set on a cost cap far above its
 * own CPA had no in-product way to move.
 *
 * This is the seam that fills it. Recommendations in, recommendations out,
 * with `targetValue` set on the rows `sizeBidChange` sized and left untouched
 * on every other. It performs no IO — everything it needs is gathered once per
 * account by the caller, where those reads already happen.
 *
 * The amount is not written on the sizing policy's word alone: it goes through
 * `validateBidIntent` first, which owns the minor-unit arithmetic, the
 * rounding rule and the refusal codes. A percentage that rounds to no change
 * at all is rejected there rather than proposed here as a change.
 */
import {
  META_BID_INTENT_CONTRACT_VERSION,
  validateBidIntent,
} from "@/lib/meta/bid-intent-contract";
import {
  sizeBidChange,
  type BidSizingInput,
} from "@/lib/meta/bid-sizing-policy";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

/** The per-ad-set facts the sizing policy needs, gathered by the caller. */
export interface BidIntentEntityContext {
  bidStrategyType: string | null;
  currentBidMinor: number | null;
  spend28d: number | null;
  purchases28d: number | null;
  maturityOk: boolean;
  deliveryConstrained: boolean;
  hoursSinceLastChange: number | null;
  changesLast7d: number | null;
  parentCampaignId: string | null;
}

export interface BidIntentProjectionInput {
  recommendations: MetaRecommendation[];
  businessId: string;
  providerAccountId: string;
  /** The derived CPA benchmark in minor units. See the spend-unit resolver. */
  spendUnitMinor: number | null;
  accountCurrency: string | null;
  policy: BidSizingInput["policy"];
  contextByAdsetId: Map<string, BidIntentEntityContext>;
  /** Ad sets that already have a budget change proposed in this same run. */
  budgetChangedAdsetIds: Set<string>;
  originDate: string;
  effectiveAsOf: string;
  knowledgeAsOf: string;
  evidenceWindow: { from: string; to: string };
}

export interface BidIntentProjectionResult {
  recommendations: MetaRecommendation[];
  sized: number;
  withheldByCode: Record<string, number>;
}

export function projectBidIntents(
  input: BidIntentProjectionInput,
): BidIntentProjectionResult {
  const withheldByCode: Record<string, number> = {};
  const note = (code: string) => {
    withheldByCode[code] = (withheldByCode[code] ?? 0) + 1;
  };
  let sized = 0;
  const bindings = [{
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  }];

  const recommendations = input.recommendations.map((rec) => {
    if (rec.kind === "anomaly" || rec.kind === "state") return rec;
    // A bid amount lives on an ad set; there is no campaign-grain bid write.
    if (rec.level !== "adset") return rec;
    const adsetId = rec.adsetId?.trim();
    if (!adsetId) return rec;
    const context = input.contextByAdsetId.get(adsetId);
    if (!context) return rec;

    const outcome = sizeBidChange({
      bidStrategyType: context.bidStrategyType,
      currentBidMinor: context.currentBidMinor,
      spendUnitMinor: input.spendUnitMinor,
      spend28d: context.spend28d,
      purchases28d: context.purchases28d,
      maturityOk: context.maturityOk,
      deliveryConstrained: context.deliveryConstrained,
      // The same ad set does not get both a budget and a bid change in one
      // window: two simultaneous levers make the outcome unattributable.
      budgetChangeProposedSameWindow: input.budgetChangedAdsetIds.has(adsetId),
      hoursSinceLastChange: context.hoursSinceLastChange,
      changesLast7d: context.changesLast7d,
      policy: input.policy,
    });
    if (outcome.status === "withheld") {
      note(outcome.code);
      return rec;
    }

    /*
      The contract owns the money.

      The sizing policy chose a direction and a rung; turning that into an
      exact integer of minor units, and refusing the cases where it cannot be
      one, belongs to the validator — the same one the queue will re-run.
    */
    const validated = validateBidIntent({
      contractVersion: META_BID_INTENT_CONTRACT_VERSION,
      scope: {
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        entityGrain: "adset",
        entityId: adsetId,
        parentCampaignId: context.parentCampaignId,
      },
      bidStrategyType: context.bidStrategyType ?? "",
      direction: outcome.direction,
      percent: outcome.percent,
      currency: input.accountCurrency ?? "",
      observedBidMinorUnits: context.currentBidMinor,
      originDate: input.originDate,
      effectiveAsOf: input.effectiveAsOf,
      knowledgeAsOf: input.knowledgeAsOf,
      evidenceWindow: input.evidenceWindow,
      authorityStatus: "authorised",
      blockerCodes: [],
    }, bindings);

    if (validated.status !== "valid") {
      for (const code of validated.rejections) note(code);
      return rec;
    }

    sized += 1;
    return {
      ...rec,
      targetValue: {
        contractVersion: META_BID_INTENT_CONTRACT_VERSION,
        direction: validated.intent.direction,
        percent: validated.intent.percent,
        /*
          The field `proposedActionForRecommendation` reads.

          It is the whole reason the manual apply path lights up: with it, the
          decision card offers "Apply bid" against a proven amount; without it
          the same card offers nothing at all.
        */
        bidAmountMinor: validated.intent.proposedMinorUnits,
        currentMinorUnits: validated.intent.currentMinorUnits,
        bidStrategyType: validated.intent.bidStrategyType,
        sizingPolicyVersion: outcome.policyVersion,
        intentKey: validated.intent.intentKey,
        // The band, the ratio and every clamp that moved the rung: a card
        // shows this instead of a bare percentage, because a constraint is
        // not evidence for an amount.
        rationale: outcome.rationale,
      },
    } satisfies MetaRecommendation;
  });

  return { recommendations, sized, withheldByCode };
}
